// Relativistic two-body kinematics, beam optics, energy loss.
// Units: MeV, mm, degrees at the boundary; radians inside.

import NUCLIDES from './nuclides.js'

// The silicon dE tables are ~800 kB; loadEloss() pulls them in on demand and
// everything that needs them degrades to null until it resolves.
let elossSi = null
export const elossReady = () => !!elossSi
export async function loadEloss() {
  if (!elossSi) elossSi = (await import('./eloss_si.js')).default
  return elossSi
}

const U = 931.49410242;      // atomic mass unit, MeV
const ME = 0.51099895;       // electron mass, MeV
const K = 0.307075;          // MeV cm2/mol, Bethe coefficient
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// NUBASE mass excesses are atomic, so strip the electrons: kinematics needs
// nuclear masses. (Q values are unaffected either way - Z is conserved.)
function nuc(name) {
  const e = NUCLIDES && NUCLIDES[name];
  if (!e) return null;
  return { Z: e[0], A: e[1], dm: e[2], m: e[1] * U + e[2] / 1000 - e[0] * ME };
}

// ---- two-body kinematics -------------------------------------------------
// 1(beam) + 2(target) -> 3(ejectile) + 4(recoil, left at excitation Ex)
function reaction(beamName, targName, ejName, Tbeam, Ex) {
  const n1 = nuc(beamName), n2 = nuc(targName), n3 = nuc(ejName);
  if (!n1 || !n2 || !n3) return { ok: false, err: 'unknown nuclide' };
  const Z4 = n1.Z + n2.Z - n3.Z, A4 = n1.A + n2.A - n3.A;
  if (Z4 < 0 || A4 < 1 || A4 < Z4) return { ok: false, err: 'unphysical recoil' };
  const rec = recoilName(Z4, A4);
  const n4 = rec && nuc(rec);
  if (!n4) return { ok: false, err: 'recoil Z=' + Z4 + ' A=' + A4 + ' not in mass table' };

  const m1 = n1.m, m2 = n2.m, m3 = n3.m, m4 = n4.m + (Ex || 0);
  const Q = m1 + m2 - m3 - n4.m;                       // ground-state Q
  const E1 = Tbeam + m1, p1 = Math.sqrt(Math.max(0, E1 * E1 - m1 * m1));
  const s = m1 * m1 + m2 * m2 + 2 * E1 * m2, rs = Math.sqrt(s);
  const beta = p1 / (E1 + m2), gamma = 1 / Math.sqrt(1 - beta * beta);

  const thr = (m3 + m4) * (m3 + m4);
  const open = s >= thr;
  const pf = open
    ? Math.sqrt((s - (m3 + m4) ** 2) * (s - (m3 - m4) ** 2)) / (2 * rs) : 0;

  // Sample the CM angle; everything else is read off this curve.
  const N = 721, cm = new Float64Array(N), lab3 = new Float64Array(N);
  const T3 = new Float64Array(N), lab4 = new Float64Array(N), T4 = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const th = (i / (N - 1)) * Math.PI;
    cm[i] = th;
    const s3 = boost(pf, m3, th, beta, gamma);
    lab3[i] = s3.theta; T3[i] = s3.T;
    const s4 = boost(pf, m4, Math.PI - th, beta, gamma);
    lab4[i] = s4.theta; T4[i] = s4.T;
  }
  return {
    ok: open, err: open ? '' : 'below threshold',
    n1, n2, n3, n4, recName: rec, Q, Tbeam, Ex: Ex || 0,
    beta, gamma, rs, pf, cm, lab3, T3, lab4, T4,
    maxLab3: Math.max(...lab3) * R2D,
    // ejectile kinetic energy + CM angles for a given lab angle (may be 2-valued)
    atLab: (thetaLabDeg, which) => invert(cm, which === 4 ? lab4 : lab3,
      which === 4 ? T4 : T3, thetaLabDeg * D2R),
  };
}

function boost(pf, m, thCM, beta, gamma) {
  const E = Math.sqrt(pf * pf + m * m);
  const pz = gamma * (pf * Math.cos(thCM) + beta * E);
  const pt = pf * Math.sin(thCM);
  const Elab = gamma * (E + beta * pf * Math.cos(thCM));
  return { theta: Math.atan2(pt, pz), T: Elab - m };
}

// Scan the sampled curve for every CM angle mapping onto this lab angle.
function invert(cm, lab, T, thLab) {
  const out = [];
  for (let i = 0; i + 1 < cm.length; i++) {
    const a = lab[i], b = lab[i + 1];
    if ((a - thLab) * (b - thLab) > 0) continue;
    const f = b === a ? 0 : (thLab - a) / (b - a);
    out.push({ cm: (cm[i] + f * (cm[i + 1] - cm[i])) * R2D, T: T[i] + f * (T[i + 1] - T[i]) });
  }
  return out;
}

const SYM = ('n H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn ' +
  'Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm ' +
  'Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U').split(' ');
function recoilName(Z, A) { return SYM[Z] ? A + SYM[Z] : null; }

// ---- beam ----------------------------------------------------------------
// Straight-line centroid with linear divergence growth. sigma in mm,
// div in mrad (1 sigma), offsets in mm at the target plane.
function beamAt(beam, z, zRef) {
  const dz = z - zRef;
  return {
    x: beam.x0 + beam.divx * 1e-3 * dz,
    y: beam.y0 + beam.divy * 1e-3 * dz,
    sx: Math.hypot(beam.sx, beam.divx * 1e-3 * dz),
    sy: Math.hypot(beam.sy, beam.divy * 1e-3 * dz),
  };
}

// Beam envelope along z, re-truncated at every collimator it passes.
// Returns stage records (for the readout) and at(z) for drawing.
function envelope(beam, collimators, zTarget) {
  const cols = (collimators || []).filter((c) => c.enabled)
    .map((c) => ({ ...c, z: +c.z, r: +c.r })).sort((a, b) => a.z - b.z);
  // state = beam parameters valid from `z0` downstream
  let st = { z0: zTarget, x: beam.x0, y: beam.y0, sx: beam.sx, sy: beam.sy, T: 1 };
  const segs = [{ from: -1e9, ...st }], stages = [];
  for (const c of cols) {
    const b0 = propagate(st, beam, c.z);
    const cut = collimate(b0, c.r);
    stages.push({
      id: c.id, name: c.name, z: c.z, r: c.r,
      nSigX: b0.sx > 0 ? c.r / b0.sx : Infinity,
      nSigY: b0.sy > 0 ? c.r / b0.sy : Infinity,
      offSig: Math.hypot(b0.x / (b0.sx || 1), b0.y / (b0.sy || 1)),
      inSx: b0.sx, inSy: b0.sy, outSx: cut.sx, outSy: cut.sy,
      T: cut.T, Tcum: st.T * cut.T,
    });
    st = { z0: c.z, x: cut.x, y: cut.y, sx: cut.sx, sy: cut.sy, T: st.T * cut.T };
    segs.push({ from: c.z, ...st });
  }
  const at = (z) => {
    let s = segs[0];
    for (const q of segs) if (z >= q.from) s = q;
    const p = propagate(s, beam, z);
    p.T = s.T;
    // downstream of a collimator the halo is gone: clip the drawn envelope
    for (const c of cols) if (z >= c.z) {
      const lim = c.r + Math.abs(z - c.z) * Math.max(beam.divx, beam.divy) * 1e-3 * 3;
      p.rmax = Math.min(p.rmax === undefined ? Infinity : p.rmax, lim);
    }
    return p;
  };
  return { at, stages, cols };
}

function propagate(st, beam, z) {
  const dz = z - st.z0;
  return {
    x: st.x + beam.divx * 1e-3 * dz,
    y: st.y + beam.divy * 1e-3 * dz,
    sx: Math.hypot(st.sx, beam.divx * 1e-3 * dz),
    sy: Math.hypot(st.sy, beam.divy * 1e-3 * dz),
  };
}

// Fraction of a 2-D Gaussian passing a disc of radius R centred on the axis,
// plus the second moments of what survives.
function collimate(b, R) {
  const n = 121, lim = 4.5;
  let w = 0, wx = 0, wy = 0, wxx = 0, wyy = 0;
  const dx = 2 * lim * b.sx / (n - 1), dy = 2 * lim * b.sy / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = b.x - lim * b.sx + i * dx, gx = Math.exp(-0.5 * ((x - b.x) / b.sx) ** 2);
    for (let j = 0; j < n; j++) {
      const y = b.y - lim * b.sy + j * dy, g = gx * Math.exp(-0.5 * ((y - b.y) / b.sy) ** 2);
      if (x * x + y * y > R * R) continue;
      w += g; wx += g * x; wy += g * y; wxx += g * x * x; wyy += g * y * y;
    }
  }
  const norm = 2 * Math.PI * b.sx * b.sy / (dx * dy);
  if (w <= 0) return { T: 0, x: 0, y: 0, sx: 0, sy: 0 };
  const mx = wx / w, my = wy / w;
  return {
    T: Math.min(1, w / norm), x: mx, y: my,
    sx: Math.sqrt(Math.max(0, wxx / w - mx * mx)),
    sy: Math.sqrt(Math.max(0, wyy / w - my * my)),
  };
}

// ---- energy loss ---------------------------------------------------------
// Bethe-Bloch without the density or shell corrections: good to a few % above
// ~1 MeV/u, unreliable below. Returns MeV / (g/cm2).
function dEdx(Z, Mamu, T, mat) {
  const M = Mamu * U;
  const g = 1 + T / M, b2 = Math.max(1e-6, 1 - 1 / (g * g)), bg2 = b2 * g * g;
  const r = ME / M;
  const Tmax = 2 * ME * bg2 / (1 + 2 * g * r + r * r);
  const I = mat.I * 1e-6;
  const val = K * Z * Z * mat.ZA / b2 *
    (0.5 * Math.log(2 * ME * bg2 * Tmax / (I * I)) - b2);
  return Math.max(0, val);
}

// Integrate through a slab. thickness in mg/cm2. Returns {out, dep, stopped}.
function slab(Z, Mamu, T0, mat, mgcm2, table) {
  const n = 200, dx = mgcm2 / n / 1000; // g/cm2 per step
  let T = T0;
  for (let i = 0; i < n; i++) {
    const s = table ? table(T) : dEdx(Z, Mamu, T, mat);
    if (!isFinite(s) || s <= 0) break;
    const half = T - s * dx * 0.5;
    const s2 = half > 0.01 ? (table ? table(half) : dEdx(Z, Mamu, half, mat)) : s;
    T -= s2 * dx;
    if (T <= 0.01) return { out: 0, dep: T0, stopped: true };
  }
  return { out: T, dep: T0 - T, stopped: false };
}

// Bilinear lookup into the sheet's Si dE tables: energy deposited in
// `t` mm of silicon by a particle of energy E. null until eloss_si.js loads.
function siDeposit(kind, E, t) {
  const tab = elossSi && elossSi[kind];
  if (!tab) return null;
  const fi = (E - tab.E0) / tab.dE, fj = (t - tab.t0) / tab.dt;
  const i = Math.max(0, Math.min(tab.nE - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(tab.nt - 2, Math.floor(fj)));
  const u = Math.max(0, Math.min(1, fi - i)), v = Math.max(0, Math.min(1, fj - j));
  const g = (a, b) => { const r = tab.v[a] && tab.v[a][b]; return r == null ? 0 : r; };
  return (1 - u) * (1 - v) * g(i, j) + u * (1 - v) * g(i + 1, j)
    + (1 - u) * v * g(i, j + 1) + u * v * g(i + 1, j + 1);
}

// Parse a pasted/uploaded stopping-power table: two columns, E then dE/dx.
function parseTable(text, unit, rho) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().split(/[\s,;\t]+/).filter(Boolean).map(Number);
    if (m.length < 2 || !isFinite(m[0]) || !isFinite(m[1])) continue;
    pts.push([m[0], m[1]]);
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  // normalise to MeV/(g/cm2)
  const f = unit === 'MeV/mm' ? 10 / rho : unit === 'MeV/(mg/cm2)' ? 1000 : 1;
  const E = pts.map((p) => p[0]), S = pts.map((p) => p[1] * f);
  return function (x) {
    if (x <= E[0]) return S[0];
    if (x >= E[E.length - 1]) return S[S.length - 1];
    let lo = 0, hi = E.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (E[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - E[lo]) / (E[hi] - E[lo]);
    return S[lo] + t * (S[hi] - S[lo]);
  };
}

export const PH = {
  U, D2R, R2D, nuc, reaction, beamAt, envelope, collimate, dEdx, slab,
  siDeposit, parseTable, recoilName,
};
