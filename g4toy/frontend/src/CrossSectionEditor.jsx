import React, { useMemo, useState } from 'react'

// Generate / edit the differential cross-section file (2 columns: angle[deg] value).
// flat (isotropic), exponential (forward-peaked), gaussian — plus raw text editing.
const SHAPES = [
  { key: 'flat', label: 'flat (isotropic)' },
  { key: 'exp', label: 'exponential decay' },
  { key: 'gauss', label: 'gaussian' },
  { key: 'free', label: 'free (empty — 직접 입력)' },
]

function generate(g) {
  const { shape, min, max, step, value, amp, tau, mu, sigma } = g
  const rows = []
  const st = Math.max(Math.abs(step) || 1, 1e-6)
  for (let a = min; a <= max + 1e-9; a += st) {
    const angle = a.toFixed(1)
    if (shape === 'free') { rows.push(`${angle}\t`); continue }   // angles only, values blank
    let v
    if (shape === 'flat') v = value
    else if (shape === 'exp') v = amp * Math.exp(-(a - min) / Math.max(tau, 1e-6))
    else v = amp * Math.exp(-((a - mu) ** 2) / (2 * Math.max(sigma, 1e-6) ** 2))
    rows.push(`${angle}\t${(+v).toPrecision(6)}`)
  }
  return rows.join('\n') + '\n'
}

function parsePoints(text) {
  const pts = []
  for (const ln of (text || '').split('\n')) {
    const f = ln.trim().split(/\s+/)
    if (f.length >= 2 && !isNaN(+f[0]) && !isNaN(+f[1])) pts.push([+f[0], +f[1]])
  }
  return pts
}

// one labelled control: label on top, [input][unit] aligned on the row below
function Field({ label, unit, wide, children, ...rest }) {
  return (
    <label className={`csf${wide ? ' wide' : ''}`}>
      <span className="csfl">{label}</span>
      <span className="csfc">
        {children || <input type="number" {...rest} />}
        {unit && <i>{unit}</i>}
      </span>
    </label>
  )
}

export default function CrossSectionEditor({ path, value, onChange, files = [], onPick, onSaveAs }) {
  const [g, setG] = useState({
    shape: 'flat', min: 0, max: 180, step: 1, value: 1, amp: 1, tau: 30, mu: 0, sigma: 30,
  })
  const [saveName, setSaveName] = useState('')
  const set = (k, v) => setG((s) => ({ ...s, [k]: v }))
  const num = (k) => (e) => set(k, +e.target.value)
  const apply = () => onChange(generate(g))

  const pts = useMemo(() => parsePoints(value), [value])

  return (
    <div className="cseditor">
      {(files.length > 0 || onSaveAs) && (
        <div className="csfiles">
          <Field label="파일 열기">
            <select value={files.includes(path) ? path : ''}
              onChange={(e) => e.target.value && onPick && onPick(e.target.value)}>
              <option value="">{files.includes(path) ? path : `${path || '(현재)'}`}</option>
              {files.filter((f) => f !== path).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          {onSaveAs && (
            <Field label="다른 이름으로 저장" wide>
              <span className="cssaveas">
                <input type="text" value={saveName} placeholder="파일명 (예: my_cs.txt)"
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveName.trim() && onSaveAs(saveName.trim())} />
                <button className="sbtn" disabled={!saveName.trim()}
                  onClick={() => onSaveAs(saveName.trim())}>저장</button>
              </span>
            </Field>
          )}
        </div>
      )}

      <div className="csgen">
        <div className="csrow">
          <Field label="shape" wide>
            <select value={g.shape} onChange={(e) => set('shape', e.target.value)}>
              {SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="csrow">
          <Field label="θ min" unit="deg" value={g.min} onChange={num('min')} />
          <Field label="θ max" unit="deg" value={g.max} onChange={num('max')} />
          <Field label="step" unit="deg" value={g.step} step="any" onChange={num('step')} />
          {g.shape === 'flat' && (
            <Field label="value" value={g.value} step="any" onChange={num('value')} />
          )}
          {g.shape === 'exp' && (<>
            <Field label="amplitude" value={g.amp} step="any" onChange={num('amp')} />
            <Field label="decay τ" unit="deg" value={g.tau} step="any" onChange={num('tau')} />
          </>)}
          {g.shape === 'gauss' && (<>
            <Field label="amplitude" value={g.amp} step="any" onChange={num('amp')} />
            <Field label="center μ" unit="deg" value={g.mu} step="any" onChange={num('mu')} />
            <Field label="width σ" unit="deg" value={g.sigma} step="any" onChange={num('sigma')} />
          </>)}
          <button className="sbtn go csgenbtn" onClick={apply}>generate</button>
        </div>
      </div>

      <Plot pts={pts} />

      <div className="csbody">
        <div className="cslabel">angle[deg] · dσ/dΩ ({pts.length} points) → {path}</div>
        <textarea value={value} spellCheck={false}
          onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  )
}

function Plot({ pts }) {
  const W = 520, H = 150, pad = 24
  if (pts.length < 2) return <div className="csplot empty">데이터 없음 — generate 하세요.</div>
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y1 = Math.max(...ys, 1e-9), y0 = Math.min(...ys, 0)
  const X = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad)
  const Y = (y) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * pad)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')
  return (
    <svg className="csplot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="axis" />
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} className="axis" />
      <path d={d} className="curve" />
      <text x={W - pad} y={H - 8} className="axlabel" textAnchor="end">θ {x0}–{x1}°</text>
      <text x={4} y={pad} className="axlabel">{y1.toPrecision(3)}</text>
    </svg>
  )
}
