import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Execute the real route handlers and SQL against an isolated SQLite database.
const sqlite = new DatabaseSync(':memory:');
for (const name of readdirSync('drizzle').filter(n => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`drizzle/${name}`, 'utf8'));
function prepare(sql) {
  let args = [];
  return {
    bind(...values) { args = values; return this; },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
    async execute() { return { results: sqlite.prepare(sql).all(...args) }; },
  };
}
globalThis.budgetTestEnv = { DB: { prepare, async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.execute()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } };
const source = readFileSync('app/api/budget/route.ts', 'utf8').replace("import { env } from 'cloudflare:workers';", 'const env = globalThis.budgetTestEnv;');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const handlers = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
sqlite.prepare('INSERT INTO settings VALUES (1, ?)').run(createHash('sha256').update('test-pin').digest('hex'));
sqlite.exec("INSERT INTO people VALUES ('p', 'Alex', 0); INSERT INTO categories VALUES ('c', 'Food', 10000, '#2f7d64', 0); INSERT INTO categories VALUES ('d', 'Other', 0, '#2f7d64', 1);");
async function call(method, body, query = '') {
  return handlers[method](new Request(`http://localhost/api/budget${query}`, { method, headers: { 'x-household-pin': 'test-pin', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
}
const get = async month => (await call('GET', null, `?month=${month}`)).json();
const category = (month, amount) => call('PUT', { kind: 'category', id: 'c', month, name: 'Food', color: '#2f7d64', monthlyLimit: amount });

test('editing, year rollover, monthly allowances, and finalized history', async () => {
  assert.equal((await call('POST', { kind: 'expense', personId: 'p', categoryId: 'd', amount: 70, note: 'Market', date: '2025-12-10' })).status, 201);
  let december = await get('2025-12');
  const id = december.expenses[0].id;
  const edit = { kind: 'expense', id, personId: 'p', categoryId: 'c', amount: 80, note: 'Market', date: '2025-12-10' };
  assert.equal((await call('PUT', edit)).status, 200);
  december = await get('2025-12');
  assert.equal(december.expenses[0].amount, 80);
  assert.equal(december.expenses[0].categoryId, 'c');
  assert.equal((await get('2026-01')).categories[0].carryover, 20, 'December allowance counts exactly once');
  assert.equal((await category('2026-01', 50)).status, 200);
  assert.equal((await get('2025-12')).categories[0].monthlyLimit, 100);
  assert.equal((await get('2026-01')).categories[0].carryover, 20, 'new allowance must not rewrite prior rollover');
  assert.equal((await get('2026-02')).categories[0].monthlyLimit, 50, 'new allowance carries forward');
  assert.equal((await get('2026-02')).categories[0].carryover, 70);
  assert.equal((await call('POST', { kind: 'finalize', month: '2026-01' })).status, 200);
  assert.equal((await get('2025-12')).finalized, true);
  assert.equal((await category('2026-02', 25)).status, 200);
  assert.equal((await get('2026-01')).categories[0].monthlyLimit, 50);
  assert.equal((await get('2026-02')).categories[0].carryover, 70);
  assert.equal((await call('PUT', { ...edit, date: '2026-02-10' })).status, 409, 'cannot move a locked transaction out');
  assert.equal((await call('DELETE', null, `?kind=expense&id=${id}&month=2026-02`)).status, 409, 'query month cannot bypass lock');
  assert.equal((await category('2025-12', 5)).status, 409);
  assert.equal((await call('POST', { kind: 'income', personId: 'p', amount: 100, source: 'Pay', date: '2026-02-10' })).status, 201);
  const income = (await get('2026-02')).incomes[0];
  assert.equal((await call('PUT', { ...income, kind: 'income', amount: 150 })).status, 200);
  assert.equal((await get('2026-02')).incomes[0].amount, 150);
  assert.equal((await call('PUT', { ...income, kind: 'income', date: '2026-01-10' })).status, 409, 'cannot move a transaction into a locked month');
  for (const amount of ['not money', -1, 0]) assert.equal((await call('PUT', { ...income, kind: 'income', amount })).status, 400);
  assert.equal((await call('PUT', { ...income, kind: 'income', date: '2026-02-30' })).status, 400);
  assert.equal((await call('POST', { kind: 'finalize', month: '2026-13' })).status, 400);
  assert.equal((await call('POST', { kind: 'category', month: '2026-02', name: 'Pets', monthlyLimit: 30, color: '#2f7d64' })).status, 201);
  assert.equal((await get('2026-01')).categories.find(c => c.name === 'Pets').monthlyLimit, 0);
  assert.equal((await get('2026-02')).categories.find(c => c.name === 'Pets').carryover, 0, 'new categories do not gain fictional history');
});
