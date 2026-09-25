// The volume tree, lifted from nptoy's simulation tab: group → name → copies,
// each row show/hide + solo + a per-name style editor. It knows nothing about
// STARK — it just walks the volume array the planner hands the Viewer.
import { useMemo, useState } from 'react'
import { ColorPicker } from 'lilak-ui'

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
const rgbHex = (c, k = 1) => '#' + hex2((c?.[0] || 0) * k) + hex2((c?.[1] || 0) * k) + hex2((c?.[2] || 0) * k)
const swatch = (c) => rgbHex(c, 0.85)

const STYLE_MODES = [['wire', '와이어'], ['solid', '솔리드'], ['transparent', '투명']]

function StyleEditor({ style, onChange, onReset, onApplyAll, defEdge, defFill, hideApplyAll }) {
  const s = style || {}
  const mode = s.mode || 'wire'
  return (
    <div className="vstyle">
      <div className="vsmodes">
        {STYLE_MODES.map(([m, label]) => (
          <button key={m} className={`vsmode ${mode === m ? 'on' : ''}`} onClick={() => onChange({ mode: m })}>{label}</button>
        ))}
      </div>
      <div className="vsrow"><span>선 색</span>
        <ColorPicker value={s.edge || defEdge} onChange={(c) => onChange({ edge: c })} size={22} title="선 색" />
      </div>
      {mode !== 'wire' && (
        <div className="vsrow"><span>채움 색</span>
          <ColorPicker value={s.fill || defFill} onChange={(c) => onChange({ fill: c })} size={22} title="채움 색" />
        </div>
      )}
      {mode === 'transparent' && (
        <label className="vsrow"><span>투명도</span>
          <input type="range" min="0.05" max="0.9" step="0.05" value={s.opacity ?? 0.35}
            onChange={(e) => onChange({ opacity: +e.target.value })} />
          <b className="vsval">{(s.opacity ?? 0.35).toFixed(2)}</b></label>
      )}
      <label className="vsrow"><span>선 두께</span>
        <input type="range" min="1" max="6" step="1" value={s.width ?? 1}
          onChange={(e) => onChange({ width: +e.target.value })} />
        <b className="vsval">{s.width ?? 1}px</b></label>
      <div className="vsflags">
        <button className={`vsflag ${s.label ? 'on' : ''}`} onClick={() => onChange({ label: !s.label })}>치수 라벨</button>
        <button className={`vsflag ${s.highlight ? 'on' : ''}`} onClick={() => onChange({ highlight: !s.highlight })}>하이라이트</button>
        {mode !== 'wire' && (
          <button className={`vsflag ${s.noWire ? 'on' : ''}`} onClick={() => onChange({ noWire: !s.noWire })}>선 숨기기</button>
        )}
      </div>
      <div className="vsfoot">
        <button className="vsmini" onClick={onReset}>초기화</button>
        {!hideApplyAll && <button className="vsmini" onClick={() => onApplyAll(s)}>전체 적용</button>}
      </div>
    </div>
  )
}

function Row({ color, swatchC, label, hidden, onToggle, onSolo, onGear, styled, indent }) {
  return (
    <div className={`vol ${indent ? 'indent' + Math.min(indent, 2) : ''}`}>
      <button className={`tg ${hidden ? '' : 'on'}`} onClick={onToggle} title="show/hide">
        <span className="box" style={{ '--c': swatchC || swatch(color) }} />
        <span className="vname">{label}</span>
      </button>
      {onGear && <button className={`gear ${styled ? 'on' : ''}`} title="스타일" onClick={onGear}>◐</button>}
      <button className="solo" title="이것만 표시" onClick={onSolo}>◎</button>
    </div>
  )
}

export default function VolumesPanel({ geometry, hidden, setHidden, styles, setStyles }) {
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [styleFor, setStyleFor] = useState(null)
  const [gstyle, setGstyle] = useState({})

  const groups = useMemo(() => {
    const m = new Map()
    for (const g of geometry) {
      if (!m.has(g.group)) m.set(g.group, new Map())
      const nm = m.get(g.group)
      if (!nm.has(g.name)) nm.set(g.name, [])
      nm.get(g.name).push({ id: g.id, copy: g.copy, color: g.color })
    }
    return m
  }, [geometry])

  const allIds = useMemo(() => geometry.map((g) => g.id), [geometry])
  const toggleIds = (ids) => setHidden((h) => {
    const n = new Set(h)
    const off = ids.every((i) => n.has(i))
    ids.forEach((i) => (off ? n.delete(i) : n.add(i)))
    return n
  })
  const soloIds = (ids) => setHidden(new Set(allIds.filter((i) => !ids.includes(i))))
  const allHidden = (ids) => ids.every((i) => hidden.has(i))
  const isCol = (k) => collapsed.has(k)
  const toggleCol = (k) => setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n })

  const setStyle = (name, patch) => setStyles((s) => ({ ...s, [name]: { ...s[name], ...patch } }))
  const resetOne = (name) => setStyles((s) => { const n = { ...s }; delete n[name]; return n })
  const resetAll = () => { setStyles({}); setGstyle({}) }
  const applyAll = (style) => setStyles(() => {
    const n = {}
    for (const nm of new Set(geometry.map((g) => g.name))) n[nm] = { ...style }
    return n
  })
  const applyGlobal = (patch) => setGstyle((g) => { const n = { ...g, ...patch }; applyAll(n); return n })

  const gearFor = (name) => () => setStyleFor((x) => (x === name ? null : name))
  const styleEditor = (name, color) => styleFor === name
    ? <StyleEditor style={styles[name]} onChange={(p) => setStyle(name, p)}
        onReset={() => resetOne(name)} onApplyAll={applyAll}
        defEdge={rgbHex(color, 0.7)} defFill={rgbHex(color)} /> : null

  const swatchColor = (name, id, color) => {
    const d = { ...(styles[name] || {}), ...(id != null ? styles[id] || {} : {}) }
    return d.edge || d.fill || swatch(color)
  }

  function renderName(grp, name, items, indent) {
    const ids = items.map((x) => x.id)
    if (items.length === 1) {
      return (
        <div key={name}>
          <Row indent={indent} color={items[0].color} swatchC={swatchColor(name, ids[0], items[0].color)}
            label={name} styled={!!styles[name]} hidden={hidden.has(ids[0])}
            onToggle={() => toggleIds(ids)} onSolo={() => soloIds(ids)} onGear={gearFor(name)} />
          {styleEditor(name, items[0].color)}
        </div>
      )
    }
    const nk = 'n:' + grp + '/' + name
    return (
      <div className="vgroup" key={name}>
        <div className={`vghead ${indent ? 'indent' : ''}`}>
          <button className="caret" onClick={() => toggleCol(nk)}>{isCol(nk) ? '▸' : '▾'}</button>
          <button className={`tg ${allHidden(ids) ? '' : 'on'}`} onClick={() => toggleIds(ids)} title="show/hide all copies">
            <span className="box" style={{ '--c': swatchColor(name, null, items[0].color) }} />
            <span className="vname">{name}</span><span className="vtype">×{items.length}</span>
          </button>
          <button className={`gear ${styles[name] ? 'on' : ''}`} title="스타일" onClick={gearFor(name)}>◐</button>
        </div>
        {styleEditor(name, items[0].color)}
        {!isCol(nk) && items.map((it) => (
          <div key={it.id}>
            <Row indent={(indent || 0) + 1} color={it.color} swatchC={swatchColor(name, it.id, it.color)}
              label={`#${it.copy}`} styled={!!styles[it.id]} hidden={hidden.has(it.id)}
              onToggle={() => toggleIds([it.id])} onSolo={() => soloIds([it.id])} onGear={gearFor(it.id)} />
            {styleEditor(it.id, it.color)}
          </div>
        ))}
      </div>
    )
  }

  if (!geometry.length) return <div className="dnote">지오메트리가 없습니다.</div>

  return (
    <div className="vollist tall">
      <div className="psaverow">
        <button className="mini" onClick={() => setHidden(new Set())}>all on</button>
        <button className="mini" disabled={!Object.keys(styles).length} onClick={resetAll}>모두 초기화</button>
      </div>
      <div className="allstylerow">
        <span className="vname">모든 볼륨 스타일 통일</span>
        <button className={`gear ${styleFor === '*' ? 'on' : ''}`} title="전체 스타일 통일" onClick={gearFor('*')}>◐</button>
      </div>
      {styleFor === '*' && (
        <StyleEditor style={gstyle} onChange={applyGlobal} onReset={resetAll}
          defEdge="#88aacc" defFill="#88aacc" hideApplyAll />
      )}
      {[...groups.entries()].map(([grp, names]) =>
        grp === ''
          ? [...names.entries()].map(([name, items]) => renderName('', name, items, 0))
          : (
            <div className="vgroup" key={grp}>
              <div className="vghead">
                <button className="caret" onClick={() => toggleCol('g:' + grp)}>{isCol('g:' + grp) ? '▸' : '▾'}</button>
                <button className={`tg ${allHidden([...names.values()].flat().map((x) => x.id)) ? '' : 'on'}`}
                  onClick={() => toggleIds([...names.values()].flat().map((x) => x.id))} title="show/hide group">
                  <span className="box" />
                  <span className="vname">{grp}</span>
                  <span className="vtype">{[...names.values()].flat().length}</span>
                </button>
              </div>
              {!isCol('g:' + grp) && [...names.entries()].map(([name, items]) => renderName(grp, name, items, 1))}
            </div>
          ))}
    </div>
  )
}
