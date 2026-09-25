// Everything derived from a setup: beam energy, target thickness, the reaction,
// per-ring numbers and whole-array acceptance. Pure functions — the React layer
// only holds the setup itself.
import { MATERIALS, DET_TYPES } from './data.js'
import { PH, elossReady } from './physics.js'
import { GEO } from './geometry.js'
import { activeBeam, activeTarget, targetPos } from './scene.js'

export { activeBeam, activeTarget, targetPos }

export const TEXT_KEYS = ['name', 'nuc', 'material', 'eUnit', 'thickUnit', 'type', 'det', 'offMode', 'facing', 'mount']

export function beamEnergyMeV(b) {
  const n = PH.nuc(b.nuc)
  return b.eUnit === 'MeV/u' ? (+b.energy) * (n ? n.A : 1) : +b.energy
}

// Areal thickness in mg/cm2, whichever way the user entered it.
export function targetMgcm2(t) {
  const m = MATERIALS[t.material]
  if (!m) return +t.thick
  if (t.thickUnit === 'mg/cm2') return +t.thick
  if (t.thickUnit === 'um') return (+t.thick) * 1e-4 * m.rho * 1000
  return (+t.thick) * 0.1 * m.rho * 1000            // mm
}
export function targetMm(t) {
  const m = MATERIALS[t.material]
  if (!m) return 0
  if (t.thickUnit === 'mm') return +t.thick
  if (t.thickUnit === 'um') return (+t.thick) / 1000
  return (+t.thick) / 1000 / m.rho * 10
}

// Energy the beam has lost after `frac` of the target.
export function targetLoss(b, t, frac, stopTable) {
  const n = PH.nuc(b.nuc), m = MATERIALS[t.material]
  if (!n || !m) return { dep: 0, out: beamEnergyMeV(b), stopped: false }
  return PH.slab(n.Z, n.A, beamEnergyMeV(b), m, targetMgcm2(t) * frac, stopTable)
}

// The reaction as it happens in the MIDDLE of the target, not at its face.
export function reactionOf(S, stopTable) {
  const b = activeBeam(S), t = activeTarget(S)
  if (!b || !t) return null
  const loss = targetLoss(b, t, 0.5, stopTable)
  return PH.reaction(b.nuc, t.nuc, S.reaction.ejectile,
    beamEnergyMeV(b) - loss.dep, +S.reaction.Ex || 0)
}

// Interaction-point spread: the clipped beam sigma at the target plus its thickness.
export function spotOf(S) {
  const b = activeBeam(S), t = activeTarget(S)
  if (!b || !t) return null
  const p = PH.envelope(b, S.collimators, +t.z).at(+t.z)
  return { x: p.x, y: p.y, sx: p.sx, sy: p.sy, dz: targetMm(t) }
}

export function cmFor(rx, th1, th2) {
  const lo = Math.min(th1, th2), hi = Math.max(th1, th2)
  let a = 1e9, b = -1e9
  for (let i = 0; i < rx.cm.length; i++) {
    const lab = rx.lab3[i] * 180 / Math.PI
    if (lab >= lo && lab <= hi) { const c = rx.cm[i] * 180 / Math.PI; a = Math.min(a, c); b = Math.max(b, c) }
  }
  return a > b ? null : [a, b]
}

export const ejKind = (S) => ({ '1H': 'p', '2H': 'd', '4He': 'a' }[S.reaction.ejectile])

const ptCache = {}
export function punchThroughE(kind, mm) {
  if (!kind || !elossReady()) return undefined
  const ck = kind + '|' + mm
  if (ptCache[ck] === undefined) {
    let e = null
    for (let E = 0.5; E <= 40; E += 0.1) {
      const d = PH.siDeposit(kind, E, mm)
      if (d != null && d < E - 0.05) { e = E; break }
    }
    ptCache[ck] = e
  }
  return ptCache[ck]
}

// Whole-array acceptance seen from the interaction point. Wafer solid angles are
// summed for reference, but the headline number counts the sky once — stacked
// dE-E layers look at the same directions.
export function arrayTotals(S) {
  const T = targetPos(S)
  let omega = 0, ch = 0, nDet = 0
  const segs = [], all = []
  for (const r of S.rings) {
    if (!r.enabled) continue
    const c = GEO.ringCoverage(r, T)
    omega += c.omega; nDet += c.nDet
    ch += (DET_TYPES[r.det] || {}).ch * c.nDet || 0
    segs.push([c.thetaMin, c.thetaMax])
    all.push(...GEO.faces(r, T[2]))
  }
  for (const d of S.singles) {
    if (d.enabled === false) continue
    const fc = GEO.singleFace(d, T)
    const a = GEO.faceAngles(fc, T)
    omega += a.omega; nDet += 1
    ch += (DET_TYPES[d.det] || {}).ch || 0
    segs.push([a.thetaMin, a.thetaMax])
    all.push(fc)
  }
  if (!segs.length) return null
  segs.sort((a, b) => a[0] - b[0])
  const merged = [segs[0].slice()]
  for (const s of segs.slice(1)) {
    const last = merged[merged.length - 1]
    if (s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push(s.slice())
  }
  let shell = 0
  for (const [x, y] of merged) {
    shell += 2 * Math.PI * Math.abs(Math.cos(x / 180 * Math.PI) - Math.cos(y / 180 * Math.PI))
  }
  const gaps = []
  for (let i = 0; i + 1 < merged.length; i++) gaps.push([merged[i][1], merged[i + 1][0]])
  const uniq = GEO.uniqueAcceptance(all, T)
  return {
    nDet, ch, merged, gaps, omega, uniq, shell,
    eff: uniq / (4 * Math.PI),
    inShell: shell > 0 ? Math.min(1, uniq / shell) : 0,
    stack: uniq > 0 ? omega / uniq : 1,
  }
}
