// GET /api/satcat?id=25544 -> CelesTrak SATCAT record (owner, launch date/site, type, size…).
// Proxied (no CORS upstream), cached 1 day with a 30-day stale backup.
import { cachedFetch } from '../_lib/cached.js';

export async function onRequestGet({ request, waitUntil }) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^\d{1,9}$/.test(id)) return new Response('bad id', { status: 400 });
  return cachedFetch({
    key: `satcat/${id}`,
    ttl: 86400,
    staleTtl: 30 * 86400,
    contentType: 'application/json',
    waitUntil,
    validate: (t) => t.startsWith('{'),
    fetcher: async () => {
      const r = await fetch(`https://celestrak.org/satcat/records.php?CATNR=${id}&FORMAT=json`, { headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' } });
      if (!r.ok) return null;
      const rows = await r.json().catch(() => null);
      return Array.isArray(rows) && rows.length ? JSON.stringify(rows[0]) : null;
    },
  });
}
