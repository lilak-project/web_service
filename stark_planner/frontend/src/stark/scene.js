// Turns a planner setup into the volume array nptoy's Viewer renders.
//
// Every component becomes one entry of {id, name, group, copy, type, pos, rot,
// color, ...dims} — the same shape /det/export_geometry produces in nptoy, so
// the volume tree, style editor, picking and dimension labels all work on it
// without knowing anything about STARK.
import { DET_TYPES, DET_COLOR } from './data.js'
import { GEO } from './geometry.js'
import { PH } from './physics.js'

const D2R = Math.PI / 180
const hex2rgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const C = {
  ring: hex2rgb('#96a3b4'), ringBad: hex2rgb('#d1495b'),
  target: hex2rgb('#d1495b'), coll: hex2rgb('#7c8797'), beam: hex2rgb('#d9822b'),
}

// A face's orientation as a 9-element global rotation matrix (column vectors
// U, V, N), which is what Viewer.mat4 wants — no Euler round-trip.
const basis = (f) => [
  f.U[0], f.V[0], f.N[0],
  f.U[1], f.V[1], f.N[1],
  f.U[2], f.V[2], f.N[2],
]

// An n-gon prism shell as a triangle soup. The Viewer has box/cylinder/sphere
// but no polygon primitive, and a ring frame really is an n-gon, so emit it as
// a 'mesh'. rmin/rmax are the flat faces; corners sit at r/cos(pi/n).
// Verts are emitted around z = 0 and the volume carries its centre in `pos`,
// so the translate gizmo grabs the ring where it actually sits.
function prism(rmin, rmax, h, n, phiDeg) {
  const z1 = -h / 2, z2 = h / 2
  const k = n >= 3 && n < 32 ? 1 / Math.cos(Math.PI / n) : 1
  const a = rmin * k, b = rmax * k, seg = n >= 3 ? n : 48
  const verts = []
  const tri = (p, q, r) => verts.push(...p, ...q, ...r)
  const quad = (p, q, r, s) => { tri(p, q, r); tri(p, r, s) }
  const ang = (i) => ((phiDeg || 0) + 180 / seg + (360 / seg) * i) * D2R
  for (let i = 0; i < seg; i++) {
    const t0 = ang(i), t1 = ang(i + 1)
    const o0 = [b * Math.cos(t0), b * Math.sin(t0)], o1 = [b * Math.cos(t1), b * Math.sin(t1)]
    const i0 = [a * Math.cos(t0), a * Math.sin(t0)], i1 = [a * Math.cos(t1), a * Math.sin(t1)]
    quad([o0[0], o0[1], z1], [o1[0], o1[1], z1], [o1[0], o1[1], z2], [o0[0], o0[1], z2]) // outer
    quad([i1[0], i1[1], z1], [i0[0], i0[1], z1], [i0[0], i0[1], z2], [i1[0], i1[1], z2]) // inner
    quad([i0[0], i0[1], z1], [i1[0], i1[1], z1], [o1[0], o1[1], z1], [o0[0], o0[1], z1]) // z1 cap
    quad([o0[0], o0[1], z2], [o1[0], o1[1], z2], [i1[0], i1[1], z2], [i0[0], i0[1], z2]) // z2 cap
  }
  return verts
}

// 3-sigma beam envelope as a tube, re-clipped at every collimator it passes.
function beamTube(beam, collimators, zt, z0, z1) {
  const env = PH.envelope(beam, collimators, zt)
  const NZ = 90, NU = 24, ring = []
  for (let i = 0; i <= NZ; i++) {
    const z = z0 + (z1 - z0) * (i / NZ)
    const p = env.at(z)
    let rx = 3 * p.sx, ry = 3 * p.sy
    if (p.rmax !== undefined) { rx = Math.min(rx, p.rmax); ry = Math.min(ry, p.rmax) }
    const loop = []
    for (let j = 0; j < NU; j++) {
      const a = (j / NU) * 2 * Math.PI
      loop.push([p.x + rx * Math.cos(a), p.y + ry * Math.sin(a), z])
    }
    ring.push(loop)
  }
  const verts = []
  for (let i = 0; i < NZ; i++) {
    for (let j = 0; j < NU; j++) {
      const k = (j + 1) % NU
      const A = ring[i][j], B = ring[i][k], Cp = ring[i + 1][k], D = ring[i + 1][j]
      verts.push(...A, ...B, ...Cp, ...A, ...Cp, ...D)
    }
  }
  return verts
}

export function zExtent(s) {
  let lo = -120, hi = 260
  for (const r of s.rings) { const [a, b] = GEO.ringZSpan(r); lo = Math.min(lo, a); hi = Math.max(hi, b) }
  for (const c of s.collimators) { lo = Math.min(lo, +c.z); hi = Math.max(hi, +c.z) }
  for (const d of s.singles) { lo = Math.min(lo, +d.z); hi = Math.max(hi, +d.z) }
  return [lo - 60, hi + 60]
}

export const activeBeam = (s) => s.beamSlots.find((b) => b.active) || s.beamSlots[0]
export const activeTarget = (s) => s.targetSlots.find((t) => t.active) || s.targetSlots[0]
export const targetPos = (s) => {
  const t = activeTarget(s)
  return t ? [+t.x0 || 0, +t.y0 || 0, +t.z || 0] : [0, 0, 0]
}

/**
 * setup -> nptoy volume array.
 * `bad` is the set of colliding ring ids (drawn red). `show` toggles the
 * non-detector helpers off without touching the component list.
 */
export function buildScene(s, bad, show) {
  show = show || {}
  const out = []
  const T = targetPos(s)
  const zs = zExtent(s)
  // Stable ids: hiding a volume must survive an unrelated edit, so key them on
  // the component that produced them rather than on build order.
  const push = (v) => { out.push({ copy: 1, ...v }); return out[out.length - 1] }

  for (const r of s.rings) {
    if (!r.enabled) continue
    const [z1, z2] = GEO.ringZSpan(r)
    if (show.frames !== false && !GEO.isBare(r)) {
      push({
        id: r.id + ':frame', name: r.name + ' frame', group: r.name, type: 'mesh',
        verts: prism(+r.rmin, +r.rmax, z2 - z1, r.dir === 1 ? Math.round(r.div) : 48, +r.phi0 || 0),
        pos: [0, 0, (z1 + z2) / 2], rot: [0, 0, 0],
        color: bad && bad.has(r.id) ? C.ringBad : C.ring,
        starkId: r.id, starkKind: 'ring',
      })
    }
    GEO.faces(r, T[2]).forEach((f, k) => {
      if (f.kind === 'rect') {
        const t = Math.max(0.5, f.thick / 1000)
        push({
          id: `${r.id}:d${k}`, copy: k + 1,
          name: `${r.name} ${r.det}`, group: r.name, type: 'box',
          size: [f.w, f.h, t],
          pos: [f.C[0] - f.N[0] * t / 2, f.C[1] - f.N[1] * t / 2, f.C[2] - f.N[2] * t / 2],
          rot: basis(f), color: hex2rgb(DET_COLOR[r.det] || '#888888'),
          starkId: r.id, starkKind: 'ring', phi: f.phi,
        })
      } else {
        push({
          id: `${r.id}:d${k}`, copy: k + 1,
          name: `${r.name} ${r.det}`, group: r.name, type: 'cylinder',
          rmin: f.rin, rmax: f.rout, height: Math.max(0.5, f.thick / 1000),
          phi0: f.phiStart * D2R, dphi: f.phiSpan * D2R,
          pos: [0, 0, f.C[2]], rot: [0, 0, 0],
          color: hex2rgb(DET_COLOR[r.det] || '#888888'),
          starkId: r.id, starkKind: 'ring', phi: f.phi,
        })
      }
    })
  }

  for (const d of s.singles) {
    if (d.enabled === false) continue
    const f = GEO.singleFace(d, T)
    const t = Math.max(0.5, f.thick / 1000)
    push({
      id: d.id, name: `${d.name} ${d.det}`, group: 'single detectors', type: 'box',
      size: [f.w, f.h, t],
      pos: [f.C[0] - f.N[0] * t / 2, f.C[1] - f.N[1] * t / 2, f.C[2] - f.N[2] * t / 2],
      rot: basis(f), color: hex2rgb(DET_COLOR[d.det] || '#5c8f3f'),
      starkId: d.id, starkKind: 'single',
    })
  }

  const tg = activeTarget(s)
  if (tg) {
    push({
      id: tg.id, name: tg.name, group: 'target', type: 'cylinder',
      rmin: 0, rmax: +tg.radius, height: 1.0, phi0: 0, dphi: 2 * Math.PI,
      pos: [+tg.x0 || 0, +tg.y0 || 0, +tg.z], rot: [0, 0, 0], color: C.target,
      starkId: tg.id, starkKind: 'target',
    })
  }

  for (const c of s.collimators) {
    if (!c.enabled) continue
    push({
      id: c.id, name: c.name, group: 'collimators', type: 'cylinder',
      rmin: +c.r, rmax: +c.r + 12, height: +c.thick, phi0: 0, dphi: 2 * Math.PI,
      pos: [0, 0, +c.z], rot: [0, 0, 0], color: C.coll,
      starkId: c.id, starkKind: 'coll',
    })
  }

  const b = activeBeam(s)
  if (b && show.beam !== false) {
    push({
      id: 'beam', name: 'beam 3σ', group: 'beam', type: 'mesh',
      verts: beamTube(b, s.collimators, T[2], zs[0], zs[1]),
      pos: [0, 0, 0], rot: [0, 0, 0], color: C.beam,
      starkKind: 'beam',
    })
  }
  return out
}

// A true bounding box of the built scene.
//
// The Viewer's own fit() takes the MEDIAN volume position as the world centre,
// which is robust for nptoy's hundreds of similar volumes but jumps here: drag
// one ring past another and the median flips to a different ring, translating
// the whole scene out from under a camera that lives in world coordinates.
// Framing from real extents instead changes smoothly — and the caller only
// re-reads it on demand, so editing never moves the world.
export function sceneFrame(scene) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const grow = (p) => { for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k] } }
  for (const g of scene) {
    const P = g.pos || [0, 0, 0]
    if (g.type === 'mesh' && g.verts) {
      for (let i = 0; i < g.verts.length; i += 3) grow([P[0] + g.verts[i], P[1] + g.verts[i + 1], P[2] + g.verts[i + 2]])
    } else if (g.type === 'box') {
      const h = Math.hypot(...g.size) / 2            // any rotation stays inside this
      grow([P[0] - h, P[1] - h, P[2] - h]); grow([P[0] + h, P[1] + h, P[2] + h])
    } else if (g.type === 'cylinder') {
      grow([P[0] - g.rmax, P[1] - g.rmax, P[2] - g.height / 2])
      grow([P[0] + g.rmax, P[1] + g.rmax, P[2] + g.height / 2])
    } else grow(P)
  }
  if (!isFinite(lo[0])) return { center: [0, 0, 0], radius: 200 }
  const center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2)
  const radius = Math.max(50, Math.hypot(...[0, 1, 2].map((k) => (hi[k] - lo[k]) / 2)))
  return { center, radius }
}

// Sensible first-look styling: wafers solid, frames and beam see-through.
export function defaultStyles(scene) {
  const st = {}
  for (const g of scene) {
    if (g.starkKind === 'beam') st[g.name] = { mode: 'transparent', opacity: 0.22 }
    else if (/frame$/.test(g.name)) st[g.name] = { mode: 'transparent', opacity: 0.14 }
    else st[g.name] = { mode: 'solid' }
  }
  return st
}
