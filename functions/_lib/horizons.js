// Fetches osculating heliocentric ecliptic (J2000) orbital elements from
// NASA/JPL Horizons. Shared by the Pages Function (live, cached daily) and the
// build script (bakes a fallback file into /public/data).

export const ASTEROIDS = [
  { id: '1', name: 'Ceres', kind: 'Dwarf planet', H: 3.34, G: 0.12 },
  { id: '2', name: 'Pallas', kind: 'Asteroid', H: 4.13, G: 0.11 },
  { id: '3', name: 'Juno', kind: 'Asteroid', H: 5.33, G: 0.32 },
  { id: '4', name: 'Vesta', kind: 'Asteroid', H: 3.2, G: 0.32 },
  { id: '10', name: 'Hygiea', kind: 'Asteroid', H: 5.43, G: 0.15 },
  { id: '16', name: 'Psyche', kind: 'Asteroid', H: 6.0, G: 0.2 },
  { id: '433', name: 'Eros', kind: 'Near-Earth asteroid', H: 10.4, G: 0.46 },
  { id: '25143', name: 'Itokawa', kind: 'Near-Earth asteroid', H: 19.2, G: 0.21 },
  { id: '65803', name: 'Didymos', kind: 'Near-Earth asteroid', H: 18.1, G: 0.2 },
  { id: '99942', name: 'Apophis', kind: 'Near-Earth asteroid', H: 19.09, G: 0.24 },
  { id: '101955', name: 'Bennu', kind: 'Near-Earth asteroid', H: 20.21, G: -0.08 },
  { id: '162173', name: 'Ryugu', kind: 'Near-Earth asteroid', H: 19.6, G: 0.13 },
];

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

export async function fetchElements(body, date = new Date()) {
  const start = isoDay(date);
  const stop = isoDay(new Date(date.getTime() + 86400000));
  const p = new URLSearchParams({
    format: 'json',
    COMMAND: `'${body.id};'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS',
    CENTER: "'500@10'",
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: "'1d'",
    REF_PLANE: 'ECLIPTIC',
    OUT_UNITS: "'AU-D'",
    CSV_FORMAT: 'YES',
  });
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`, {
    headers: { 'User-Agent': 'sky-tracker (Cloudflare Pages)' },
  });
  if (!res.ok) throw new Error(`Horizons ${res.status}`);
  const { result } = await res.json();
  const block = result.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!block) throw new Error(`Horizons: no data for ${body.name}`);
  // JDTDB, Cal, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
  const c = block.trim().split('\n')[0].split(',').map((s) => s.trim());
  return {
    ...body,
    epoch: +c[0], // JD (TDB)
    e: +c[2],
    i: +c[4],
    node: +c[5],
    peri: +c[6],
    n: +c[8], // deg/day
    M: +c[9], // deg at epoch
    a: +c[11], // AU
  };
}

export async function fetchAll(date = new Date()) {
  const out = [];
  // Sequential: Horizons dislikes bursts of parallel requests.
  for (const b of ASTEROIDS) {
    try {
      out.push(await fetchElements(b, date));
    } catch (e) {
      // skip this body; client merges with its baked fallback
    }
  }
  return { generated: new Date().toISOString(), source: 'NASA/JPL Horizons', bodies: out };
}
