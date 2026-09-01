import { env } from 'cloudflare:workers';
async function hash(value: string) { const bytes = new TextEncoder().encode(value); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function POST(request: Request) {
  if (await env.DB.prepare('SELECT 1 FROM settings WHERE id = 1').first()) return Response.json({ error: 'This household is already set up' }, { status: 409 });
  const body = await request.json() as { yourName?: string; partnerName?: string; pin?: string }; const pin = String(body.pin || ''); const yourName = String(body.yourName || '').trim().slice(0, 40); const partnerName = String(body.partnerName || '').trim().slice(0, 40);
  if (pin.length < 4 || !yourName || !partnerName) return Response.json({ error: 'Add both names and a PIN of at least 4 characters' }, { status: 400 });
  const categories: [string, number, string][] = [['Housing', 180000, '#2f7d64'], ['Groceries', 65000, '#e28555'], ['Transportation', 40000, '#d3ab41'], ['Dining & fun', 25000, '#6c7ecf'], ['Savings', 50000, '#b4607c']];
  await env.DB.batch([env.DB.prepare('INSERT INTO settings (id, pin_hash) VALUES (1, ?)').bind(await hash(pin)), env.DB.prepare('INSERT INTO people (id, name, position) VALUES (?, ?, 0)').bind(crypto.randomUUID(), yourName), env.DB.prepare('INSERT INTO people (id, name, position) VALUES (?, ?, 1)').bind(crypto.randomUUID(), partnerName), ...categories.map((c, i) => env.DB.prepare('INSERT INTO categories (id, name, monthly_limit_cents, color, position) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), c[0], c[1], c[2], i))]);
  return Response.json({ ok: true }, { status: 201 });
}
