// GET /api/tle?group=stations -> CelesTrak TLEs, proxied (CelesTrak sends no CORS
// headers) and cached for 2 hours, matching CelesTrak's update cadence/usage policy.
const GROUPS = new Set(['stations', 'visual', 'weather', 'science', 'gnss', 'starlink', 'amateur', 'geo']);

export async function onRequestGet({ request, waitUntil }) {
  const group = new URL(request.url).searchParams.get('group') || 'visual';
  if (!GROUPS.has(group)) return new Response('unknown group', { status: 400 });

  const cacheKey = new Request(`https://cache.internal/tle/${group}`);
  const cache = caches.default;
  let res = await cache.match(cacheKey);
  if (res) return res;

  const upstream = await fetch(
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
    { headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' } },
  );
  const text = await upstream.text();
  if (!upstream.ok || !text.includes('\n1 ')) {
    return new Response('upstream error', { status: 502 });
  }
  res = new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=7200',
      'access-control-allow-origin': '*',
    },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
