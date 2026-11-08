import { Sky, enu } from './sky.js';
import { Orientation, wrap180, dot, load, save } from './orient.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = (az) => CARD[Math.round(az / 22.5) % 16];
const PLANET_COLORS = {
  Sun: '#ffd34d', Moon: '#ececec', Mercury: '#c9b99b', Venus: '#fff2c4', Mars: '#ff7a4d', Jupiter: '#f2d6ae',
  Saturn: '#ead68f', Uranus: '#9fe3ec', Neptune: '#7d98ff', Pluto: '#c9b29b',
};
const KIND_COLOR = { asteroid: '#c99bff', satellite: '#5ff0c4', star: '#ffffff' };

const sky = new Sky();
const orient = new Orientation();
const canvas = $('sky');
const ctx = canvas.getContext('2d');
const video = $('cam');

const state = {
  mode: 'map', // 'ar' | 'map'
  target: null,
  layers: load('layers', { constellations: true, starLabels: true, grid: false, satLabels: true }),
  satGroups: load('satGroups', ['stations', 'visual']),
  camFov: load('camFov', 64), // degrees across the camera's long side
  mapFov: 70, // degrees vertical in sky-map mode
  lastSlow: 0,
  lastFast: 0,
  located: false,
  locked: false,
  extraAt: 0,
  W: 0, H: 0, f: 1,
};

// ---------------- Startup ----------------
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

async function init() {
  resize();
  addEventListener('resize', resize);
  await sky.loadStatic();
  const saved = load('loc', null);
  if (saved) setLocation(saved.lat, saved.lon, saved.elev || 0, saved.label || 'saved location');
  else {
    // Approximate location from Cloudflare's edge until GPS answers.
    fetch('api/whereami').then((r) => r.json()).then((d) => {
      if (!state.located && d.lat != null) setLocation(d.lat, d.lon, 0, `${d.city || 'approx.'} (approx.)`);
    }).catch(() => { if (!state.located) setLocation(28.61, 77.21, 0, 'New Delhi (default)'); });
  }
  sky.refreshAsteroids();
  for (const g of state.satGroups) loadGroup(g);
  bindUI();
  requestAnimationFrame(frame);
}

function setLocation(lat, lon, elev, label) {
  sky.setLocation(lat, lon, elev);
  state.located = true;
  state.locLabel = label;
  $('loc').textContent = `${label} · ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  $('lat').value = lat.toFixed(4);
  $('lon').value = lon.toFixed(4);
  state.lastSlow = -1e9;
  state.extraAt = -1e9;
}

function startGps() {
  if (!navigator.geolocation) return toast('Geolocation not available');
  navigator.geolocation.watchPosition(
    (p) => {
      const { latitude: lat, longitude: lon, altitude } = p.coords;
      const prev = sky.observer;
      if (state.locLabel === 'GPS' && Math.abs(prev.latitude - lat) < 0.01 && Math.abs(prev.longitude - lon) < 0.01) return;
      setLocation(lat, lon, altitude || 0, 'GPS');
      save('loc', { lat, lon, elev: altitude || 0, label: 'GPS' });
    },
    (e) => toast(`Location: ${e.message}. Using approximate location; set it under Layers.`),
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 },
  );
}

async function loadGroup(g) {
  try {
    const n = await sky.loadSatGroup(g);
    $('satStatus').textContent = `${sky.satellites.length} satellites loaded`;
    state.lastFast = 0;
    return n;
  } catch (e) {
    $('satStatus').textContent = `Could not load ${g}: ${e.message}`;
  }
}

async function startAR() {
  $('splashMsg').textContent = 'Requesting permissions…';
  let sensorErr = null;
  try { await orient.start(); } catch (e) { sensorErr = e; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    toast(`Camera unavailable (${e.name}). Showing sky map instead.`);
    return startMap();
  }
  startGps();
  enter('ar');
  if (sensorErr) toast(sensorErr.message);
  try { await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  setTimeout(() => {
    if (!orient.hasSensor) toast('No motion sensor detected – drag to look around.', 5000);
    else if (!orient.absolute) toast('Compass not available – point at a known object and tap Align.', 6000);
  }, 2000);
}

function startMap() {
  startGps();
  enter('map');
}

function enter(mode) {
  state.mode = mode;
  $('splash').classList.add('hidden');
  ['hud', 'toolbar', 'crosshair'].forEach((id) => $(id).classList.remove('hidden'));
  orient.mode = mode === 'ar' ? 'sensor' : 'manual';
  state.arSince = performance.now();
  if (mode === 'map' && orient.basis) Object.assign(orient.view, orient.pointing());
  video.style.display = mode === 'ar' ? 'block' : 'none';
  $('modeLabel').textContent = mode === 'ar' ? 'Map' : 'AR';
  $('fov').value = state.camFov;
  $('fovVal').textContent = state.camFov;
  $('yaw').value = orient.yawOffset;
  $('yawVal').textContent = orient.yawOffset.toFixed(1);
}

// ---------------- Projection ----------------
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2.5);
  state.W = innerWidth;
  state.H = innerHeight;
  canvas.width = Math.round(state.W * dpr);
  canvas.height = Math.round(state.H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function focal() {
  const { W, H } = state;
  if (state.mode === 'ar' && video.videoWidth) {
    // object-fit: cover — scale the video's own focal length to the screen.
    const vw = video.videoWidth, vh = video.videoHeight;
    const fv = (Math.max(vw, vh) / 2) / Math.tan((state.camFov / 2) * D2R);
    return fv * Math.max(W / vw, H / vh);
  }
  if (state.mode === 'ar') return (Math.max(W, H) / 2) / Math.tan((state.camFov / 2) * D2R);
  return (H / 2) / Math.tan((state.mapFov / 2) * D2R);
}

let B; // current basis
function project(e) {
  const z = dot(e, B.fwd);
  if (z <= 0.05) return null;
  const x = dot(e, B.right), y = dot(e, B.up);
  return [state.W / 2 + (state.f * x) / z, state.H / 2 - (state.f * y) / z];
}
const onScreen = (p, m = 40) => p && p[0] > -m && p[1] > -m && p[0] < state.W + m && p[1] < state.H + m;

// ---------------- Render loop ----------------
function frame(now) {
  requestAnimationFrame(frame);
  if (!state.located) return;
  const date = new Date();
  if (now - state.lastSlow > 1000) { sky.updateSlow(date); state.lastSlow = now; }
  if (now - state.lastFast > 100) { sky.updateFast(date); state.lastFast = now; }
  if (state.mode === 'ar' && orient.mode === 'manual' && orient.hasSensor) orient.mode = 'sensor';
  if (state.mode === 'ar' && orient.mode === 'sensor' && !orient.raw && now - state.arSince > 4000) orient.mode = 'manual';
  B = orient.update();
  state.f = focal();
  draw();
  hud(date, now);
}

function bvColor(bv) {
  if (bv < 0) return '#a9bfff';
  if (bv < 0.3) return '#d4e0ff';
  if (bv < 0.6) return '#f8f7ff';
  if (bv < 1.0) return '#fff2df';
  if (bv < 1.4) return '#ffd7a8';
  return '#ffb46b';
}

function draw() {
  const { W, H } = state;
  ctx.clearRect(0, 0, W, H);
  const ar = state.mode === 'ar';
  if (!ar) {
    const s = sky.sunAlt ?? -30;
    const k = Math.max(0, Math.min(1, (s + 12) / 18));
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgb(${5 + 40 * k},${8 + 70 * k},${18 + 130 * k})`);
    g.addColorStop(1, `rgb(${10 + 60 * k},${16 + 90 * k},${36 + 140 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const zoom = Math.max(0.7, Math.min(2.2, state.f / 700));

  drawGround(ar);
  if (state.layers.grid) drawGrid();
  if (state.layers.constellations) drawConstellations();

  // Stars
  const magLimit = ar ? 4.6 : Math.min(6, 4.2 + (state.f / 900) * 1.2);
  ctx.textAlign = 'left';
  for (const s of sky.stars) {
    if (s.mag > magLimit) break; // sorted by magnitude
    if (s.alt < -2 && ar) continue;
    const p = project(s.e);
    if (!onScreen(p, 4)) continue;
    const r = Math.max(0.55, (magLimit + 1 - s.mag) * 0.5) * zoom;
    ctx.fillStyle = bvColor(s.bv);
    ctx.globalAlpha = s.alt < 0 ? 0.35 : 1;
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
    if (state.layers.starLabels && s.name && s.mag < (ar ? 2.2 : 2.6 + (state.f / 1500))) {
      label(s.name, p[0] + r + 4, p[1] + 4, 'rgba(220,230,255,.75)', 11.5);
    }
  }
  ctx.globalAlpha = 1;

  // Asteroids
  for (const a of sky.asteroids) {
    const p = project(a.e);
    if (!onScreen(p)) continue;
    ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = KIND_COLOR.asteroid; ctx.lineWidth = 1.5; ctx.globalAlpha = a.alt < 0 ? 0.45 : 1;
    ctx.strokeRect(-4, -4, 8, 8); ctx.restore();
    label(a.name, p[0] + 8, p[1] + 4, KIND_COLOR.asteroid, 12, a.alt < 0 ? 0.5 : 1);
  }
  ctx.globalAlpha = 1;

  // Satellites
  const many = sky.satellites.length > 600;
  for (const s of sky.satellites) {
    if (s.alt < 0 || s.dead) continue;
    const p = project(s.e);
    if (!onScreen(p)) continue;
    const station = s.type === 'Space station';
    ctx.fillStyle = s.sunlit ? KIND_COLOR.satellite : '#3c6f63';
    const sz = station ? 6 : many ? 2.4 : 3.5;
    ctx.fillRect(p[0] - sz / 2, p[1] - sz / 2, sz, sz);
    if (state.layers.satLabels && (station || (!many && s.sunlit) || s === state.target)) {
      label(shortSat(s.name), p[0] + 6, p[1] - 4, s.sunlit ? '#8ff5d6' : '#5f9c8c', 11.5);
    }
  }

  // Planets, Sun, Moon
  for (const pl of sky.planets) {
    const p = project(pl.e);
    if (!onScreen(p, 60)) continue;
    const col = PLANET_COLORS[pl.name];
    const big = pl.name === 'Sun' || pl.name === 'Moon';
    const r = big ? Math.max(9, state.f * 0.0047) : Math.max(3, 5.5 - (pl.mag ?? 5) * 0.5) * zoom;
    ctx.globalAlpha = pl.alt < 0 ? 0.45 : 1;
    if (pl.name === 'Moon') drawMoon(p, r, pl.moonPhase);
    else {
      ctx.shadowColor = col; ctx.shadowBlur = big ? 22 : 10;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      if (pl.name === 'Saturn') {
        ctx.strokeStyle = col; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(p[0], p[1], r * 2.1, r * 0.7, -0.35, 0, 7); ctx.stroke();
      }
    }
    label(pl.name, p[0] + r + 5, p[1] + 5, col, 14, pl.alt < 0 ? 0.55 : 1, true);
    ctx.globalAlpha = 1;
  }

  drawTarget();
}

function shortSat(n) {
  return n.replace(/\s+DEB$/, ' debris').replace(/\s+/g, ' ').trim();
}

function label(text, x, y, color, size = 12, alpha = 1, bold = false) {
  ctx.globalAlpha = alpha;
  ctx.font = `${bold ? 600 : 500} ${size}px system-ui, sans-serif`;
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.65)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

function drawMoon(p, r, phaseAngle) {
  // phaseAngle: 0 new, 90 first quarter, 180 full, 270 last quarter
  ctx.fillStyle = '#2a2d33'; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
  const k = Math.cos(phaseAngle * D2R); // 1 new .. -1 full
  const waxing = phaseAngle < 180;
  ctx.fillStyle = '#ececec';
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, -Math.PI / 2, Math.PI / 2, !waxing);
  ctx.ellipse(p[0], p[1], Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === waxing);
  ctx.fill();
}

function polyline(points, close = false) {
  let started = false;
  ctx.beginPath();
  for (const e of points) {
    const p = project(e);
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
  }
  if (close) ctx.closePath();
  ctx.stroke();
}

function drawGround(ar) {
  if (!ar) {
    // Fill below the horizon with small quads (robust to any view direction).
    ctx.fillStyle = 'rgba(9, 22, 15, 0.9)';
    ctx.beginPath();
    for (let alt = 0; alt > -90; alt -= 15) {
      for (let az = 0; az < 360; az += 6) {
        const q = [enu(az, alt), enu(az + 6.5, alt), enu(az + 6.5, alt - 15.5), enu(az, alt - 15.5)].map(project);
        if (q.some((p) => !p)) continue;
        ctx.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
        ctx.closePath();
      }
    }
    ctx.fill();
  }
  const ring = [];
  for (let az = 0; az <= 360; az += 2) ring.push(enu(az, 0));
  ctx.strokeStyle = ar ? 'rgba(120, 255, 170, .7)' : 'rgba(110, 200, 140, .8)';
  ctx.lineWidth = 1.5;
  polyline(ring);
  for (let az = 0; az < 360; az += 45) {
    const p = project(enu(az, 0));
    if (!onScreen(p)) continue;
    const name = cardinal(az);
    label(name, p[0] - (name.length * 4.5), p[1] - 8, az === 0 ? '#ff7b7b' : '#bdf5cf', name.length === 1 ? 17 : 13, 1, true);
  }
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(120,150,255,.16)';
  ctx.lineWidth = 1;
  for (let alt = 15; alt < 90; alt += 15) {
    const ring = [];
    for (let az = 0; az <= 360; az += 3) ring.push(enu(az, alt));
    polyline(ring);
  }
  for (let az = 0; az < 360; az += 15) {
    const m = [];
    for (let alt = 0; alt <= 90; alt += 3) m.push(enu(az, alt));
    polyline(m);
  }
}

function drawConstellations() {
  for (const c of sky.constellations) {
    ctx.strokeStyle = state.mode === 'ar' ? 'rgba(140,180,255,.38)' : 'rgba(120,160,255,.3)';
    ctx.lineWidth = 1;
    for (const seg of c.segs) {
      ctx.beginPath();
      let pen = false;
      for (const pt of seg) {
        const p = project(pt.e);
        if (!p) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    }
    if (state.f > 450) {
      const p = project(c.labelE);
      if (onScreen(p, 0)) {
        ctx.textAlign = 'center';
        label(c.name.toUpperCase(), p[0], p[1], 'rgba(150,175,255,.45)', 10);
        ctx.textAlign = 'left';
      }
    }
  }
}

function drawTarget() {
  const t = state.target;
  if (!t) return;
  const { W, H } = state;
  const e = t.e;
  const z = dot(e, B.fwd), x = dot(e, B.right), y = dot(e, B.up);
  const p = project(e);
  const now = performance.now();
  if (onScreen(p, -30)) {
    const pulse = 18 + Math.sin(now / 250) * 3;
    ctx.strokeStyle = state.locked ? '#3ddc97' : '#ffb547';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p[0], p[1], pulse, 0, 7); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(p[0] + Math.cos(a) * (pulse + 4), p[1] + Math.sin(a) * (pulse + 4));
      ctx.lineTo(p[0] + Math.cos(a) * (pulse + 12), p[1] + Math.sin(a) * (pulse + 12));
      ctx.stroke();
    }
    if (t.kind === 'satellite') drawSatTrack(t);
  } else {
    // Off-screen: arrow at the screen edge pointing the way to turn.
    let ang = Math.atan2(-y, x);
    if (z < 0 && Math.hypot(x, y) < 0.05) ang = -Math.PI / 2;
    const card = $('target').getBoundingClientRect();
    const top = 96, bottom = Math.min(H - 90, card.top || H) - 40;
    const cx = W / 2, cy = (top + bottom) / 2;
    const rx = W / 2 - 46, ry = (bottom - top) / 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    const k = Math.min(Math.abs(rx / (c || 1e-6)), Math.abs(ry / (s || 1e-6)));
    const ax = cx + c * k, ay = cy + s * k;
    ctx.save();
    ctx.translate(ax, ay); ctx.rotate(ang);
    ctx.fillStyle = '#ffb547'; ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
    const bob = Math.sin(now / 200) * 4;
    ctx.beginPath(); ctx.moveTo(18 + bob, 0); ctx.lineTo(-10 + bob, -14); ctx.lineTo(-4 + bob, 0); ctx.lineTo(-10 + bob, 14); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.textAlign = 'center';
    label(t.name.length > 18 ? `${t.name.slice(0, 17)}…` : t.name, ax - c * 42, ay - s * 30 + 4, '#ffd391', 12.5, 1, true);
    ctx.textAlign = 'left';
  }
}

function drawSatTrack(s) {
  // Path ±3 min to show direction of travel.
  if (!s._trackAt || performance.now() - s._trackAt > 2000) {
    s._track = sky.trackPoints ? sky.trackPoints(s) : null;
    s._trackAt = performance.now();
  }
  if (!s._track) return;
  ctx.strokeStyle = 'rgba(95,240,196,.55)'; ctx.setLineDash([4, 5]); ctx.lineWidth = 1.5;
  polyline(s._track);
  ctx.setLineDash([]);
}

// ---------------- HUD + target card ----------------
function fmtTime(d) { return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
function fmtDist(o) {
  if (o.kind === 'satellite') return `${Math.round(o.range).toLocaleString()} km`;
  if (o.name === 'Moon') return `${Math.round(o.dist * 149597870.7).toLocaleString()} km`;
  if (o.kind === 'star') return '—';
  return o.dist < 0.1 ? `${Math.round(o.dist * 149597870.7).toLocaleString()} km` : `${o.dist.toFixed(3)} AU`;
}

function hud(date, now) {
  const pt = orient.pointing();
  $('heading').textContent = `${Math.round(pt.az)}° ${cardinal(pt.az)}`;
  const src = state.mode === 'ar' ? (orient.mode === 'sensor' ? (orient.absolute ? 'compass' : 'gyro (relative)') : 'drag') : 'sky map';
  $('sub').textContent = `alt ${pt.alt.toFixed(0)}° · ${src}${orient.yawOffset ? ` · cal ${orient.yawOffset > 0 ? '+' : ''}${orient.yawOffset.toFixed(1)}°` : ''}`;
  $('clock').textContent = date.toLocaleTimeString();

  const t = state.target;
  if (!t) return;
  const dAz = wrap180(t.az - pt.az), dAlt = t.alt - pt.alt;
  const sep = Math.acos(Math.max(-1, Math.min(1, dot(t.e, B.fwd)))) / D2R;
  const locked = sep < 2.5;
  if (locked && !state.locked && navigator.vibrate) navigator.vibrate(60);
  state.locked = locked;
  const g = $('tGuide');
  g.classList.toggle('locked', locked);
  if (locked) g.textContent = `✓ On target (${sep.toFixed(1)}° off)`;
  else {
    const parts = [];
    if (Math.abs(dAz) > 1.5 && Math.abs(pt.alt) < 85) parts.push(`${dAz > 0 ? '→ Turn right' : '← Turn left'} ${Math.abs(dAz).toFixed(0)}°`);
    if (Math.abs(dAlt) > 1.5) parts.push(`${dAlt > 0 ? '↑ Tilt up' : '↓ Tilt down'} ${Math.abs(dAlt).toFixed(0)}°`);
    g.textContent = parts.join('  ·  ') || `${sep.toFixed(0)}° away`;
  }
  const stats = [
    ['Azimuth', `${t.az.toFixed(2)}° ${cardinal(t.az)}`],
    ['Altitude', `<span class="${t.alt > 0 ? 'up' : 'down'}">${t.alt.toFixed(2)}°</span>`],
    ['Distance', fmtDist(t)],
  ];
  if (t.mag != null && Number.isFinite(t.mag)) stats.push(['Magnitude', t.mag.toFixed(1)]);
  if (t.kind === 'satellite') {
    stats.push(['Height', `${Math.round(t.height)} km`], ['Speed', `${t.speed?.toFixed(2)} km/s`]);
  }
  if (t.ra != null) stats.push(['RA / Dec', `${t.ra.toFixed(2)}h ${t.dec >= 0 ? '+' : ''}${t.dec.toFixed(1)}°`]);
  $('tStats').innerHTML = stats.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');

  if (now - state.extraAt > 30000) {
    state.extraAt = now;
    $('tExtra').textContent = extraInfo(t, date);
  }
}

function extraInfo(t, date) {
  const bits = [];
  if (t.kind === 'planet') {
    const rs = sky.riseSet(t, date);
    if (rs) bits.push(`Rises ${fmtTime(rs.rise)} · Sets ${fmtTime(rs.set)}`);
    if (t.name === 'Moon' && t.phase != null) bits.push(`${Math.round(t.phase * 100)}% illuminated`);
  } else if (t.kind === 'satellite') {
    const age = (date - t.epoch) / 86400000;
    if (t.alt > 0) bits.push(`Above your horizon now. ${t.sunlit ? 'Sunlit' : 'In Earth’s shadow (not visible)'}${t.sunlit && sky.sunAlt < -6 ? ', sky is dark: look for a moving point of light' : ''}.`);
    else {
      const np = sky.nextPass(t, date);
      bits.push(np?.start ? `Next pass ${fmtTime(np.start)}, max ${np.peak.toFixed(0)}° at ${fmtTime(np.peakT)}` : 'No pass above 10° in the next 24 h');
    }
    bits.push(`NORAD ${t.norad} · TLE age ${age.toFixed(1)} d`);
  } else if (t.kind === 'asteroid') {
    bits.push(`Orbit: a=${t.el.a.toFixed(3)} AU, e=${t.el.e.toFixed(3)}, i=${t.el.i.toFixed(1)}°`);
    if (t.mag > 6.5) bits.push(t.mag > 12 ? 'Too faint to see without a large telescope' : 'Needs binoculars or a telescope');
  } else if (t.kind === 'star') {
    if (t.con) bits.push(`In ${t.con}`);
  }
  if (t.alt < 0) bits.unshift('Below the horizon right now.');
  return bits.join(' · ');
}

function selectTarget(o) {
  state.target = o;
  state.extraAt = -1e9;
  state.locked = false;
  $('target').classList.toggle('hidden', !o);
  if (!o) return;
  $('tName').textContent = o.kind === 'satellite' ? shortSat(o.name) : o.name;
  $('tType').textContent = o.type + (o.kind === 'satellite' ? ` · ${o.group}` : '');
  $('tGoto').classList.toggle('hidden', orient.mode === 'sensor');
  $('tAlign').classList.toggle('hidden', orient.mode !== 'sensor');
  if (orient.mode === 'manual') centerOn(o);
}

function centerOn(o) {
  orient.view.az = o.az;
  orient.view.alt = Math.max(-30, Math.min(89, o.alt));
}

// Satellite ground track in the sky (±3 min).
sky.trackPoints = (s) => {
  const out = [];
  const t0 = Date.now();
  const save = { az: s.az, alt: s.alt, e: s.e, range: s.range, sunlit: s.sunlit, height: s.height, speed: s.speed };
  const tmp = { ...s };
  const keep = sky.satellites;
  sky.satellites = [tmp];
  for (let dt = -180; dt <= 180; dt += 10) {
    sky.updateFast(new Date(t0 + dt * 1000));
    out.push(tmp.e);
  }
  sky.satellites = keep;
  Object.assign(s, save);
  return out;
};

// ---------------- Search ----------------
let filter = 'up';
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  let items = sky.objects.filter((o) => !o.dead);
  const score = (o) => {
    const n = o.name.toLowerCase();
    if (n === q || o.norad === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[^a-z0-9]+/).includes(q)) return 2;
    return n.includes(q) ? 3 : 9;
  };
  if (q) items = items.filter((o) => score(o) < 9);
  else if (filter === 'up') items = items.filter((o) => o.alt > 0);
  if (filter !== 'up' && filter !== 'all') items = items.filter((o) => o.kind === filter);
  const rank = { planet: 0, asteroid: 1, satellite: 2, star: 3 };
  items.sort((a, b) => (q ? score(a) - score(b) : 0) || (q && a.norad && b.norad ? a.norad - b.norad : 0) || (b.alt > 0) - (a.alt > 0) || rank[a.kind] - rank[b.kind] || (a.mag ?? 99) - (b.mag ?? 99) || a.name.localeCompare(b.name));
  items = items.slice(0, 150);
  $('list').innerHTML = items.map((o, i) => {
    const col = o.kind === 'planet' ? PLANET_COLORS[o.name] : o.kind === 'star' ? bvColor(o.bv) : KIND_COLOR[o.kind];
    return `<li data-i="${i}"><span class="dot" style="background:${col}"></span>
      <span class="nm"><b>${escapeHtml(o.kind === 'satellite' ? shortSat(o.name) : o.name)}</b><span class="muted small">${o.type}${o.mag != null && Number.isFinite(o.mag) ? ` · mag ${o.mag.toFixed(1)}` : ''}</span></span>
      <span class="pos"><span class="${o.alt > 0 ? 'up' : 'down'}">${o.alt > 0 ? '▲' : '▼'} ${o.alt.toFixed(0)}°</span><br><span class="muted">${Math.round(o.az)}° ${cardinal(o.az)}</span></span></li>`;
  }).join('') || '<li class="muted">Nothing matches.</li>';
  $('list').onclick = (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (!li) return;
    selectTarget(items[+li.dataset.i]);
    $('search').classList.add('hidden');
  };
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- UI wiring ----------------
function bindUI() {
  $('startAR').onclick = startAR;
  $('startMap').onclick = startMap;
  $('btnSearch').onclick = () => {
    $('settings').classList.add('hidden');
    $('search').classList.remove('hidden');
    renderList();
  };
  $('sClose').onclick = () => $('search').classList.add('hidden');
  $('q').oninput = renderList;
  $('chips').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    [...$('chips').children].forEach((c) => c.classList.toggle('on', c === b));
    renderList();
  };
  $('btnSettings').onclick = () => { $('search').classList.add('hidden'); $('settings').classList.toggle('hidden'); };
  $('setClose').onclick = () => $('settings').classList.add('hidden');
  $('tClose').onclick = () => selectTarget(null);
  $('tGoto').onclick = () => state.target && centerOn(state.target);
  $('tAlign').onclick = () => alignOn(state.target);
  $('btnCal').onclick = () => {
    if (orient.mode !== 'sensor') return toast('Calibration is for AR mode with motion sensors.');
    const t = state.target;
    if (t && t.alt > 0) return alignOn(t);
    const bright = sky.planets.filter((p) => p.alt > 5 && (p.name === 'Moon' || p.name === 'Sun' || p.mag < 0));
    toast(bright.length
      ? `Select ${bright.map((b) => b.name).join(' or ')} (Find), put it in the centre circle, then tap Align.`
      : 'Select a bright star you can see (Find), put it in the centre circle, then tap Align.', 6000);
  };
  $('btnMode').onclick = async () => {
    if (state.mode === 'ar') enter('map');
    else if (video.srcObject) enter('ar');
    else await startAR();
  };

  for (const cb of document.querySelectorAll('[data-layer]')) {
    cb.checked = !!state.layers[cb.dataset.layer];
    cb.onchange = () => { state.layers[cb.dataset.layer] = cb.checked; save('layers', state.layers); };
  }
  for (const cb of document.querySelectorAll('[data-sat]')) {
    const g = cb.dataset.sat;
    cb.checked = state.satGroups.includes(g);
    cb.onchange = async () => {
      if (cb.checked) { state.satGroups.push(g); $('satStatus').textContent = `Loading ${g}…`; await loadGroup(g); }
      else {
        state.satGroups = state.satGroups.filter((x) => x !== g);
        sky.dropSatGroup(g);
        if (state.target?.group === g) selectTarget(null);
        $('satStatus').textContent = `${sky.satellites.length} satellites loaded`;
      }
      save('satGroups', state.satGroups);
    };
  }
  $('fov').oninput = (e) => { state.camFov = +e.target.value; $('fovVal').textContent = state.camFov; save('camFov', state.camFov); };
  $('yaw').oninput = (e) => { orient.yawOffset = +e.target.value; $('yawVal').textContent = orient.yawOffset.toFixed(1); save('yawOffset', orient.yawOffset); };
  $('calReset').onclick = () => { orient.resetCalibration(); $('yaw').value = 0; $('yawVal').textContent = '0.0'; toast('Calibration reset'); };
  $('locSet').onclick = () => {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return toast('Enter a valid latitude and longitude');
    setLocation(lat, lon, 0, 'Manual');
    save('loc', { lat, lon, elev: 0, label: 'Manual' });
    toast('Location updated');
  };
  $('locGps').onclick = () => { try { localStorage.removeItem('loc'); } catch { /* */ } state.locLabel = ''; startGps(); };

  // Drag / zoom / tap-to-select on the sky canvas.
  const pointers = new Map();
  let dragStart = null, pinch0 = null, moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    dragStart = { x: e.clientX, y: e.clientY, az: orient.view.az, alt: orient.view.alt };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: state.mapFov };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && pinch0) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (orient.mode === 'manual') state.mapFov = Math.max(10, Math.min(120, pinch0.fov * (pinch0.d / d)));
      moved = true;
      return;
    }
    if (!dragStart || orient.mode !== 'manual') return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    const degPerPx = 1 / (state.f * D2R);
    orient.view.az = (dragStart.az - dx * degPerPx + 360) % 360;
    orient.view.alt = Math.max(-60, Math.min(89.9, dragStart.alt + dy * degPerPx));
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = null;
    if (!moved && pointers.size === 0 && dragStart) pick(e.clientX, e.clientY);
    if (pointers.size === 0) dragStart = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); dragStart = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (orient.mode === 'manual') state.mapFov = Math.max(10, Math.min(120, state.mapFov * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (orient.mode !== 'manual' || e.target.tagName === 'INPUT') return;
    const k = { ArrowLeft: [-3, 0], ArrowRight: [3, 0], ArrowUp: [0, 3], ArrowDown: [0, -3] }[e.key];
    if (k) { orient.view.az = (orient.view.az + k[0] + 360) % 360; orient.view.alt = Math.max(-60, Math.min(89.9, orient.view.alt + k[1])); }
  });
}

function pick(x, y) {
  let best = null, bd = 30;
  const cands = [...sky.planets, ...sky.asteroids, ...sky.satellites.filter((s) => s.alt > 0), ...sky.stars.filter((s) => s.name && s.mag < 4.5)];
  for (const o of cands) {
    const p = project(o.e);
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - y) - (o.kind === 'planet' ? 6 : 0);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) selectTarget(best);
}

function alignOn(t) {
  if (!t) return;
  if (orient.mode !== 'sensor') return toast('Alignment works in AR mode with motion sensors.');
  if (t.alt < 0) return toast(`${t.name} is below the horizon. Pick an object you can actually see.`);
  orient.calibrateTo(t.az);
  $('yaw').value = orient.yawOffset;
  $('yawVal').textContent = orient.yawOffset.toFixed(1);
  toast(`Compass aligned on ${t.name} (offset ${orient.yawOffset.toFixed(1)}°)`);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
init().catch((e) => { console.error(e); toast(`Failed to start: ${e.message}`, 10000); });
