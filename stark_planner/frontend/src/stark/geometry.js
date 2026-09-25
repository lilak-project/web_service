// Turns the component list into placed detector faces and the angles they see.

import { DET_TYPES } from './data.js'

const R2D = 180 / Math.PI;

const detType = (r) => DET_TYPES[r.det] || DET_TYPES.X6;

// `flip` mirrors the whole ring about its own front-face plane, so a ring
// built for the downstream side can be reused facing upstream.
const sgn = (r) => (r.flip ? -1 : 1);

// A `bare` ring has no frame: its z IS the detector centre, and it claims no
// volume, so it can sit anywhere — for sketching a layout before there is a
// mechanical design to hang it on.
const isBare = (r) => r.mount === 'bare';

function detCentreZ(r) {
  if (isBare(r)) return +r.z;
  const t = detType(r), s = sgn(r);
  const h = t.shape === 'rect' ? t.h : 0;
  return r.offMode === 'edge' ? r.z + s * (+r.off + h / 2) : r.z + s * (+r.off);
}

// The z a ring's BODY occupies. A bare ring has none, so report the wafers'
// own extent instead — z-edit still needs something to draw.
function ringZSpan(r) {
  if (isBare(r)) {
    const t = detType(r), zc = +r.z;
    const h = t.shape === 'rect' ? t.h : Math.max(1, t.thick / 1000);
    return [zc - h / 2, zc + h / 2];
  }
  const s = sgn(r);
  const a = r.z + s * (+r.z1 || 0), b = r.z + s * (+r.z2 || 0);
  return [Math.min(a, b), Math.max(a, b)];
}

// Placed faces for one ring. Barrel faces are flat plates tangent at r;
// annular faces are equal wafer sectors normal to z, facing the target.
function faces(r, zt) {
  const t = detType(r), zc = detCentreZ(r), out = [];
  const n = Math.max(1, Math.round(r.div));
  for (let k = 0; k < n; k++) {
    const phi = ((+r.phi0 || 0) + (360 / n) * k) * Math.PI / 180;
    if (r.dir === 1) {
      const c = Math.cos(phi), s = Math.sin(phi);
      out.push({
        kind: 'rect', idx: k, phi: phi * R2D,
        C: [r.r * c, r.r * s, zc],
        N: [-c, -s, 0], U: [s, -c, 0], V: [0, 0, 1],
        w: t.w, h: t.h, thick: t.thick,
      });
    } else {
      // phi0 is the detector CENTRE for both facings, so a wafer runs from
      // centre - span/2 to centre + span/2. The QQQ5 frame's four spokes sit on
      // the axes with the wafers between them, i.e. centred on the diagonals.
      const span = 360 / n;
      out.push({
        kind: 'annular', idx: k, phi: phi * R2D,
        C: [0, 0, zc], N: [0, 0, zc > (zt || 0) ? -1 : 1],
        rin: t.rin, rout: t.rout,
        phiStart: phi * R2D - span / 2, phiSpan: span, thick: t.thick,
      });
    }
  }
  return out;
}

// What fraction of azimuth the wafers fill, and how much of the theta shell
// they subtend actually reaches silicon.
function ringCoverage(r, T) {
  const t = detType(r), n = Math.max(1, Math.round(r.div));
  const fs = faces(r, T[2]);
  let omega = 0, tmin = 1e9, tmax = -1e9;
  for (const fc of fs) {
    const a = faceAngles(fc, T);
    omega += a.omega;
    tmin = Math.min(tmin, a.thetaMin); tmax = Math.max(tmax, a.thetaMax);
  }
  const dphi = r.dir === 1 ? 2 * Math.atan(t.w / 2 / r.r) * R2D : 360 / n;
  const shell = 2 * Math.PI * Math.abs(Math.cos(tmin / R2D) - Math.cos(tmax / R2D));
  return {
    dphi, nDet: n,
    phiFrac: Math.min(1, n * dphi / 360),
    omega, eff4pi: omega / (4 * Math.PI),
    effShell: shell > 0 ? Math.min(1, omega / shell) : 0,
    thetaMin: tmin, thetaMax: tmax,
  };
}

// Free-standing detector: a plate at (x, y, z) turned to face the target.
function singleFace(d, T) {
  const t = DET_TYPES[d.det] || DET_TYPES.W1;
  const C = [+d.x || 0, +d.y || 0, +d.z || 0];
  let N;
  if (d.facing === 'z') N = [0, 0, C[2] > T[2] ? -1 : 1];
  else if (d.facing === 'r') { const m = Math.hypot(C[0], C[1]) || 1; N = [-C[0] / m, -C[1] / m, 0]; }
  else { const v = [T[0] - C[0], T[1] - C[1], T[2] - C[2]], m = Math.hypot(...v) || 1; N = v.map((q) => q / m); }
  // build an orthonormal frame with V as close to +z as the normal allows
  let V = [0, 0, 1];
  if (Math.abs(N[2]) > 0.98) V = [0, 1, 0];
  const Uv = norm(cross(V, N));
  const Vv = norm(cross(N, Uv));
  return { kind: 'rect', idx: 0, phi: Math.atan2(C[1], C[0]) * R2D, C, N, U: Uv, V: Vv, w: t.w, h: t.h, thick: t.thick };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const m = Math.hypot(...a) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const theta = (P, T) => Math.atan2(Math.hypot(P[0] - T[0], P[1] - T[1]), P[2] - T[2]) * R2D;

// Angles and solid angle a single face subtends from the interaction point T.
function faceAngles(f, T, nu, nv) {
  nu = nu || 12; nv = nv || 20;
  let omega = 0, tmin = 1e9, tmax = -1e9;
  if (f.kind === 'rect') {
    const dA = (f.w / nu) * (f.h / nv);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = (i + 0.5) / nu - 0.5, b = (j + 0.5) / nv - 0.5;
        const P = [
          f.C[0] + a * f.w * f.U[0] + b * f.h * f.V[0],
          f.C[1] + a * f.w * f.U[1] + b * f.h * f.V[1],
          f.C[2] + a * f.w * f.U[2] + b * f.h * f.V[2],
        ];
        const d = sub(P, T), r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, r = Math.sqrt(r2);
        omega += dA * Math.abs((d[0] * f.N[0] + d[1] * f.N[1] + d[2] * f.N[2]) / r) / r2;
      }
    }
    // the grid samples cell centres, so take the extremes off the real edges
    for (const a of [-0.5, 0, 0.5]) {
      for (const b of [-0.5, 0, 0.5]) {
        const th = theta([
          f.C[0] + a * f.w * f.U[0] + b * f.h * f.V[0],
          f.C[1] + a * f.w * f.U[1] + b * f.h * f.V[1],
          f.C[2] + a * f.w * f.U[2] + b * f.h * f.V[2],
        ], T);
        if (th < tmin) tmin = th; if (th > tmax) tmax = th;
      }
    }
  } else {
    for (let i = 0; i < nv; i++) {
      const r0 = f.rin + (f.rout - f.rin) * (i / nv), r1 = f.rin + (f.rout - f.rin) * ((i + 1) / nv);
      const rm = (r0 + r1) / 2, dA = (r1 * r1 - r0 * r0) / 2 * (f.phiSpan * Math.PI / 180);
      const P = [rm * Math.cos(f.phiStart * Math.PI / 180), rm * Math.sin(f.phiStart * Math.PI / 180), f.C[2]];
      const d = sub(P, T), r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, r = Math.sqrt(r2);
      omega += dA * Math.abs(d[2] / r) / r2;
      for (const rr of [r0, r1]) {
        const th = Math.atan2(rr, f.C[2] - T[2]) * R2D;
        if (th < tmin) tmin = th; if (th > tmax) tmax = th;
      }
    }
  }
  // centre-of-face angles, the number usually quoted per ring
  const thc = theta(f.C, T);
  const cen = f.kind === 'rect'
    ? [theta(add(f.C, scale(f.V, -f.h / 2)), T), theta(add(f.C, scale(f.V, f.h / 2)), T)]
    : [Math.atan2(f.rout, f.C[2] - T[2]) * R2D, Math.atan2(f.rin, f.C[2] - T[2]) * R2D];
  return {
    omega, thetaMin: tmin, thetaMax: tmax, thetaC: thc,
    th1: Math.min(cen[0], cen[1]), th2: Math.max(cen[0], cen[1]),
  };
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Spread in theta introduced by the finite beam spot and target thickness.
// Samples the interaction point rather than propagating derivatives.
function spotSpread(f, T, spot) {
  if (!spot || (!spot.sx && !spot.sy && !spot.dz)) return { sigma: 0, min: 0, max: 0 };
  const N = 240; let s = 0, s2 = 0, mn = 1e9, mx = -1e9;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const base = theta(f.C, T);
  for (let i = 0; i < N; i++) {
    const P = [T[0] + spot.x + gauss() * spot.sx, T[1] + spot.y + gauss() * spot.sy,
      T[2] + (rnd() - 0.5) * (spot.dz || 0)];
    const th = theta(f.C, P) - base;
    s += th; s2 += th * th;
    if (th < mn) mn = th; if (th > mx) mx = th;
  }
  const m = s / N;
  return { sigma: Math.sqrt(Math.max(0, s2 / N - m * m)), min: mn, max: mx };
}

// Does the ray T + t*d land inside this face?
function hits(f, T, d) {
  if (f.kind === 'rect') {
    const dn = d[0] * f.N[0] + d[1] * f.N[1] + d[2] * f.N[2];
    if (Math.abs(dn) < 1e-9) return false;
    const w = sub(f.C, T);
    const t = (w[0] * f.N[0] + w[1] * f.N[1] + w[2] * f.N[2]) / dn;
    if (t <= 0) return false;
    const p = [T[0] + t * d[0] - f.C[0], T[1] + t * d[1] - f.C[1], T[2] + t * d[2] - f.C[2]];
    const u = p[0] * f.U[0] + p[1] * f.U[1] + p[2] * f.U[2];
    if (Math.abs(u) > f.w / 2) return false;
    const v = p[0] * f.V[0] + p[1] * f.V[1] + p[2] * f.V[2];
    return Math.abs(v) <= f.h / 2;
  }
  if (Math.abs(d[2]) < 1e-9) return false;
  const t = (f.C[2] - T[2]) / d[2];
  if (t <= 0) return false;
  const x = T[0] + t * d[0], y = T[1] + t * d[1], r = Math.hypot(x, y);
  if (r < f.rin || r > f.rout) return false;
  let a = (Math.atan2(y, x) * R2D - f.phiStart) % 360;
  if (a < 0) a += 360;
  return a <= f.phiSpan;
}

// Solid angle that has at least one wafer in front of it. Stacked dE-E
// layers cover the same directions, so summing per-wafer solid angles
// double-counts them; this counts the sky instead.
// ponytail: fixed 120x240 direction grid, ~0.3% resolution. Raise if you
// start caring about sub-percent acceptance.
function uniqueAcceptance(allFaces, T) {
  const NC = 120, NP = 240;
  let hit = 0;
  for (let i = 0; i < NC; i++) {
    const c = 1 - 2 * (i + 0.5) / NC, s = Math.sqrt(Math.max(0, 1 - c * c));
    for (let j = 0; j < NP; j++) {
      const a = 2 * Math.PI * (j + 0.5) / NP;
      const d = [s * Math.cos(a), s * Math.sin(a), c];
      for (let k = 0; k < allFaces.length; k++) {
        if (hits(allFaces[k], T, d)) { hit++; break; }
      }
    }
  }
  return 4 * Math.PI * hit / (NC * NP);
}

// --- telescope pairing -------------------------------------------------------
// The two layers of a dE-E pair sit at different radii, so the same z gives them
// different theta coverage. Their edge angles can only be matched exactly when
// h/r happens to agree, which it does not for X6 vs BB10 — so solve for the z
// that minimises the two edge mismatches rather than pretend it is exact.

// Theta the ring's face-centre edges see from T, optionally at a hypothetical z.
function edgeAngles(r, T, zTry) {
  const f = faces(zTry === undefined ? r : { ...r, z: zTry }, T[2])[0];
  if (!f) return null;
  const a = faceAngles(f, T, 4, 6);
  return [a.th1, a.th2];
}

const mismatch = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null);

/**
 * The z for `ring` that best lines its theta coverage up with `ref`.
 * Coarse scan then a bisecting refine — the cost is smooth with one minimum over
 * any sane range, so this stays obvious instead of clever.
 */
function matchZ(ring, ref, T, range) {
  const want = edgeAngles(ref, T);
  if (!want) return null;
  const cost = (z) => {
    const got = edgeAngles(ring, T, z);
    return got ? (got[0] - want[0]) ** 2 + (got[1] - want[1]) ** 2 : Infinity;
  };
  const span = range || 400;
  let best = +ring.z, bestC = cost(best);
  for (let z = +ring.z - span; z <= +ring.z + span; z += 2) {
    const c = cost(z);
    if (c < bestC) { bestC = c; best = z; }
  }
  for (let d = 1; d >= 0.05; d /= 2) {
    for (const z of [best - d, best + d]) {
      const c = cost(z);
      if (c < bestC) { bestC = c; best = z; }
    }
  }
  return {
    z: Math.round(best * 10) / 10, want,
    before: mismatch(edgeAngles(ring, T), want),
    after: mismatch(edgeAngles(ring, T, best), want),
  };
}

// Rings may not share z AND radial space.
function collisions(rings) {
  const bad = new Set();
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i], b = rings[j];
      if (!a.enabled || !b.enabled) continue;
      if (isBare(a) || isBare(b)) continue;   // no frame, nothing to clash with
      const [a1, a2] = ringZSpan(a), [b1, b2] = ringZSpan(b);
      const zOv = a1 < b2 && b1 < a2;
      const rOv = (+a.rmin) < (+b.rmax) && (+b.rmin) < (+a.rmax);
      if (zOv && rOv) { bad.add(a.id); bad.add(b.id); }
    }
  }
  return bad;
}

export const GEO = {
  detType, detCentreZ, ringZSpan, faces, singleFace, faceAngles,
  ringCoverage, uniqueAcceptance, hits, spotSpread, collisions, theta, isBare,
  edgeAngles, mismatch, matchZ,
};
