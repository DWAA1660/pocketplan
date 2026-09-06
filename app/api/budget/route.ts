import { env } from 'cloudflare:workers';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const cents = (value: unknown) => Math.round(Number(value) * 100);
const validMonth = (value: string) => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
const validDate = (value: string) => validMonth(value.slice(0, 7)) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validAmount = (value: unknown, minimum = 1) => Number.isSafeInteger(cents(value)) && cents(value) >= minimum;
const clean = (value: unknown, max = 80) => String(value || '').trim().slice(0, max);
async function hash(value: string) { const bytes = new TextEncoder().encode(value); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function authorized(request: Request) { const row = await env.DB.prepare('SELECT pin_hash AS pinHash FROM settings WHERE id = 1').first<{ pinHash: string }>(); return Boolean(row && row.pinHash === await hash(request.headers.get('x-household-pin') || '')); }
async function monthIsFinalized(month: string) { const row = await env.DB.prepare('SELECT finalized FROM budget_months WHERE finalized = 1 AND month >= ? LIMIT 1').bind(month).first<{ finalized: number }>(); return Boolean(row?.finalized); }
export async function GET(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return json({ error: 'Choose a valid month' }, 400);
  const [people, categories, incomes, expenses, history, startDate, monthState, limitHistory] = await env.DB.batch([
    env.DB.prepare('SELECT id, name FROM people ORDER BY position'),
    env.DB.prepare('SELECT c.id, c.name, c.monthly_limit_cents AS baseLimitCents, COALESCE((SELECT limit_cents FROM category_monthly_limits WHERE category_id = c.id AND month <= ? ORDER BY month DESC LIMIT 1), c.monthly_limit_cents) AS monthlyLimitCents, color FROM categories c ORDER BY c.position').bind(month),
    env.DB.prepare("SELECT id, person_id AS personId, amount_cents AS amountCents, source, date FROM incomes WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT id, person_id AS personId, category_id AS categoryId, amount_cents AS amountCents, note, date FROM expenses WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT category_id AS categoryId, substr(date,1,7) AS month, SUM(amount_cents) AS spentCents FROM expenses WHERE substr(date,1,7) < ? GROUP BY category_id, substr(date,1,7)").bind(month),
    env.DB.prepare("SELECT MIN(date) AS firstDate FROM (SELECT date FROM incomes UNION ALL SELECT date FROM expenses UNION ALL SELECT month || '-01' AS date FROM category_monthly_limits)"),
    env.DB.prepare('SELECT finalized FROM budget_months WHERE finalized = 1 AND month >= ? LIMIT 1').bind(month),
    env.DB.prepare('SELECT category_id AS categoryId, month, limit_cents AS limitCents FROM category_monthly_limits'),
  ]);
  const firstMonth = String((startDate.results[0] as any)?.firstDate || month).slice(0, 7);
  const [targetYear, targetMonth] = month.split('-').map(Number);
  const [startYear, startMonth] = firstMonth.split('-').map(Number);
  const historyByCategory = new Map<string, Map<string, number>>();
  const limitsByCategory = new Map<string, Map<string, number>>();
  for (const row of history.results as any[]) { if (!historyByCategory.has(row.categoryId)) historyByCategory.set(row.categoryId, new Map()); historyByCategory.get(row.categoryId)!.set(row.month, Number(row.spentCents)); }
  for (const row of limitHistory.results as any[]) { if (!limitsByCategory.has(row.categoryId)) limitsByCategory.set(row.categoryId, new Map()); limitsByCategory.get(row.categoryId)!.set(row.month, Number(row.limitCents)); }
  const categoriesWithCarryover = (categories.results as any[]).map(r => {
    let balance = 0; const spentByMonth = historyByCategory.get(r.id) || new Map<string, number>();
    const limits = limitsByCategory.get(r.id) || new Map<string, number>();
    let allowance = Number(r.baseLimitCents);
    // Walk integer month indexes so December never accidentally includes January twice.
    for (let index = startYear * 12 + startMonth - 1; index < targetYear * 12 + targetMonth - 1; index++) {
      const priorMonth = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
      allowance = limits.get(priorMonth) ?? allowance;
      balance = Math.max(0, balance + allowance - (spentByMonth.get(priorMonth) || 0));
    }
    return { ...r, monthlyLimit: r.monthlyLimitCents / 100, carryover: balance / 100 };
  });
  return json({ month, finalized: Boolean((monthState.results[0] as any)?.finalized), people: people.results, categories: categoriesWithCarryover, incomes: incomes.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })), expenses: expenses.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })) });
}
export async function POST(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>; const newId = crypto.randomUUID();
  if (body.kind === 'finalize') {
    const month = clean(body.month, 7);
    if (!validMonth(month)) return json({ error: 'Choose a valid month' }, 400);
    if (await monthIsFinalized(month)) return json({ error: 'This month is already finalized' }, 409);
    const categories = await env.DB.prepare('SELECT c.id, COALESCE((SELECT limit_cents FROM category_monthly_limits WHERE category_id = c.id AND month <= ? ORDER BY month DESC LIMIT 1), c.monthly_limit_cents) AS limitCents FROM categories c').bind(month).all<{ id: string; limitCents: number }>();
    const statements = [env.DB.prepare('INSERT INTO budget_months (month, finalized, finalized_at) VALUES (?, 1, ?) ON CONFLICT(month) DO UPDATE SET finalized = 1, finalized_at = excluded.finalized_at').bind(month, new Date().toISOString()), ...categories.results.map(c => env.DB.prepare('INSERT OR REPLACE INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, COALESCE((SELECT limit_cents FROM category_monthly_limits WHERE category_id = ? AND month = ?), ?))').bind(crypto.randomUUID(), c.id, month, c.id, month, c.limitCents))];
    await env.DB.batch(statements);
    return json({ ok: true, finalized: true });
  }
  if (body.kind === 'income') {
    if (!validAmount(body.amount)) return json({ error: 'Enter an amount greater than zero' }, 400);
    const date = clean(body.date, 10); if (!validDate(date)) return json({ error: 'Choose a valid date' }, 400); if (await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    await env.DB.prepare('INSERT INTO incomes (id, person_id, amount_cents, source, date) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.personId), cents(body.amount), clean(body.source), date).run();
  } else if (body.kind === 'expense') {
    if (!validAmount(body.amount)) return json({ error: 'Enter an amount greater than zero' }, 400);
    const date = clean(body.date, 10); if (!validDate(date)) return json({ error: 'Choose a valid date' }, 400); if (await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    await env.DB.prepare('INSERT INTO expenses (id, person_id, category_id, amount_cents, note, date) VALUES (?, ?, ?, ?, ?, ?)').bind(newId, clean(body.personId), clean(body.categoryId), cents(body.amount), clean(body.note), date).run();
  } else if (body.kind === 'category') {
    const month = clean(body.month, 7); if (!validMonth(month)) return json({ error: 'Choose a valid month' }, 400); if (await monthIsFinalized(month)) return json({ error: 'This month is finalized and locked' }, 409);
    if (!clean(body.name) || !validAmount(body.monthlyLimit, 0)) return json({ error: 'Enter a name and a non-negative allowance' }, 400);
    const next = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM categories').first<{ position: number }>();
    await env.DB.batch([env.DB.prepare('INSERT INTO categories (id, name, monthly_limit_cents, color, position) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.name), 0, clean(body.color, 12), next?.position || 0),
    env.DB.prepare('INSERT INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), newId, month, cents(body.monthlyLimit)),
    ]);
  } else return json({ error: 'Unknown entry type' }, 400);
  return json({ ok: true }, 201);
}
export async function DELETE(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const params = new URL(request.url).searchParams; const kind = params.get('kind'); const entryId = params.get('id'); const requestedMonth = params.get('month') || '';
  const table = kind === 'income' ? 'incomes' : kind === 'expense' ? 'expenses' : kind === 'category' ? 'categories' : '';
  if (!table || !entryId) return json({ error: 'Invalid request' }, 400);
  const entry = kind === 'income' ? await env.DB.prepare('SELECT date FROM incomes WHERE id = ?').bind(entryId).first<{ date: string }>() : kind === 'expense' ? await env.DB.prepare('SELECT date FROM expenses WHERE id = ?').bind(entryId).first<{ date: string }>() : null;
  const lockedMonth = entry?.date?.slice(0, 7) || requestedMonth;
  if (kind !== 'category' && !entry) return json({ error: 'Transaction not found' }, 404);
  if (kind === 'category' && await env.DB.prepare('SELECT 1 FROM budget_months WHERE finalized = 1 LIMIT 1').first()) return json({ error: 'Envelopes cannot be deleted after a month is finalized. Set a future allowance to zero instead.' }, 409);
  if (lockedMonth && await monthIsFinalized(lockedMonth)) return json({ error: 'This month is finalized and locked' }, 409);
  if (kind === 'category' && await env.DB.prepare('SELECT 1 FROM expenses WHERE category_id = ? LIMIT 1').bind(entryId).first()) return json({ error: 'This envelope has expenses. Remove them first.' }, 409);
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(entryId).run(); return json({ ok: true });
}
export async function PUT(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>;
  if (body.kind === 'income' || body.kind === 'expense') {
    const table = body.kind === 'income' ? 'incomes' : 'expenses';
    const id = clean(body.id, 64);
    const entry = await env.DB.prepare(`SELECT date FROM ${table} WHERE id = ?`).bind(id).first<{ date: string }>();
    if (!entry) return json({ error: 'Transaction not found' }, 404);
    const date = clean(body.date, 10);
    if (!validDate(date) || !validAmount(body.amount)) return json({ error: 'Enter a valid date and an amount greater than zero' }, 400);
    if (await monthIsFinalized(entry.date.slice(0, 7)) || await monthIsFinalized(date.slice(0, 7))) return json({ error: 'This month is finalized and locked' }, 409);
    if (!await env.DB.prepare('SELECT id FROM people WHERE id = ?').bind(clean(body.personId)).first()) return json({ error: 'Choose a household member' }, 400);
    if (body.kind === 'expense') {
      if (!await env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(clean(body.categoryId)).first()) return json({ error: 'Choose an envelope' }, 400);
      await env.DB.prepare('UPDATE expenses SET person_id = ?, category_id = ?, amount_cents = ?, note = ?, date = ? WHERE id = ?').bind(clean(body.personId), clean(body.categoryId), cents(body.amount), clean(body.note), date, id).run();
    } else {
      await env.DB.prepare('UPDATE incomes SET person_id = ?, amount_cents = ?, source = ?, date = ? WHERE id = ?').bind(clean(body.personId), cents(body.amount), clean(body.source), date, id).run();
    }
    return json({ ok: true });
  }
  if (body.kind !== 'category' || !clean(body.id, 64)) return json({ error: 'Invalid request' }, 400);
  const month = clean(body.month, 7); if (!validMonth(month)) return json({ error: 'Choose a valid month' }, 400); if (await monthIsFinalized(month)) return json({ error: 'This month is finalized and locked' }, 409);
  const name = clean(body.name); const limit = cents(body.monthlyLimit); const color = clean(body.color, 12);
  if (!name) return json({ error: 'Enter an envelope name' }, 400);
  if (!validAmount(body.monthlyLimit, 0)) return json({ error: 'Enter a non-negative monthly amount' }, 400);
  const categoryId = clean(body.id, 64);
  const result = await env.DB.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').bind(name, color, categoryId).run();
  if (!result.meta.changes) return json({ error: 'Envelope not found' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM category_monthly_limits WHERE category_id = ? AND month = ?').bind(categoryId, month),
    env.DB.prepare('INSERT INTO category_monthly_limits (id, category_id, month, limit_cents) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), categoryId, month, limit),
  ]);
  return json({ ok: true });
}
