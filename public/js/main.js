import { Sky, enu } from './sky.js';
import { Orientation, wrap180, dot, load, save } from './orient.js';
import { initDetails, openDetails, closeDetails, updateLive, isOpen as detailsOpen } from './details.js';
import * as camctl from './camctl.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = (az) => CARD[Math.round(az / 22.5) % 16];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const PLANET_COLORS = {
  Sun: '#ffd34d', Moon: '#ececec', Mercury: '#c9b99b', Venus: '#fff2c4', Mars: '#ff7a4d', Jupiter: '#f2d6ae',
  Saturn: '#ead68f', Uranus: '#9fe3ec', Neptune: '#7d98ff', Pluto: '#c9b29b',
};
const SAT_COLORS = { station: '#ffe08a', starlink: '#9fd4ff', other: '#7ef0cf' };
const AST_COLOR = '#c99bff';
const DEFAULT_GROUPS = ['stations', 'starlink', 'visual'];
const ZOOM = { ar: [1, 10], map: [0.6, 40] };

const sky = new Sky();
const orient = new Orientation();
const canvas = $('sky');
const ctx = canvas.getContext('2d');
const tape = $('tape');
const tctx = tape.getContext('2d');
const video = $('cam');

const state = {
  mode: 'map', // 'ar' (camera) | 'map'
  target: null,
  layers: { constellations: true, starLabels: true, grid: false, satLabels: true, trails: true, ...load('layers', {}) },
  satGroups: load('satGroups.v2', DEFAULT_GROUPS),
  zoom: 1,
  lastSlow: -1e9,
  located: false,
  locked: false,
  extraAt: -1e9,
  W: 0, H: 0, f: 1,
};
const sat = { cursor: 0, building: [], near: [], vis: [] };
const cam = { stream: null, track: null, error: null };

// ---------------- Platform ----------------
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
document.documentElement.classList.toggle('ios', IS_IOS);
document.documentElement.classList.toggle('standalone', STANDALONE);

// Haptic tick. iPhone Safari has no Vibration API, but on iOS 18+ toggling a
// native <input switch> produces a system haptic.
function haptic(ms = 40) {
  if (navigator.vibrate) { navigator.vibrate(ms); return; }
  if (!IS_IOS) return;
  try {
    const label = document.createElement('label');
    label.ariaHidden = 'true';
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch { /* no haptics */ }
}

// Canvas roundRect arrived in Safari 16; keep iOS 15 working.
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
  };
}

// Stop Safari's page-level pinch/double-tap zoom; the sky has its own zoom.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

function syncFovUi() {
  const v = Math.round(camctl.fov());
  $('fov').value = v;
  $('fovVal').textContent = `${v}°`;
}

// ---------------- Helpers ----------------
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SAT_ALIASES = { 'ISS (ZARYA)': 'ISS', 'CSS (TIANHE)': 'Tiangong (CSS)' };
function satName(n) { return SAT_ALIASES[n] || n.replace(/\s+DEB$/, ' debris').replace(/\s+/g, ' ').trim(); }
function displayName(o) { return o.kind === 'satellite' ? satName(o.name) : o.name; }
function satClass(s) { return s.type === 'Space station' ? 'station' : s.type === 'Starlink satellite' ? 'starlink' : 'other'; }
function colorOf(o) {
  if (o.kind === 'planet') return PLANET_COLORS[o.name];
  if (o.kind === 'satellite') return SAT_COLORS[satClass(o)];
  if (o.kind === 'asteroid') return AST_COLOR;
  return bvColor(o.bv);
}
function bvColor(bv) {
  if (bv < 0) return '#a9bfff';
  if (bv < 0.3) return '#d4e0ff';
  if (bv < 0.6) return '#f8f7ff';
  if (bv < 1.0) return '#fff2df';
  if (bv < 1.4) return '#ffd7a8';
  return '#ffb46b';
}

// ---------------- Startup ----------------
async function init() {
  resize();
  addEventListener('resize', resize);
  splashStars();
  bindUI();
  camctl.initCamControls(video, $('camfx'), {
    onZoom: () => cssZoom(),
    onLens: () => { syncFovUi(); cssZoom(); },
    // Frames stopped arriving: restart the camera (at most every 15 s).
    onStall: async () => {
      if (state.mode !== 'ar' || document.hidden || Date.now() - (state.lastRestart || 0) < 15000) return;
      state.lastRestart = Date.now();
      try { await startCamera(true); } catch (e) { cam.error = e; showCamBanner(); }
    },
    // Camera works but the picture is nearly black (normal at night).
    onDark: () => {
      if (state.mode !== 'ar' || state.darkHinted) return;
      state.darkHinted = true;
      $('darkHint').classList.remove('hidden');
    },
  });
  camctl.setOpenHandler((id) => attachStream(() => camctl.open(id)));
  await sky.loadStatic();
  const consNames = Object.fromEntries(sky.constellations.map((c) => [c.id, c.name]));
  initDetails({
    sky, displayName, colorOf, cardinal, fmtDist, lightTime,
    consName: (id) => consNames[id] || id,
    onGuide: (o) => selectTarget(o, true),
    onShare: shareObject,
    linkFor,
    isIOS: IS_IOS,
  });
  applyLayers();
  openDeepLink();
  const saved = load('loc', null);
  if (saved) setLocation(saved.lat, saved.lon, saved.elev || 0, 'last GPS fix');
  else {
    fetch('api/whereami').then((r) => r.json()).then((d) => {
      if (!state.located && d.lat != null) setLocation(d.lat, d.lon, 0, `${d.city || 'approx.'} (approx.)`);
    }).catch(() => { if (!state.located) setLocation(28.61, 77.21, 0, 'New Delhi (default)'); });
  }
  sky.refreshAsteroids();
  // Small groups first so the ISS appears immediately, Starlink right after.
  const order = [...state.satGroups].sort((a, b) => (a === 'starlink') - (b === 'starlink'));
  (async () => { for (const g of order) await loadGroup(g); })();
  requestAnimationFrame(frame);

  // Camera already allowed on a previous visit → go straight to the live camera.
  try {
    const p = await navigator.permissions?.query({ name: 'camera' });
    if (p?.state === 'granted') startAR(false);
  } catch { /* Safari/Firefox: wait for the tap */ }
}

function setLocation(lat, lon, elev, label) {
  sky.setLocation(lat, lon, elev);
  state.located = true;
  state.locLabel = label;
  $('loc').textContent = `${label} · ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  $('lat').value = lat.toFixed(5);
  $('lon').value = lon.toFixed(5);
  state.lastSlow = -1e9;
  state.extraAt = -1e9;
}

let gpsWatch = null;
function startGps() {
  if (!navigator.geolocation) return toast('Geolocation not available');
  if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      const { latitude: lat, longitude: lon, altitude, accuracy } = p.coords;
      const prev = sky.observer;
      const acc = `GPS ±${accuracy < 1000 ? `${Math.round(accuracy)} m` : `${(accuracy / 1000).toFixed(1)} km`}`;
      $('locDot').classList.toggle('ok', accuracy < 100);
      if (IS_IOS && accuracy > 1500 && !state.preciseHinted) {
        state.preciseHinted = true;
        toast('Your location is approximate. Turn on Precise Location: Settings › Privacy & Security › Location Services › Safari Websites.', 8000);
      }
      const text = `${acc} · ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
      // ~100 m moves matter for low satellites; ignore jitter below that.
      if (state.locLabel?.startsWith('GPS') && Math.abs(prev.latitude - lat) < 0.001 && Math.abs(prev.longitude - lon) < 0.001) {
        state.locLabel = acc;
        $('loc').textContent = text;
        return;
      }
      setLocation(lat, lon, altitude || 0, acc);
      $('loc').textContent = text;
      save('loc', { lat, lon, elev: altitude || 0 });
    },
    (e) => toast(`Location: ${e.message}. Using approximate location; you can set it under Layers.`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

async function loadGroup(g) {
  try {
    const n = await sky.loadSatGroup(g);
    satStatus();
    sat.cursor = 0;
    return n;
  } catch (e) {
    $('satStatus').textContent = `Could not load ${g}: ${e.message}`;
  }
}
function satStatus() {
  const t = sky.tleLoadedAt ? new Date(sky.tleLoadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  $('satStatus').textContent = `${sky.satellites.length.toLocaleString()} satellites tracked live · orbit data ${t}, refreshed every 2 h`;
}
async function refreshTles() {
  for (const g of state.satGroups) {
    try { await sky.loadSatGroup(g, true); } catch { /* keep old elements */ }
  }
  satStatus();
}
setInterval(refreshTles, 2 * 3600 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && sky.tleLoadedAt && Date.now() - sky.tleLoadedAt > 2 * 3600 * 1000) refreshTles();
});

// ---------------- Sharing & deep links ----------------
const CARD_LONG = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };
function linkFor(o) {
  const key = o.kind === 'satellite' ? o.norad : o.name;
  return `${location.origin}${location.pathname}?t=${encodeURIComponent(key)}`;
}
async function shareObject(o) {
  const where = o.alt > 0 ? `${o.alt.toFixed(0)}° up in the ${CARD_LONG[cardinal(o.az)]}` : 'below the horizon';
  const text = `${displayName(o)} is ${where} right now, ${fmtDist(o)} away. Find it live with SkyTracker AR:`;
  const url = linkFor(o);
  try {
    if (navigator.share) { await navigator.share({ title: `${displayName(o)} · SkyTracker AR`, text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Link copied');
  } catch (e) { if (e.name !== 'AbortError') toast('Could not share'); }
}
// ?t=25544 (NORAD) or ?t=Jupiter opens that object's details once it's loaded.
function openDeepLink() {
  const key = new URLSearchParams(location.search).get('t');
  if (!key) return;
  let tries = 0;
  const attempt = () => {
    const k = key.toLowerCase();
    const o = /^\d+$/.test(key) ? sky.satellites.find((s) => s.norad === key)
      : sky.objects.find((x) => x.name.toLowerCase() === k || displayName(x).toLowerCase() === k);
    if (o && state.located) {
      sky.updateSlow(new Date());
      sky.updateFast(new Date(), sky.satellites.filter((s) => s === o));
      selectTarget(o, true);
      openDetails(o);
    } else if (++tries < 30) setTimeout(attempt, 1000);
  };
  setTimeout(attempt, 300);
}

// ---------------- Layers ----------------
function applyLayers() {
  document.body.classList.toggle('red', !!state.layers.red);
}

// ---------------- iPhone hints ----------------
function maybeShowInstallHint() {
  if (!IS_IOS || STANDALONE || load('iosHintDone', false)) return;
  setTimeout(() => {
    if (state.mode && !$('splash').classList.contains('hidden')) return;
    $('iosHint').classList.remove('hidden');
  }, 8000);
}

// ---------------- Camera ----------------
async function startCamera(force = false) {
  if (!window.isSecureContext) throw Object.assign(new Error('the camera needs an https:// address'), { name: 'Insecure' });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('this browser has no camera access (try Safari or Chrome)'), { name: 'Unsupported' });
  if (!force && camctl.liveTrack()) return;
  await attachStream(() => camctl.open());
}

// Shared by first start, lens switches and resume-after-background.
async function attachStream(openFn) {
  const { stream, track } = await openFn();
  cam.stream = stream;
  cam.track = track;
  cam.error = null;
  video.srcObject = stream;
  await video.play().catch(() => {});
  track.addEventListener('ended', () => { cam.stream = null; });
  // Some browsers start the stream but never paint a frame until another play() call.
  setTimeout(async () => {
    if (state.mode !== 'ar' || video.videoWidth) return;
    await video.play().catch(() => {});
    setTimeout(() => {
      if (state.mode === 'ar' && !video.videoWidth) {
        cam.error = Object.assign(new Error('the camera started but sent no picture. Close other camera apps and retry.'), { name: 'NoFrames' });
        showCamBanner();
      }
    }, 1500);
  }, 2500);
}

// iOS stops the camera, wake lock and sometimes sensors when you switch apps or lock the phone.
async function resumeAfterBackground() {
  if (document.hidden || state.mode !== 'ar') return;
  const t = camctl.liveTrack();
  if (!t || t.muted) {
    try { await startCamera(true); } catch (e) { cam.error = e; showCamBanner(); }
  } else if (video.paused) video.play().catch(() => {});
  requestWakeLock();
}
document.addEventListener('visibilitychange', resumeAfterBackground);
addEventListener('pageshow', resumeAfterBackground);

let wakeLock = null;
async function requestWakeLock() {
  try {
    if (navigator.wakeLock && !document.hidden && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not allowed right now */ }
}

function cameraErrorText(e) {
  switch (e.name) {
    case 'NotAllowedError': return 'Camera permission is blocked. Allow it in your browser’s site settings, then retry.';
    case 'NotFoundError': case 'OverconstrainedError': return 'No camera found on this device.';
    case 'NotReadableError': return 'The camera is being used by another app.';
    default: return `Camera unavailable: ${e.message || e.name}.`;
  }
}

async function startAR(fromTap = true) {
  $('splashMsg').textContent = 'Starting camera…';
  // Must run first, synchronously inside the tap, for iOS to show its prompt.
  const sensors = orient.start().catch((e) => e);
  try {
    await startCamera();
  } catch (e) {
    cam.error = e;
    enter('map');
    showCamBanner();
    startGps();
    return;
  }
  startGps();
  enter('ar');
  const err = await sensors;
  if (err instanceof Error && fromTap) toast(err.message);
  requestWakeLock();
  setTimeout(() => {
    if (state.mode !== 'ar') return;
    if (!orient.hasSensor) {
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') $('btnSensors').classList.remove('hidden');
      else toast('No motion sensor found. Drag to look around.', 5000);
    } else if (!orient.absolute) toast('Compass not available. Point at a known object and tap Align.', 6000);
  }, 2500);
}

function showCamBanner() {
  if (!cam.error) return $('camBanner').classList.add('hidden');
  $('camMsg').textContent = cameraErrorText(cam.error);
  $('camBanner').classList.remove('hidden');
}

function startMap() {
  startGps();
  enter('map');
}

function enter(mode) {
  state.mode = mode;
  $('splash').classList.add('hidden');
  ['hud', 'toolbar', 'crosshair', 'zoomCtl'].forEach((id) => $(id).classList.remove('hidden'));
  resize();
  if (mode === 'map' && orient.basis) Object.assign(orient.view, orient.pointing());
  orient.mode = mode === 'ar' ? 'sensor' : 'manual';
  state.arSince = performance.now();
  camctl.show(mode === 'ar');
  if (mode === 'ar') $('camBanner').classList.add('hidden');
  else $('camSheet').classList.add('hidden');
  if (mode === 'map') $('btnSensors').classList.add('hidden');
  $('modeLabel').textContent = mode === 'ar' ? 'Sky map' : 'Camera';
  $('icoMode').innerHTML = mode === 'ar'
    ? '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'
    : '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l2-3h4l2 3"/>';
  setZoom(1);
  syncFovUi();
  $('yaw').value = orient.yawOffset;
  $('yawVal').textContent = `${orient.yawOffset.toFixed(1)}°`;
  if (state.target) selectTarget(state.target, false);
  maybeShowInstallHint();
}

// ---------------- Zoom ----------------
function setZoom(z) {
  const [lo, hi] = ZOOM[state.mode];
  state.zoom = clamp(z, lo, hi);
  $('zoomVal').textContent = `${state.zoom < 10 ? state.zoom.toFixed(1).replace(/\.0$/, '') : Math.round(state.zoom)}×`;
  if (state.mode === 'ar') applyCameraZoom();
}

// Optical/sensor zoom when the camera supports it, CSS digital zoom for the rest.
// The overlay's focal length is scaled by the same total factor, so labels stay on target.
function applyCameraZoom() {
  camctl.setHwZoom(state.zoom);
  cssZoom();
}
function cssZoom() {
  camctl.setCss(`scale(${state.zoom / camctl.hwZoomApplied()})`);
}

// ---------------- Projection ----------------
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2.5);
  state.W = innerWidth;
  state.H = innerHeight;
  state.dpr = dpr;
  canvas.width = Math.round(state.W * dpr);
  canvas.height = Math.round(state.H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tw = tape.clientWidth || Math.min(560, state.W - 32);
  tape.width = Math.round(tw * dpr);
  tape.height = Math.round(34 * dpr);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function focal() {
  const { W, H } = state;
  if (state.mode === 'ar') {
    const vw = video.videoWidth || Math.max(W, H), vh = video.videoHeight || Math.min(W, H);
    const fv = (Math.max(vw, vh) / 2) / Math.tan((camctl.fov() / 2) * D2R);
    return fv * Math.max(W / vw, H / vh) * state.zoom;
  }
  const fov = clamp(70 / state.zoom, 1, 120);
  return (H / 2) / Math.tan((fov / 2) * D2R);
}

let B; // camera basis for this frame
function project(e) {
  const z = dot(e, B.fwd);
  if (z <= 0.05) return null;
  const x = dot(e, B.right), y = dot(e, B.up);
  return [state.W / 2 + (state.f * x) / z, state.H / 2 - (state.f * y) / z];
}
const onScreen = (p, m = 40) => p && p[0] > -m && p[1] > -m && p[0] < state.W + m && p[1] < state.H + m;

// ---------------- Frame loop ----------------
function frame(now) {
  requestAnimationFrame(frame);
  if (!state.located) return;
  const date = new Date();
  if (now - state.lastSlow > 1000) { sky.updateSlow(date); state.lastSlow = now; }
  if (state.mode === 'ar' && orient.mode === 'manual' && orient.hasSensor) orient.mode = 'sensor';
  if (state.mode === 'ar' && orient.mode === 'sensor' && !orient.raw && now - state.arSince > 4000) orient.mode = 'manual';
  B = orient.update(state.mode === 'ar' ? state.zoom : 1);
  state.f = focal();
  updateSatellites(date, now);
  if (state.mode === 'ar') camctl.frame(now);
  state.center = null;
  draw(now);
  hud(date, now);
}

// Whole catalogue is swept in slices (~3×/s) to find who is near/above the horizon;
// those inside the view are re-propagated every frame so they move smoothly.
function updateSatellites(date, now) {
  const all = sky.satellites;
  const n = all.length;
  if (!n) { sat.near = []; sat.vis = []; return; }
  if (sat.cursor >= n) sat.cursor = 0;
  const per = Math.max(60, Math.ceil(n / 20));
  const end = Math.min(n, sat.cursor + per);
  const slice = all.slice(sat.cursor, end);
  sky.updateFast(date, slice);
  for (const s of slice) if (s.alt > -3 && !s.dead) sat.building.push(s);
  sat.cursor = end;
  if (end >= n) { sat.near = sat.building; sat.building = []; sat.cursor = 0; }

  const halfDiag = Math.atan(Math.hypot(state.W, state.H) / 2 / state.f) / D2R;
  const cosLim = Math.cos(Math.min(89, halfDiag + 6) * D2R);
  const vis = [];
  for (const s of sat.near) if (dot(s.e, B.fwd) > cosLim) vis.push(s);
  const t = state.target;
  if (t?.kind === 'satellite' && !vis.includes(t)) vis.push(t);
  sky.updateFast(date, vis);
  sat.vis = vis;
  // Short motion trails (last ~3 s).
  if (state.layers.trails) {
    for (const s of vis) {
      if (!s.trail) s.trail = [];
      if (!s.trailAt || now - s.trailAt > 200) {
        s.trail.push(s.e);
        if (s.trail.length > 15) s.trail.shift();
        s.trailAt = now;
      }
    }
  }
}

// ---------------- Drawing ----------------
function considerCenter(o, p, r = 0) {
  const d = Math.hypot(p[0] - state.W / 2, p[1] - state.H / 2) - r;
  if (d < 34 && (!state.center || d < state.center.d)) state.center = { o, d };
}

function draw(now) {
  const { W, H } = state;
  ctx.clearRect(0, 0, W, H);
  const ar = state.mode === 'ar';
  if (!ar) {
    const s = sky.sunAlt ?? -30;
    const k = clamp((s + 12) / 18, 0, 1);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgb(${4 + 40 * k},${7 + 70 * k},${18 + 130 * k})`);
    g.addColorStop(1, `rgb(${12 + 60 * k},${18 + 90 * k},${42 + 140 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    // Gentle vignette so labels stay readable over a bright camera image.
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const zs = clamp(Math.sqrt(state.f / 700), 0.8, 2.2);

  drawGround(ar);
  if (state.layers.grid) drawGrid();
  if (state.layers.constellations) drawConstellations(ar);

  // Stars (catalogue sorted bright → faint)
  const magLimit = clamp((ar ? 4.2 : 4.6) + Math.log2(state.zoom) * 0.9, 3.5, 6);
  ctx.textAlign = 'left';
  for (const s of sky.stars) {
    if (s.mag > magLimit) break;
    if (s.alt < -2 && ar) continue;
    const p = project(s.e);
    if (!onScreen(p, 4)) continue;
    const r = Math.max(0.6, (magLimit + 1.2 - s.mag) * 0.48) * zs;
    ctx.fillStyle = bvColor(s.bv);
    ctx.globalAlpha = s.alt < 0 ? 0.35 : 1;
    if (s.mag < 1.5) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8; }
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (s.name) {
      considerCenter(s, p, r);
      if (state.layers.starLabels && s.mag < (ar ? 2.0 : 2.4) + Math.log2(state.zoom) * 0.8) {
        text(s.ly ? `${s.name} · ${fmtDist(s, true)}` : s.name, p[0] + r + 5, p[1] + 4, 'rgba(225,232,255,.8)', 11.5, 500);
      }
    }
  }
  ctx.globalAlpha = 1;

  // Asteroids
  for (const a of sky.asteroids) {
    const p = project(a.e);
    if (!onScreen(p)) continue;
    considerCenter(a, p, 4);
    ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = AST_COLOR; ctx.lineWidth = 1.6; ctx.globalAlpha = a.alt < 0 ? 0.45 : 1;
    ctx.strokeRect(-4, -4, 8, 8); ctx.restore();
    pill(`${a.name} · ${fmtDist(a, true)}`, p[0] + 9, p[1], AST_COLOR, a.alt < 0 ? 0.55 : 0.95, 11);
  }
  ctx.globalAlpha = 1;

  drawSatellites(zs);

  // Planets, Sun, Moon
  for (const pl of sky.planets) {
    const p = project(pl.e);
    if (!onScreen(p, 80)) continue;
    const col = PLANET_COLORS[pl.name];
    const big = pl.name === 'Sun' || pl.name === 'Moon';
    // Sun/Moon drawn at true angular size (0.53°) once zoomed in.
    const r = big ? Math.max(10, state.f * Math.tan(0.265 * D2R)) : Math.max(3.2, 6 - (pl.mag ?? 5) * 0.5) * zs;
    considerCenter(pl, p, r);
    ctx.globalAlpha = pl.alt < 0 ? 0.5 : 1;
    if (pl.name === 'Moon') drawMoon(p, r, pl.moonPhase);
    else {
      ctx.shadowColor = col; ctx.shadowBlur = big ? 30 : 14;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      if (pl.name === 'Saturn') {
        ctx.strokeStyle = col; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.ellipse(p[0], p[1], r * 2.1, r * 0.7, -0.35, 0, 7); ctx.stroke();
      }
    }
    pill(`${pl.name} · ${fmtDist(pl, true)}`, p[0] + r + 7, p[1], col, pl.alt < 0 ? 0.6 : 1, 12.5, true);
    ctx.globalAlpha = 1;
  }

  drawTarget(now);
}

function drawSatellites(zs) {
  const vis = sat.vis;
  const crowded = vis.length > 60;
  const trails = state.layers.trails;
  for (const s of vis) {
    if (s.dead) continue;
    const cls = satClass(s);
    const col = SAT_COLORS[cls];
    const below = s.alt < 0;
    if (below && s !== state.target) continue;
    const p = project(s.e);
    if (!onScreen(p, 30)) continue;
    const alpha = (s.sunlit ? 1 : 0.75) * (below ? 0.5 : 1);
    if (trails && s.trail?.length > 1) {
      ctx.lineWidth = cls === 'station' ? 2 : 1.2;
      let prev = null;
      for (let i = 0; i < s.trail.length; i++) {
        const q = project(s.trail[i]);
        if (q && prev) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = alpha * (i / s.trail.length) * 0.6;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        }
        prev = q;
      }
      if (prev) { ctx.globalAlpha = alpha * 0.6; ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); }
    }
    ctx.globalAlpha = alpha;
    const r = (cls === 'station' ? 4.5 : cls === 'starlink' ? 2.3 : 2.8) * zs;
    if (s.sunlit) {
      // Sunlit: solid glowing dot (these are the ones you can actually see).
      ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = cls === 'station' ? 18 : 8;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // In Earth's shadow: hollow ring (tracked, but not visible to the eye).
      ctx.strokeStyle = col; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(p[0], p[1], r + 0.6, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    considerCenter(s, p, r);
    if (state.layers.satLabels) {
      const nearC = Math.hypot(p[0] - state.W / 2, p[1] - state.H / 2) < 90;
      if (cls === 'station' || s === state.target || (!crowded && s.sunlit && cls !== 'starlink') || (nearC && !crowded) || state.zoom >= 6) {
        pill(`${satName(s.name)} · ${fmtDist(s, true)}`, p[0] + r + 6, p[1], col, s.sunlit ? 0.95 : 0.6, cls === 'station' ? 12 : 10.5, cls === 'station');
      }
    }
  }
}

function text(str, x, y, color, size = 12, weight = 500) {
  ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.strokeText(str, x, y);
  ctx.fillStyle = color; ctx.fillText(str, x, y);
}

function pill(str, x, y, color, alpha = 1, size = 12, bold = false) {
  ctx.globalAlpha = alpha;
  ctx.font = `${bold ? 650 : 550} ${size}px Inter, system-ui, sans-serif`;
  const w = ctx.measureText(str).width + 12, h = size + 8;
  ctx.fillStyle = 'rgba(6,10,22,.62)';
  ctx.beginPath(); ctx.roundRect(x, y - h / 2, w, h, h / 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(str, x + 6, y + size * 0.36);
  ctx.globalAlpha = 1;
}

function drawMoon(p, r, phaseAngle) {
  ctx.shadowColor = '#fff'; ctx.shadowBlur = 20;
  ctx.fillStyle = '#2a2d33'; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill();
  ctx.shadowBlur = 0;
  const k = Math.cos(phaseAngle * D2R);
  const waxing = phaseAngle < 180;
  ctx.fillStyle = '#efefef';
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, -Math.PI / 2, Math.PI / 2, !waxing);
  ctx.ellipse(p[0], p[1], Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === waxing);
  ctx.fill();
}

function polyline(points) {
  let started = false;
  ctx.beginPath();
  for (const e of points) {
    const p = project(e);
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}

function drawGround(ar) {
  if (!ar) {
    ctx.fillStyle = 'rgba(8, 20, 16, 0.92)';
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
  for (let az = 0; az <= 360; az += 1) ring.push(enu(az, 0));
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ar ? 'rgba(126, 240, 180, .75)' : 'rgba(110, 200, 150, .8)';
  polyline(ring);
  ctx.textAlign = 'center';
  for (let az = 0; az < 360; az += 45) {
    const p = project(enu(az, 0));
    if (!onScreen(p)) continue;
    const name = cardinal(az);
    text(name, p[0], p[1] - 9, az === 0 ? '#ff8080' : '#c4f7d8', name.length === 1 ? 18 : 13, 700);
  }
  ctx.textAlign = 'left';
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(140,165,255,.16)';
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

function drawConstellations(ar) {
  for (const c of sky.constellations) {
    ctx.strokeStyle = ar ? 'rgba(160,190,255,.4)' : 'rgba(120,160,255,.3)';
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
        text(c.name.toUpperCase(), p[0], p[1], 'rgba(160,185,255,.5)', 9.5, 600);
        ctx.textAlign = 'left';
      }
    }
  }
}

function drawTarget(now) {
  const t = state.target;
  if (!t) return;
  const { W, H } = state;
  const e = t.e;
  const z = dot(e, B.fwd), x = dot(e, B.right), y = dot(e, B.up);
  const p = project(e);
  if (onScreen(p, -30)) {
    const pulse = 20 + Math.sin(now / 250) * 3;
    ctx.strokeStyle = state.locked ? '#44e3a0' : '#ffb547';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p[0], p[1], pulse, 0, 7); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(p[0] + Math.cos(a) * (pulse + 4), p[1] + Math.sin(a) * (pulse + 4));
      ctx.lineTo(p[0] + Math.cos(a) * (pulse + 11), p[1] + Math.sin(a) * (pulse + 11));
      ctx.stroke();
    }
    if (t.kind === 'satellite') drawSatTrack(t);
  } else {
    let ang = Math.atan2(-y, x);
    if (z < 0 && Math.hypot(x, y) < 0.05) ang = -Math.PI / 2;
    const card = $('target').getBoundingClientRect();
    const top = 170, bottom = Math.min(H - 100, card.top || H) - 30;
    const cx = W / 2, cy = (top + bottom) / 2;
    const rx = W / 2 - 70, ry = Math.max(40, (bottom - top) / 2);
    const c = Math.cos(ang), s = Math.sin(ang);
    const k = Math.min(Math.abs(rx / (c || 1e-6)), Math.abs(ry / (s || 1e-6)));
    const ax = cx + c * k, ay = cy + s * k;
    ctx.save();
    ctx.translate(ax, ay); ctx.rotate(ang);
    ctx.fillStyle = '#ffb547'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10;
    const bob = Math.sin(now / 200) * 4;
    ctx.beginPath(); ctx.moveTo(20 + bob, 0); ctx.lineTo(-10 + bob, -15); ctx.lineTo(-4 + bob, 0); ctx.lineTo(-10 + bob, 15); ctx.closePath(); ctx.fill();
    ctx.restore();
    const name = displayName(t);
    ctx.font = '650 12px Inter, system-ui, sans-serif';
    const w = ctx.measureText(name).width + 12;
    pill(name, ax - c * 40 - w / 2, ay - s * 36, '#ffd391', 1, 12, true);
  }
}

function drawSatTrack(s) {
  if (!s._trackAt || performance.now() - s._trackAt > 2000) {
    s._track = trackPoints(s);
    s._trackAt = performance.now();
  }
  ctx.strokeStyle = 'rgba(126,240,207,.5)'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1.5;
  polyline(s._track);
  ctx.setLineDash([]);
}

// Predicted path ±3 min.
function trackPoints(s) {
  const out = [];
  const t0 = Date.now();
  const tmp = { satrec: s.satrec };
  for (let dt = -180; dt <= 180; dt += 10) {
    sky.updateFast(new Date(t0 + dt * 1000), [tmp]);
    out.push(tmp.e);
  }
  return out;
}

// ---------------- Compass tape ----------------
function drawTape(heading) {
  const w = tape.width / state.dpr, h = 34;
  tctx.clearRect(0, 0, w, h);
  const span = 90; // degrees visible
  const pxd = w / span;
  tctx.textAlign = 'center';
  for (let d = Math.ceil((heading - span / 2) / 5) * 5; d <= heading + span / 2; d += 5) {
    const x = w / 2 + (d - heading) * pxd;
    const a = ((d % 360) + 360) % 360;
    const major = a % 45 === 0, mid = a % 15 === 0;
    const fade = 1 - Math.abs(x - w / 2) / (w / 2);
    tctx.globalAlpha = clamp(fade * 1.6, 0, 1);
    tctx.strokeStyle = '#fff';
    tctx.lineWidth = major ? 2 : 1;
    tctx.beginPath(); tctx.moveTo(x, h - 2); tctx.lineTo(x, h - (major ? 12 : mid ? 9 : 5)); tctx.stroke();
    if (major) {
      tctx.font = '700 13px "Space Grotesk", Inter, sans-serif';
      tctx.fillStyle = a === 0 ? '#ff8080' : '#fff';
      tctx.fillText(cardinal(a), x, 13);
    } else if (mid) {
      tctx.font = '500 10px Inter, sans-serif';
      tctx.fillStyle = 'rgba(255,255,255,.7)';
      tctx.fillText(String(a), x, 12);
    }
  }
  tctx.globalAlpha = 1;
  // Target marker
  const t = state.target;
  if (t) {
    const d = wrap180(t.az - heading);
    tctx.fillStyle = '#ffb547';
    if (Math.abs(d) < span / 2) {
      const x = w / 2 + d * pxd;
      tctx.beginPath(); tctx.moveTo(x, 18); tctx.lineTo(x - 6, 27); tctx.lineTo(x + 6, 27); tctx.closePath(); tctx.fill();
    } else {
      tctx.font = '700 11px Inter, sans-serif';
      tctx.textAlign = d > 0 ? 'right' : 'left';
      tctx.fillText(d > 0 ? `${Math.round(d)}° ▶` : `◀ ${Math.round(-d)}°`, d > 0 ? w : 0, 26);
    }
  }
  // Centre index
  tctx.fillStyle = '#7ef0cf';
  tctx.fillRect(w / 2 - 1, h - 16, 2, 16);
}

// ---------------- HUD + target card ----------------
function fmtTime(d) { return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
const AU_KM = 149597870.7;
const LIGHT_KM_S = 299792.458;
// Distance from the observer. short = compact form for on-sky labels.
function fmtDist(o, short = false) {
  if (o.kind === 'satellite') return o.range == null ? '—' : `${Math.round(o.range).toLocaleString()} km`;
  if (o.kind === 'star') {
    if (!o.ly) return '—';
    const v = o.ly < 100 ? o.ly.toFixed(1) : Math.round(o.ly).toLocaleString();
    return short ? `${v} ly` : `${v} light-years`;
  }
  if (o.dist == null) return '—';
  const km = o.dist * AU_KM;
  if (km < 2e6) return `${Math.round(km).toLocaleString()} km`;
  const m = km / 1e6;
  const mtxt = m < 1000 ? `${m < 100 ? m.toFixed(1) : Math.round(m)}M km` : `${(m / 1000).toFixed(2)}B km`;
  return short ? mtxt : `${mtxt.replace('M km', ' million km').replace('B km', ' billion km')} (${o.dist.toFixed(3)} AU)`;
}
function lightTime(o) {
  if (o.kind === 'star') return o.ly ? `${o.ly < 100 ? o.ly.toFixed(1) : Math.round(o.ly).toLocaleString()} years` : '—';
  const km = o.kind === 'satellite' ? o.range : o.dist * AU_KM;
  const sec = km / LIGHT_KM_S;
  if (sec < 1) return `${(sec * 1000).toFixed(1)} ms`;
  if (sec < 120) return `${sec.toFixed(1)} s`;
  if (sec < 7200) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

let lastLive = 0;
function hud(date, now) {
  const pt = orient.pointing();
  $('heading').textContent = `${Math.round(pt.az)}° ${cardinal(pt.az)}`;
  const acc = orient.accuracy;
  const src = state.mode === 'ar'
    ? (orient.mode === 'sensor' ? (orient.absolute ? `compass${acc > 0 ? ` ±${Math.round(acc)}°` : ''}` : 'gyro only') : 'drag to look')
    : 'sky map';
  if (state.mode === 'ar' && orient.mode === 'sensor' && acc != null && (acc < 0 || acc > 25) && !state.calHinted) {
    state.calHinted = true;
    toast(`Compass accuracy is poor${acc > 0 ? ` (±${Math.round(acc)}°)` : ''}. Move your phone in a figure-8, away from metal and magnets, or tap Align on a bright object.`, 7000);
  }
  $('sub').textContent = `Alt ${pt.alt.toFixed(0)}° · ${src}${orient.yawOffset ? ` · cal ${orient.yawOffset > 0 ? '+' : ''}${orient.yawOffset.toFixed(1)}°` : ''}`;
  $('clock').textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  drawTape(pt.az);

  if (now - lastLive > 500) {
    updateLive();
    lastLive = now;
    const up = sat.near.filter((s) => s.alt > 0);
    const starlink = up.filter((s) => s.type === 'Starlink satellite').length;
    const iss = sky.satellites.find((s) => s.norad === '25544');
    let txt = sky.satellites.length
      ? `LIVE · ${up.length.toLocaleString()} satellites overhead${starlink ? ` · ${starlink} Starlink` : ''}`
      : 'Loading satellites…';
    if (iss && iss.alt > 0) txt = `ISS is overhead now! · ${txt}`;
    $('liveText').textContent = txt;
  }

  // What's under the crosshair
  const c = state.center?.o;
  const ret = $('reticle');
  if (c && c !== state.target) {
    const extra = c.kind === 'satellite' ? `${fmtDist(c)} from you · ${Math.round(c.height)} km up`
      : `${c.kind === 'star' ? 'Star' : c.type}${fmtDist(c, true) !== '—' ? ` · ${fmtDist(c, true)} from you` : ''}`;
    ret.innerHTML = `<b>${escapeHtml(displayName(c))}</b> · <span class="muted">${escapeHtml(extra)}</span>`;
    ret.classList.remove('hidden');
  } else ret.classList.add('hidden');

  const t = state.target;
  if (!t) return;
  const dAz = wrap180(t.az - pt.az), dAlt = t.alt - pt.alt;
  const sep = Math.acos(clamp(dot(t.e, B.fwd), -1, 1)) / D2R;
  const locked = sep < Math.max(0.6, 2.5 / Math.sqrt(state.zoom));
  if (locked && !state.locked) haptic();
  state.locked = locked;
  const g = $('tGuide');
  g.classList.toggle('locked', locked);
  if (locked) g.textContent = `✓ On target · ${sep.toFixed(1)}° off`;
  else {
    const parts = [];
    if (Math.abs(dAz) > 1 && Math.abs(pt.alt) < 85) parts.push(`${dAz > 0 ? '→ Turn right' : '← Turn left'} ${Math.abs(dAz).toFixed(0)}°`);
    if (Math.abs(dAlt) > 1) parts.push(`${dAlt > 0 ? '↑ Tilt up' : '↓ Tilt down'} ${Math.abs(dAlt).toFixed(0)}°`);
    g.textContent = parts.join('   ') || `${sep.toFixed(1)}° away`;
  }
  $('tQuick').innerHTML = `Az ${t.az.toFixed(1)}° ${cardinal(t.az)} · Alt <span class="${t.alt > 0 ? 'up' : 'down'}">${t.alt.toFixed(1)}°</span> · <b>${fmtDist(t)}</b> away`
    + (t.kind !== 'satellite' && t.kind !== 'star' ? ` · light ${lightTime(t)}` : '')
    + (t.kind === 'satellite' && t.rangeRate != null ? ` · ${t.rangeRate < 0 ? 'approaching' : 'receding'} ${Math.abs(t.rangeRate).toFixed(1)} km/s` : '');

  if (!$('tDetails').classList.contains('collapsed')) {
    const stats = [
      ['Azimuth', `${t.az.toFixed(2)}° ${cardinal(t.az)}`],
      ['Altitude', `<span class="${t.alt > 0 ? 'up' : 'down'}">${t.alt.toFixed(2)}°</span>`],
      ['Distance', fmtDist(t)],
    ];
    if (t.kind === 'star' && t.ly) {
      const yr = new Date().getFullYear() - Math.round(t.ly);
      stats.push(['Light left it', yr > 0 ? `≈ ${yr} AD` : `≈ ${-yr + 1} BC`]);
    } else if (t.kind !== 'star') stats.push(['Light time', lightTime(t)]);
    if (t.mag != null && Number.isFinite(t.mag)) stats.push(['Magnitude', t.mag.toFixed(1)]);
    if (t.kind === 'satellite') {
      const rr = t.rangeRate;
      stats.push(
        ['Height', `${Math.round(t.height)} km`],
        ['Speed', `${t.speed?.toFixed(2)} km/s`],
        ['Range rate', rr == null ? '—' : `<span class="${rr < 0 ? 'up' : 'down'}">${rr < 0 ? '−' : '+'}${Math.abs(rr).toFixed(2)} km/s</span>`],
        ['Over', `${Math.abs(t.lat).toFixed(2)}°${t.lat >= 0 ? 'N' : 'S'} ${Math.abs(t.lon).toFixed(2)}°${t.lon >= 0 ? 'E' : 'W'}`],
        ['Lighting', t.sunlit ? 'Sunlit' : 'In shadow'],
      );
    }
    if (t.ra != null) stats.push(['RA / Dec', `${t.ra.toFixed(2)}h ${t.dec >= 0 ? '+' : ''}${t.dec.toFixed(1)}°`]);
    $('tStats').innerHTML = stats.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
  }
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
    if (t.alt > 0) bits.push(`Above your horizon now. ${t.sunlit ? 'Sunlit' : 'In Earth’s shadow (not visible)'}${t.sunlit && sky.sunAlt < -6 ? '. The sky is dark, so look for a moving point of light' : ''}.`);
    else {
      const np = sky.nextPass(t, date);
      bits.push(np?.start ? `Next pass ${fmtTime(np.start)}, max ${np.peak.toFixed(0)}° at ${fmtTime(np.peakT)}` : 'No pass above 10° in the next 24 h');
    }
    bits.push(`NORAD ${t.norad} · orbit data ${age.toFixed(1)} d old`);
  } else if (t.kind === 'asteroid') {
    bits.push(`Orbit: a=${t.el.a.toFixed(3)} AU, e=${t.el.e.toFixed(3)}, i=${t.el.i.toFixed(1)}°`);
    if (t.mag > 6.5) bits.push(t.mag > 12 ? 'Too faint to see without a large telescope' : 'Needs binoculars or a telescope');
  } else if (t.kind === 'star' && t.con) bits.push(`In ${t.con}`);
  if (t.alt < 0) bits.unshift('Below the horizon right now.');
  return bits.join(' · ');
}

function selectTarget(o, center = true) {
  state.target = o;
  state.extraAt = -1e9;
  state.locked = false;
  $('target').classList.toggle('hidden', !o);
  if (!o) return;
  const col = colorOf(o);
  $('tIcon').style.background = col;
  $('tIcon').style.boxShadow = `0 0 12px ${col}`;
  $('tName').textContent = displayName(o);
  $('tType').innerHTML = escapeHtml(o.type + (o.kind === 'satellite' ? ` · NORAD ${o.norad}` : ''))
    + (o.kind === 'satellite' ? '<span class="live">LIVE</span>' : '');
  $('tGoto').classList.toggle('hidden', orient.mode === 'sensor');
  $('tAlign').classList.toggle('hidden', orient.mode !== 'sensor');
  if (center && orient.mode === 'manual') centerOn(o);
}

function centerOn(o) {
  orient.view.az = o.az;
  orient.view.alt = clamp(o.alt, -30, 89);
}

// ---------------- Search ----------------
let filter = 'overhead';
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  let items = sky.objects.filter((o) => !o.dead);
  const score = (o) => {
    const n = o.name.toLowerCase(), d = displayName(o).toLowerCase();
    if (n === q || d === q || o.norad === q) return 0;
    if (n.startsWith(q) || d.startsWith(q)) return 1;
    if (n.split(/[^a-z0-9]+/).includes(q)) return 2;
    return n.includes(q) ? 3 : 9;
  };
  if (q) items = items.filter((o) => score(o) < 9);
  else if (filter === 'up') items = items.filter((o) => o.alt > 0);
  else if (filter === 'overhead') items = items.filter((o) => o.kind === 'satellite' && o.alt > 0);
  if (!q && !['up', 'all', 'overhead'].includes(filter)) items = items.filter((o) => o.kind === filter);
  const rank = { planet: 0, asteroid: 1, satellite: 2, star: 3 };
  const cls = { station: 0, other: 1, starlink: 2 };
  if (filter === 'overhead' && !q) items.sort((a, b) => cls[satClass(a)] - cls[satClass(b)] || b.alt - a.alt);
  else items.sort((a, b) => (q ? score(a) - score(b) : 0) || (q && a.norad && b.norad ? a.norad - b.norad : 0)
    || (b.alt > 0) - (a.alt > 0) || rank[a.kind] - rank[b.kind] || (a.mag ?? 99) - (b.mag ?? 99) || a.name.localeCompare(b.name));
  items = items.slice(0, 200);
  $('list').innerHTML = items.map((o, i) => {
    const col = colorOf(o);
    const sub = o.kind === 'satellite'
      ? `${fmtDist(o)} away · ${Math.round(o.height || 0)} km up${o.alt > 0 ? (o.sunlit ? ' · sunlit' : ' · in shadow') : ''}`
      : `${o.type} · ${fmtDist(o, true)} away${o.mag != null && Number.isFinite(o.mag) ? ` · mag ${o.mag.toFixed(1)}` : ''}`;
    return `<li data-i="${i}"><span class="dot" style="background:${col};color:${col}"></span>
      <span class="nm"><b>${escapeHtml(displayName(o))}</b><span class="muted small">${escapeHtml(sub)}</span></span>
      <span class="pos"><span class="${o.alt > 0 ? 'up' : 'down'}">${o.alt > 0 ? '▲' : '▼'} ${o.alt.toFixed(o.kind === 'satellite' ? 1 : 0)}°</span><br><span class="muted">${Math.round(o.az)}° ${cardinal(o.az)}</span></span></li>`;
  }).join('') || `<li class="muted">${sky.satellites.length || filter !== 'overhead' ? 'Nothing matches.' : 'Loading satellites…'}</li>`;
  $('list').onclick = (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (!li) return;
    selectTarget(items[+li.dataset.i]);
    openDetails(items[+li.dataset.i]);
    $('search').classList.add('hidden');
  };
}

function openSearch(f) {
  $('settings').classList.add('hidden');
  closeDetails();
  $('search').classList.remove('hidden');
  if (f) {
    filter = f;
    [...$('chips').children].forEach((c) => c.classList.toggle('on', c.dataset.f === f));
  }
  renderList();
}

// ---------------- UI wiring ----------------
function bindUI() {
  $('startAR').onclick = () => startAR(true);
  $('startMap').onclick = startMap;
  $('btnSearch').onclick = () => openSearch();
  $('liveChip').onclick = () => openSearch('overhead');
  $('locChip').onclick = () => { $('search').classList.add('hidden'); $('settings').classList.remove('hidden'); };
  setInterval(() => { if (!$('search').classList.contains('hidden')) renderList(); }, 1000);
  $('sClose').onclick = () => $('search').classList.add('hidden');
  $('q').oninput = renderList;
  $('chips').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    [...$('chips').children].forEach((c) => c.classList.toggle('on', c === b));
    renderList();
  };
  $('btnSettings').onclick = () => { $('search').classList.add('hidden'); closeDetails(); $('settings').classList.toggle('hidden'); };
  $('tInfo').onclick = () => state.target && openDetails(state.target);
  $('setClose').onclick = () => $('settings').classList.add('hidden');
  $('tClose').onclick = () => selectTarget(null);
  $('tMore').onclick = () => {
    const d = $('tDetails');
    d.classList.toggle('collapsed');
    $('tMore').textContent = d.classList.contains('collapsed') ? '▾' : '▴';
  };
  $('tGoto').onclick = () => state.target && centerOn(state.target);
  $('tAlign').onclick = () => alignOn(state.target);
  $('btnCal').onclick = () => {
    if (orient.mode !== 'sensor') return toast('Calibration works in camera mode with motion sensors.');
    const t = state.target;
    if (t && t.alt > 0) return alignOn(t);
    const bright = sky.planets.filter((p) => p.alt > 5 && (p.name === 'Moon' || p.name === 'Sun' || p.mag < 0));
    toast(bright.length
      ? `Select ${bright.map((b) => b.name).join(' or ')} in Find, put it in the centre frame, then tap Align.`
      : 'Select a bright star you can see in Find, put it in the centre frame, then tap Align.', 6000);
  };
  $('btnMode').onclick = async () => {
    if (state.mode === 'ar') enter('map');
    else if (cam.stream?.active) enter('ar');
    else await startAR(true);
  };
  $('camRetry').onclick = () => startAR(true);
  $('darkBoost').onclick = () => { $('darkHint').classList.add('hidden'); camctl.applyPreset('night'); toast('Night camera on. Rest the phone on something steady for the best picture.'); };
  $('darkClose').onclick = () => $('darkHint').classList.add('hidden');
  $('iosHintClose').onclick = () => { $('iosHint').classList.add('hidden'); save('iosHintDone', true); };
  $('btnSensors').onclick = async () => {
    $('btnSensors').classList.add('hidden');
    try { await orient.start(); } catch (e) { toast(e.message); }
  };
  $('zIn').onclick = () => setZoom(state.zoom * 1.5);
  $('zOut').onclick = () => setZoom(state.zoom / 1.5);
  $('zoomVal').onclick = () => setZoom(1);

  for (const cb of document.querySelectorAll('[data-layer]')) {
    cb.checked = !!state.layers[cb.dataset.layer];
    cb.onchange = () => { state.layers[cb.dataset.layer] = cb.checked; save('layers', state.layers); applyLayers(); };
  }
  for (const cb of document.querySelectorAll('[data-sat]')) {
    const g = cb.dataset.sat;
    cb.checked = state.satGroups.includes(g);
    cb.onchange = async () => {
      if (cb.checked) {
        state.satGroups.push(g);
        $('satStatus').textContent = `Loading ${g}…`;
        await loadGroup(g);
      } else {
        state.satGroups = state.satGroups.filter((x) => x !== g);
        sky.dropSatGroup(g);
        sat.near = sat.near.filter((s) => s.group !== g);
        sat.building = [];
        sat.cursor = 0;
        if (state.target?.group === g) selectTarget(null);
        satStatus();
      }
      save('satGroups.v2', state.satGroups);
    };
  }
  $('fov').oninput = (e) => { camctl.setFov(+e.target.value); $('fovVal').textContent = `${e.target.value}°`; };
  $('yaw').oninput = (e) => { orient.yawOffset = +e.target.value; $('yawVal').textContent = `${orient.yawOffset.toFixed(1)}°`; save('yawOffset', orient.yawOffset); };
  $('calReset').onclick = () => { orient.resetCalibration(); $('yaw').value = 0; $('yawVal').textContent = '0.0°'; toast('Calibration reset'); };
  $('locSet').onclick = () => {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return toast('Enter a valid latitude and longitude');
    if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
    setLocation(lat, lon, 0, 'Manual');
    save('loc', { lat, lon, elev: 0 });
    toast('Location updated');
  };
  $('locGps').onclick = () => { state.locLabel = ''; $('loc').textContent = 'getting GPS fix…'; startGps(); };

  // Drag (sky map), pinch / wheel zoom (both modes), tap to select.
  const pointers = new Map();
  let dragStart = null, pinch0 = null, moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (state.mode === 'ar' && video.paused && cam.stream) video.play().catch(() => {});
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = pointers.size > 1;
    dragStart = { x: e.clientX, y: e.clientY, az: orient.view.az, alt: orient.view.alt };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: state.zoom };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && pinch0) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch0.zoom * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0.d));
      moved = true;
      return;
    }
    if (!dragStart || orient.mode !== 'manual') return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    const degPerPx = 1 / (state.f * D2R);
    orient.view.az = (dragStart.az - dx * degPerPx + 360) % 360;
    orient.view.alt = clamp(dragStart.alt + dy * degPerPx, -60, 89.9);
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = null;
    if (!moved && pointers.size === 0 && dragStart) pick(e.clientX, e.clientY);
    if (pointers.size === 0) dragStart = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); dragStart = null; pinch0 = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') return setZoom(state.zoom * 1.25);
    if (e.key === '-') return setZoom(state.zoom / 1.25);
    if (orient.mode !== 'manual') return;
    const k = { ArrowLeft: [-3, 0], ArrowRight: [3, 0], ArrowUp: [0, 3], ArrowDown: [0, -3] }[e.key];
    if (k) {
      const s = 1 / Math.sqrt(state.zoom);
      orient.view.az = (orient.view.az + k[0] * s + 360) % 360;
      orient.view.alt = clamp(orient.view.alt + k[1] * s, -60, 89.9);
    }
  });
}

function pick(x, y) {
  let best = null, bd = 30;
  const cands = [...sky.planets, ...sky.asteroids, ...sat.vis.filter((s) => s.alt > 0 && !s.dead), ...sky.stars.filter((s) => s.name && s.mag < 5)];
  for (const o of cands) {
    const p = project(o.e);
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - y) - (o.kind === 'planet' ? 6 : 0);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) {
    selectTarget(best, false);
    $('search').classList.add('hidden');
    $('settings').classList.add('hidden');
    openDetails(best);
  }
}

function alignOn(t) {
  if (!t) return;
  if (orient.mode !== 'sensor') return toast('Alignment works in camera mode with motion sensors.');
  if (t.alt < 0) return toast(`${displayName(t)} is below the horizon. Pick an object you can see.`);
  orient.calibrateTo(t.az);
  $('yaw').value = orient.yawOffset;
  $('yawVal').textContent = `${orient.yawOffset.toFixed(1)}°`;
  toast(`Compass aligned on ${displayName(t)} (offset ${orient.yawOffset.toFixed(1)}°)`);
}

// ---------------- Splash starfield ----------------
function splashStars() {
  const c = $('stars');
  const g = c.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const pts = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.2, p: Math.random() * 6 }));
  const sats = Array.from({ length: 3 }, (_, i) => ({ y: 0.12 + i * 0.22 + Math.random() * 0.1, v: 0.00004 + Math.random() * 0.00005, o: Math.random() }));
  const loop = (t) => {
    if ($('splash').classList.contains('hidden')) return;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    const W = c.width, H = c.height;
    for (const s of pts) {
      g.globalAlpha = 0.45 + 0.4 * Math.sin(t / 900 + s.p);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(s.x * W, s.y * H, s.r * dpr, 0, 7); g.fill();
    }
    for (const s of sats) {
      const x = ((s.o + t * s.v) % 1.2 - 0.1) * W, y = s.y * H + x * 0.15;
      const grad = g.createLinearGradient(x - 60 * dpr, y - 9 * dpr, x, y);
      grad.addColorStop(0, 'rgba(126,240,207,0)'); grad.addColorStop(1, 'rgba(126,240,207,.7)');
      g.globalAlpha = 1; g.strokeStyle = grad; g.lineWidth = 1.5 * dpr;
      g.beginPath(); g.moveTo(x - 60 * dpr, y - 9 * dpr); g.lineTo(x, y); g.stroke();
      g.fillStyle = '#d7fff2'; g.beginPath(); g.arc(x, y, 2 * dpr, 0, 7); g.fill();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
init().catch((e) => { console.error(e); toast(`Failed to start: ${e.message}`, 10000); });
