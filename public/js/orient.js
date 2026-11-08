// Device orientation -> camera basis vectors in the local ENU frame
// (x = east, y = north, z = up). Also supports a manual (drag) view.
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => ((a + 540) % 360) - 180;

function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export class Orientation {
  constructor() {
    this.mode = 'manual'; // 'sensor' | 'manual'
    this.view = { az: 180, alt: 35 };
    this.yawOffset = load('yawOffset', 0); // user calibration, degrees
    this.raw = null; // latest sensor basis
    this.basis = null; // smoothed basis {right, up, fwd}
    this.absolute = false;
    this.iosOffset = null; // alpha -> true heading offset on iOS
    this.lastEvent = 0;
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

  _onEvt(e, absEvt) {
    if (e.alpha == null || e.beta == null) return;
    let alpha = e.alpha;
    const ios = typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading);
    if (ios) {
      // iOS: e.alpha is gyro-stable but has an arbitrary zero; webkitCompassHeading is
      // magnetic but jumps near vertical. Learn the offset while the phone is not upright.
      const cand = wrap360(360 - e.webkitCompassHeading - e.alpha);
      const reliable = Math.abs(e.beta) < 70 && Math.abs(e.gamma) < 40;
      if (this.iosOffset == null) this.iosOffset = cand;
      else if (reliable) this.iosOffset = wrap360(this.iosOffset + wrap180(cand - this.iosOffset) * 0.05);
      alpha = e.alpha + this.iosOffset;
      this.absolute = true;
      // iOS reports the compass uncertainty in degrees (−1 = needs calibration).
      if (typeof e.webkitCompassAccuracy === 'number') this.accuracy = e.webkitCompassAccuracy;
    } else if (absEvt || e.absolute) {
      this.absolute = true;
    } else if (this.absolute) {
      return; // prefer absolute events when the browser provides both
    }
    this.lastEvent = performance.now();
    this.raw = this._basisFromEuler(alpha, e.beta, e.gamma || 0);
  }

  _basisFromEuler(alpha, beta, gamma) {
    const [a, b, g] = [alpha * D2R, beta * D2R, gamma * D2R];
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    // Columns of R = Rz(a) Rx(b) Ry(g): device axes expressed in ENU.
    const X = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
    const Y = [-cB * sA, cA * cB, sB];
    const Z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
    const th = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * D2R;
    const c = Math.cos(th), s = Math.sin(th);
    const right = [c * X[0] - s * Y[0], c * X[1] - s * Y[1], c * X[2] - s * Y[2]];
    const up = [s * X[0] + c * Y[0], s * X[1] + c * Y[1], s * X[2] + c * Y[2]];
    return { right, up, fwd: [-Z[0], -Z[1], -Z[2]] };
  }

  _basisFromView(az, alt) {
    const a = az * D2R, h = alt * D2R;
    const fwd = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
    let right = norm(cross(fwd, [0, 0, 1]));
    if (!Number.isFinite(right[0]) || Math.abs(alt) > 89.9) right = [Math.cos(a), -Math.sin(a), 0];
    const up = cross(right, fwd);
    return { right, up, fwd };
  }

  _yaw(v) {
    const o = this.yawOffset * D2R, c = Math.cos(o), s = Math.sin(o);
    return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
  }

  // Call once per frame. Returns the smoothed basis.
  update(zoom = 1) {
    let target;
    if (this.mode === 'sensor' && this.raw) {
      target = { right: this._yaw(this.raw.right), up: this._yaw(this.raw.up), fwd: this._yaw(this.raw.fwd) };
    } else {
      target = this._basisFromView(this.view.az, this.view.alt);
    }
    if (!this.basis) this.basis = target;
    else {
      // Heavier smoothing when zoomed in, so sensor jitter isn't magnified.
      const k = this.mode === 'sensor' ? 0.22 / Math.sqrt(zoom) : 0.5;
      let fwd = norm(lerp(this.basis.fwd, target.fwd, k));
      let up = lerp(this.basis.up, target.up, k);
      up = norm(up.map((x, i) => x - dot(up, fwd) * fwd[i]));
      this.basis = { fwd, up, right: cross(fwd, up) };
    }
    return this.basis;
  }

  // Where the centre of the screen points.
  pointing() {
    const f = this.basis?.fwd || [0, 1, 0];
    return { az: wrap360(Math.atan2(f[0], f[1]) * R2D), alt: Math.asin(Math.max(-1, Math.min(1, f[2]))) * R2D };
  }

  calibrateTo(az) {
    const cur = this.pointing().az;
    this.yawOffset = wrap180(this.yawOffset + wrap180(az - cur));
    save('yawOffset', this.yawOffset);
  }

  resetCalibration() { this.yawOffset = 0; save('yawOffset', 0); }
}

export { dot, load, save };
