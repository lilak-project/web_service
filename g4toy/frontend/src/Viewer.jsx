import React, { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei'
import * as THREE from 'three'

// blue → cyan → green → yellow → red colormap for normalised energy t∈[0,1].
function colormap(t) {
  t = Math.max(0, Math.min(1, t))
  // saturated/darker so it reads on a white background
  const stops = [
    [0.16, 0.20, 0.80], [0.06, 0.50, 0.78], [0.10, 0.60, 0.24],
    [0.80, 0.60, 0.05], [0.82, 0.18, 0.13],
  ]
  const s = t * (stops.length - 1)
  const i = Math.floor(s), f = s - i
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

const DEG = Math.PI / 180

// Rotation matrix from Euler XYZ degrees (R = Rz·Ry·Rx — matches gdml.py).
function rotMat(rx, ry, rz) {
  rx *= DEG; ry *= DEG; rz *= DEG
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ]
}
const apply = (M, p, t) => [
  M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + t[0],
  M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + t[1],
  M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2] + t[2],
]

const BOX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

// Build ALL visible volumes as ONE wireframe BufferGeometry (1 draw call) with
// per-volume vertex colours. Rebuilds only when geometry or hidden changes.
function buildWireframe(geometry, hidden) {
  const pos = [], col = []
  const seg = (a, b, c) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
    col.push(c[0], c[1], c[2], c[0], c[1], c[2])
  }
  for (const g of geometry) {
    if (hidden.has(g.id)) continue
    // darken the material colour so wireframes read on the white background
    const c = (g.color || [0.6, 0.7, 0.8]).map((v) => v * 0.5)
    const M = rotMat(...(g.rot || [0, 0, 0]))
    const T = g.pos
    if (g.type === 'box') {
      const [sx, sy, sz] = g.size.map((v) => v / 2)
      const sgn = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                   [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
      const cor = sgn.map((s) => apply(M, [s[0] * sx, s[1] * sy, s[2] * sz], T))
      for (const [i, j] of BOX_EDGES) seg(cor[i], cor[j], c)
    } else if (g.type === 'cylinder') {
      const r = g.rmax, h = g.height / 2, N = 24
      const ring = (z) => Array.from({ length: N + 1 }, (_, k) => {
        const a = (2 * Math.PI * k) / N
        return apply(M, [r * Math.cos(a), r * Math.sin(a), z], T)
      })
      const top = ring(h), bot = ring(-h)
      for (let k = 0; k < N; k++) { seg(top[k], top[k + 1], c); seg(bot[k], bot[k + 1], c) }
      for (let k = 0; k < N; k += 6) seg(bot[k], top[k], c)
    } else if (g.type === 'sphere') {
      const r = g.radius, N = 24
      const circle = (ax) => Array.from({ length: N + 1 }, (_, k) => {
        const a = (2 * Math.PI * k) / N, u = r * Math.cos(a), v = r * Math.sin(a)
        const p = ax === 0 ? [0, u, v] : ax === 1 ? [u, 0, v] : [u, v, 0]
        return apply(M, p, T)
      })
      for (const ax of [0, 1, 2]) {
        const cc = circle(ax)
        for (let k = 0; k < N; k++) seg(cc[k], cc[k + 1], c)
      }
    }
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  return geom
}

function Geometry({ geometry, hidden }) {
  const geom = useMemo(() => buildWireframe(geometry, hidden), [geometry, hidden])
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial vertexColors transparent opacity={0.72} />
    </lineSegments>
  )
}

// All tracks as ONE LineSegments (1 draw call), colour per track.
function Tracks({ tracks }) {
  const geom = useMemo(() => {
    const pos = [], col = []
    tracks.forEach((t, i) => {
      const c = new THREE.Color().setHSL((i * 0.137) % 1, 0.75, 0.42)
      const p = t.points
      for (let k = 0; k + 1 < p.length; k++) {
        pos.push(p[k][0], p[k][1], p[k][2], p[k + 1][0], p[k + 1][1], p[k + 1][2])
        col.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
    return g
  }, [tracks])
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial vertexColors />
    </lineSegments>
  )
}

function EdepPoints({ edep, emax, size }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(edep.length * 3)
    const col = new Float32Array(edep.length * 3)
    const m = emax || 1
    edep.forEach((p, i) => {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]
      const c = colormap(p[3] / m)
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
    })
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  }, [edep, emax])
  return (
    <points geometry={geom}>
      <pointsMaterial vertexColors size={size} sizeAttenuation />
    </points>
  )
}

const halfExtent = (g) =>
  g.type === 'box' ? Math.max(...g.size) / 2
    : g.type === 'cylinder' ? Math.max(g.rmax, g.height / 2)
      : g.type === 'sphere' ? g.radius : 0

// Robust camera fit: centre on the median volume position and size to the 85th
// percentile reach, so far stray volumes (nptool parks a "sample" at 10 m) don't
// blow up the framing.
function fit(geometry) {
  const vis = geometry.filter((g) => g.visible !== false)
  if (!vis.length) return { center: [0, 0, 0], radius: 100 }
  const median = (k) => {
    const a = vis.map((g) => g.pos[k]).sort((x, y) => x - y)
    return a[a.length >> 1]
  }
  const center = [median(0), median(1), median(2)]
  const reach = vis
    .map((g) => Math.hypot(...g.pos.map((p, k) => p - center[k])) + halfExtent(g))
    .sort((a, b) => a - b)
  const radius = Math.max(1, reach[Math.floor(reach.length * 0.85)])
  return { center, radius }
}

export default function Viewer({ geometry, event, show, hidden, controlsRef }) {
  const { center, radius } = useMemo(() => fit(geometry), [geometry])
  const d = radius * 2.4
  const camPos = [center[0] + d * 0.7, center[1] + d * 0.55, center[2] + d]
  return (
    <Canvas camera={{ position: camPos, fov: 42, near: 0.1, far: radius * 60 }}>
      <color attach="background" args={['#ffffff']} />
      <Geometry geometry={geometry} hidden={hidden} />
      {show.tracks && <Tracks tracks={event.tracks} />}
      {show.edep && event.edep.length > 0 && (
        <EdepPoints edep={event.edep} emax={event.meta.energy_max} size={show.pointSize} />
      )}
      {show.axes && <axesHelper args={[radius * 0.5]} />}
      <OrbitControls ref={controlsRef} target={center} makeDefault />
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={['#e06666', '#93c47d', '#6fa8dc']} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  )
}
