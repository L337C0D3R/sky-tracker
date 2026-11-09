// Scheduled refresher: every 2 hours, download each satellite group from CelesTrak once
// and store it in the shared KV namespace the website reads from. Visitors are then served
// from KV, and CelesTrak sees one request per group per 2 hours (its usage policy).
const GROUPS = ['stations', 'visual', 'weather', 'science', 'gnss', 'amateur', 'starlink', 'geo'];

async function refresh(env) {
  const report = {};
  for (const g of GROUPS) {
    try {
      let text = null;
      for (const fmt of ['tle', '3le']) {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=${fmt}`, { headers: { 'User-Agent': 'sky-tracker refresher' } });
        const t = r.ok ? await r.text() : '';
        if (t.includes('\n1 ') && t.includes('\n2 ')) { text = t.replace(/^0 /gm, ''); break; }
      }
      if (text) {
        await env.CACHE_KV.put(`tle/${g}`, text, { metadata: { t: Date.now() }, expirationTtl: 7 * 86400 });
        report[g] = 'ok';
      } else report[g] = 'refused (kept previous copy)';
    } catch (e) {
      report[g] = `error: ${e.message}`;
    }
  }
  return report;
}

export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(refresh(env)); },
  async fetch() { return new Response('sky-tracker refresher: runs every 2 hours', { status: 200 }); },
};
