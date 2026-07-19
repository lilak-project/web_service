import { useEffect, useRef, useState } from 'react'
import { Button, Icon, ColorPicker } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { LOGO_PATHS, LOGO_CENTER, LOGO_SPAN } from './lilakLogo'

/**
 * IconLabView — the in-portal icon editor (opened from the "lilak icon" card).
 *
 * Per-line stroke width / color / rotation, plus the logo's position, size and
 * rotation inside the box, and the box background + corner radius. Apply straight
 * to the live favicon / macOS app icon, export SVG / PNG, and save up to 10 named
 * presets (two fixed ones reproduce the icon + favicon currently in use).
 */

const VB = 1000
const LX = LOGO_CENTER.x, LY = LOGO_CENTER.y

// Current live app icon = the default the editor opens on.
const DEFAULT_CFG = {
  bg: '#EBEBEA', bgTransparent: false, radius: 20, rotation: 0,
  size: 80, offsetX: 0, offsetY: 35, darkInvert: true,
  lines: LOGO_PATHS.map(() => ({ color: '#111827', width: 28, on: true, rot: 0 })),
}
// Current live favicon = transparent, maximised, dark-aware.
const FAVICON_CFG = { ...DEFAULT_CFG, bgTransparent: true, radius: 0, size: 100, offsetX: 0, offsetY: 0 }

// Fixed (built-in, non-deletable) presets reproducing what's in use today.
const FIXED_PRESETS = [
  { id: '_app', fixed: true, name_ko: '현재 앱아이콘', name_en: 'Current app icon', config: DEFAULT_CFG },
  { id: '_fav', fixed: true, name_ko: '현재 favicon', name_en: 'Current favicon', config: FAVICON_CFG },
]

function normLine(ln) { return { color: '#111827', width: 28, on: true, rot: 0, ...ln } }
function normCfg(c) {
  return {
    ...DEFAULT_CFG, ...c,
    lines: (c?.lines && c.lines.length ? c.lines : DEFAULT_CFG.lines).map(normLine),
  }
}

function transformStr(c) {
  const k = (c.size / 100) * (VB / LOGO_SPAN)
  return `translate(${VB / 2 + c.offsetX} ${VB / 2 + c.offsetY}) rotate(${c.rotation || 0}) scale(${k.toFixed(5)}) translate(${-LX} ${-LY})`
}

// Compose the export SVG string. px → add width/height (needed to rasterize to
// PNG); dark → embed a prefers-color-scheme media query that whitens lines.
function buildSVG(c, { px, dark } = {}) {
  const rect = c.bgTransparent ? ''
    : `<rect width="${VB}" height="${VB}" rx="${(c.radius / 100 * VB).toFixed(1)}" fill="${c.bg}"/>`
  const style = (dark && c.darkInvert)
    ? '<style>@media (prefers-color-scheme:dark){.lk path{fill:#fff;stroke:#fff}}</style>' : ''
  const paths = c.lines.map((ln, i) => (ln.on
    ? `<path d="${LOGO_PATHS[i].d}"${ln.rot ? ` transform="rotate(${ln.rot} ${LX} ${LY})"` : ''} fill="${ln.color}" stroke="${ln.color}" stroke-width="${ln.width}" stroke-linejoin="round" stroke-linecap="round"/>`
    : '')).join('')
  const dim = px ? ` width="${px}" height="${px}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg"${dim} viewBox="0 0 ${VB} ${VB}">${style}${rect}<g class="lk" transform="${transformStr(c)}">${paths}</g></svg>`
}

// ── small styled bits ─────────────────────────────────────────────────────────
const sectionHdr = { fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', margin: '14px 0 8px' }
const rowS = { display: 'flex', alignItems: 'center', gap: 8 }
const lblS = { fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 56 }
const numStyle = { width: 56, height: 26, padding: '0 6px', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)', textAlign: 'right', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const CHECKER = 'repeating-conic-gradient(#0001 0% 25%, transparent 0% 50%) 50% / 18px 18px'

// One scalar control: slider + number input, both editing the same value.
function NumField({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  return (
    <div style={rowS}>
      {label != null && <span style={lblS}>{label}</span>}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, minWidth: 60 }} />
      <input type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} style={numStyle} />
      {suffix && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', width: 12 }}>{suffix}</span>}
    </div>
  )
}

// A tiny static render of a config — used for preset thumbnails.
function MiniIcon({ cfg, px = 30 }) {
  const c = cfg
  return (
    <div style={{ width: px, height: px, borderRadius: 6, overflow: 'hidden', background: c.bgTransparent ? CHECKER : 'transparent', border: '1px solid var(--border-subtle)' }}>
      <svg viewBox={`0 0 ${VB} ${VB}`} width={px} height={px}>
        {!c.bgTransparent && <rect width={VB} height={VB} rx={c.radius / 100 * VB} fill={c.bg} />}
        <g transform={transformStr(c)}>
          {c.lines.map((ln, i) => ln.on && (
            <path key={i} d={LOGO_PATHS[i].d} transform={ln.rot ? `rotate(${ln.rot} ${LX} ${LY})` : undefined}
              fill={ln.color} stroke={ln.color} strokeWidth={ln.width} strokeLinejoin="round" strokeLinecap="round" />
          ))}
        </g>
      </svg>
    </div>
  )
}

export default function IconLabView() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [c, setC] = useState(DEFAULT_CFG)
  const [presets, setPresets] = useState([])      // user presets (≤10)
  const [hover, setHover] = useState(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [pngSize, setPngSize] = useState(512)
  const [open, setOpen] = useState({ box: true, whole: true, lines: true, all: true })  // collapsible sections
  const toggle = (k) => setOpen((s) => ({ ...s, [k]: !s[k] }))
  const caretEl = (k) => <span style={{ display: 'inline-block', width: 9, fontSize: 9, color: 'var(--text-muted)' }}>{open[k] ? '▼' : '▶'}</span>

  const upd = (patch) => setC((s) => ({ ...s, ...patch }))
  const updLine = (i, patch) => setC((s) => ({ ...s, lines: s.lines.map((ln, j) => (j === i ? { ...ln, ...patch } : ln)) }))
  const allLines = (patch) => setC((s) => ({ ...s, lines: s.lines.map((ln) => ({ ...ln, ...patch })) }))

  // Restore the last working design + saved presets.
  useEffect(() => {
    launcher.get('/admin/iconlab/config').then((r) => { if (r.data?.config) setC(normCfg(r.data.config)) }).catch(() => {})
    launcher.get('/admin/iconlab/presets').then((r) => setPresets(r.data?.presets || [])).catch(() => {})
  }, [])

  async function act(kind) {
    setBusy(kind); setMsg('')
    try {
      if (kind === 'favicon') {
        const r = await launcher.post('/admin/iconlab/favicon', { svg: buildSVG(c, { dark: true }) })
        setMsg(L(`favicon 적용됨 · ${r.data.wrote.length}곳 · 탭에서 Cmd+Shift+R`, `favicon written to ${r.data.wrote.length} files · hard-reload the tab`))
      } else if (kind === 'appicon') {
        const r = await launcher.post('/admin/iconlab/appicon', { svg: buildSVG(c) })
        setMsg(r.data.icns_rebuilt ? L('앱 아이콘 재생성 완료 (~/Applications)', 'app icon rebuilt (~/Applications)')
          : L(`app-icon.svg 저장됨 — ${r.data.detail}`, `app-icon.svg saved — ${r.data.detail}`))
      } else if (kind === 'header') {
        await launcher.post('/admin/iconlab/header', { svg: buildSVG(c, { dark: true }) })
        setMsg(L('헤더 아이콘 적용됨 · 새로고침하면 제목 옆 아이콘이 바뀝니다', 'header icon set · reload to update the title mark'))
      } else if (kind === 'webicon') {
        const r = await launcher.post('/admin/iconlab/webicon', { svg: buildSVG(c), bg: c.bgTransparent ? '#ffffff' : c.bg })
        setMsg(L(`웹앱(PWA) 아이콘 적용됨 · ${r.data.wrote.length}개 파일 · 브라우저 ‘앱 설치’ 시 사용`, `web app (PWA) icons written (${r.data.wrote.length}) · used on browser “Install app”`))
      }
    } catch (e) {
      setMsg(e?.response?.data?.detail || L('실패', 'failed'))
    } finally { setBusy('') }
  }

  // ── presets ──
  async function persistPresets(list) {
    setPresets(list)
    try { await launcher.put('/admin/iconlab/presets', { presets: list }) } catch { /* surfaced via msg */ }
  }
  async function saveCurrent() {
    if (presets.length >= 10) { setMsg(L('프리셋은 최대 10개입니다.', 'up to 10 presets')); return }
    const name = (window.prompt(L('프리셋 이름', 'Preset name'), L(`프리셋 ${presets.length + 1}`, `Preset ${presets.length + 1}`)) || '').trim()
    if (!name) return
    await persistPresets([...presets, { id: 'p' + Date.now(), name, config: c }])
    setMsg(L('프리셋 저장됨', 'preset saved'))
  }
  function loadPreset(p) { setC(normCfg(p.config)); setMsg(L(`불러옴: ${p.name || p.name_ko}`, `loaded: ${p.name || p.name_en}`)) }
  async function deletePreset(id) { await persistPresets(presets.filter((p) => p.id !== id)) }
  async function saveWorking() {
    setBusy('save')
    try { await launcher.put('/admin/iconlab/config', { config: c }); setMsg(L('현재 작업 저장됨', 'working design saved')) }
    catch { setMsg(L('실패', 'failed')) } finally { setBusy('') }
  }

  // ── export ──
  function download(name, blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }
  function exportSVG() { download('lilak-icon.svg', new Blob([buildSVG(c, { dark: true })], { type: 'image/svg+xml' })) }
  async function exportVector(fmt) {   // pdf | eps — converted server-side
    setBusy(fmt); setMsg('')
    try {
      const res = await launcher.post('/admin/iconlab/export', { svg: buildSVG(c, { dark: true }), fmt }, { responseType: 'blob' })
      download(`lilak-icon.${fmt}`, res.data)
    } catch (e) {
      let d = e?.response?.data
      if (d instanceof Blob) { try { d = JSON.parse(await d.text())?.detail } catch { d = null } }
      setMsg(d || L(`${fmt.toUpperCase()} 내보내기 실패`, `${fmt.toUpperCase()} export failed`))
    } finally { setBusy('') }
  }
  function exportPNG() {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = pngSize
      cv.getContext('2d').drawImage(img, 0, 0, pngSize, pngSize)
      cv.toBlob((b) => b && download(`lilak-icon-${pngSize}.png`, b), 'image/png')
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildSVG(c, { px: pngSize }))
  }

  // Live preview (React SVG → instant).
  const Preview = ({ px, dark = false, checker = false }) => (
    <div style={{ width: px, height: px, borderRadius: Math.min(px * 0.06, 12), overflow: 'hidden',
      background: dark ? '#1e1e1e' : (checker ? CHECKER : 'transparent'), border: '1px solid var(--border-subtle)' }}>
      <svg viewBox={`0 0 ${VB} ${VB}`} width={px} height={px}>
        {!c.bgTransparent && <rect width={VB} height={VB} rx={c.radius / 100 * VB} fill={c.bg} />}
        <g transform={transformStr(c)}>
          {c.lines.map((ln, i) => ln.on && (
            <path key={i} d={LOGO_PATHS[i].d} transform={ln.rot ? `rotate(${ln.rot} ${LX} ${LY})` : undefined}
              fill={dark && c.darkInvert ? '#fff' : ln.color} stroke={dark && c.darkInvert ? '#fff' : ln.color}
              strokeWidth={ln.width} strokeLinejoin="round" strokeLinecap="round"
              opacity={hover == null || hover === i ? 1 : 0.16} />
          ))}
        </g>
      </svg>
    </div>
  )

  const allPresets = [...FIXED_PRESETS, ...presets]

  return (
    <div>
      <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', marginBottom: 12 }}>
        {L('각 선의 굵기·색상·회전과 박스 안 위치·크기·회전을 편집해 favicon·앱 아이콘으로 적용하거나 SVG·PNG로 내보냅니다. 설정은 프리셋으로 최대 10개 저장됩니다.',
          'Edit each line’s width/color/rotation and the logo’s position/size/rotation, then apply as favicon/app icon or export SVG/PNG. Save up to 10 presets.')}
      </div>

      {/* ── presets strip ── */}
      <div style={sectionHdr}>{L('프리셋', 'Presets')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        {allPresets.map((p) => (
          <div key={p.id} title={p.fixed ? L(p.name_ko, p.name_en) : p.name}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 54 }}>
            <button onClick={() => loadPreset(p)} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
              <MiniIcon cfg={normCfg(p.config)} px={36} />
            </button>
            <span style={{ fontSize: 'var(--fs-micro, 10px)', color: p.fixed ? 'var(--btn-primary-bg)' : 'var(--text-muted)',
              maxWidth: 54, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
              {p.fixed ? L(p.name_ko, p.name_en) : p.name}
            </span>
            {!p.fixed && (
              <button onClick={() => deletePreset(p.id)} title={L('삭제', 'delete')}
                style={{ position: 'absolute', top: -4, right: 2, width: 16, height: 16, lineHeight: '14px', borderRadius: 999,
                  border: '1px solid var(--border-default)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0 }}>×</button>
            )}
          </div>
        ))}
        <button onClick={saveCurrent} disabled={presets.length >= 10} title={L('현재 설정을 프리셋으로 저장', 'save current as preset')}
          style={{ width: 36, height: 36, borderRadius: 6, border: '1px dashed var(--border-default)', background: 'var(--surface)',
            color: 'var(--text-muted)', cursor: presets.length >= 10 ? 'default' : 'pointer', fontSize: 18, opacity: presets.length >= 10 ? 0.4 : 1 }}>+</button>
      </div>

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {/* ── left: live preview + actions (capped so the controls sit beside it
             even in the narrow 760 card) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280, flexShrink: 0 }}>
          <Preview px={250} checker />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
            <div style={{ textAlign: 'center' }}><Preview px={48} checker /><div style={{ fontSize: 'var(--fs-micro,10px)', color: 'var(--text-muted)' }}>tab 48</div></div>
            <div style={{ textAlign: 'center' }}><Preview px={24} checker /><div style={{ fontSize: 'var(--fs-micro,10px)', color: 'var(--text-muted)' }}>tab 24</div></div>
            <div style={{ textAlign: 'center' }}><Preview px={48} dark /><div style={{ fontSize: 'var(--fs-micro,10px)', color: 'var(--text-muted)' }}>dark</div></div>
          </div>
          <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginTop: 2 }}>{L('아이콘으로 적용', 'Apply as')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Button size="sm" variant="primary" disabled={busy === 'favicon'} onClick={() => act('favicon')} title={L('favicon으로 만들기', 'Set as favicon')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="images" size={14} /> favicon</Button>
            <Button size="sm" variant="primary" disabled={busy === 'appicon'} onClick={() => act('appicon')} title={L('앱 아이콘으로 만들기', 'Set as app icon')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="images" size={14} /> {L('앱', 'app')}</Button>
            <Button size="sm" variant="primary" disabled={busy === 'header'} onClick={() => act('header')} title={L('헤더 아이콘으로 만들기', 'Set as header icon')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="images" size={14} /> {L('헤더', 'header')}</Button>
            <Button size="sm" variant="primary" disabled={busy === 'webicon'} onClick={() => act('webicon')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title={L('PWA(앱 설치) 아이콘 — 모든 OS', 'PWA install icon — all OSes')}><Icon name="images" size={14} /> {L('웹앱', 'web')}</Button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <Button size="sm" variant="secondary" onClick={exportSVG} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="download" size={14} /> SVG</Button>
            <Button size="sm" variant="secondary" onClick={exportPNG} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="download" size={14} /> PNG</Button>
            <Button size="sm" variant="secondary" disabled={busy === 'pdf'} onClick={() => exportVector('pdf')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="download" size={14} /> PDF</Button>
            <Button size="sm" variant="secondary" disabled={busy === 'eps'} onClick={() => exportVector('eps')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="download" size={14} /> EPS</Button>
            <select value={pngSize} onChange={(e) => setPngSize(Number(e.target.value))}
              style={{ height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 4px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }}>
              {[256, 512, 1024].map((s) => <option key={s} value={s}>{s}px</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" disabled={busy === 'save'} onClick={saveWorking}>{L('작업 저장', 'Save')}</Button>
          </div>
          {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', wordBreak: 'break-word' }}>{msg}</div>}
        </div>

        {/* ── right: controls (scrolls on its own so the preview stays in view) ── */}
        <div style={{ flex: 1, minWidth: 260, maxHeight: 'min(72vh, 620px)', overflowY: 'auto', paddingRight: 6 }}>
          <div style={{ ...sectionHdr, marginTop: 0, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggle('box')}>{caretEl('box')} {L('박스', 'Box')}</div>
          {open.box && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={rowS}>
              <span style={lblS}>{L('배경', 'Background')}</span>
              <ColorPicker value={c.bg} onChange={(v) => upd({ bg: v, bgTransparent: false })} size={22} title={L('배경색', 'Background color')} />
              <label style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={c.bgTransparent} onChange={(e) => upd({ bgTransparent: e.target.checked })} /> {L('투명', 'Transparent')}
              </label>
              <div style={{ flex: 1 }} />
              <label style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title={L('favicon 다크모드에서 흰색', 'whiten in dark mode (favicon)')}>
                <input type="checkbox" checked={c.darkInvert} onChange={(e) => upd({ darkInvert: e.target.checked })} /> {L('다크 흰색', 'Dark→white')}
              </label>
            </div>
            <NumField label={L('모서리', 'Corner')} value={c.radius} min={0} max={50} onChange={(v) => upd({ radius: v })} suffix="%" />
          </div>
          )}

          <div style={{ ...sectionHdr, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span onClick={() => toggle('whole')} style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{caretEl('whole')} {L('전체: 위치 · 크기 · 회전', 'Whole: position · size · rotation')}</span>
            <div style={{ flex: 1 }} />
            {open.whole && <Button size="sm" variant="ghost" onClick={() => upd({ size: 80, offsetX: 0, offsetY: 35, rotation: 0 })}>{L('가운데로', 'Recenter')}</Button>}
          </div>
          {open.whole && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <NumField label={L('크기', 'Size')} value={c.size} min={20} max={110} onChange={(v) => upd({ size: v })} suffix="%" />
            <NumField label={L('가로', 'X')} value={c.offsetX} min={-300} max={300} onChange={(v) => upd({ offsetX: v })} />
            <NumField label={L('세로', 'Y')} value={c.offsetY} min={-300} max={300} onChange={(v) => upd({ offsetY: v })} />
            <NumField label={L('회전', 'Rotate')} value={c.rotation} min={-180} max={180} onChange={(v) => upd({ rotation: v })} suffix="°" />
          </div>
          )}

          <div style={{ ...sectionHdr, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggle('lines')}>{caretEl('lines')} {L('선 (굵기 · 색상 · 회전)', 'Lines (width · color · rotation)')}</div>
          {open.lines && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {/* per-line column header */}
            <div style={{ ...rowS, fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>
              <span style={{ width: 18 }} /><span style={{ minWidth: 76 }} /><span style={{ width: 22 }} />
              <span style={{ flex: 1, minWidth: 60 }}>{L('굵기', 'width')}</span>
              <span style={{ width: 56, textAlign: 'right' }}>{L('굵기', 'width')}</span>
              <span style={{ width: 56, textAlign: 'right' }}>{L('회전°', 'rot°')}</span>
            </div>
            {c.lines.map((ln, i) => (
              <div key={i} style={{ ...rowS, padding: '3px 6px', borderRadius: 6, background: hover === i ? 'var(--surface-2)' : 'transparent' }}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <input type="checkbox" checked={ln.on} onChange={(e) => updLine(i, { on: e.target.checked })} />
                <span style={{ ...lblS, minWidth: 76, opacity: ln.on ? 1 : 0.4 }}>{L(LOGO_PATHS[i].ko, LOGO_PATHS[i].en)}</span>
                <ColorPicker value={ln.color} onChange={(v) => updLine(i, { color: v })} size={22} title={L(LOGO_PATHS[i].ko, LOGO_PATHS[i].en)} />
                <input type="range" min={0} max={70} value={ln.width} onChange={(e) => updLine(i, { width: Number(e.target.value) })} style={{ flex: 1, minWidth: 60 }} />
                <input type="number" min={0} max={70} value={ln.width} onChange={(e) => updLine(i, { width: e.target.value === '' ? 0 : Number(e.target.value) })} style={numStyle} />
                <input type="number" min={-180} max={180} value={ln.rot} onChange={(e) => updLine(i, { rot: e.target.value === '' ? 0 : Number(e.target.value) })} style={numStyle} />
              </div>
            ))}
          </div>
          )}

          {/* ── ALL controls, full-width, at the bottom ── */}
          <div style={{ ...sectionHdr, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span onClick={() => toggle('all')} style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{caretEl('all')} {L('전체 선 (all)', 'All lines')}</span>
            {open.all && <>
              <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', fontWeight: 400 }}>{L('색', 'color')}</span>
              <ColorPicker value={c.lines[0].color} onChange={(v) => allLines({ color: v })} size={22} title={L('전체 색', 'all color')} />
              <button onClick={() => allLines({ color: '#111827' })} title="#111827" style={{ width: 18, height: 18, borderRadius: 4, background: '#111827', border: '1px solid var(--border-default)', cursor: 'pointer', padding: 0 }} />
              <button onClick={() => allLines({ color: '#ffffff' })} title="#ffffff" style={{ width: 18, height: 18, borderRadius: 4, background: '#ffffff', border: '1px solid var(--border-default)', cursor: 'pointer', padding: 0 }} />
            </>}
          </div>
          {open.all && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <NumField label={L('전체 굵기', 'All width')} value={c.lines[0].width} min={0} max={70} onChange={(v) => allLines({ width: v })} />
            <NumField label={L('전체 회전', 'All rotate')} value={c.lines[0].rot} min={-180} max={180} onChange={(v) => allLines({ rot: v })} suffix="°" />
          </div>
          )}
        </div>
      </div>
    </div>
  )
}
