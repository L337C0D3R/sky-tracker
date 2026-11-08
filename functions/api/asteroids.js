import { fetchAll } from '../_lib/horizons.js';

// GET /api/asteroids -> today's osculating elements from JPL Horizons, cached ~12h at the edge.
export async function onRequestGet(ctx) {
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = new Request(`https://cache.internal/asteroids/${day}`);
  const cache = caches.default;
  let res = await cache.match(cacheKey);
  if (res) return res;

  const data = await fetchAll(new Date());
  if (!data.bodies.length) {
    return Response.json({ error: 'Horizons unavailable' }, { status: 502 });
  }
  res = new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=43200',
      'access-control-allow-origin': '*',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
