import { useEffect, useRef, useState } from 'react'
import { Button, Icon, ColorPicker, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Row, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'
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

function normLine(ln) { return { color: '#111827', width: 28, on: true, rot: 0, dx: 0, dy: 0, ...ln } }

// Per-line transform in logo space: nudge by (dx,dy) then rotate about the logo
// centre. Empty when the line is untouched (keeps the SVG clean).
function lineTransform(ln) {
  const t = []
  if (ln.dx || ln.dy) t.push(`translate(${ln.dx || 0} ${ln.dy || 0})`)
  if (ln.rot) t.push(`rotate(${ln.rot} ${LX} ${LY})`)
  return t.join(' ')
}
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
  const paths = c.lines.map((ln, i) => {
    if (!ln.on) return ''
    const tf = lineTransform(ln)
    return `<path d="${LOGO_PATHS[i].d}"${tf ? ` transform="${tf}"` : ''} fill="${ln.color}" stroke="${ln.color}" stroke-width="${ln.width}" stroke-linejoin="round" stroke-linecap="round"/>`
  }).join('')
  const dim = px ? ` width="${px}" height="${px}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg"${dim} viewBox="0 0 ${VB} ${VB}">${style}${rect}<g class="lk" transform="${transformStr(c)}">${paths}</g></svg>`
}

// ── small styled bits ─────────────────────────────────────────────────────────
const numStyle = { ...fieldInput, width: 58, fontFamily: 'var(--font-mono)', textAlign: 'right' }
const numS = { ...numStyle, width: '100%' }
// on · name · colour · slider · w · rot · x · y
const LINE_COLS = { gridTemplateColumns: '18px minmax(60px, 96px) 24px minmax(40px, 1fr) 54px 54px 54px 54px' }
const CHECKER = 'repeating-conic-gradient(#0001 0% 25%, transparent 0% 50%) 50% / 18px 18px'

// One scalar control: slider + number input, both editing the same value.
function NumField({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  return (
    <Field label={label}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, minWidth: 60 }} />
      <input type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} style={numStyle} />
      {suffix && <span style={fieldMuted}>{suffix}</span>}
    </Field>
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
            <path key={i} d={LOGO_PATHS[i].d} transform={lineTransform(ln) || undefined}
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
  const setMsg = (m, tone) => m && notify(m, tone)
  const [busy, setBusy] = useState('')
  const [pngSize, setPngSize] = useState(512)

  const upd = (patch) => setC((s) => ({ ...s, ...patch }))
  const updLine = (i, patch) => setC((s) => ({ ...s, lines: s.lines.map((ln, j) => (j === i ? { ...ln, ...patch } : ln)) }))
  const allLines = (patch) => setC((s) => ({ ...s, lines: s.lines.map((ln) => ({ ...ln, ...patch })) }))

  // Restore the last working design + saved presets.
  useEffect(() => {
    launcher.get('/admin/iconlab/config').then((r) => { if (r.data?.config) setC(normCfg(r.data.config)) }).catch(() => {})
    launcher.get('/admin/iconlab/presets').then((r) => setPresets(r.data?.presets || [])).catch(() => {})
  }, [])

  async function act(kind) {
    setBusy(kind)
    try {
      if (kind === 'favicon') {
        const r = await launcher.post('/admin/iconlab/favicon', { svg: buildSVG(c, { dark: true }) })
        setMsg(tr("p_favicon_written_to_files_hard", r.data.wrote.length), 'ok')
      } else if (kind === 'appicon') {
        const r = await launcher.post('/admin/iconlab/appicon', { svg: buildSVG(c) })
        setMsg(r.data.icns_rebuilt ? tr("p_app_icon_rebuilt_applications")
          : tr("p_app_icon_svg_saved", r.data.detail))
      } else if (kind === 'header') {
        await launcher.post('/admin/iconlab/header', { svg: buildSVG(c, { dark: true }) })
        setMsg(tr("p_header_icon_set_reload_to"))
      } else if (kind === 'webicon') {
        const r = await launcher.post('/admin/iconlab/webicon', { svg: buildSVG(c), bg: c.bgTransparent ? '#ffffff' : c.bg })
        setMsg(tr("p_web_app_pwa_icons_written", r.data.wrote.length))
      }
    } catch (e) {
      setMsg(e?.response?.data?.detail || tr("p_failed"))
    } finally { setBusy('') }
  }

  // ── presets ──
  async function persistPresets(list) {
    setPresets(list)
    try { await launcher.put('/admin/iconlab/presets', { presets: list }) } catch { /* surfaced via msg */ }
  }
  async function saveCurrent() {
    if (presets.length >= 10) { setMsg(tr("p_up_to_10_presets")); return }
    const name = (window.prompt(tr("p_preset_name"), tr("p_preset", presets.length + 1)) || '').trim()
    if (!name) return
    await persistPresets([...presets, { id: 'p' + Date.now(), name, config: c }])
    setMsg(tr("p_preset_saved"))
  }
  function loadPreset(p) { setC(normCfg(p.config)); setMsg(tr("p_loaded", p.name || p.name_ko, p.name || p.name_en)) }
  async function deletePreset(id) { await persistPresets(presets.filter((p) => p.id !== id)) }
  async function saveWorking() {
    setBusy('save')
    try { await launcher.put('/admin/iconlab/config', { config: c }); setMsg(tr("p_working_design_saved")) }
    catch { setMsg(tr("p_failed")) } finally { setBusy('') }
  }

  // ── export ──
  function download(name, blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }
  function exportSVG() { download('lilak-icon.svg', new Blob([buildSVG(c, { dark: true })], { type: 'image/svg+xml' })) }
  async function exportVector(fmt) {   // pdf | eps — converted server-side
    setBusy(fmt)
    try {
      const res = await launcher.post('/admin/iconlab/export', { svg: buildSVG(c, { dark: true }), fmt }, { responseType: 'blob' })
      download(`lilak-icon.${fmt}`, res.data)
    } catch (e) {
      let d = e?.response?.data
      if (d instanceof Blob) { try { d = JSON.parse(await d.text())?.detail } catch { d = null } }
      setMsg(d || tr("p_export_failed_2", fmt.toUpperCase()))
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
            <path key={i} d={LOGO_PATHS[i].d} transform={lineTransform(ln) || undefined}
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
    <div className="svc-mg">

      {/* The preview and its exports on the left, the numbers on the right —
          two columns of the same panels, so the page reads like the rest. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 300, flexShrink: 0 }}>
          <Panel bare title={tr("p_presets")} hint={String(allPresets.length)}>
            <Row>
              {allPresets.map((p) => (
                <span key={p.id} title={p.fixed ? L(p.name_ko, p.name_en) : p.name}
                  style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 54 }}>
                  <button type="button" className="set-plain" onClick={() => loadPreset(p)}
                    style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
                    <MiniIcon cfg={normCfg(p.config)} px={36} />
                  </button>
                  <span style={{ fontSize: 'var(--fs-small, 12px)', color: p.fixed ? 'var(--btn-primary-bg)' : 'var(--text-muted)',
                    maxWidth: 54, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
                    {p.fixed ? L(p.name_ko, p.name_en) : p.name}
                  </span>
                  {!p.fixed && (
                    <button type="button" className="set-plain" onClick={() => deletePreset(p.id)} title={tr("p_delete_3")}
                      style={{ position: 'absolute', top: -4, right: 2, width: 16, height: 16, lineHeight: '14px', borderRadius: 999,
                        border: '1px solid var(--border-default)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-tiny)', padding: 0 }}>×</button>
                  )}
                </span>
              ))}
              <button type="button" className="set-plain" onClick={saveCurrent} disabled={presets.length >= 10}
                title={tr("p_save_current_as_preset")}
                style={{ width: 36, height: 36, borderRadius: 'var(--rack-radius, 0)', border: '1px dashed var(--border-strong)',
                  display: 'grid', placeItems: 'center', lineHeight: 1,
                  background: 'var(--surface)', color: 'var(--text-muted)', cursor: presets.length >= 10 ? 'default' : 'pointer',
                  fontSize: 'var(--fs-xlarge)', opacity: presets.length >= 10 ? 0.4 : 1 }}>+</button>
            </Row>
          </Panel>
          <Panel bare title={tr("p_preview")}>
            <Row><Preview px={250} checker /></Row>
            <Row>
              <span style={{ textAlign: 'center' }}><Preview px={48} checker /><div style={fieldMuted}>tab 48</div></span>
              <span style={{ textAlign: 'center' }}><Preview px={24} checker /><div style={fieldMuted}>tab 24</div></span>
              <span style={{ textAlign: 'center' }}><Preview px={48} dark /><div style={fieldMuted}>dark</div></span>
            </Row>
          </Panel>

          {/* Under the preview: applying and exporting are what you do once the
              picture is right, so they follow the picture. */}
          {/* bare rows, not label/value: at 300px a 170px label column left the
              four buttons stacked one per line. */}
          <Panel bare title={tr("p_apply_as")}>
            <Row>
              <Button variant="primary" disabled={busy === 'favicon'} onClick={() => act('favicon')} title={tr("p_set_as_favicon")}>favicon</Button>
              <Button variant="primary" disabled={busy === 'appicon'} onClick={() => act('appicon')} title={tr("p_set_as_app_icon")}>{tr("p_app")}</Button>
              <Button variant="primary" disabled={busy === 'header'} onClick={() => act('header')} title={tr("p_set_as_header_icon")}>{tr("p_header")}</Button>
              <Button variant="primary" disabled={busy === 'webicon'} onClick={() => act('webicon')} title={tr("p_pwa_install_icon_all_oses")}>{tr("p_web")}</Button>
            </Row>
            <Row>
              <Button variant="secondary" onClick={exportSVG}>SVG</Button>
              <Button variant="secondary" onClick={exportPNG}>PNG</Button>
              <Button variant="secondary" disabled={busy === 'pdf'} onClick={() => exportVector('pdf')}>PDF</Button>
              <Button variant="secondary" disabled={busy === 'eps'} onClick={() => exportVector('eps')}>EPS</Button>
              <select value={pngSize} onChange={(e) => setPngSize(Number(e.target.value))} style={{ ...fieldInput, width: 84 }}>
                {[256, 512, 1024].map((v) => <option key={v} value={v}>{v}px</option>)}
              </select>
            </Row>
            <Row>
              <Button variant="secondary" disabled={busy === 'save'} onClick={saveWorking}>{tr("p_save_working_copy")}</Button>
            </Row>
          </Panel>
        </div>

        <div style={{ flex: 1, minWidth: 320 }}>
          <Panel fold title={tr("p_box")}>
            <Field label={tr("p_background")}>
              <span className="set-pick"><ColorPicker value={c.bg} onChange={(v) => upd({ bg: v, bgTransparent: false })} size={22} title={tr("p_background_color")} /></span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={c.bgTransparent} onChange={(e) => upd({ bgTransparent: e.target.checked })} /> {tr("p_transparent")}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title={tr("p_whiten_in_dark_mode_favicon")}>
                <input type="checkbox" checked={c.darkInvert} onChange={(e) => upd({ darkInvert: e.target.checked })} /> {tr("p_dark_white")}
              </label>
            </Field>
            <NumField label={tr("p_corner")} value={c.radius} min={0} max={50} onChange={(v) => upd({ radius: v })} suffix="%" />
          </Panel>

          <Panel fold title={tr("p_whole_position_size_rotation")}
            right={<Button variant="secondary" onClick={() => upd({ size: 80, offsetX: 0, offsetY: 35, rotation: 0 })}>{tr("p_recenter")}</Button>}>
            <NumField label={tr("p_size")} value={c.size} min={20} max={110} onChange={(v) => upd({ size: v })} suffix="%" />
            <NumField label={tr("p_x_2")} value={c.offsetX} min={-300} max={300} onChange={(v) => upd({ offsetX: v })} />
            <NumField label={tr("p_y")} value={c.offsetY} min={-300} max={300} onChange={(v) => upd({ offsetY: v })} />
            <NumField label={tr("p_rotate_2")} value={c.rotation} min={-180} max={180} onChange={(v) => upd({ rotation: v })} suffix="°" />
          </Panel>

          <Panel fold bare title={tr("p_lines")} hint={tr("p_width_colour_rotation_x_y")}>
            <Row className="cols head" style={LINE_COLS}>
              <span /><span /><span />
              <span>{tr("p_width")}</span>
              <span style={{ textAlign: 'right' }}>w</span>
              <span style={{ textAlign: 'right' }}>rot°</span>
              <span style={{ textAlign: 'right' }}>X</span>
              <span style={{ textAlign: 'right' }}>Y</span>
            </Row>
            {c.lines.map((ln, i) => (
              <div key={i} className="set-row cols" style={{ ...LINE_COLS, background: hover === i ? 'var(--surface-2)' : undefined }}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <input type="checkbox" checked={ln.on} onChange={(e) => updLine(i, { on: e.target.checked })} />
                <span style={{ opacity: ln.on ? 1 : 0.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{L(LOGO_PATHS[i].ko, LOGO_PATHS[i].en)}</span>
                <span className="set-pick"><ColorPicker value={ln.color} onChange={(v) => updLine(i, { color: v })} size={22} title={L(LOGO_PATHS[i].ko, LOGO_PATHS[i].en)} /></span>
                <input type="range" min={0} max={70} value={ln.width} onChange={(e) => updLine(i, { width: Number(e.target.value) })} />
                <input type="number" min={0} max={70} value={ln.width} onChange={(e) => updLine(i, { width: e.target.value === '' ? 0 : Number(e.target.value) })} style={numS} title={tr("p_width")} />
                <input type="number" min={-180} max={180} value={ln.rot} onChange={(e) => updLine(i, { rot: e.target.value === '' ? 0 : Number(e.target.value) })} style={numS} title={tr("p_rotation")} />
                <input type="number" min={-400} max={400} value={ln.dx} onChange={(e) => updLine(i, { dx: e.target.value === '' ? 0 : Number(e.target.value) })} style={numS} title={tr("p_x_offset")} />
                <input type="number" min={-400} max={400} value={ln.dy} onChange={(e) => updLine(i, { dy: e.target.value === '' ? 0 : Number(e.target.value) })} style={numS} title={tr("p_y_offset")} />
              </div>
            ))}
          </Panel>

          <Panel fold title={tr("p_all_lines")}>
            <Field label={tr("p_colour")}>
              <span className="set-pick"><ColorPicker value={c.lines[0].color} onChange={(v) => allLines({ color: v })} size={22} title={tr("p_all_color")} /></span>
              <button type="button" className="set-plain" onClick={() => allLines({ color: '#111827' })} title="#111827"
                style={{ width: 20, height: 20, borderRadius: 4, background: '#111827', border: '1px solid var(--border-strong)', cursor: 'pointer', padding: 0 }} />
              <button type="button" className="set-plain" onClick={() => allLines({ color: '#ffffff' })} title="#ffffff"
                style={{ width: 20, height: 20, borderRadius: 4, background: '#ffffff', border: '1px solid var(--border-strong)', cursor: 'pointer', padding: 0 }} />
            </Field>
            <NumField label={tr("p_all_width")} value={c.lines[0].width} min={0} max={70} onChange={(v) => allLines({ width: v })} />
            <NumField label={tr("p_all_rotate")} value={c.lines[0].rot} min={-180} max={180} onChange={(v) => allLines({ rot: v })} suffix="°" />
          </Panel>
        </div>
      </div>

    </div>
  )
}
