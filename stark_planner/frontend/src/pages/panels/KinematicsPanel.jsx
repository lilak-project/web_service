// Reaction, beam energy loss, the E–θ curves with each ring's coverage band,
// and the whole-array acceptance.
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlanner } from '../../stark/store.jsx'
import { DET_TYPES, DET_COLOR, MATERIALS } from '../../stark/data.js'
import { GEO } from '../../stark/geometry.js'
import { PH } from '../../stark/physics.js'
import {
  beamEnergyMeV, targetMgcm2, targetMm, targetLoss, cmFor, ejKind,
  punchThroughE, targetPos, activeBeam, activeTarget,
} from '../../stark/model.js'

const f = (x, n = 2) => (x == null || !isFinite(x) ? '–' : (+x).toFixed(n))
const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888'

function Plot({ mode, range, canvasRef }) {
  const { S, rx, elossTick } = usePlanner()
  const ref = canvasRef
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1
    if (!W || !H) return
    c.width = W * dpr; c.height = H * dpr
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const ink = cssv('--text'), ink3 = cssv('--text-muted'), line = cssv('--border')
    const L = 46, R = 10, Tp = 10, B = 26
    const T = targetPos(S)

    let auto = 1
    if (rx && rx.ok) for (let i = 0; i < rx.cm.length; i++) auto = Math.max(auto, rx.T3[i])
    const x0 = range.x0 ?? 0, x1 = range.x1 ?? 180
    const y0 = range.y0 ?? 0, y1 = range.y1 ?? Math.ceil(auto * 1.08)
    const px = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R)
    const py = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - Tp - B)
    // the axes double as the clip box so a curve can't run over the labels
    const clip = () => { g.save(); g.beginPath(); g.rect(L, Tp, W - L - R, H - Tp - B); g.clip() }

    clip()
    for (const r of S.rings) {
      if (!r.enabled) continue
      const fs = GEO.faces(r, T[2]); if (!fs.length) continue
      const a = GEO.faceAngles(fs[0], T)
      let lo = a.th1, hi = a.th2
      if (mode === 'cm') { const cr = rx && rx.ok ? cmFor(rx, a.th1, a.th2) : null; if (!cr) continue; lo = cr[0]; hi = cr[1] }
      const col = DET_COLOR[r.det] || '#888'
      g.fillStyle = col + '22'
      g.fillRect(px(lo), Tp, Math.max(1.5, px(hi) - px(lo)), H - Tp - B)
      g.fillStyle = col
      g.fillRect(px(lo), H - B - 3, Math.max(1.5, px(hi) - px(lo)), 3)
    }
    g.restore()

    g.strokeStyle = line; g.lineWidth = 1
    g.beginPath(); g.moveTo(L, Tp); g.lineTo(L, H - B); g.lineTo(W - R, H - B); g.stroke()
    g.font = '10px var(--font-mono, monospace)'; g.textAlign = 'center'; g.fillStyle = ink3
    const nice = (span) => { const raw = span / 6, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p
      return (n > 5 ? 10 : n > 2 ? 5 : n > 1 ? 2 : 1) * p }
    const xs = nice(x1 - x0), ys = nice(y1 - y0)
    for (let a = Math.ceil(x0 / xs) * xs; a <= x1; a += xs) {
      g.globalAlpha = 0.4; g.beginPath(); g.moveTo(px(a), Tp); g.lineTo(px(a), H - B); g.stroke(); g.globalAlpha = 1
      g.fillText(+a.toFixed(6) + '°', px(a), H - B + 13)
    }
    g.textAlign = 'right'
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1; v += ys) {
      g.globalAlpha = 0.4; g.beginPath(); g.moveTo(L, py(v)); g.lineTo(W - R, py(v)); g.stroke(); g.globalAlpha = 1
      g.fillText(+v.toFixed(6), L - 6, py(v) + 3)
    }
    g.save(); g.translate(12, H / 2); g.rotate(-Math.PI / 2)
    g.textAlign = 'center'; g.fillStyle = ink3; g.fillText('kinetic energy (MeV)', 0, 0); g.restore()
    g.textAlign = 'center'; g.fillText(mode === 'lab' ? 'θ_lab (deg)' : 'θ_cm (deg)', (L + W - R) / 2, H - 4)

    if (!rx || !rx.ok) {
      g.fillStyle = ink3; g.font = '12px var(--font-sans, sans-serif)'
      g.fillText(rx ? rx.err : '반응을 정의하세요', W / 2, H / 2)
      return
    }
    clip()
    const curve = (lab, Tk, color, dash) => {
      g.strokeStyle = color; g.lineWidth = 2; g.setLineDash(dash || [])
      g.beginPath()
      let started = false
      for (let i = 0; i < rx.cm.length; i++) {
        const x = mode === 'lab' ? lab[i] * 180 / Math.PI : rx.cm[i] * 180 / Math.PI
        const y = Tk[i]
        if (y < 0) { started = false; continue }
        if (!started) { g.moveTo(px(x), py(y)); started = true } else g.lineTo(px(x), py(y))
      }
      g.stroke(); g.setLineDash([])
    }
    curve(rx.lab3, rx.T3, '#d9822b')
    curve(rx.lab4, rx.T4, '#8a6fd0', [5, 4])
    g.restore()

    const kind = ejKind(S)
    const seen = new Set()
    for (const r of S.rings) {
      if (!r.enabled) continue
      const dt = DET_TYPES[r.det]; if (!dt || seen.has(dt.thick)) continue
      seen.add(dt.thick)
      const pt = punchThroughE(kind, dt.thick / 1000)
      if (pt == null || pt < y0 || pt > y1) continue
      g.strokeStyle = '#d1495b'; g.globalAlpha = 0.7; g.setLineDash([3, 3])
      g.beginPath(); g.moveTo(L, py(pt)); g.lineTo(W - R, py(pt)); g.stroke()
      g.setLineDash([]); g.globalAlpha = 1
      g.fillStyle = '#d1495b'; g.textAlign = 'left'; g.font = '9px var(--font-mono, monospace)'
      g.fillText('punch-through ' + dt.thick + 'µm', L + 5, py(pt) - 4)
    }
    g.font = '10px var(--font-mono, monospace)'; g.textAlign = 'left'
    g.fillStyle = '#d9822b'; g.fillText('── ' + S.reaction.ejectile, W - 120, Tp + 12)
    g.fillStyle = '#8a6fd0'; g.fillText('-- ' + rx.recName, W - 120, Tp + 25)
  }, [S, rx, mode, elossTick, range])

  return <canvas ref={ref} className="kplot" />
}

export default function KinematicsPanel() {
  const { S, rx, totals, setReaction, stopTable, setStopTable } = usePlanner()
  const [mode, setMode] = useState('lab')
  const [rng, setRng] = useState({ x0: '', x1: '', y0: '', y1: '' })   // '' = auto
  const canvasRef = useRef(null)
  const [tbl, setTbl] = useState(null)
  const [unit, setUnit] = useState('MeV/(mg/cm2)')
  const num = (v) => (v === '' || v == null || !isFinite(+v) ? null : +v)
  const range = useMemo(() => ({
    x0: num(rng.x0), x1: num(rng.x1), y0: num(rng.y0), y1: num(rng.y1),
  }), [rng])
  const setR = (k, v) => setRng((r) => ({ ...r, [k]: v }))

  // Downloads work here (unlike in a sandboxed artifact), so hand over a real
  // PNG at 2x with an opaque background — a transparent one is useless in a talk.
  const savePNG = () => {
    const src = canvasRef.current
    if (!src) return
    const out = document.createElement('canvas')
    out.width = src.width; out.height = src.height
    const g = out.getContext('2d')
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff'
    g.fillRect(0, 0, out.width, out.height)
    g.drawImage(src, 0, 0)
    out.toBlob((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(S.name || 'stark').replace(/\s+/g, '_')}_kinematics_${mode}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  const b = activeBeam(S), t = activeTarget(S)
  const loss = b && t ? targetLoss(b, t, 1, stopTable) : null
  const nb = b && PH.nuc(b.nuc)

  // MeV/mm needs the material density to reach MeV/(g/cm2); the areal units don't.
  const applyTable = () => {
    const m = t ? MATERIALS[t.material] : null
    const fn = PH.parseTable(tbl || '', unit, m ? m.rho : 1)
    if (!fn) return
    setStopTable(() => fn)
    setTbl(null)
  }

  return (
    <div className="kinpanel">
      <div className="psec">
        <div className="psechead"><span>Reaction</span></div>
        <div className="pfrow">
          <label>ejectile</label>
          <div className="pfin"><input list="nuclist" value={S.reaction.ejectile}
            onChange={(e) => setReaction({ ejectile: e.target.value.trim() })} /></div>
        </div>
        <div className="pfrow">
          <label>recoil E<sub>x</sub></label>
          <div className="pfin"><input type="number" step="0.01" value={S.reaction.Ex}
            onChange={(e) => setReaction({ Ex: +e.target.value })} /></div>
          <span className="pfu">MeV</span>
        </div>
        <div className="pfkv">
          <div><b>반응</b><span>{rx && rx.ok
            ? `${t.nuc}(${b.nuc},${S.reaction.ejectile})${rx.recName}`
            : <span className="warn">{rx ? rx.err : '미완성'}</span>}</span></div>
          {rx && rx.ok && (<>
            <div><b>Q<sub>gs</sub></b><span>{f(rx.Q, 3)} MeV</span></div>
            <div><b>E<sub>beam</sub> in / mid</b><span>{f(beamEnergyMeV(b))} / {f(rx.Tbeam)} MeV</span></div>
            <div><b>β<sub>cm</sub></b><span>{f(rx.beta, 4)}</span></div>
            <div><b>θ<sub>lab</sub> max</b><span>{rx.maxLab3 > 179.5 ? '180 (full)' : f(rx.maxLab3, 1) + '°'}</span></div>
          </>)}
        </div>
      </div>

      <div className="psec">
        <div className="psechead">
          <span>Kinematics</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="lab">vs θ_lab</option>
            <option value="cm">vs θ_cm</option>
          </select>
        </div>
        <Plot mode={mode} range={range} canvasRef={canvasRef} />
        <div className="krange">
          <span>θ</span>
          <input type="number" placeholder="auto" value={rng.x0} onChange={(e) => setR('x0', e.target.value)} />
          <em>–</em>
          <input type="number" placeholder="180" value={rng.x1} onChange={(e) => setR('x1', e.target.value)} />
          <span>E</span>
          <input type="number" placeholder="0" value={rng.y0} onChange={(e) => setR('y0', e.target.value)} />
          <em>–</em>
          <input type="number" placeholder="auto" value={rng.y1} onChange={(e) => setR('y1', e.target.value)} />
          <button className="mini" onClick={() => setRng({ x0: '', x1: '', y0: '', y1: '' })}>auto</button>
          <button className="mini" onClick={savePNG}>PNG 저장</button>
        </div>
        <div className="dnote">음영 밴드 = 각 링이 덮는 각도. 빈 칸은 자동 범위입니다.</div>
      </div>

      <div className="psec">
        <div className="psechead"><span>Energy loss</span></div>
        <div className="pfkv">
          <div><b>타겟</b><span>{t ? `${t.material} · ${f(targetMgcm2(t), 3)} mg/cm² · ${f(targetMm(t) * 1000, 1)} µm` : '–'}</span></div>
          <div><b>빔 ΔE (전체)</b><span>{loss ? (loss.stopped ? <span className="bad">정지</span> : f(loss.dep, 3) + ' MeV') : '–'}</span></div>
          <div><b>빔 출구</b><span>{loss ? `${f(loss.out)} MeV` : '–'}{nb && loss ? ` (${f(loss.out / nb.A)} MeV/u)` : ''}</span></div>
          <div><b>stopping</b><span>{stopTable
            ? <span className="ok">불러온 테이블</span>
            : <span className="warn">Bethe-Bloch 근사</span>}</span></div>
        </div>
        {tbl == null
          ? (<div className="psaverow">
              <button className="mini" onClick={() => setTbl('')}>{stopTable ? '테이블 교체' : '테이블 불러오기'}…</button>
              {stopTable && <button className="mini" onClick={() => setStopTable(null)}>Bethe-Bloch로</button>}
            </div>)
          : (<div className="piobox">
              <div className="dnote">한 줄에 두 열: 에너지(MeV), stopping power. SRIM/LISE++ 출력을 그대로 붙여넣어도 됩니다.</div>
              <div className="psaverow">
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option>MeV/(mg/cm2)</option><option>MeV/(g/cm2)</option><option>MeV/mm</option>
                </select>
                <input type="file" accept=".txt,.csv,.dat,text/plain"
                  onChange={(e) => { const fl = e.target.files[0]; if (fl) fl.text().then(setTbl) }} />
              </div>
              <textarea value={tbl} spellCheck={false} onChange={(e) => setTbl(e.target.value)}
                placeholder={'0.1   1.23\n0.2   1.51'} />
              <div className="psaverow">
                <button className="mini" onClick={applyTable}>적용</button>
                <button className="mini" onClick={() => setTbl(null)}>닫기</button>
              </div>
            </div>)}
      </div>

      <div className="psec">
        <div className="psechead"><span>Array acceptance</span></div>
        {totals ? (
          <div className="pfkv">
            <div><b>검출기</b><span>{totals.nDet}대 · {totals.ch} 채널</span></div>
            <div><b>도달 θ<sub>lab</sub></b><span>{totals.merged.map(([x, y]) => `${f(x, 1)}–${f(y, 1)}°`).join(', ')}</span></div>
            <div><b>θ 빈틈</b><span>{totals.gaps.length
              ? totals.gaps.map(([x, y]) => `${f(x, 0)}–${f(y, 0)}°`).join(', ')
              : <span className="ok">연속</span>}</span></div>
            <div><b>기하 효율</b><span><b>{f(totals.eff * 100)} % of 4π</b> ({f(totals.uniq, 3)} sr)</span></div>
            <div><b>… 덮은 θ 중</b><span>{f(totals.inShell * 100, 1)} %</span></div>
            <div><b>웨이퍼 합</b><span>{f(totals.omega, 3)} sr — 고유 입체각의 {f(totals.stack)}×
              {totals.stack > 1.15 ? ' (적층)' : ''}</span></div>
          </div>
        ) : <div className="dnote">검출기가 없습니다.</div>}
      </div>
    </div>
  )
}
