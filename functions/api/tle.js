// GET /api/tle?group=stations -> CelesTrak TLEs, proxied (CelesTrak sends no CORS headers),
// cached 2 h (CelesTrak's update cadence / usage policy) with a 7-day stale backup.
import { cachedFetch } from '../_lib/cached.js';

const GROUPS = new Set(['stations', 'visual', 'weather', 'science', 'gnss', 'starlink', 'amateur', 'geo']);

export async function onRequestGet({ request, env, waitUntil }) {
  const group = new URL(request.url).searchParams.get('group') || 'visual';
  if (!GROUPS.has(group)) return new Response('unknown group', { status: 400 });
  return cachedFetch({
    env,
    key: `tle/${group}`,
    ttl: 7200,
    staleTtl: 7 * 86400,
    contentType: 'text/plain; charset=utf-8',
    waitUntil,
    validate: (t) => t.includes('\n1 ') && t.includes('\n2 '),
    // CelesTrak refuses a repeat download of the same query within ~2 h (it returns a
    // message instead of data). The 3LE format is a separate query with the same orbits.
    fetcher: async () => {
      for (const fmt of ['tle', '3le']) {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=${fmt}`, { headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' } });
        if (!r.ok) continue;
        const t = await r.text();
        if (t.includes('\n1 ') && t.includes('\n2 ')) return t.replace(/^0 /gm, '');
      }
      return null;
    },
  });
}
