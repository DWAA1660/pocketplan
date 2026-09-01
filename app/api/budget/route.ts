import { env } from 'cloudflare:workers';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const cents = (value: unknown) => Math.round(Number(value) * 100);
const clean = (value: unknown, max = 80) => String(value || '').trim().slice(0, max);
async function hash(value: string) { const bytes = new TextEncoder().encode(value); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function authorized(request: Request) { const row = await env.DB.prepare('SELECT pin_hash AS pinHash FROM settings WHERE id = 1').first<{ pinHash: string }>(); return Boolean(row && row.pinHash === await hash(request.headers.get('x-household-pin') || '')); }
export async function GET(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  const [people, categories, incomes, expenses, history, startDate] = await env.DB.batch([
    env.DB.prepare('SELECT id, name FROM people ORDER BY position'),
    env.DB.prepare('SELECT id, name, monthly_limit_cents AS monthlyLimitCents, color FROM categories ORDER BY position'),
    env.DB.prepare("SELECT id, person_id AS personId, amount_cents AS amountCents, source, date FROM incomes WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT id, person_id AS personId, category_id AS categoryId, amount_cents AS amountCents, note, date FROM expenses WHERE substr(date,1,7) = ? ORDER BY date DESC").bind(month),
    env.DB.prepare("SELECT category_id AS categoryId, substr(date,1,7) AS month, SUM(amount_cents) AS spentCents FROM expenses WHERE substr(date,1,7) < ? GROUP BY category_id, substr(date,1,7)").bind(month),
    env.DB.prepare("SELECT MIN(date) AS firstDate FROM (SELECT date FROM incomes UNION ALL SELECT date FROM expenses)"),
  ]);
  const firstMonth = String((startDate.results[0] as any)?.firstDate || month).slice(0, 7);
  const [targetYear, targetMonth] = month.split('-').map(Number);
  const [startYear, startMonth] = firstMonth.split('-').map(Number);
  const historyByCategory = new Map<string, Map<string, number>>();
  for (const row of history.results as any[]) { if (!historyByCategory.has(row.categoryId)) historyByCategory.set(row.categoryId, new Map()); historyByCategory.get(row.categoryId)!.set(row.month, Number(row.spentCents)); }
  const categoriesWithCarryover = (categories.results as any[]).map(r => {
    let balance = 0; const spentByMonth = historyByCategory.get(r.id) || new Map<string, number>();
    for (let y = startYear, m = startMonth; y < targetYear || (y === targetYear && m < targetMonth); m += 1) { if (m > 12) { y += 1; m = 1; } balance = Math.max(0, balance + Number(r.monthlyLimitCents) - (spentByMonth.get(`${y}-${String(m).padStart(2, '0')}`) || 0)); }
    return { ...r, monthlyLimit: r.monthlyLimitCents / 100, carryover: balance / 100 };
  });
  return json({ people: people.results, categories: categoriesWithCarryover, incomes: incomes.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })), expenses: expenses.results.map((r: any) => ({ ...r, amount: r.amountCents / 100 })) });
}
export async function POST(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>; const newId = crypto.randomUUID();
  if (body.kind === 'income') {
    if (cents(body.amount) <= 0) return json({ error: 'Enter an amount greater than zero' }, 400);
    await env.DB.prepare('INSERT INTO incomes (id, person_id, amount_cents, source, date) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.personId), cents(body.amount), clean(body.source), clean(body.date, 10)).run();
  } else if (body.kind === 'expense') {
    if (cents(body.amount) <= 0) return json({ error: 'Enter an amount greater than zero' }, 400);
    await env.DB.prepare('INSERT INTO expenses (id, person_id, category_id, amount_cents, note, date) VALUES (?, ?, ?, ?, ?, ?)').bind(newId, clean(body.personId), clean(body.categoryId), cents(body.amount), clean(body.note), clean(body.date, 10)).run();
  } else if (body.kind === 'category') {
    const next = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM categories').first<{ position: number }>();
    await env.DB.prepare('INSERT INTO categories (id, name, monthly_limit_cents, color, position) VALUES (?, ?, ?, ?, ?)').bind(newId, clean(body.name), Math.max(0, cents(body.monthlyLimit)), clean(body.color, 12), next?.position || 0).run();
  } else return json({ error: 'Unknown entry type' }, 400);
  return json({ ok: true }, 201);
}
export async function DELETE(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const params = new URL(request.url).searchParams; const kind = params.get('kind'); const entryId = params.get('id');
  const table = kind === 'income' ? 'incomes' : kind === 'expense' ? 'expenses' : kind === 'category' ? 'categories' : '';
  if (!table || !entryId) return json({ error: 'Invalid request' }, 400);
  if (kind === 'category' && await env.DB.prepare('SELECT 1 FROM expenses WHERE category_id = ? LIMIT 1').bind(entryId).first()) return json({ error: 'This envelope has expenses. Remove them first.' }, 409);
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(entryId).run(); return json({ ok: true });
}
export async function PUT(request: Request) {
  if (!(await authorized(request))) return json({ error: 'Incorrect household PIN' }, 401);
  const body = await request.json() as Record<string, unknown>;
  if (body.kind !== 'category' || !clean(body.id, 64)) return json({ error: 'Invalid request' }, 400);
  const name = clean(body.name); const limit = cents(body.monthlyLimit); const color = clean(body.color, 12);
  if (!name) return json({ error: 'Enter an envelope name' }, 400);
  if (limit < 0) return json({ error: 'Enter a non-negative monthly amount' }, 400);
  const result = await env.DB.prepare('UPDATE categories SET name = ?, monthly_limit_cents = ?, color = ? WHERE id = ?').bind(name, limit, color, clean(body.id, 64)).run();
  if (!result.meta.changes) return json({ error: 'Envelope not found' }, 404);
  return json({ ok: true });
}
