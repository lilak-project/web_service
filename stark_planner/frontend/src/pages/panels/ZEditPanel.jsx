// Every component that has a z, on one shared scale. The rows line up into a
// side elevation of the beamline, so dragging one ring shows immediately what it
// runs into — which is the thing the 3D gizmo was bad at.
import { useMemo, useState } from 'react'
import { usePlanner } from '../../stark/store.jsx'
import { DET_COLOR } from '../../stark/data.js'
import { GEO } from '../../stark/geometry.js'
import { targetMm } from '../../stark/model.js'
import { activeTarget } from '../../stark/scene.js'

const f = (x, n = 1) => (x == null || !isFinite(x) ? '–' : (+x).toFixed(n))
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// One row per movable thing: its z, the z range its body occupies, and colour.
// Emitted in DECLARATION order — sorting by z would slide the row out from under
// the cursor mid-drag, so that is opt-in (see `sort`).
function rowsOf(S) {
  const out = []
  // same section order as the planner dock, so the two lists agree
  for (const c of S.collimators) {
    out.push({
      id: c.id, kind: 'coll', name: c.name, z: +c.z,
      span: [+c.z - (+c.thick) / 2, +c.z + (+c.thick) / 2],
      color: '#7c8797', note: `R ${f(c.r)}`, enabled: c.enabled !== false,
    })
  }
  for (const t of S.targetSlots) {
    const h = targetMm(t)
    out.push({
      id: t.id, kind: 'target', name: t.name, z: +t.z, span: [+t.z - h / 2, +t.z + h / 2],
      color: '#d1495b', note: t.material, enabled: !!t.active,
    })
  }
  for (const r of S.rings) {
    const [z1, z2] = GEO.ringZSpan(r)
    out.push({
      id: r.id, kind: 'ring', name: r.name, z: +r.z, span: [z1, z2],
      mark: GEO.detCentreZ(r), color: DET_COLOR[r.det] || '#888',
      note: `${r.det} ×${r.div}`, enabled: r.enabled !== false,
    })
  }
  for (const d of S.singles) {
    out.push({
      id: d.id, kind: 'single', name: d.name, z: +d.z, span: [+d.z, +d.z],
      color: DET_COLOR[d.det] || '#5c8f3f', note: d.det, enabled: d.enabled !== false,
    })
  }
  return out
}


// A range thumb is inset by half its width at each end, so a plain percentage
// would drift from the handle by up to THUMB/2. Match the native geometry.
const THUMB = 11

function Track({ row, lo, hi, zt, bad, onDrag, step }) {
  const pct = (v) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100)
  const at = (v) => { const t = pct(v) / 100; return `calc(${t * 100}% + ${(0.5 - t) * THUMB}px)` }
  const a = pct(Math.min(...row.span)) / 100, b = pct(Math.max(...row.span)) / 100
  return (
    <div className="ztrack">
      <div className="zline" />
      <div className="zzero" style={{ left: at(0) }} title="z = 0" />
      {zt != null && <div className="ztgt" style={{ left: at(zt) }} title="타겟" />}
      <div className={`zspan${bad ? ' bad' : ''}`}
        style={{
          left: at(Math.min(...row.span)),
          width: `max(2px, calc(${(b - a) * 100}% - ${(b - a) * THUMB}px))`,
          background: row.color,
        }} />
      {row.mark != null && (
        <div className="zmark" style={{ left: at(row.mark) }} title={`검출기 중심 ${f(row.mark)} mm`} />
      )}
      <input type="range" min={lo} max={hi} step={step} value={clamp(row.z, lo, hi)}
        onChange={(e) => onDrag(+e.target.value)} aria-label={`${row.name} z`} />
    </div>
  )
}

export default function ZEditPanel() {
  const { S, sel, setSel, setField, bad } = usePlanner()
  const [step, setStep] = useState(1)
  const [pad, setPad] = useState(60)
  const [sort, setSort] = useState('fixed')

  const rows = useMemo(() => {
    const r = rowsOf(S)
    return sort === 'z' ? [...r].sort((a, b) => a.z - b.z) : r
  }, [S, sort])
  const zt = activeTarget(S) ? +activeTarget(S).z : null

  // One scale for every row, so the panel reads as a side elevation.
  const [lo, hi] = useMemo(() => {
    if (!rows.length) return [-100, 300]
    let a = Math.min(0, ...rows.map((r) => Math.min(...r.span)))
    let b = Math.max(0, ...rows.map((r) => Math.max(...r.span)))
    if (b - a < 50) { a -= 25; b += 25 }
    return [Math.floor(a - pad), Math.ceil(b + pad)]
  }, [rows, pad])

  const ticks = useMemo(() => {
    const span = hi - lo
    const grid = span > 900 ? 200 : span > 400 ? 100 : 50
    const out = []
    for (let z = Math.ceil(lo / grid) * grid; z <= hi; z += grid) out.push(z)
    return out
  }, [lo, hi])

  return (
    <div className="zeditpanel">
      <div className="psaverow">
        <label className="zopt">눈금
          <select value={step} onChange={(e) => setStep(+e.target.value)}>
            <option value={0.1}>0.1 mm</option>
            <option value={0.5}>0.5 mm</option>
            <option value={1}>1 mm</option>
            <option value={5}>5 mm</option>
          </select>
        </label>
        <label className="zopt">순서
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="fixed">기본</option>
            <option value="z">z 순</option>
          </select>
        </label>
        <label className="zopt">여백
          <select value={pad} onChange={(e) => setPad(+e.target.value)}>
            <option value={20}>좁게</option>
            <option value={60}>보통</option>
            <option value={200}>넓게</option>
          </select>
        </label>
      </div>

      <div className="zscale">
        {ticks.map((z) => {
          const t = (z - lo) / (hi - lo)
          return <span key={z} style={{ left: `calc(${t * 100}% + ${(0.5 - t) * 11}px)` }}>{z}</span>
        })}
      </div>

      {rows.length === 0 && <div className="dnote">움직일 컴포넌트가 없습니다.</div>}

      {rows.map((row) => (
        <div key={row.id}
          className={`zrow${sel === row.id ? ' sel' : ''}${row.enabled ? '' : ' off'}${bad.has(row.id) ? ' bad' : ''}`}
          onMouseDown={() => setSel(row.id)}>
          <div className="zhead">
            <i className="pdot" style={{ background: row.color }} />
            <span className="pname">{row.name}</span>
            <span className="znote">{row.note}</span>
            <input className="znum" type="number" step={step} value={row.z}
              onChange={(e) => setField(row.id, 'z', e.target.value)} />
            <span className="pfu">mm</span>
          </div>
          <Track row={row} lo={lo} hi={hi} zt={zt} step={step} bad={bad.has(row.id)}
            onDrag={(v) => { setSel(row.id); setField(row.id, 'z', v) }} />
        </div>
      ))}

      <div className="dnote">
        {sort === 'z' && '※ z 순 정렬에서는 끄는 동안 줄 순서가 바뀝니다. '}
        막대 = 그 컴포넌트가 차지하는 z 구간, 가는 선 = 검출기 중심.
        빨간 막대는 다른 링과 부피가 겹친다는 뜻입니다.
        회색 세로선이 z = 0, 붉은 세로선이 타겟입니다.
      </div>
    </div>
  )
}
