// The component dock: add beams / collimators / targets / rings / single
// detectors, edit any of them, and read the numbers each one implies.
import { useState } from 'react'
import { usePlanner } from '../../stark/store.jsx'
import { RING_TYPES, DET_TYPES, DET_COLOR, MATERIALS } from '../../stark/data.js'
import { GEO } from '../../stark/geometry.js'
import NUCLIDES from '../../stark/nuclides.js'
import {
  beamEnergyMeV, targetMgcm2, targetMm, targetLoss, spotOf, cmFor,
  ejKind, punchThroughE, targetPos, activeBeam, activeTarget,
} from '../../stark/model.js'
import { PH } from '../../stark/physics.js'

const f = (x, n = 2) => (x == null || !isFinite(x) ? '–' : (+x).toFixed(n))

const SECTIONS = [
  { key: 'beamSlots', label: 'Beam', slot: true, add: 'beam', addLabel: '빔 슬롯 복제' },
  { key: 'collimators', label: 'Collimators', add: 'coll', addLabel: '콜리메이터' },
  { key: 'targetSlots', label: 'Targets', slot: true, add: 'target', addLabel: '타겟 슬롯' },
  { key: 'rings', label: 'Detector rings', add: 'ring', addLabel: '검출기 링' },
  { key: 'singles', label: 'Single detectors', add: 'single', addLabel: '개별 검출기' },
]

function Row({ label, children, unit }) {
  return (
    <div className="pfrow">
      <label>{label}</label>
      <div className="pfin">{children}</div>
      {unit ? <span className="pfu">{unit}</span> : null}
    </div>
  )
}

// One field bound to obj[key]. Numbers commit on change so typing "-" or "1."
// does not get rewritten under the cursor.
function Field({ o, k, label, unit, opts, list, text, bool, step = 0.1 }) {
  const { setField } = usePlanner()
  const [draft, setDraft] = useState(null)
  const v = draft != null ? draft : o[k]
  if (bool) {
    return (
      <Row label={label}>
        <input type="checkbox" checked={!!o[k]} onChange={(e) => setField(o.id, k, e.target.checked)} />
      </Row>
    )
  }
  if (opts) {
    return (
      <Row label={label} unit={unit}>
        <select value={o[k]} onChange={(e) => setField(o.id, k, e.target.value)}>
          {opts.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </Row>
    )
  }
  const commit = () => { if (draft != null) { setField(o.id, k, draft); setDraft(null) } }
  return (
    <Row label={label} unit={unit}>
      <input
        type={text || list ? 'text' : 'number'} step={step} list={list} value={v}
        onChange={(e) => (text || list ? setField(o.id, k, e.target.value) : setDraft(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur() } }}
      />
    </Row>
  )
}

function KV({ rows }) {
  return (
    <div className="pfkv">
      {rows.map(([k, v], i) => (
        <div key={i}><b dangerouslySetInnerHTML={{ __html: k }} /><span dangerouslySetInnerHTML={{ __html: v }} /></div>
      ))}
    </div>
  )
}

// Telescope pairing lives in its own block: pick the partner, then match this
// ring's z to it. The residual is quoted because a dE-E pair at two radii can
// never line up exactly unless h/r agrees.
function PairBlock({ o }) {
  const { S, setPair, matchPairZ, byId } = usePlanner()
  const [res, setRes] = useState(null)
  const others = S.rings.filter((r) => r.id !== o.id)
  const mate = o.pair ? byId(o.pair) : null
  const T = targetPos(S)
  const gap = mate ? GEO.mismatch(GEO.edgeAngles(o, T), GEO.edgeAngles(mate, T)) : null
  return (
    <>
      <div className="pfrow">
        <label>페어 링</label>
        <div className="pfin">
          <select value={o.pair || ''} onChange={(e) => { setPair(o.id, e.target.value || null); setRes(null) }}>
            <option value="">없음</option>
            {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>
      {mate && (
        <div className="pairbox">
          <div className="pfkv">
            <div><b>θ 차이</b><span>{gap == null ? '–' : `${f(gap, 2)}°`} &nbsp;
              <span className="dim">({f(GEO.edgeAngles(o, T)[0], 1)}–{f(GEO.edgeAngles(o, T)[1], 1)}° vs {f(GEO.edgeAngles(mate, T)[0], 1)}–{f(GEO.edgeAngles(mate, T)[1], 1)}°)</span></span></div>
          </div>
          <button className="mini" onClick={() => setRes(matchPairZ(o.id))}>
            {mate.name} 에 각도 맞추기
          </button>
          {res && (
            <div className="dnote">
              z {f(res.z, 1)} mm 로 이동 — θ 차이 {f(res.before, 2)}° → <b>{f(res.after, 2)}°</b>
              {res.after > 0.05 && <> (반지름이 달라 완전히 같아질 수는 없습니다)</>}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function Form({ o, sec }) {
  const detNames = Object.keys(DET_TYPES)
  if (sec.key === 'beamSlots') return (<>
    <Field o={o} k="name" label="이름" text />
    <Field o={o} k="nuc" label="핵종" list="nuclist" />
    <Field o={o} k="energy" label="에너지" step={0.01} />
    <Field o={o} k="eUnit" label="단위" opts={['MeV/u', 'MeV']} />
    <Field o={o} k="intensity" label="세기" step={1000} unit="pps" />
    <Field o={o} k="sx" label="σx" unit="mm" />
    <Field o={o} k="sy" label="σy" unit="mm" />
    <Field o={o} k="x0" label="x offset" unit="mm" />
    <Field o={o} k="y0" label="y offset" unit="mm" />
    <Field o={o} k="divx" label="div x" unit="mrad" />
    <Field o={o} k="divy" label="div y" unit="mrad" />
  </>)
  if (sec.key === 'collimators') return (<>
    <Field o={o} k="name" label="이름" text />
    <Field o={o} k="r" label="구경 R" unit="mm" />
    <Field o={o} k="z" label="z" step={1} unit="mm" />
    <Field o={o} k="thick" label="두께" step={0.5} unit="mm" />
  </>)
  if (sec.key === 'targetSlots') return (<>
    <Field o={o} k="name" label="이름" text />
    <Field o={o} k="material" label="물질" opts={Object.keys(MATERIALS)} />
    <Field o={o} k="nuc" label="반응 핵종" list="nuclist" />
    <Field o={o} k="thick" label="두께" step={0.01} />
    <Field o={o} k="thickUnit" label="단위" opts={['mg/cm2', 'um', 'mm']} />
    <Field o={o} k="radius" label="반지름" step={0.5} unit="mm" />
    <Field o={o} k="z" label="z" step={1} unit="mm" />
    <Field o={o} k="x0" label="x offset" unit="mm" />
    <Field o={o} k="y0" label="y offset" unit="mm" />
  </>)
  if (sec.key === 'singles') return (<>
    <Field o={o} k="name" label="이름" text />
    <Field o={o} k="det" label="검출기" opts={detNames} />
    <Field o={o} k="z" label="z" step={1} unit="mm" />
    <Field o={o} k="x" label="x" step={1} unit="mm" />
    <Field o={o} k="y" label="y" step={1} unit="mm" />
    <Field o={o} k="facing" label="바라보는 곳" opts={['target', 'z', 'r']} />
  </>)
  const bare = o.mount === 'bare'
  return (<>
    <Field o={o} k="name" label="이름" text />
    <Field o={o} k="type" label="링 종류" opts={Object.keys(RING_TYPES)} />
    <Field o={o} k="det" label="검출기" opts={detNames} />
    <PairBlock o={o} />
    <Field o={o} k="mount" label="마운트" opts={['frame', 'bare']} />
    <Field o={o} k="z" label={bare ? '검출기 중심 z' : '링 z (앞면)'} step={1} unit="mm" />
    <Field o={o} k="div" label="φ 분할" step={1} />
    <Field o={o} k="phi0" label="첫 검출기 φ" step={1} unit="°" />
    <Field o={o} k="r" label="링 반지름" unit="mm" />
    {/* frame geometry is meaningless without a frame, so it is hidden rather
        than left there inviting edits that do nothing */}
    {!bare && (<>
      <Field o={o} k="off" label="링 z →" step={0.05} unit="mm" />
      <Field o={o} k="offMode" label="… 기준" opts={['center', 'edge']} />
      <Field o={o} k="flip" label="z 뒤집기" bool />
      <Field o={o} k="z1" label="링 z₁" step={1} unit="mm" />
      <Field o={o} k="z2" label="링 z₂" step={1} unit="mm" />
      <Field o={o} k="rmin" label="링 r_min" step={1} unit="mm" />
      <Field o={o} k="rmax" label="링 r_max" step={1} unit="mm" />
    </>)}
    <Field o={o} k="dir" label="바라보는 곳" opts={[1, 2]} />
    <p className="dnote">1 = 빔축을 보는 평판 (X6/BB10/CSD) · 2 = z에 수직인 웨이퍼 (QQQ5).
      {bare
        ? ' bare 는 프레임 없이 검출기만 답니다 — z 가 곧 검출기 중심이고, 부피를 차지하지 않아 충돌 검사에서 빠집니다.'
        : ' 뒤집기는 offset과 링 몸체를 앞면 기준으로 미러링합니다. r_min/r_max와 z₁/z₂는 다른 링이 들어올 수 없는 부피입니다.'}</p>
  </>)
}

function Readout({ o, sec }) {
  const { S, rx } = usePlanner()
  const T = targetPos(S)
  if (sec.key === 'beamSlots') {
    const n = PH.nuc(o.nuc)
    if (!n) return <div className="dnote">모르는 핵종입니다.</div>
    const E = beamEnergyMeV(o), g = 1 + E / n.m, beta = Math.sqrt(1 - 1 / (g * g))
    return <KV rows={[
      ['Z / A', `${n.Z} / ${n.A}`],
      ['전체 에너지', `${f(E)} MeV (${f(E / n.A, 3)} MeV/u)`],
      ['β / γ', `${f(beta, 4)} / ${f(g, 4)}`],
      ['스폿 3σ', `${f(3 * o.sx)} × ${f(3 * o.sy)} mm`],
      ['rate', `${(+o.intensity).toExponential(2)} pps`],
    ]} />
  }
  if (sec.key === 'collimators') {
    const b = activeBeam(S); if (!b) return null
    const st = PH.envelope(b, S.collimators, T[2]).stages.find((x) => x.id === o.id)
    if (!st) return null
    return <KV rows={[
      ['구경', `${f(st.nSigX)} σ<sub>x</sub> · ${f(st.nSigY)} σ<sub>y</sub>`],
      ['여기서의 빔', `σ ${f(st.inSx)} × ${f(st.inSy)} mm, 축에서 ${f(st.offSig)} σ`],
      ['투과율', `<b class="${st.T < 0.5 ? 'warn' : 'ok'}">${f(st.T * 100, 1)} %</b> (누적 ${f(st.Tcum * 100, 1)} %)`],
      ['클립 후 σ', `${f(st.outSx)} × ${f(st.outSy)} mm`],
      ['통과 rate', `${(b.intensity * st.Tcum).toExponential(2)} pps`],
    ]} />
  }
  if (sec.key === 'targetSlots') {
    const b = activeBeam(S)
    const l = b ? targetLoss(b, o, 1) : null
    const sp = b ? PH.envelope(b, S.collimators, +o.z).at(+o.z) : null
    return <KV rows={[
      ['면밀도', `${f(targetMgcm2(o), 4)} mg/cm²`],
      ['두께', `${f(targetMm(o) * 1000)} µm`],
      ['차지하는 곳', `r ≤ ${f(o.radius, 1)} mm, z ${f(+o.z - targetMm(o) / 2, 3)} … ${f(+o.z + targetMm(o) / 2, 3)} mm`],
      ['여기서의 빔 스폿', sp ? `σ ${f(sp.sx)} × ${f(sp.sy)} mm, 3σ ${f(6 * sp.sx, 1)} × ${f(6 * sp.sy, 1)} mm` : '–'],
      ['스폿 vs 타겟', sp ? (3 * Math.max(sp.sx, sp.sy) > +o.radius
        ? '<span class="bad">3σ 스폿이 타겟보다 큽니다</span>' : '<span class="ok">3σ가 타겟 안에 듭니다</span>') : '–'],
      ['빔 ΔE', l ? (l.stopped ? '<span class="bad">타겟에서 정지</span>' : `${f(l.dep, 3)} MeV → ${f(l.out)} MeV`) : '–'],
    ]} />
  }

  const isRing = sec.key === 'rings'
  const faces = isRing ? GEO.faces(o, T[2]) : [GEO.singleFace(o, T)]
  if (!faces.length) return null
  const a = GEO.faceAngles(faces[0], T)
  const dt = DET_TYPES[o.det] || {}
  const sp = GEO.spotSpread(faces[0], T, spotOf(S))
  const cm = rx && rx.ok ? cmFor(rx, a.th1, a.th2) : null
  const cov = isRing ? GEO.ringCoverage(o, T) : null
  const rows = [
    ['θ<sub>lab</sub> (면 중심)', `<b>${f(a.th1)}° – ${f(a.th2)}°</b> &nbsp; Δ ${f(a.th2 - a.th1)}°`],
    ['θ<sub>lab</sub> (면 전체)', `${f(a.thetaMin)}° – ${f(a.thetaMax)}°`],
    ['θ<sub>cm</sub>', cm ? `<b>${f(cm[0])}° – ${f(cm[1])}°</b>` : '<span class="warn">반응을 먼저 정의하세요</span>'],
    ['σ<sub>θ</sub> (빔 스폿)', `± ${f(sp.sigma, 3)}° (${f(sp.min)} … ${f(sp.max)}°)`],
  ]
  if (cov) {
    rows.push(['φ 커버리지', `<b>${f(cov.phiFrac * 100, 1)} %</b> — ${cov.nDet} × ${f(cov.dphi)}° / ${f(360 / cov.nDet)}° pitch`])
    rows.push(['기하 효율', `<b>${f(cov.eff4pi * 100)} % of 4π</b> · 자기 θ shell의 ${f(cov.effShell * 100, 1)} %`])
  }
  rows.push(['입체각', `${f(a.omega, 4)} sr/det · ${f(cov ? cov.omega : a.omega, 3)} sr`])
  if (isRing) {
    const [z1, z2] = GEO.ringZSpan(o)
    rows.push(['검출기 z 중심', `${f(GEO.detCentreZ(o))} mm${o.flip ? ' (뒤집힘)' : ''}`])
    rows.push(o.mount === 'bare'
      ? ['마운트', '<span class="ok">bare</span> — 프레임 없음, 충돌 검사 제외']
      : ['링 부피', `z ${f(z1, 1)} … ${f(z2, 1)} mm, r ${f(o.rmin, 1)} … ${f(o.rmax, 1)} mm`])
    rows.push(['채널', `${(dt.ch || 0) * o.div} (${dt.ch || 0} × ${o.div})`])
  }
  const mm = (dt.thick || 0) / 1000
  const pt = punchThroughE(ejKind(S), mm)
  if (pt !== undefined) {
    rows.push(['punch-through', pt == null
      ? `40 MeV 이하에서는 관통 안 함 (${f(mm * 1000, 0)} µm Si)`
      : `${S.reaction.ejectile} — <b>${f(pt, 1)} MeV</b> 이상 ${f(mm * 1000, 0)} µm Si 관통`])
  }
  return <KV rows={rows} />
}

function Item({ o, sec }) {
  const { sel, setSel, open, toggleOpen, bad, remove, setField, setActiveSlot } = usePlanner()
  const isOpen = open.has(o.id)
  const dot = o.kind === 'ring' || o.kind === 'single' ? (DET_COLOR[o.det] || '#888')
    : sec.key === 'targetSlots' ? '#d1495b' : sec.key === 'collimators' ? '#7c8797' : '#d9822b'
  const sub = sec.key === 'rings'
    ? `${o.det} ×${o.div} · r ${f(o.r, 1)} · z ${f(o.z, 1)}${o.mount === 'bare' ? ' · bare' : ''}${o.pair ? ' · ⛓' : ''}`
    : sec.key === 'collimators' ? `R ${f(o.r, 1)} · z ${f(o.z, 1)}`
      : sec.key === 'targetSlots' ? `${o.material} ${f(o.thick)} ${o.thickUnit} · z ${f(o.z, 1)}`
        : sec.key === 'singles' ? `${o.det} · z ${f(o.z, 1)}`
          : `${o.nuc} ${f(o.energy)} ${o.eUnit}`
  return (
    <div className={`pitem${isOpen ? ' open' : ''}${sel === o.id ? ' sel' : ''}${bad.has(o.id) ? ' bad' : ''}`}>
      <div className="phead" onClick={() => { toggleOpen(o.id); setSel(o.id) }}>
        <i className="pdot" style={{ background: dot }} />
        <span className="pname">{o.name}</span>
        <span className="psub">{sub}</span>
        {sec.slot
          ? <input type="radio" checked={!!o.active} title="이 슬롯 사용"
              onChange={() => setActiveSlot(o.id)} onClick={(e) => e.stopPropagation()} />
          : <input type="checkbox" checked={o.enabled !== false} title="표시"
              onChange={(e) => setField(o.id, 'enabled', e.target.checked)} onClick={(e) => e.stopPropagation()} />}
        <button className="px" title="삭제"
          onClick={(e) => { e.stopPropagation(); remove(o.id) }}>✕</button>
      </div>
      {isOpen && (
        <div className="pbody">
          <Form o={o} sec={sec} />
          <Readout o={o} sec={sec} />
        </div>
      )}
    </div>
  )
}

export default function PlannerPanel() {
  const { S, add, setView } = usePlanner()

  return (
    <div className="plannerpanel">
      <datalist id="nuclist">{Object.keys(NUCLIDES).map((n) => <option key={n} value={n} />)}</datalist>

      <div className="paddrow">
        {SECTIONS.map((s) => (
          <button key={s.add} className="mini" onClick={() => add(s.add)}>+ {s.addLabel}</button>
        ))}
      </div>

      <div className="pviewrow">
        <label><input type="checkbox" checked={S.view.showFrames !== false}
          onChange={(e) => setView({ showFrames: e.target.checked })} /> 링 프레임</label>
        <label><input type="checkbox" checked={S.view.showBeam !== false}
          onChange={(e) => setView({ showBeam: e.target.checked })} /> 빔 3σ</label>
      </div>

      {SECTIONS.map((sec) => (
        <div className="psec" key={sec.key}>
          <div className="psechead"><span>{sec.label}</span><em>{S[sec.key].length}</em></div>
          {S[sec.key].length
            ? S[sec.key].map((o) => <Item key={o.id} o={o} sec={sec} />)
            : <div className="dnote">아직 없습니다.</div>}
        </div>
      ))}

    </div>
  )
}
