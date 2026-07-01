import React, { useState } from 'react'
import {
  DETECTOR_BLOCKS, parseDetector, serializeDetector, fieldSpec, newBlock,
  detectCombo, switchStark, getParam,
} from './detector.js'
import { Field } from './formfields.jsx'

const ADDABLE = ['Target', 'ATOMX', 'STARK']
const defaultFor = (f) => f.default ?? (f.type === 'num'
  ? Array(f.n).fill('0').join(' ') + (f.unit ? ' ' + f.unit : '')
  : f.type === 'choice' ? f.choices[0] : '')

export default function DetectorForm({ initialText, onChange }) {
  const [blocks, setBlocks] = useState(() => parseDetector(initialText))
  const [confirmClear, setConfirmClear] = useState(false)
  const commit = (next) => { setBlocks(next); onChange(serializeDetector(next)) }
  const mutate = (bi, fn) => commit(blocks.map((b, i) => {
    if (i !== bi) return b
    const nb = { ...b, params: b.params.map((p) => ({ ...p })) }
    fn(nb); return nb
  }))

  const hasATOMX = blocks.some((b) => b.type === 'ATOMX')
  const setVal = (bi, key, value) => mutate(bi, (nb) => {
    const p = nb.params.find((x) => x.key === key)
    if (p) p.value = value; else nb.params.push({ key, value })
  })
  const removeField = (bi, key) => mutate(bi, (nb) => { nb.params = nb.params.filter((p) => p.key !== key) })
  const addField = (bi, key) =>
    mutate(bi, (nb) => nb.params.push({ key, value: fieldSpec(blocks[bi].type, key) ? defaultFor(fieldSpec(blocks[bi].type, key)) : '' }))
  const applyPreset = (bi, set) => mutate(bi, (nb) =>
    Object.entries(set).forEach(([k, v]) => {
      const p = nb.params.find((x) => x.key === k); if (p) p.value = v; else nb.params.push({ key: k, value: v })
    }))
  const setCombo = (bi, combo) => mutate(bi, (nb) => { nb.params = switchStark(nb, combo) })
  const addBlock = (type) => commit([...blocks, newBlock(type, { hasATOMX })])
  const removeBlock = (bi) => commit(blocks.filter((_, i) => i !== bi))
  const clearAll = () => {                          // inline 2-step confirm
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false); commit([])
  }
  const has = (type) => blocks.some((b) => b.type === type)

  return (
    <div className="dform">
      <div className="dtoolbar">
        <span className="dnote">add:</span>
        {ADDABLE.map((t) => (
          <button key={t} className="reload" disabled={DETECTOR_BLOCKS[t].single && has(t)}
            onClick={() => addBlock(t)}>+ {t}</button>
        ))}
        <button className="reload danger" onClick={clearAll} disabled={!blocks.length}
          onMouseLeave={() => setConfirmClear(false)}>{confirmClear ? '정말 지울까요?' : 'clear all'}</button>
      </div>

      {blocks.map((b, bi) => {
        const spec = DETECTOR_BLOCKS[b.type]
        const presentKeys = new Set(b.params.map((p) => p.key))
        const addable = (spec?.fields || []).filter((f) => !presentKeys.has(f.key))
        return (
          <section className="dblock" key={bi}>
            <div className="dbhead">
              <span className="dbtitle">{spec ? spec.label : b.type}
                {spec?.repeatable ? ` · ${b.type}` : ''}{!spec && ' (unknown)'}</span>
              {spec?.combos && (
                <select className="comboSel" value={detectCombo(b)}
                  onChange={(e) => setCombo(bi, e.target.value)} title="파라미터 조합">
                  {Object.entries(spec.combos).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
                </select>
              )}
              <button className="solo" title="remove block" onClick={() => removeBlock(bi)}>✕</button>
            </div>

            {spec?.presets && Object.entries(spec.presets).map(([k, list]) => (
              <div className="dpreset" key={k}>
                <span>{k} preset</span>
                <div className="presetbtns">
                  {list.map((p) => {
                    const on = Object.entries(p.set).every(([kk, vv]) => getParam(b, kk).trim() === vv)
                    return (
                      <button key={p.label} type="button" className={`pbtn ${on ? 'on' : ''}`}
                        onClick={() => applyPreset(bi, p.set)}>{p.label}</button>
                    )
                  })}
                </div>
              </div>
            ))}

            <div className="dfields">
              {b.params.map((p) => {
                const f = fieldSpec(b.type, p.key) || { key: p.key, label: p.key, type: 'text' }
                return <Field key={p.key} f={f} value={p.value}
                  onChange={(v) => setVal(bi, p.key, v)} onRemove={() => removeField(bi, p.key)} />
              })}
            </div>

            {addable.length > 0 && (
              <div className="daddfield">
                <select value="" onChange={(e) => { if (e.target.value) addField(bi, e.target.value) }}>
                  <option value="" disabled>+ 필드 추가…</option>
                  {addable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
            )}
          </section>
        )
      })}

      {!blocks.length && <div className="dnote">검출기 블록이 없습니다. 위에서 추가하세요.</div>}
    </div>
  )
}
