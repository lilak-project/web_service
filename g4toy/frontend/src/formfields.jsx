import React from 'react'
import { splitNum, composeNum, MATERIALS, MATERIAL_COMPOSITION } from './detector.js'

// Shared schema-driven field renderer for the detector / reaction forms.
export function Field({ f, value, onChange, onRemove }) {
  // a <div> (not <label>): a <label> dispatches its click to the first labelable
  // descendant, which would trigger the remove (×) button on a title click.
  return (
    <div className="dfield">
      <span className="dlabel">
        {f.label}{f.comment && <em title={f.comment}> ⓘ</em>}
        {onRemove && <button className="fdel" title="remove field"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove() }}>×</button>}
      </span>
      {f.type === 'choice' ? (
        <select value={value || f.choices[0]} onChange={(e) => onChange(e.target.value)}>
          {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : f.type === 'num' ? (
        <NumInput value={value} n={f.n} unit={f.unit} onChange={onChange} />
      ) : f.type === 'material' ? (
        <>
          <input type="text" value={value} list="np-materials" placeholder="물질 선택/입력"
            onChange={(e) => onChange(e.target.value)} />
          <datalist id="np-materials">
            {MATERIALS.map((m) => <option key={m} value={m} />)}
          </datalist>
          {MATERIAL_COMPOSITION[value] && <span className="matcomp">{MATERIAL_COMPOSITION[value]}</span>}
        </>
      ) : (
        <input type="text" value={value} placeholder={f.comment}
          onChange={(e) => onChange(e.target.value)} />
      )}
      {f.comment && <span className="dcomment">{f.comment}</span>}
    </div>
  )
}

export function NumInput({ value, n, unit, onChange }) {
  const { nums, unit: u } = splitNum(value, n, unit)
  const set = (idx, v) => { const next = nums.slice(); next[idx] = v; onChange(composeNum(next, u)) }
  return (
    <span className="dnum">
      {nums.map((x, i) => (
        <input key={i} type="number" value={x} step="any" onChange={(e) => set(i, e.target.value)} />
      ))}
      {u && <span className="dunit">{u}</span>}
    </span>
  )
}
