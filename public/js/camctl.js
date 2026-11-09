// Night camera: hardware exposure controls (shutter, ISO, EV, focus, white balance,
// frame rate) where the browser exposes them, plus a software boost (gain, contrast,
// frame stacking) that works on every phone. Also owns hardware zoom, because
// applyConstraints() replaces the whole constraint set each call.
import { load, save } from './orient.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

let video, fx, fctx, track = null, stream = null, caps = {}, visible = false;
let lenses = []; // back-facing cameras [{deviceId, label, name, kind}]
let onLensChange = null;
const fovMap = load('camFovMap', {});
const zoom = { want: 1, applied: 1 };
let busy = false, queued = false, lastReadout = 0, stackFresh = true;
let hwTouched = false; // only call applyConstraints once the user (or a preset) changed something
// Health monitoring
let lastTime = -1, lastProgress = 0, luma = null, darkCount = 0, stallFired = 0, stallStep = 0;
const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = lumaCanvas.height = 24;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
let onStall = null, onDark = null;

const sw = { preset: 'auto', gain: 1, contrast: 1, stack: 1, ...load('camSw', {}) };
let hw = { mode: 'auto', exposureTime: null, iso: null, ev: null, fps: 30, focusInf: false, wb: null, ...load('camHw', {}) };

const has = (k, v) => Array.isArray(caps[k]) && caps[k].includes(v);
const range = (k) => (caps[k] && typeof caps[k].max === 'number' && caps[k].max > caps[k].min ? caps[k] : null);

// Shutter in exposureTime units (100 µs) <-> human text
function shutterText(u) {
  const s = u / 10000;
  if (s >= 0.95) return `${s.toFixed(1)} s`;
  return `1/${Math.round(1 / s)} s`;
}

// ---------------- Presets ----------------
function hwPreset(name) {
  const fr = range('frameRate');
  const et = range('exposureTime');
  const iso = range('iso');
  const ev = range('exposureCompensation');
  const wb = range('colorTemperature');
  if (name === 'auto') return { mode: 'auto', exposureTime: null, iso: null, ev: ev ? 0 : null, fps: 30, focusInf: false, wb: null };
  const fps = name === 'max' ? Math.max(fr?.min ?? 5, 5) : Math.max(fr?.min ?? 10, 10);
  const maxEt = Math.floor((10000 / fps) * 0.95); // exposure can't exceed one frame
  return {
    mode: 'manual',
    exposureTime: et ? clamp(maxEt, et.min, et.max) : null,
    iso: iso ? (name === 'max' ? iso.max : clamp(1600, iso.min, iso.max)) : null,
    ev: ev ? (name === 'max' ? ev.max : clamp(1.5, ev.min, ev.max)) : null,
    fps,
    focusInf: true,
    wb: wb ? clamp(4300, wb.min, wb.max) : null,
  };
}
const SW_PRESETS = {
  auto: { gain: 1, contrast: 1, stack: 1 },
  night: { gain: 1.8, contrast: 1.35, stack: 1 },
  max: { gain: 2.6, contrast: 1.6, stack: 6 },
};

export async function applyPreset(name) {
  sw.preset = name;
  Object.assign(sw, SW_PRESETS[name]);
  hw = hwPreset(name);
  hwTouched = true;
  persist();
  applySoftware();
  syncUi();
  await applyHardware();
}

function persist() { save('camSw', sw); save('camHw', hw); }

// ---------------- Hardware ----------------
function compose() {
  // Separate advanced sets: each is best-effort, so one unsupported setting
  // doesn't cancel the others.
  const sets = [];
  if (range('zoom') && (zoom.want !== 1 || zoom.applied !== 1)) sets.push({ zoom: zoom.want });
  if (!hwTouched) return { advanced: sets };
  if (hw.mode === 'manual' && has('exposureMode', 'manual')) {
    const s = { exposureMode: 'manual' };
    if (range('exposureTime') && hw.exposureTime) s.exposureTime = hw.exposureTime;
    if (range('iso') && hw.iso) s.iso = hw.iso;
    sets.push(s);
  } else if (has('exposureMode', 'continuous')) sets.push({ exposureMode: 'continuous' });
  if (range('exposureCompensation') && hw.ev != null) sets.push({ exposureCompensation: hw.ev });
  if (hw.focusInf && has('focusMode', 'manual') && range('focusDistance')) sets.push({ focusMode: 'manual', focusDistance: caps.focusDistance.max });
  else if (has('focusMode', 'continuous')) sets.push({ focusMode: 'continuous' });
  if (hw.wb && has('whiteBalanceMode', 'manual') && range('colorTemperature')) sets.push({ whiteBalanceMode: 'manual', colorTemperature: hw.wb });
  else if (has('whiteBalanceMode', 'continuous')) sets.push({ whiteBalanceMode: 'continuous' });
  const c = { width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: sets };
  if (range('frameRate')) c.frameRate = { ideal: hw.fps };
  return c;
}
function needsApply(c) {
  return c.advanced.length > 0 || c.frameRate;
}

async function applyHardware() {
  if (!track || track.readyState !== 'live') return;
  if (busy) { queued = true; return; }
  const c = compose();
  if (!needsApply(c)) return; // nothing to change: never poke the camera needlessly (iOS can freeze)
  busy = true;
  try {
    await track.applyConstraints(c);
    const s = track.getSettings?.() || {};
    zoom.applied = typeof s.zoom === 'number' && s.zoom >= 1 ? s.zoom : (range('zoom') ? zoom.want : 1);
    $('camErr').textContent = '';
  } catch (e) {
    $('camErr').textContent = `The camera refused some settings (${e.name}).`;
    try { await track.applyConstraints({ advanced: range('zoom') ? [{ zoom: zoom.want }] : [] }); } catch { /* */ }
  } finally {
    busy = false;
    stackFresh = true;
    onZoomChange?.();
    if (queued) { queued = false; applyHardware(); }
  }
}

let onZoomChange = null;
export function hwZoomApplied() { const z = zoom.applied; return Number.isFinite(z) && z >= 1 ? z : 1; }
export function setHwZoom(z) {
  const r = range('zoom');
  if (!r) { zoom.applied = 1; return; }
  const want = clamp(z, Math.max(1, r.min), r.max);
  if (Math.abs(want - zoom.want) < 0.02) return;
  zoom.want = want;
  applyHardware();
}

// ---------------- Software boost ----------------
function applySoftware() {
  const f = sw.gain === 1 && sw.contrast === 1 ? 'none' : `brightness(${sw.gain}) contrast(${sw.contrast})`;
  video.style.filter = f;
  fx.style.filter = f;
  updateVisibility();
}
function stackingActive() { return visible && sw.stack > 1 && video.readyState >= 2 && video.videoWidth > 0; }
function updateVisibility() {
  const stacking = stackingActive();
  video.style.display = visible ? 'block' : 'none';
  video.style.opacity = stacking ? '0' : '1';
  fx.style.display = stacking ? 'block' : 'none';
  $('camBtn').classList.toggle('hidden', !visible);
  const active = sw.preset !== 'auto' || sw.gain !== 1 || sw.stack > 1 || hw.mode === 'manual';
  $('camBtn').classList.toggle('on', active);
  stackFresh = true;
}

// Called every animation frame while the camera is shown.
export function frame(now) {
  if (!visible) return;
  if (now - lastReadout > 1000) { lastReadout = now; readout(); health(now); }
  if (!video.videoWidth) return;
  if (stackingActive() !== (fx.style.display === 'block')) updateVisibility();
  if (stackingActive()) {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (fx.width !== W || fx.height !== H) { fx.width = W; fx.height = H; stackFresh = true; }
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    // Running average of the last ~N frames: noise drops by about √N.
    fctx.globalAlpha = stackFresh ? 1 : 1 / sw.stack;
    try { fctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh); stackFresh = false; } catch { sw.stack = 1; updateVisibility(); }
  }
}

// Once a second: are frames still arriving, and how bright is the picture?
function health(now) {
  const t = video.currentTime;
  if (t !== lastTime) { lastTime = t; lastProgress = now; }
  const stalled = track && now - lastProgress > 3500;
  const btn = $('camBtn');
  btn.classList.toggle('stalled', !!stalled);
  if (!stalled) stallStep = 0;
  else if (now - stallFired > 4000) {
    stallFired = now;
    // Recovery ladder: re-attach the stream to the <video>, then fully restart the camera.
    if (stallStep++ === 0 && video.srcObject) {
      const so = video.srcObject;
      video.srcObject = null;
      video.srcObject = so;
      video.play().catch(() => {});
    } else onStall?.();
  }
  if (video.videoWidth && video.readyState >= 2) {
    try {
      lumaCtx.drawImage(video, 0, 0, 24, 24);
      const d = lumaCtx.getImageData(0, 0, 24, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      luma = sum / (d.length / 4) / 255;
    } catch { luma = null; }
    if (luma != null && luma < 0.05 && sw.preset === 'auto' && sw.gain === 1) {
      if (++darkCount === 4) onDark?.(luma);
    } else darkCount = 0;
  }
  if (!$('camSheet').classList.contains('hidden')) diagnostics();
}

function diagnostics() {
  const s = track?.getSettings?.() || {};
  const vs = getComputedStyle(video), fs = getComputedStyle(fx);
  const lines = [
    `Track: ${track ? `${track.readyState}${track.muted ? ', muted' : ''}${track.enabled ? '' : ', disabled'}` : 'none'} · ${track?.label || '—'}`,
    `Stream: ${s.width || '?'}×${s.height || '?'} @ ${s.frameRate ? Math.round(s.frameRate) : '?'} fps`,
    `Video: ${video.videoWidth}×${video.videoHeight}, ready ${video.readyState}, ${video.paused ? 'paused' : 'playing'}, t=${video.currentTime.toFixed(1)}s`,
    `Frames: ${performance.now() - lastProgress < 2000 ? 'arriving' : 'NOT arriving'} · picture brightness ${luma == null ? '?' : `${Math.round(luma * 100)}%`}`,
    `Display: video ${vs.display}/${vs.opacity}/${video.style.transform || 'none'} · stack canvas ${fs.display}`,
    `Settings: ${sw.preset} · gain ${sw.gain} · stack ${sw.stack} · hw ${hw.mode}${hwTouched ? '' : ' (untouched)'}`,
  ];
  $('camDiag').textContent = lines.join('\n');
}
export function pictureBrightness() { return luma; }

function readout() {
  if (!track) return;
  const s = track.getSettings?.() || {};
  const bits = [];
  if (s.exposureTime) bits.push(shutterText(s.exposureTime));
  if (s.iso) bits.push(`ISO ${Math.round(s.iso)}`);
  if (s.frameRate) bits.push(`${Math.round(s.frameRate)} fps`);
  if (typeof s.exposureCompensation === 'number' && s.exposureCompensation) bits.push(`EV ${s.exposureCompensation > 0 ? '+' : ''}${s.exposureCompensation.toFixed(1)}`);
  if (sw.gain !== 1) bits.push(`gain ${sw.gain.toFixed(1)}×`);
  if (sw.stack > 1) bits.push(`stack ${sw.stack}`);
  $('camNow').textContent = bits.length ? `Camera now: ${bits.join(' · ')}` : 'Camera now: automatic';
}

// ---------------- UI ----------------
function slider(id, label, min, max, step, value, fmt, onInput, log = false) {
  const toPos = (v) => (log ? Math.log(v / min) / Math.log(max / min) * 1000 : v);
  const fromPos = (p) => (log ? min * (max / min) ** (p / 1000) : p);
  const wrap = document.createElement('label');
  wrap.className = 'range';
  wrap.innerHTML = `<span>${label}</span><input id="${id}" type="range" min="${log ? 0 : min}" max="${log ? 1000 : max}" step="${log ? 1 : step}" /><b></b>`;
  const input = wrap.querySelector('input'), out = wrap.querySelector('b');
  input.value = toPos(value);
  out.textContent = fmt(value);
  input.oninput = () => {
    let v = fromPos(+input.value);
    if (!log && step) v = Math.round(v / step) * step;
    out.textContent = fmt(v);
    onInput(v);
  };
  return wrap;
}

function syncUi() {
  for (const b of document.querySelectorAll('#camPresets button')) b.classList.toggle('on', b.dataset.p === sw.preset);
  renderHwControls();
  renderSwControls();
}

function custom() { sw.preset = 'custom'; for (const b of document.querySelectorAll('#camPresets button')) b.classList.remove('on'); persist(); }

function renderHwControls() {
  const box = $('camHw');
  box.innerHTML = '';
  if (!track) { box.innerHTML = '<p class="muted small">Start the camera to see what it supports.</p>'; return; }
  const et = range('exposureTime'), iso = range('iso'), ev = range('exposureCompensation'), fr = range('frameRate');
  const fd = range('focusDistance') && has('focusMode', 'manual'), wb = range('colorTemperature') && has('whiteBalanceMode', 'manual');
  const manual = has('exposureMode', 'manual');
  if (!manual && !ev && !fd && !wb && !fr) {
    box.innerHTML = '<p class="muted small">This browser doesn’t allow manual camera control. iPhone and iPad browsers never do; on Android use Chrome. The software boost below still works.</p>';
    return;
  }
  const hwSet = (k, v) => { hw[k] = v; hwTouched = true; custom(); applyHardware(); };
  if (manual && et) {
    box.append(slider('cShutter', 'Shutter', et.min, et.max, 0, hw.exposureTime ?? Math.min(et.max, 333), shutterText, (v) => {
      hw.mode = 'manual'; hw.exposureTime = Math.round(v); hwTouched = true;
      // A slow shutter needs a slow frame rate.
      const need = Math.floor(10000 / hw.exposureTime);
      if (fr && hw.fps > need) hw.fps = clamp(need, fr.min, fr.max);
      custom(); applyHardware();
    }, true));
  }
  if (manual && iso) box.append(slider('cIso', 'ISO', iso.min, iso.max, iso.step || 1, hw.iso ?? iso.min, (v) => `${Math.round(v)}`, (v) => { hw.mode = 'manual'; hwSet('iso', Math.round(v)); }, true));
  if (ev) box.append(slider('cEv', 'Exposure', ev.min, ev.max, ev.step || 0.1, hw.ev ?? 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`, (v) => hwSet('ev', v)));
  if (fr) box.append(slider('cFps', 'Frame rate', Math.max(1, fr.min), Math.min(60, fr.max), 1, hw.fps ?? 30, (v) => `${Math.round(v)} fps`, (v) => hwSet('fps', Math.round(v))));
  if (fd) {
    const l = document.createElement('label');
    l.className = 'tog';
    l.innerHTML = '<span>Lock focus at infinity <em>sharp stars</em></span><input type="checkbox" />';
    const cb = l.querySelector('input');
    cb.checked = !!hw.focusInf;
    cb.onchange = () => hwSet('focusInf', cb.checked);
    box.append(l);
  }
  if (wb) box.append(slider('cWb', 'White balance', caps.colorTemperature.min, caps.colorTemperature.max, caps.colorTemperature.step || 50, hw.wb ?? 5000, (v) => `${Math.round(v)} K`, (v) => hwSet('wb', Math.round(v))));
  if (manual) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = 'Back to automatic exposure';
    b.onclick = () => { hw.mode = 'auto'; hw.exposureTime = null; hw.iso = null; custom(); applyHardware(); renderHwControls(); };
    box.append(b);
  }
}

function renderSwControls() {
  const box = $('camSwBox');
  box.innerHTML = '';
  box.append(
    slider('cGain', 'Brightness gain', 1, 4, 0.1, sw.gain, (v) => `${v.toFixed(1)}×`, (v) => { sw.gain = v; custom(); applySoftware(); }),
    slider('cContrast', 'Contrast', 0.8, 2.2, 0.05, sw.contrast, (v) => v.toFixed(2), (v) => { sw.contrast = v; custom(); applySoftware(); }),
    slider('cStack', 'Noise reduction', 1, 12, 1, sw.stack, (v) => (v <= 1 ? 'off' : `${Math.round(v)} frames`), (v) => { sw.stack = Math.round(v); custom(); applySoftware(); }),
  );
}

export function initCamControls(videoEl, fxCanvas, { onZoom, onLens, onStall: st, onDark: dk } = {}) {
  onLensChange = onLens;
  onStall = st;
  onDark = dk;
  $('camReset').onclick = () => {
    for (const k of ['camSw', 'camHw', 'camDevice', 'camFovMap']) { try { localStorage.removeItem(k); } catch { /* */ } }
    location.reload();
  };
  video = videoEl;
  fx = fxCanvas;
  fctx = fx.getContext('2d', { alpha: false });
  onZoomChange = onZoom;
  $('camBtn').onclick = () => {
    for (const id of ['search', 'settings', 'details']) $(id).classList.add('hidden');
    $('camSheet').classList.toggle('hidden');
    syncUi();
    readout();
  };
  $('camClose').onclick = () => $('camSheet').classList.add('hidden');
  $('camPresets').onclick = (e) => {
    const b = e.target.closest('button[data-p]');
    if (b) applyPreset(b.dataset.p);
  };
  applySoftware();
}

async function cameraStarted(t) {
  track = t;
  hwTouched = sw.preset !== 'auto' || hw.mode === 'manual';
  lastProgress = performance.now();
  caps = t.getCapabilities?.() || {};
  zoom.want = 1;
  zoom.applied = 1;
  if (sw.preset !== 'auto' && sw.preset !== 'custom') hw = hwPreset(sw.preset);
  syncUi();
  await applyHardware();
}

// ---------------- Stream & lenses ----------------
const isVirtual = (l) => /dual|triple/i.test(l);
function lensKind(label) {
  if (/ultra/i.test(label)) return 'ultra';
  if (/tele/i.test(label)) return 'tele';
  return 'wide';
}
// Android (Chrome) labels cameras "camera2 0, facing back", "camera2 2, facing back"…
// The lowest-numbered back camera is the phone's main lens.
const androidIndex = (label) => { const m = /camera\s?2?\s*(\d+),\s*facing back/i.exec(label || ''); return m ? +m[1] : null; };
function androidMain(list) {
  const backs = list.filter((l) => androidIndex(l.label) != null);
  return backs.length ? backs.reduce((a, b) => (androidIndex(a.label) <= androidIndex(b.label) ? a : b)) : null;
}
function lensName(l, i, list = []) {
  const ai = androidIndex(l.label);
  if (ai != null) {
    const main = androidMain(list);
    return main && main.deviceId === l.deviceId ? 'Main camera' : `Other lens ${ai}`;
  }
  if (/^back camera$/i.test(l.label)) return 'Wide 1×';
  if (/ultra wide/i.test(l.label)) return 'Ultra Wide 0.5×';
  if (/telephoto/i.test(l.label)) return 'Telephoto';
  if (/dual wide/i.test(l.label)) return 'Dual Wide (auto)';
  if (/triple/i.test(l.label)) return 'Triple (auto)';
  if (/dual/i.test(l.label)) return 'Dual (auto)';
  return l.label ? l.label.replace(/camera2 /i, 'Camera ').replace(/, facing back/i, '') : `Back camera ${i + 1}`;
}
// Typical horizontal field of view across the long side, per lens type.
const DEFAULT_FOV = { wide: 64, ultra: 100, tele: 26 };

export function fov() {
  const key = track?.label || 'default';
  return fovMap[key] ?? DEFAULT_FOV[lensKind(track?.label || '')] ?? 64;
}
export function setFov(v) {
  fovMap[track?.label || 'default'] = v;
  save('camFovMap', fovMap);
}

async function refreshLenses() {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const back = all.filter((d) => /back|rear|environment|world/i.test(d.label));
    let list = back.length ? back : all;
    // Hide iPhone virtual multi-lens devices when the individual lenses are available.
    if (list.some((d) => /^back camera$/i.test(d.label))) list = list.filter((d) => !isVirtual(d.label));
    lenses = list.map((d, i) => ({ deviceId: d.deviceId, label: d.label, name: lensName(d, i, list), kind: lensKind(d.label) }));
  } catch { lenses = []; }
}

// Opens (or re-opens) the camera. On iPhones, prefer the plain 1× "Back Camera":
// the virtual Dual/Triple devices swap lenses on their own, which breaks the
// overlay's field-of-view calibration.
export async function open(deviceId = load('camDevice', null)) {
  stop();
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const constraints = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (e) {
    if (deviceId) { save('camDevice', null); return open(null); }
    throw e;
  }
  track = stream.getVideoTracks()[0];
  await refreshLenses();
  if (!deviceId && isVirtual(track.label)) {
    const wide = lenses.find((l) => /^back camera$/i.test(l.label));
    if (wide) return open(wide.deviceId);
  }
  // Android: Chrome's "environment" camera is sometimes the ultra-wide or telephoto lens.
  // Use the main lens so the overlay's field of view is right.
  if (!deviceId && androidIndex(track.label) != null) {
    const main = androidMain(lenses);
    if (main && main.label !== track.label) return open(main.deviceId);
  }
  renderLenses();
  await cameraStarted(track);
  onLensChange?.();
  return { stream, track };
}

export function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
}
export function liveTrack() { return track && track.readyState === 'live' ? track : null; }

function renderLenses() {
  const box = $('lensBox');
  if (!box) return;
  if (lenses.length < 2) { box.innerHTML = ''; $('lensHead').classList.add('hidden'); return; }
  $('lensHead').classList.remove('hidden');
  const cur = track?.getSettings?.().deviceId;
  box.innerHTML = lenses.map((l, i) => `<button data-i="${i}" class="${l.deviceId === cur || l.label === track?.label ? 'on' : ''}"><b>${l.name}</b><span>${l.kind === 'ultra' ? 'Widest view' : l.kind === 'tele' ? 'Zoomed, needs steady hands' : 'Best for most use'}</span></button>`).join('');
  box.onclick = async (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const l = lenses[+b.dataset.i];
    save('camDevice', l.deviceId);
    $('camErr').textContent = '';
    try { await openFromUi(l.deviceId); } catch (err) { $('camErr').textContent = `Could not switch lens (${err.name}).`; }
  };
}
let openFromUi = (id) => open(id);
export function setOpenHandler(fn) { openFromUi = fn; }

export function setCss(transform) { video.style.transform = transform; fx.style.transform = transform; }
export function show(on) { visible = on; updateVisibility(); }
