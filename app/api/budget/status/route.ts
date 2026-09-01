import { env } from 'cloudflare:workers';
export async function GET() { return Response.json({ configured: Boolean(await env.DB.prepare('SELECT 1 FROM settings WHERE id = 1').first()) }); }
