import { env } from 'cloudflare:workers';
import { carryoverBalance } from '@/lib/envelope-balances';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const cents = (value: unknown) => Math.round(Number(value) * 100);
const clean = (value: unknown, max = 80) => String(value || '').trim().slice(0, max);
async function hash(value: string) { const bytes = new TextEncoder().encode(value); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function authorized(request: Request) { const row = await env.DB.prepare('SELECT pin_hash AS pinHash FROM settings WHERE id = 1').first<{ pinHash: string }>(); return Boolean(row && row.pinHash === await hash(request.headers.get('x-household-pin') || '')); }
async function monthIsFinalized(month: string) { const row = await env.DB.prepare('SELECT finalized FROM budget_months WHERE month = ?').bind(month).first<{ finalized: number }>(); return Boolean(row?.finalized); }
export async function GET(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  const [people, categories, incomes, expenses, history, startDate, monthState, limitHistory, transfers, transferHistory] = await env.DB.batch([
    env.DB.prepare('SELECT id, name FROM people ORDER BY position'),
    env.DB.prepare('SELECT c.id, c.name, c.monthly_limit_cents AS defaultLimitCents, COALESCE(ml.limit_cents, c.monthly_limit_cents) AS monthlyLimitCents, color FROM categories c LEFT JOIN category_monthly_limits ml ON ml.category_id = c.id AND ml.month = ? ORDER BY c.position').bind(month),
    env.DB.prepare("SELECT id, person_id AS personId, amount_cents AS amountCents, source, date FROM incomes WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT id, person_id AS personId, category_id AS categoryId, amount_cents AS amountCents, note, date FROM expenses WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT category_id AS categoryId, substr(date,1,7) AS month, SUM(amount_cents) AS spentCents FROM expenses WHERE substr(date,1,7) < ? GROUP BY category_id, substr(date,1,7)").bind(month),
    env.DB.prepare("SELECT MIN(date) AS firstDate FROM (SELECT date FROM incomes UNION ALL SELECT date FROM expenses UNION ALL SELECT date FROM envelope_transfers UNION ALL SELECT month || '-01' AS date FROM category_monthly_limits)"),
    env.DB.prepare('SELECT finalized FROM budget_months WHERE month = ?').bind(month),
    env.DB.prepare('SELECT category_id AS categoryId, month, limit_cents AS limitCents FROM category_monthly_limits'),
    env.DB.prepare('SELECT id, from_category_id AS fromCategoryId, to_category_id AS toCategoryId, amount_cents AS amountCents, note, date FROM envelope_transfers WHERE substr(date,1,7) = ? ORDER BY date DESC, rowid DESC').bind(month),
    env.DB.prepare("SELECT from_category_id AS fromCategoryId, to_category_id AS toCategoryId, amount_cents AS amountCents, substr(date,1,7) AS month FROM envelope_transfers WHERE substr(date,1,7) < ?").bind(month),
  ]);
  const firstMonth = String((startDate.results[0] as any)?.firstDate || month).slice(0, 7);
  const historyByCategory = new Map<string, Map<string, number>>();
  const limitsByCategory = new Map<string, Map<string, number>>();
  const transfersByCategory = new Map<string, Map<string, number>>();
  for (const row of transferHistory.results as any[]) {
    for (const [id, amount] of [[row.fromCategoryId, -Number(row.amountCents)], [row.toCategoryId, Number(row.amountCents)]] as [string, number][]) {
      if (!transfersByCategory.has(id)) transfersByCategory.set(id, new Map());
      const amounts = transfersByCategory.get(id)!; amounts.set(row.month, (amounts.get(row.month) || 0) + amount);
    }
  }
  for (const row of history.results as any[]) { if (!historyByCategory.has(row.categoryId)) historyByCategory.set(row.categoryId, new Map()); historyByCategory.get(row.categoryId)!.set(row.month, Number(row.spentCents)); }
  for (const row of limitHistory.results as any[]) { if (!limitsByCategory.has(row.categoryId)) limitsByCategory.set(row.categoryId, new Map()); limitsByCategory.get(row.categoryId)!.set(row.month, Number(row.limitCents)); }
  const categoriesWithCarryover = (categories.results as any[]).map(r => {
    const spentByMonth = historyByCategory.get(r.id) || new Map<string, number>();
    const limits = limitsByCategory.get(r.id) || new Map<string, number>();
    const balance = carryoverBalance(firstMonth, month, Number(r.defaultLimitCents), limits, spentByMonth, transfersByCategory.get(r.id) || new Map());
    const transferCents = (transfers.results as any[]).reduce((sum, t) => sum + (t.toCategoryId === r.id ? Number(t.amountCents) : 0) - (t.fromCategoryId === r.id ? Number(t.amountCents) : 0), 0);
    return { ...r, monthlyLimit: r.monthlyLimitCents / 100, carryover: balance / 100, transferred: transferCents / 100 };
  });
  return json({ month, finalized: Boolean((monthState.results[0] as any)?.finalized), people: people.results, categories: categoriesWithCarryover, transfers: transfers.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })), incomes: incomes.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })), expenses: expenses.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })) });
}
export async function POST(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>; const newId = crypto.randomUUID();
  if (body.kind === 'finalize') {
    const month = clean(body.month, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'Choose a valid month' }, 400);
    if (await monthIsFinalized(month)) return json({ error: 'This month is already finalized' }, 409);
    const categories = await env.DB.prepare('SELECT id, monthly_limit_cents AS limitCents FROM categories').all<{ id: string; limitCents: number }>();
    const statements = [env.DB.prepare('INSERT INTO budget_months (month, finalized, finalized_at) VALUES (?, 1, ?)').bind(month, new Date().toISOString()), ...categories.results.map(c => env.DB.prepare('INSERT OR REPLACE INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, COALESCE((SELECT limit_cents FROM category_monthly_limits WHERE category_id = ? AND month = ?), ?))').bind(crypto.randomUUID(), c.id, month, c.id, month, c.limitCents))];
    await env.DB.batch(statements);
    return json({ ok: true, finalized: true });
  }
  if (body.kind === 'transfer') {
    const amount = cents(body.amount); const date = clean(body.date, 10);
    const from = clean(body.fromCategoryId, 64); const to = clean(body.toCategoryId, 64);
    if (!Number.isSafeInteger(amount) || amount <= 0) return json({ error: 'Enter an amount greater than zero' }, 400);
    if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return json({ error: 'Choose a valid date' }, 400);
    if (!from || !to || from === to) return json({ error: 'Choose two different envelopes' }, 400);
    if (await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    const found = await env.DB.prepare('SELECT id FROM categories WHERE id IN (?, ?)').bind(from, to).all();
    if (found.results.length !== 2) return json({ error: 'Envelope not found' }, 404);
    await env.DB.prepare('INSERT INTO envelope_transfers (id, from_category_id, to_category_id, amount_cents, note, date) VALUES (?, ?, ?, ?, ?, ?)').bind(newId, from, to, amount, clean(body.note), date).run();
  } else if (body.kind === 'income') {
    if (cents(body.amount) <= 0) return json({ error: 'Enter an amount greater than zero' }, 400);
    const date = clean(body.date, 10); if (await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    await env.DB.prepare('INSERT INTO incomes (id, person_id, amount_cents, source, date) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.personId), cents(body.amount), clean(body.source), date).run();
  } else if (body.kind === 'expense') {
    if (cents(body.amount) <= 0) return json({ error: 'Enter an amount greater than zero' }, 400);
    const date = clean(body.date, 10); if (await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    await env.DB.prepare('INSERT INTO expenses (id, person_id, category_id, amount_cents, note, date) VALUES (?, ?, ?, ?, ?, ?)').bind(newId, clean(body.personId), clean(body.categoryId), cents(body.amount), clean(body.note), date).run();
  } else if (body.kind === 'category') {
    const month = clean(body.month, 7); if (await monthIsFinalized(month)) return json({ error: 'This month is finalized and locked' }, 409);
    const next = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM categories').first<{ position: number }>();
    await env.DB.prepare('INSERT INTO categories (id, name, monthly_limit_cents, color, position) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.name), Math.max(0, cents(body.monthlyLimit)), clean(body.color, 12), next?.position || 0).run();
    await env.DB.prepare('INSERT INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), newId, month, Math.max(0, cents(body.monthlyLimit))).run();
  } else return json({ error: 'Unknown entry type' }, 400);
  return json({ ok: true }, 201);
}
export async function DELETE(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const params = new URL(request.url).searchParams; const kind = params.get('kind'); const entryId = params.get('id'); const requestedMonth = params.get('month') || '';
  const table = kind === 'income' ? 'incomes' : kind === 'expense' ? 'expenses' : kind === 'transfer' ? 'envelope_transfers' : kind === 'category' ? 'categories' : '';
  if (!table || !entryId) return json({ error: 'Invalid request' }, 400);
  const entry = kind !== 'category' ? await env.DB.prepare(`SELECT date FROM ${table} WHERE id = ?`).bind(entryId).first<{ date: string }>() : null;
  const lockedMonth = entry?.date?.slice(0, 7) || requestedMonth;
  if (lockedMonth && await monthIsFinalized(lockedMonth)) return json({ error: 'This month is finalized and locked' }, 409);
  if (kind === 'category' && await env.DB.prepare('SELECT 1 FROM expenses WHERE category_id = ? LIMIT 1').bind(entryId).first()) return json({ error: 'This envelope has expenses. Remove them first.' }, 409);
  if (kind === 'category' && await env.DB.prepare('SELECT 1 FROM envelope_transfers WHERE from_category_id = ? OR to_category_id = ? LIMIT 1').bind(entryId, entryId).first()) return json({ error: 'This envelope has transfers. Remove them first.' }, 409);
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(entryId).run(); return json({ ok: true });
}
export async function PUT(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>;
  if (body.kind !== 'category' || !clean(body.id, 64)) return json({ error: 'Invalid request' }, 400);
  const month = clean(body.month, 7); if (await monthIsFinalized(month)) return json({ error: 'This month is finalized and locked' }, 409);
  const name = clean(body.name); const limit = cents(body.monthlyLimit); const color = clean(body.color, 12);
  if (!name) return json({ error: 'Enter an envelope name' }, 400);
  if (limit < 0) return json({ error: 'Enter a non-negative monthly amount' }, 400);
  const categoryId = clean(body.id, 64);
  const result = await env.DB.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').bind(name, color, categoryId).run();
  if (!result.meta.changes) return json({ error: 'Envelope not found' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM category_monthly_limits WHERE category_id = ? AND month = ?').bind(categoryId, month),
    env.DB.prepare('INSERT INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), categoryId, month, limit),
  ]);
  return json({ ok: true });
}
