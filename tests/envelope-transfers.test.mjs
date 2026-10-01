import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { carryoverBalance } from '../lib/envelope-balances.ts';

test('deficits survive December and different monthly allowances', () => {
  assert.equal(carryoverBalance('2025-12', '2026-01', 10000, new Map(), new Map([['2025-12', 12500]]), new Map()), -2500);
  assert.equal(carryoverBalance('2025-12', '2026-02', 10000, new Map([['2026-01', 6000]]), new Map([['2025-12', 12500], ['2026-01', 1000]]), new Map([['2026-01', -2000]])), 500);
});

test('transfer API, signed rollover, deletion and finalized locks', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) database.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({
    bind: (...bindings) => wrap(sql, bindings),
    first: async () => database.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...values) }),
    run: async () => ({ meta: database.prepare(sql).run(...values) }),
  });
  globalThis.__budgetTestEnv = { DB: { prepare: wrap, batch: async statements => {
    database.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } } };
  // D1 batch SELECTs return results rather than mutation metadata.
  globalThis.__budgetTestEnv.DB.prepare = sql => {
    const make = (values = []) => ({ ...wrap(sql, values), bind: (...bindings) => make(bindings), run: async () => /^SELECT/i.test(sql.trim()) ? { results: database.prepare(sql).all(...values) } : { meta: database.prepare(sql).run(...values) } });
    return make();
  };
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-pin'))).toString('hex');
  database.prepare('INSERT INTO settings VALUES (1, ?)').run(hash);
  database.exec("INSERT INTO people VALUES ('person', 'Test', 0); INSERT INTO categories VALUES ('a', 'Groceries', 10000, '#2f7d64', 0), ('b', 'Fun', 10000, '#e28555', 1); INSERT INTO incomes VALUES ('income', 'person', 20000, 'Pay', '2026-01-01')");
  const source = readFileSync(new URL('../app/api/budget/route.ts', import.meta.url), 'utf8')
    .replace("import { env } from 'cloudflare:workers';", 'const env = globalThis.__budgetTestEnv;')
    .replace("'@/lib/envelope-balances'", JSON.stringify(new URL('../lib/envelope-balances.ts', import.meta.url).href));
  const route = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`);
  const request = (method, body, query = '') => new Request(`http://test/api/budget${query}`, { method, headers: { 'x-household-pin': 'test-pin', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const post = body => route.POST(request('POST', body));
  const get = async month => (await route.GET(request('GET', null, `?month=${month}`))).json();
  assert.equal((await post({ kind: 'expense', personId: 'person', categoryId: 'a', amount: 120, note: 'Food', date: '2026-01-02' })).status, 201);
  assert.equal((await post({ kind: 'transfer', fromCategoryId: 'b', toCategoryId: 'a', amount: 10, date: '2026-01-03' })).status, 201);
  let january = await get('2026-01');
  assert.equal(january.categories.find(c => c.id === 'a').transferred, 10);
  assert.equal(january.expenses.reduce((sum, expense) => sum + expense.amount, 0), 120);
  assert.equal(january.incomes[0].amount, 200);
  let february = await get('2026-02');
  assert.equal(february.categories.find(c => c.id === 'a').carryover, -10);
  assert.equal(february.categories.find(c => c.id === 'b').carryover, 90);
  assert.equal((await route.DELETE(request('DELETE', null, `?kind=transfer&id=${january.transfers[0].id}&month=2026-01`))).status, 200);
  february = await get('2026-02');
  assert.equal(february.categories.find(c => c.id === 'a').carryover, -20);
  assert.equal((await post({ kind: 'transfer', fromCategoryId: 'a', toCategoryId: 'a', amount: 10, date: '2026-01-03' })).status, 400);
  assert.equal((await post({ kind: 'transfer', fromCategoryId: 'a', toCategoryId: 'missing', amount: 10, date: '2026-01-03' })).status, 404);
  assert.equal((await post({ kind: 'transfer', fromCategoryId: 'b', toCategoryId: 'a', amount: 5, date: '2026-01-03' })).status, 201);
  january = await get('2026-01');
  assert.equal((await post({ kind: 'finalize', month: '2026-01' })).status, 200);
  assert.equal((await post({ kind: 'transfer', fromCategoryId: 'b', toCategoryId: 'a', amount: 5, date: '2026-01-04' })).status, 409);
  assert.equal((await route.DELETE(request('DELETE', null, `?kind=transfer&id=${january.transfers[0].id}&month=2026-02`))).status, 409);
  assert.equal((await route.PUT(request('PUT', { kind: 'category', id: 'a', month: '2026-02', name: 'Groceries', color: '#2f7d64', monthlyLimit: 50 }))).status, 200);
  february = await get('2026-02');
  assert.equal(february.categories.find(c => c.id === 'a').carryover, -15);
  assert.equal(february.categories.find(c => c.id === 'a').monthlyLimit, 50);
  assert.equal((await get('2026-01')).categories.find(c => c.id === 'a').monthlyLimit, 100);
  database.close();
  delete globalThis.__budgetTestEnv;
});
