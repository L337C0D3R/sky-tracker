// Two-level cache for upstream data (CelesTrak, JPL):
//  1. the local edge cache (per Cloudflare location), fresh for `ttl` seconds;
//  2. a global KV copy shared by every location, stamped with its download time.
// Order: edge cache → KV if younger than `ttl` → upstream → KV/edge backup of any age.
// So each data set is downloaded at most about once per `ttl` worldwide (CelesTrak's
// usage policy asks for this), and an upstream outage or rate limit never empties the sky.
export async function cachedFetch({ env, key, fetcher, validate, ttl, staleTtl, contentType, waitUntil }) {
  const cache = caches.default;
  const freshKey = new Request(`https://cache.internal/fresh/${key}`);
  const staleKey = new Request(`https://cache.internal/stale/${key}`);
  const kv = env?.CACHE_KV;
  const make = (b, maxAge, extra = {}) => new Response(b, {
    headers: { 'content-type': contentType, 'cache-control': `public, max-age=${maxAge}`, 'access-control-allow-origin': '*', ...extra },
  });

  const hit = await cache.match(freshKey);
  if (hit) return hit;

  let kvCopy = null;
  if (kv) {
    try { kvCopy = await kv.getWithMetadata(key); } catch { kvCopy = null; }
    const age = kvCopy?.value && kvCopy.metadata?.t ? (Date.now() - kvCopy.metadata.t) / 1000 : Infinity;
    if (age < ttl) {
      const left = Math.max(60, Math.round(ttl - age));
      waitUntil(cache.put(freshKey, make(kvCopy.value, left)));
      return make(kvCopy.value, left, { 'x-served-from': 'kv' });
    }
  }

  let body = null;
  try {
    body = await fetcher();
    if (body == null || (validate && !validate(body))) body = null;
  } catch {
    body = null;
  }
  if (body != null) {
    const jobs = [cache.put(freshKey, make(body, ttl)), cache.put(staleKey, make(body, staleTtl))];
    if (kv) jobs.push(kv.put(key, body, { metadata: { t: Date.now() }, expirationTtl: Math.max(staleTtl, 3600) }).catch(() => {}));
    waitUntil(Promise.all(jobs));
    return make(body, ttl);
  }
  if (kvCopy?.value) return make(kvCopy.value, 300, { 'x-served-from': 'kv-backup' });
  const stale = await cache.match(staleKey);
  if (stale) return make(await stale.text(), 300, { 'x-served-from': 'stale-backup' });
  return new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 502, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
}
