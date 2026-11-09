// GET /api/asteroids -> today's osculating elements from JPL Horizons, cached 12 h,
// with a 7-day stale backup.
import { fetchAll } from '../_lib/horizons.js';
import { cachedFetch } from '../_lib/cached.js';

export async function onRequestGet({ env, waitUntil }) {
  const day = new Date().toISOString().slice(0, 10);
  return cachedFetch({
    env,
    key: `asteroids/${day}`,
    ttl: 43200,
    staleTtl: 7 * 86400,
    contentType: 'application/json',
    waitUntil,
    validate: (t) => { try { return JSON.parse(t).bodies.length > 0; } catch { return false; } },
    fetcher: async () => JSON.stringify(await fetchAll(new Date())),
  });
}
