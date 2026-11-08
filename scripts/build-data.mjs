// Builds the static catalogues in public/data:
//   stars.json          – HIP stars to mag 6 (d3-celestial, BSD-3) with proper names and
//                         distances in light-years (HYG database, CC BY-SA 4.0, from Hipparcos parallaxes)
//   constellations.json – stick figures + label positions
//   asteroids.json      – fallback orbital elements from JPL Horizons (live ones come from /api/asteroids)
// Usage: node scripts/build-data.mjs [--skip-stars]
import { writeFile } from 'node:fs/promises';
import { fetchAll } from '../functions/_lib/horizons.js';

const OUT = new URL('../public/data/', import.meta.url);
const SRC = 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@master/data/';
const get = async (f) => (await fetch(SRC + f)).json();
const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

if (!process.argv.includes('--skip-stars')) {
  const [stars, names, lines, cons, hyg] = await Promise.all([
    get('stars.6.json'),
    get('starnames.json'),
    get('constellations.lines.json'),
    get('constellations.json'),
    fetch('https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv').then((r) => r.text()),
  ]);
  // HIP id -> distance (light-years). HYG uses 100000 pc for "unknown".
  const rows = hyg.split('\n');
  const head = rows[0].replace(/"/g, '').split(',');
  const iHip = head.indexOf('hip'), iDist = head.indexOf('dist');
  const distLy = new Map();
  for (const line of rows.slice(1)) {
    const c = line.replace(/"/g, '').split(',');
    const hip = c[iHip], pc = parseFloat(c[iDist]);
    if (hip && pc > 0 && pc < 100000) distLy.set(hip, pc * 3.26156);
  }
  const list = stars.features
    .filter((f) => f.properties.mag <= 6)
    .map((f) => {
      let [ra, dec] = f.geometry.coordinates;
      if (ra < 0) ra += 360;
      const n = names[f.id] || {};
      const ly = distLy.get(String(f.id));
      const row = [r(ra, 4), r(dec, 4), r(f.properties.mag, 2), r(+f.properties.bv || 0.6, 2), ly ? (ly < 100 ? r(ly, 1) : Math.round(ly)) : 0];
      if (n.name) row.push(n.name, n.c || '');
      return row;
    })
    .sort((a, b) => a[2] - b[2]);
  await writeFile(new URL('stars.json', OUT), JSON.stringify(list));

  const label = Object.fromEntries(
    cons.features.map((f) => [f.id, { name: f.properties.name, at: f.properties.display || f.geometry.coordinates }]),
  );
  const cl = lines.features.map((f) => {
    const L = label[f.id] || {};
    let [lra, ldec] = L.at || [0, 0];
    if (lra < 0) lra += 360;
    return {
      id: f.id,
      name: L.name || f.id,
      label: [r(lra, 2), r(ldec, 2)],
      lines: f.geometry.coordinates.map((seg) => seg.map(([ra, dec]) => [r(ra < 0 ? ra + 360 : ra, 3), r(dec, 3)])),
    };
  });
  await writeFile(new URL('constellations.json', OUT), JSON.stringify(cl));
  console.log(`stars: ${list.length} (${list.filter((x) => x[4]).length} with distance), constellations: ${cl.length}`);
}

const ast = await fetchAll(new Date());
await writeFile(new URL('asteroids.json', OUT), JSON.stringify(ast, null, 1));
console.log(`asteroids: ${ast.bodies.length}`);
