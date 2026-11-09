// Device orientation -> camera basis in the local East-North-Up frame
// (x = east, y = north, z = up). Also supports a manual (drag) view.
//
// Pipeline
//  1. Sensor attitude -> rotation matrix R (device axes in ENU). Built from the
//     W3C Euler angles, which is continuous as a physical rotation even where the
//     angles themselves wrap.
//  2. iOS only: the gyro frame has an arbitrary, slowly drifting north (WebKit uses
//     CoreMotion's XArbitraryZVertical frame). Its offset to magnetic north is learned
//     from webkitCompassHeading, which WebKit takes from CLHeading.magneticHeading
//     (portrait) = bearing of the phone's TOP EDGE. That heading is low-pass filtered
//     and 1°-quantised by iOS, so it lags. It is therefore only trusted while the
//     phone has been still for a moment, away from vertical, and it can only nudge
//     north slowly: the gyro drives all motion.
//  3. Screen rotation, user calibration (yaw offset).
//  4. Adaptive quaternion smoothing (One-Euro style): strong when still (no jitter),
//     near-zero lag when moving fast. Slerp never degenerates on big swings.
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => ((a + 540) % 360) - 180;
const angleBetween = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * R2D;
const bearing = (v) => Math.atan2(v[0], v[1]) * R2D; // azimuth of a vector's horizontal part

function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

// ---------- rotation helpers ----------
// Device axes (columns of R = Rz(a) Rx(b) Ry(g)) in ENU.
function eulerAxes(alpha, beta, gamma) {
  const [a, b, g] = [alpha * D2R, beta * D2R, gamma * D2R];
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return {
    X: [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG],
    Y: [-cB * sA, cA * cB, sB],
    Z: [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG],
  };
}
// Rotate a vector about the vertical axis so its azimuth increases by `deg`.
function yawVec(v, deg) {
  const o = deg * D2R, c = Math.cos(o), s = Math.sin(o);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}
// Basis {right, up, fwd} <-> unit quaternion (of the matrix with columns right, up, -fwd).
function basisToQuat({ right: r, up: u, fwd: f }) {
  const b = [-f[0], -f[1], -f[2]];
  const m00 = r[0], m01 = u[0], m02 = b[0], m10 = r[1], m11 = u[1], m12 = b[1], m20 = r[2], m21 = u[2], m22 = b[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = 0.25 * S; x = (m21 - m12) / S; y = (m02 - m20) / S; z = (m10 - m01) / S; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / S; x = 0.25 * S; y = (m01 + m10) / S; z = (m02 + m20) / S; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / S; x = (m01 + m10) / S; y = 0.25 * S; z = (m12 + m21) / S; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / S; x = (m02 + m20) / S; y = (m12 + m21) / S; z = 0.25 * S; }
  const l = Math.hypot(w, x, y, z) || 1;
  return [w / l, x / l, y / l, z / l];
}
function quatToBasis([w, x, y, z]) {
  const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const back = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  return { right, up, fwd: [-back[0], -back[1], -back[2]] };
}
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; } // shortest path
  if (d > 0.9995) { const r = a.map((v, i) => v + (b[i] - v) * t); const l = Math.hypot(...r); return r.map((v) => v / l); }
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return a.map((v, i) => v * ka + b[i] * kb);
}
const quatAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * R2D;

export class Orientation {
  constructor() {
    this.mode = 'manual'; // 'sensor' | 'manual'
    this.view = { az: 180, alt: 35 };
    this.yawOffset = load('yawOffset', 0); // user calibration (Align), degrees
    this.declination = 0; // magnetic -> true north (WMM), degrees east-positive
    this.raw = null; // latest sensor axes {X,Y,Z} in ENU, north-corrected
    this.basis = null; // smoothed camera basis {right, up, fwd}
    this.absolute = false;
    this.accuracy = null;
    this.lastEvent = 0;
    // iOS compass fusion state
    this.ios = { delta: null, acquiredAt: 0, lastT: 0, stillSince: 0, prev: null, speed: 0, outlierT: 0,
      trusted: false, trustedAt: 0, regime: null, splitModel: load('iosSplitModel', null), votes: { top: 0, cam: 0 } };
    // smoothing state
    this.q = null;
    this.qt = 0;
    this.speed = 0;
    this._onEvt = this._onEvt.bind(this);
  }

  async start() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error('No orientation sensor available');
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('deviceorientationabsolute', (e) => this._onEvt(e, true));
      window.addEventListener('deviceorientation', (e) => this._onEvt(e, false));
    }
    if (typeof DOE.requestPermission === 'function') {
      // iOS needs this (inside the tap). Some Chromium builds expose it too and may never resolve.
      const p = await Promise.race([
        DOE.requestPermission().catch(() => 'denied'),
        new Promise((r) => setTimeout(() => r('timeout'), 6000)),
      ]);
      if (p === 'denied' && !this.raw) {
        this.denied = true;
        throw new Error('Motion & orientation access was denied. To allow it, close this tab, reopen the site and tap Allow. Until then, drag to look around.');
      }
    }
  }

  get hasSensor() { return performance.now() - this.lastEvent < 2000; }

  // Human-readable compass state for the HUD.
  get status() {
    if (!this.hasSensor) return null;
    if (this.isIOS && this.ios.delta == null) return 'finding north: hold still';
    if (this.isIOS && !this.ios.trusted && !this.ios.splitModel) return 'north is provisional: lower the phone for a second';
    return null;
  }

  _onEvt(e, absEvt) {
    if (e.alpha == null || e.beta == null) return;
    const now = performance.now();
    const ios = typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading);
    let ax = eulerAxes(e.alpha, e.beta, e.gamma || 0);
    if (ios) {
      this.isIOS = true;
      if (typeof e.webkitCompassAccuracy === 'number') this.accuracy = e.webkitCompassAccuracy;
      this._iosFuse(ax, e.webkitCompassHeading, this.accuracy, now);
      if (this.ios.delta == null) { this.lastEvent = now; return; } // north unknown yet
      ax = { X: yawVec(ax.X, this.ios.delta), Y: yawVec(ax.Y, this.ios.delta), Z: yawVec(ax.Z, this.ios.delta) };
      this.absolute = true;
    } else if (absEvt || e.absolute) {
      this.absolute = true;
    } else if (this.absolute) {
      return; // prefer absolute events when the browser provides both
    }
    this.lastEvent = now;
    this.raw = ax;
  }

  // Learns delta = (magnetic north frame) − (gyro frame), as an azimuth rotation.
  //
  // iOS's heading has a certain meaning only in some poses:
  //  • flat (screen up): bearing of the phone's top edge, as in the Compass app;
  //  • held normally (camera towards the horizon/ground): top edge and camera point the
  //    same way, so either definition gives the same answer.
  // When the camera points UP (or the phone is upside down) the top edge and the camera
  // point opposite ways; real iPhones report the camera's direction there ('cam'). That
  // is used by default, verified against trusted readings whenever both are seen, and
  // the verified answer is remembered for next time.
  _iosFuse(ax, heading, accuracy, now) {
    const s = this.ios;
    // How fast is the phone turning? (gyro frame, no compass involved)
    if (s.prev) {
      const dt = (now - s.prev.t) / 1000;
      if (dt > 0.002) {
        const rate = Math.max(angleBetween(ax.Z, s.prev.Z), angleBetween(ax.Y, s.prev.Y)) / dt;
        s.speed += (rate - s.speed) * Math.min(1, dt / 0.08);
      }
    }
    s.prev = { t: now, Z: ax.Z, Y: ax.Y };
    if (s.speed > 6) s.stillSince = now;
    const dt = Math.min(0.2, s.lastT ? (now - s.lastT) / 1000 : 0.016);
    s.lastT = now;
    if (!(heading >= 0)) return;
    if (accuracy != null && accuracy < 0 && s.delta != null) return; // iOS says: compass needs calibration

    const Yh = Math.hypot(ax.Y[0], ax.Y[1]);
    const F = [-ax.Z[0], -ax.Z[1], -ax.Z[2]];
    const Fh = Math.hypot(F[0], F[1]);
    const bTop = bearing(ax.Y), bCam = bearing(F);
    const sep = Math.abs(wrap180(bTop - bCam));
    let regime = null;
    if (ax.Z[2] > 0.85 && Yh > 0.5) regime = 'flat'; // lying flat: Compass-app pose
    else if (Yh > 0.2 && Fh > 0.4 && sep < 20) regime = 'agree'; // held normally: top edge & camera agree
    else if (Yh > 0.2 && Fh > 0.4 && sep > 160) regime = 'split'; // pointing up / upside down
    else if (Yh <= 0.2 && Fh > 0.9) regime = 'split'; // upright at the horizon: top edge vertical, only the camera has a bearing
    s.regime = regime;
    if (!regime) return; // both axes near vertical: heading meaningless there
    const settled = now - s.stillSince > (s.delta == null ? 250 : 700); // iOS's heading filter lags motion
    if (!settled) return;

    const candTop = wrap180(heading - bTop), candCam = wrap180(heading - bCam);
    if (regime !== 'split') {
      this._applyDelta(candTop, true, accuracy, dt, now);
      return;
    }
    // Split pose. Learn which definition this phone uses by checking both against
    // a north that was established from trusted readings (and carried by the gyro).
    if (s.trusted && now - s.trustedAt < 90000 && s.delta != null) {
      const eTop = Math.abs(wrap180(candTop - s.delta)), eCam = Math.abs(wrap180(candCam - s.delta));
      if (eCam < 20 && eTop > 140) s.votes.cam++;
      else if (eTop < 20 && eCam > 140) s.votes.top++;
      const lead = s.votes.cam - s.votes.top;
      if (lead >= 25 && s.splitModel !== 'cam') { s.splitModel = 'cam'; save('iosSplitModel', 'cam'); }
      if (lead <= -25 && s.splitModel !== 'top') { s.splitModel = 'top'; save('iosSplitModel', 'top'); }
    }
    const model = s.splitModel || 'cam';
    const verified = !!s.splitModel;
    if (model === 'top' && Yh <= 0.2) return; // top-edge bearing undefined when upright
    // Without trusted north, a split reading is still the best we have (provisional).
    if (s.trusted && !verified) return; // keep trusted north; don't let an unverified reading move it
    this._applyDelta(model === 'cam' ? candCam : candTop, verified, accuracy, dt, now);
  }

  _applyDelta(cand, trusted, accuracy, dt, now) {
    const s = this.ios;
    if (s.delta == null || (trusted && !s.trusted)) {
      // First fix, or first trusted fix after a provisional one: take it directly.
      if (s.delta == null || Math.abs(wrap180(cand - s.delta)) > 3) { s.delta = cand; s.acquiredAt = now; }
      s.outlierT = 0;
      if (trusted) { s.trusted = true; s.trustedAt = now; }
      return;
    }
    const err = wrap180(cand - s.delta);
    const acquiring = now - s.acquiredAt < 3000;
    if (!acquiring && Math.abs(err) > 25) {
      // Big disagreement: a magnet/metal nearby or a stale reading. Only accept if it persists.
      s.outlierT += dt;
      if (s.outlierT > 4) { s.delta = cand; s.acquiredAt = now; s.outlierT = 0; }
      return;
    }
    s.outlierT = 0;
    if (trusted) s.trustedAt = now;
    const poor = accuracy != null && accuracy > 25;
    const tau = acquiring ? 0.5 : poor ? 12 : 5; // seconds
    s.delta = wrap180(s.delta + err * (1 - Math.exp(-dt / tau)));
  }

  _sensorBasis() {
    const { X, Y, Z } = this.raw;
    const th = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * D2R;
    const c = Math.cos(th), s = Math.sin(th);
    let right = [c * X[0] - s * Y[0], c * X[1] - s * Y[1], c * X[2] - s * Y[2]];
    let up = [s * X[0] + c * Y[0], s * X[1] + c * Y[1], s * X[2] + c * Y[2]];
    let fwd = [-Z[0], -Z[1], -Z[2]];
    // Compasses measure magnetic north; the sky is laid out on true north.
    const yaw = this.yawOffset + (this.absolute ? this.declination : 0);
    if (yaw) { right = yawVec(right, yaw); up = yawVec(up, yaw); fwd = yawVec(fwd, yaw); }
    return { right, up, fwd };
  }

  _basisFromView(az, alt) {
    const a = az * D2R, h = alt * D2R;
    const fwd = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
    let right = norm(cross(fwd, [0, 0, 1]));
    if (!Number.isFinite(right[0]) || Math.abs(alt) > 89.9) right = [Math.cos(a), -Math.sin(a), 0];
    const up = cross(right, fwd);
    return { right, up, fwd };
  }

  // Call once per frame. Returns the smoothed basis.
  update(zoom = 1) {
    const sensor = this.mode === 'sensor' && this.raw;
    const target = basisToQuat(sensor ? this._sensorBasis() : this._basisFromView(this.view.az, this.view.alt));
    const now = performance.now();
    if (!this.q) { this.q = target; this.qt = now; this.basis = quatToBasis(target); return this.basis; }
    const dt = Math.min(0.1, Math.max(0.001, (now - this.qt) / 1000));
    this.qt = now;
    // One-Euro filter on rotation: the cutoff rises with how fast the *target* turns.
    // That speed is itself low-passed and given a dead-zone, so sensor noise
    // (a few tenths of a degree per sample) never looks like motion.
    const tSpeed = this.prevTarget ? quatAngle(this.prevTarget, target) / dt : 0;
    this.prevTarget = target;
    this.speed += (tSpeed - this.speed) * (1 - Math.exp(-dt / 0.06));
    const moving = Math.max(0, this.speed - (sensor ? 12 : 0)); // deg/s above the noise floor
    const z = Math.max(1, zoom);
    const fMin = sensor ? 1.1 / Math.sqrt(z) : 6; // Hz when still (lower = smoother)
    const fc = fMin + (sensor ? 0.16 : 0.3) * moving; // Hz
    const k = 1 - Math.exp(-2 * Math.PI * fc * dt);
    this.q = slerp(this.q, target, Math.min(1, k));
    this.basis = quatToBasis(this.q);
    return this.basis;
  }

  // Where the centre of the screen points. The azimuth of a camera aimed straight
  // down/up is undefined, so the heading blends towards the phone's top edge
  // (looking down: same as a flat compass app) or bottom edge (looking up).
  // Both point the same way as the camera's horizontal direction, so it's seamless.
  pointing() {
    const f = this.basis?.fwd || [0, 1, 0];
    const u = this.basis?.up || [0, 0, 1];
    const alt = Math.asin(Math.max(-1, Math.min(1, f[2]))) * R2D;
    const sgn = f[2] < 0 ? 1 : -1;
    // Unit horizontal directions of the camera and of the relevant phone edge.
    const fl = Math.hypot(f[0], f[1]) || 1e-9, ul = Math.hypot(u[0], u[1]) || 1e-9;
    const fd = [f[0] / fl, f[1] / fl], ud = [(sgn * u[0]) / ul, (sgn * u[1]) / ul];
    // Camera direction below 60° of tilt, phone edge beyond 80°, smooth in between.
    const t = Math.min(1, Math.max(0, (Math.abs(alt) - 60) / 20));
    const k = t * t * (3 - 2 * t);
    const hx = fd[0] * (1 - k) + ud[0] * k, hy = fd[1] * (1 - k) + ud[1] * k;
    return { az: wrap360(Math.atan2(hx, hy) * R2D), alt };
  }

  calibrateTo(az) {
    const cur = this.pointing().az;
    this.yawOffset = wrap180(this.yawOffset + wrap180(az - cur));
    save('yawOffset', this.yawOffset);
  }

  resetCalibration() { this.yawOffset = 0; save('yawOffset', 0); }
}

export { dot, load, save };
