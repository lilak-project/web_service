// The one place the setup lives. Panels read it through usePlanner().
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { defaultSetup, uid, RING_TYPES, DET_TYPES } from './data.js'
import { GEO } from './geometry.js'
import { loadEloss } from './physics.js'
import { buildScene, defaultStyles, targetPos } from './scene.js'
import { TEXT_KEYS, reactionOf, arrayTotals } from './model.js'

// The working setup autosaves here so a reload never loses it; NAMED setups
// are profiles on the backend (see profiles.js).
const KEY = 'stark.geom.v1', CUR = 'stark.geom.current'
const Ctx = createContext(null)
export const usePlanner = () => useContext(Ctx)

// not exported: a module that exports both a component and a plain object can't
// Fast Refresh, and nothing outside needs it
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } },
}

function normalise(S) {
  S.view = { showFrames: true, showBeam: true, ...S.view }
  S.singles = S.singles || []
  for (const r of S.rings) if (r.flip === undefined) r.flip = false
  return S
}

export function PlannerProvider({ children }) {
  const [S, setS] = useState(() => normalise(store.get(KEY, null) || defaultSetup()))
  const [sel, setSel] = useState(null)          // selected component id
  const [open, setOpen] = useState(() => new Set())
  const [stopTable, setStopTable] = useState(null)
  const [elossTick, setElossTick] = useState(0) // bumped once the Si tables land
  const [current, setCurrent] = useState(() => store.get(CUR, null))   // open profile metadata
  // Bumped when the setup is REPLACED (profile load / import / reset) rather
  // than edited, so the view can re-frame without fighting every drag.
  const [gen, setGen] = useState(0)

  useEffect(() => { store.set(KEY, S) }, [S])
  useEffect(() => { store.set(CUR, current) }, [current])
  useEffect(() => { loadEloss().then(() => setElossTick((n) => n + 1)).catch(() => {}) }, [])

  const commit = useCallback((fn) => setS((cur) => {
    const next = JSON.parse(JSON.stringify(cur))
    fn(next)
    return next
  }), [])

  const bad = useMemo(() => GEO.collisions(S.rings), [S])
  const scene = useMemo(
    () => buildScene(S, bad, { frames: S.view.showFrames, beam: S.view.showBeam }),
    [S, bad],
  )
  const rx = useMemo(() => reactionOf(S, stopTable), [S, stopTable])
  const totals = useMemo(() => arrayTotals(S), [S])

  const byId = useCallback((id) => {
    for (const a of [S.beamSlots, S.targetSlots, S.collimators, S.rings, S.singles]) {
      const o = a.find((x) => x.id === id)
      if (o) return o
    }
    return null
  }, [S])

  const listKey = (o) => (o.kind === 'ring' ? 'rings' : o.kind === 'single' ? 'singles'
    : o.nuc && o.eUnit ? 'beamSlots' : o.material ? 'targetSlots' : 'collimators')

  const setField = useCallback((id, key, raw) => commit((n) => {
    for (const k of ['beamSlots', 'targetSlots', 'collimators', 'rings', 'singles']) {
      const o = n[k].find((x) => x.id === id)
      if (!o) continue
      if (typeof raw === 'boolean') o[key] = raw
      else if (TEXT_KEYS.includes(key)) o[key] = raw
      else o[key] = raw === '' ? 0 : +raw
      if (key === 'type') {                      // adopt the library values
        const t = RING_TYPES[raw]
        if (t) Object.assign(o, {
          div: t.div, r: t.r, off: t.off, z1: t.z1, z2: t.z2, dir: t.dir, det: t.det,
          rmin: t.r - 4, rmax: t.r + 12, phi0: t.dir === 1 ? 180 / t.div : 45,
        })
      }
      if (key === 'dir') o.dir = +raw
      return
    }
  }), [commit])

  const setActiveSlot = useCallback((id) => commit((n) => {
    for (const k of ['beamSlots', 'targetSlots']) {
      if (n[k].some((x) => x.id === id)) n[k].forEach((x) => { x.active = x.id === id })
    }
  }), [commit])

  const remove = useCallback((id) => commit((n) => {
    for (const r of n.rings) if (r.pair === id) r.pair = null   // don't leave a dangling pair
    for (const k of ['beamSlots', 'targetSlots', 'collimators', 'rings', 'singles']) {
      const i = n[k].findIndex((x) => x.id === id)
      if (i >= 0) { n[k].splice(i, 1); return }
    }
  }), [commit])

  const add = useCallback((kind) => {
    let created = null
    commit((n) => {
      if (kind === 'ring') {
        const t = RING_TYPES['12E']
        const zs = n.rings.map((r) => +r.z)
        created = {
          id: uid('ring'), kind: 'ring', name: 'Ring ' + (n.rings.length + 1), type: '12E',
          z: zs.length ? Math.max(...zs) + 40 : 150, div: t.div, r: t.r, off: t.off,
          offMode: 'center', z1: t.z1, z2: t.z2, rmin: t.r - 4, rmax: t.r + 12,
          dir: t.dir, det: t.det, phi0: 180 / t.div, flip: false, enabled: true,
        }
        n.rings.push(created)
      } else if (kind === 'coll') {
        created = { id: uid('coll'), name: 'Collimator ' + (n.collimators.length + 1), r: 5, z: -60, thick: 3, enabled: true }
        n.collimators.push(created)
      } else if (kind === 'target') {
        created = {
          id: uid('targ'), name: 'Target ' + (n.targetSlots.length + 1), material: 'CD2', nuc: '2H',
          thickUnit: 'mg/cm2', thick: 1.0, radius: 7.5, z: 0, x0: 0, y0: 0, active: false,
        }
        n.targetSlots.push(created)
      } else if (kind === 'beam') {
        const b = n.beamSlots.find((x) => x.active) || n.beamSlots[0]
        created = { ...b, id: uid('beam'), name: 'Beam ' + String.fromCharCode(65 + n.beamSlots.length), active: false }
        n.beamSlots.push(created)
      } else if (kind === 'single') {
        created = {
          id: uid('det'), kind: 'single', name: 'Detector ' + (n.singles.length + 1),
          det: 'W1', z: 300, x: 0, y: 0, facing: 'target', enabled: true,
        }
        n.singles.push(created)
      }
    })
    if (created) { setSel(created.id); setOpen((o) => new Set(o).add(created.id)) }
  }, [commit])

  // Telescope pairing is symmetric and exclusive: both rings point at each
  // other, and joining a new pair releases whatever either was bound to.
  const setPair = useCallback((idA, idB) => commit((n) => {
    const find = (id) => n.rings.find((r) => r.id === id)
    const a = find(idA)
    if (!a) return
    const release = (r) => { if (r && r.pair) { const o = find(r.pair); if (o) o.pair = null; r.pair = null } }
    release(a)
    if (!idB) return
    const b = find(idB)
    if (!b) return
    release(b)
    a.pair = b.id; b.pair = a.id
  }), [commit])

  // Move `id` in z so its theta coverage lines up with its partner's.
  const matchPairZ = useCallback((id) => {
    const ring = byId(id)
    const ref = ring && ring.pair ? byId(ring.pair) : null
    if (!ring || !ref) return null
    const T = targetPos(S)
    const m = GEO.matchZ(ring, ref, T)
    if (m) setField(id, 'z', m.z)
    return m
  }, [S, byId, setField])

  const setReaction = useCallback((patch) => commit((n) => { Object.assign(n.reaction, patch) }), [commit])
  const setView = useCallback((patch) => commit((n) => { Object.assign(n.view, patch) }), [commit])

  const toggleOpen = (id) => setOpen((o) => {
    const n = new Set(o)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const exportJSON = () => JSON.stringify(S, null, 2)
  const importJSON = (text) => {
    const o = JSON.parse(text)
    if (!o.rings || !o.beamSlots) throw new Error('not a STARK setup file')
    setS(normalise(o)); setSel(null); setOpen(new Set()); setGen((g) => g + 1)
  }
  const reset = () => {
    setS(normalise(defaultSetup())); setSel(null); setOpen(new Set())
    setCurrent(null); setGen((g) => g + 1)
  }

  const value = {
    S, setS, sel, setSel, open, toggleOpen, scene, bad, rx, totals,
    stopTable, setStopTable, elossTick, current, setCurrent, gen,
    byId, listKey, setField, setActiveSlot, remove, add, setReaction, setView,
    setPair, matchPairZ,
    exportJSON, importJSON, reset, defaultStyles, DET_TYPES,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
