// GET /api/tle?group=stations -> CelesTrak TLEs, proxied (CelesTrak sends no CORS headers),
// cached 2 h (CelesTrak's update cadence / usage policy) with a 7-day stale backup.
import { cachedFetch } from '../_lib/cached.js';

const GROUPS = new Set(['stations', 'visual', 'weather', 'science', 'gnss', 'starlink', 'amateur', 'geo']);

export async function onRequestGet({ request, waitUntil }) {
  const group = new URL(request.url).searchParams.get('group') || 'visual';
  if (!GROUPS.has(group)) return new Response('unknown group', { status: 400 });
  return cachedFetch({
    key: `tle/${group}`,
    ttl: 7200,
    staleTtl: 7 * 86400,
    contentType: 'text/plain; charset=utf-8',
    waitUntil,
    validate: (t) => t.includes('\n1 ') && t.includes('\n2 '),
    fetcher: async () => {
      const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, { headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' } });
      return r.ok ? r.text() : null;
    },
  });
}
