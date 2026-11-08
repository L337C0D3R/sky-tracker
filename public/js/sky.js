// Ephemeris engine: turns catalogue data + time + observer into topocentric
// azimuth/altitude for planets, stars, asteroids and satellites.
import * as A from '../vendor/astronomy.js';
import * as S from '../vendor/satellite.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const C_AU_PER_DAY = 173.1446326846693;

// ENU unit vector (x=east, y=north, z=up) from az (clockwise from N) / alt, degrees.
export function enu(az, alt) {
  const a = az * D2R, h = alt * D2R, c = Math.cos(h);
  return [Math.sin(a) * c, Math.cos(a) * c, Math.sin(h)];
}

// Saemundsson/Bennett-style refraction in degrees for a true altitude.
function refraction(alt) {
  if (alt < -1) return 0;
  return 1.02 / 60 / Math.tan((alt + 10.3 / (alt + 5.11)) * D2R);
}

export class Sky {
  constructor() {
    this.observer = new A.Observer(0, 0, 0);
    this.objects = []; // all trackable objects
    this.stars = [];
    this.constellations = [];
    this.satellites = [];
    this.asteroids = [];
    this.satGroups = new Map();
  }

  setLocation(lat, lon, elevM = 0) {
    this.observer = new A.Observer(lat, lon, elevM);
    this.gd = { latitude: lat * D2R, longitude: lon * D2R, height: elevM / 1000 };
  }

  // ---------- Catalogues ----------
  async loadStatic() {
    const [stars, cons, ast] = await Promise.all([
      fetch('data/stars.json').then((r) => r.json()),
      fetch('data/constellations.json').then((r) => r.json()),
      fetch('data/asteroids.json').then((r) => r.json()),
    ]);
    this.stars = stars.map(([ra, dec, mag, bv, ly, name, con]) => ({
      kind: 'star',
      type: 'Star',
      name: name || null,
      con,
      ly: ly || null, // distance in light-years
      mag,
      bv,
      v: A.VectorFromSphere(new A.Spherical(dec, ra, 1), A.MakeTime(new Date())),
      az: 0, alt: -90, e: [0, 0, -1],
    }));
    this.constellations = cons.map((c) => ({
      ...c,
      labelV: A.VectorFromSphere(new A.Spherical(c.label[1], c.label[0], 1), A.MakeTime(new Date())),
      segs: c.lines.map((seg) => seg.map(([ra, dec]) => ({
        v: A.VectorFromSphere(new A.Spherical(dec, ra, 1), A.MakeTime(new Date())),
        e: [0, 0, -1],
      }))),
      labelE: [0, 0, -1],
    }));
    this.setAsteroids(ast.bodies);

    const planets = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
    this.planets = planets.map((p) => ({
      kind: 'planet',
      type: p === 'Sun' ? 'Star (our Sun)' : p === 'Moon' ? 'Moon' : p === 'Pluto' ? 'Dwarf planet' : 'Planet',
      name: p,
      body: A.Body[p],
      az: 0, alt: -90, e: [0, 0, -1],
    }));
    this.rebuildIndex();
  }

  setAsteroids(bodies) {
    this.asteroids = bodies.map((b) => ({ kind: 'asteroid', type: b.kind, name: b.name, el: b, az: 0, alt: -90, e: [0, 0, -1] }));
    this.rebuildIndex();
  }

  async refreshAsteroids() {
    try {
      const r = await fetch('api/asteroids');
      if (!r.ok) return;
      const d = await r.json();
      if (d.bodies?.length >= this.asteroids.length * 0.8) this.setAsteroids(d.bodies);
    } catch { /* offline / local dev: keep baked elements */ }
  }

  async loadSatGroup(group, refresh = false) {
    if (this.satGroups.has(group) && !refresh) return this.satGroups.get(group).length;
    const r = await fetch(`api/tle?group=${group}`, refresh ? { cache: 'no-cache' } : undefined);
    if (!r.ok) throw new Error(`TLE ${group}: ${r.status}`);
    const lines = (await r.text()).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    const sats = [];
    const old = new Map((this.satGroups.get(group) || []).map((s) => [s.norad, s]));
    const seen = new Set(this.satellites.filter((s) => s.group !== group).map((s) => s.norad));
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const [n, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
      if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
      const norad = l1.slice(2, 7).trim();
      if (seen.has(norad)) continue;
      seen.add(norad);
      const satrec = S.twoline2satrec(l1, l2);
      const name = n.trim();
      const epoch = new Date((satrec.jdsatepoch - 2440587.5) * 86400000);
      const prev = old.get(norad);
      if (prev) { // keep the same object (it may be the selected target), swap in the fresh orbit
        Object.assign(prev, { satrec, epoch, dead: false });
        sats.push(prev);
        continue;
      }
      sats.push({
        kind: 'satellite',
        type: /STARLINK/.test(name) ? 'Starlink satellite' : /ISS|CSS|TIANHE|TIANGONG/.test(name) ? 'Space station' : 'Satellite',
        name, norad, satrec, group, az: 0, alt: -90, e: [0, 0, -1], epoch,
      });
    }
    this.satGroups.set(group, sats);
    this.tleLoadedAt = Date.now();
    this.satellites = [...this.satGroups.values()].flat();
    this.rebuildIndex();
    return sats.length;
  }

  dropSatGroup(group) {
    this.satGroups.delete(group);
    this.satellites = [...this.satGroups.values()].flat();
    this.rebuildIndex();
  }

  rebuildIndex() {
    this.objects = [
      ...(this.planets || []),
      ...this.asteroids,
      ...this.satellites,
      ...this.stars.filter((s) => s.name),
    ];
  }

  // ---------- Updates ----------
  // Slow update (~1 Hz): planets, stars, asteroids, constellations.
  updateSlow(date) {
    const t = A.MakeTime(date);
    const obs = this.observer;
    this.time = t;
    const rot = A.Rotation_EQJ_HOR(t, obs);
    this.rotHor = rot;
    const sunHor = this._planet(A.Body.Sun, t);
    this.sunAlt = sunHor.alt;
    this.sunEqj = A.GeoVector(A.Body.Sun, t, true);

    for (const p of this.planets) {
      const h = p.body === A.Body.Sun ? sunHor : this._planet(p.body, t);
      Object.assign(p, h);
      try {
        const il = A.Illumination(p.body, t);
        p.mag = il.mag;
        p.phase = il.phase_fraction;
      } catch { p.mag = undefined; }
      if (p.name === 'Moon') p.moonPhase = A.MoonPhase(t);
    }

    for (const s of this.stars) this._star(s, rot);
    for (const c of this.constellations) {
      c.labelE = this._dir(c.labelV, rot);
      for (const seg of c.segs) for (const pt of seg) pt.e = this._dir(pt.v, rot);
    }

    const earth = A.HelioVector(A.Body.Earth, t);
    const obsVec = A.ObserverVector(t, obs, false);
    for (const a of this.asteroids) this._asteroid(a, t, earth, obsVec, rot);
  }

  // Satellites: SGP4 for `list` at `date`. Called every animation frame for the
  // satellites near/above the horizon, and twice a second for the full catalogue.
  updateFast(date, list = this.satellites) {
    if (!this.gd || !list.length) return;
    const gmst = S.gstime(date);
    const sun = this.sunEqj; // AU, EQJ ~ TEME for a shadow test
    const sl = sun ? Math.hypot(sun.x, sun.y, sun.z) : 1;
    const sh = sun ? [sun.x / sl, sun.y / sl, sun.z / sl] : [1, 0, 0];
    const tMs = date.getTime();
    for (const s of list) {
      const pv = S.propagate(s.satrec, date);
      if (!pv || !pv.position) { s.alt = -90; s.dead = true; continue; }
      const p = pv.position;
      const look = S.ecfToLookAngles(this.gd, S.eciToEcf(p, gmst));
      s.az = look.azimuth * R2D;
      s.alt = look.elevation * R2D;
      // Range rate (km/s, + = receding), smoothed over successive updates.
      if (s._t && tMs - s._t > 40 && tMs - s._t < 5000) {
        const rr = (look.rangeSat - s._r) / ((tMs - s._t) / 1000);
        s.rangeRate = s.rangeRate == null ? rr : s.rangeRate + (rr - s.rangeRate) * 0.3;
      }
      if (!s._t || tMs - s._t > 40) { s._t = tMs; s._r = look.rangeSat; }
      s.range = look.rangeSat;
      const geo = S.eciToGeodetic(p, gmst);
      s.lat = S.degreesLat(geo.latitude);
      s.lon = S.degreesLong(geo.longitude);
      s.e = enu(s.az, s.alt);
      // Cylindrical Earth-shadow test.
      const d = p.x * sh[0] + p.y * sh[1] + p.z * sh[2];
      const perp = Math.hypot(p.x - d * sh[0], p.y - d * sh[1], p.z - d * sh[2]);
      s.sunlit = d > 0 || perp > 6378;
      s.height = Math.hypot(p.x, p.y, p.z) - 6371;
      if (pv.velocity) s.speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    }
  }

  _dir(v, rot) {
    const h = A.RotateVector(rot, v); // x=N, y=W, z=up
    return [-h.y, h.x, h.z];
  }

  _star(s, rot) {
    const r = rot.rot, v = s.v;
    const n = r[0][0] * v.x + r[1][0] * v.y + r[2][0] * v.z;
    const w = r[0][1] * v.x + r[1][1] * v.y + r[2][1] * v.z;
    const u = r[0][2] * v.x + r[1][2] * v.y + r[2][2] * v.z;
    let alt = Math.asin(Math.max(-1, Math.min(1, u))) * R2D;
    let az = Math.atan2(-w, n) * R2D;
    if (az < 0) az += 360;
    alt += refraction(alt);
    s.az = az; s.alt = alt; s.e = enu(az, alt);
  }

  _planet(body, t) {
    const eq = A.Equator(body, t, this.observer, true, true);
    const h = A.Horizon(t, this.observer, eq.ra, eq.dec, 'normal');
    return { az: h.azimuth, alt: h.altitude, ra: eq.ra, dec: eq.dec, dist: eq.dist, e: enu(h.azimuth, h.altitude) };
  }

  // Two-body Kepler propagation of today's osculating elements (sub-arcsecond over days).
  static helio(el, jdTdb) {
    const M = ((el.M + el.n * (jdTdb - el.epoch)) % 360) * D2R;
    let E = el.e < 0.8 ? M : Math.PI;
    for (let k = 0; k < 30; k++) {
      const dE = (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-12) break;
    }
    const xv = el.a * (Math.cos(E) - el.e);
    const yv = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const [O, w, i] = [el.node * D2R, el.peri * D2R, el.i * D2R];
    const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
    const cu = Math.cos(v + w), su = Math.sin(v + w);
    // Ecliptic J2000 -> EQJ (obliquity of J2000).
    const x = r * (Math.cos(O) * cu - Math.sin(O) * su * Math.cos(i));
    const y = r * (Math.sin(O) * cu + Math.cos(O) * su * Math.cos(i));
    const z = r * (su * Math.sin(i));
    const eps = 23.4392911 * D2R;
    return [x, y * Math.cos(eps) - z * Math.sin(eps), y * Math.sin(eps) + z * Math.cos(eps)];
  }

  _asteroid(a, t, earth, obsVec, rot) {
    const jd = t.tt + 2451545.0;
    let tau = 0, g;
    for (let k = 0; k < 3; k++) { // light-time iteration
      const h = Sky.helio(a.el, jd - tau);
      g = [h[0] - earth.x - obsVec.x, h[1] - earth.y - obsVec.y, h[2] - earth.z - obsVec.z];
      tau = Math.hypot(...g) / C_AU_PER_DAY;
    }
    const dist = Math.hypot(...g);
    const hor = A.RotateVector(rot, new A.Vector(g[0], g[1], g[2], t));
    const sph = A.HorizonFromVector(hor, 'normal');
    a.az = sph.lon; a.alt = sph.lat; a.dist = dist; a.e = enu(a.az, a.alt);
    // H-G magnitude
    const h = Sky.helio(a.el, jd - tau);
    const r = Math.hypot(...h);
    const cosPh = (r * r + dist * dist - Math.hypot(earth.x, earth.y, earth.z) ** 2) / (2 * r * dist);
    const ph = Math.acos(Math.max(-1, Math.min(1, cosPh)));
    const th = Math.tan(ph / 2);
    const phi1 = Math.exp(-3.33 * th ** 0.63), phi2 = Math.exp(-1.87 * th ** 1.22);
    a.mag = a.el.H + 5 * Math.log10(r * dist) - 2.5 * Math.log10((1 - a.el.G) * phi1 + a.el.G * phi2);
  }

  // ---------- Events ----------
  riseSet(obj, date) {
    if (obj.kind !== 'planet') return null;
    const t = A.MakeTime(date);
    const rise = A.SearchRiseSet(obj.body, this.observer, +1, t, 2);
    const set = A.SearchRiseSet(obj.body, this.observer, -1, t, 2);
    return { rise: rise?.date, set: set?.date };
  }

  // Next time a satellite climbs above 10° (scans 24 h in 30 s steps, then refines).
  nextPass(sat, date) {
    const gd = this.gd;
    const el = (d) => {
      const pv = S.propagate(sat.satrec, d);
      if (!pv?.position) return -90;
      return S.ecfToLookAngles(gd, S.eciToEcf(pv.position, S.gstime(d))).elevation * R2D;
    };
    const t0 = date.getTime();
    let prev = el(date);
    if (prev > 10) return { now: true };
    for (let s = 30; s < 86400; s += 30) {
      const d = new Date(t0 + s * 1000);
      const e = el(d);
      if (e > 10 && prev <= 10) {
        let start = d, peak = e, peakT = d;
        for (let k = 0; k < 40; k++) {
          const dd = new Date(d.getTime() + k * 15000);
          const ee = el(dd);
          if (ee > peak) { peak = ee; peakT = dd; }
          if (ee < 10) break;
        }
        return { start, peak, peakT };
      }
      prev = e;
    }
    return null;
  }
}
