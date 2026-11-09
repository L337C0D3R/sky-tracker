// Edge cache with a stale fallback. A fresh copy is served for `ttl` seconds; every
// successful upstream download also refreshes a long-lived backup (`staleTtl`). If the
// upstream fails or rate-limits us (CelesTrak does), the backup is served instead of an
// error, so visitors never see an empty sky because of an upstream hiccup.
export async function cachedFetch({ key, fetcher, validate, ttl, staleTtl, contentType, waitUntil }) {
  const cache = caches.default;
  const freshKey = new Request(`https://cache.internal/fresh/${key}`);
  const staleKey = new Request(`https://cache.internal/stale/${key}`);
  const hit = await cache.match(freshKey);
  if (hit) return hit;

  let body = null;
  try {
    body = await fetcher();
    if (body == null || (validate && !validate(body))) body = null;
  } catch {
    body = null;
  }
  const make = (b, maxAge, extra = {}) => new Response(b, {
    headers: { 'content-type': contentType, 'cache-control': `public, max-age=${maxAge}`, 'access-control-allow-origin': '*', ...extra },
  });
  if (body != null) {
    waitUntil(Promise.all([cache.put(freshKey, make(body, ttl)), cache.put(staleKey, make(body, staleTtl))]));
    return make(body, ttl);
  }
  const stale = await cache.match(staleKey);
  if (stale) return make(await stale.text(), 300, { 'x-served-from': 'stale-backup' });
  return new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 502, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
}
