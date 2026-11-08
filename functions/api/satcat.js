// GET /api/satcat?id=25544 -> CelesTrak SATCAT record (owner, launch date/site, object type, size…).
// Proxied because CelesTrak sends no CORS headers; cached for a day.
export async function onRequestGet({ request, waitUntil }) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^\d{1,9}$/.test(id)) return new Response('bad id', { status: 400 });

  const cacheKey = new Request(`https://cache.internal/satcat/${id}`);
  const cache = caches.default;
  let res = await cache.match(cacheKey);
  if (res) return res;

  const upstream = await fetch(`https://celestrak.org/satcat/records.php?CATNR=${id}&FORMAT=json`, {
    headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' },
  });
  if (!upstream.ok) return new Response('upstream error', { status: 502 });
  const rows = await upstream.json().catch(() => null);
  if (!Array.isArray(rows) || !rows.length) return Response.json({ error: 'not found' }, { status: 404 });
  res = Response.json(rows[0], {
    headers: { 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
