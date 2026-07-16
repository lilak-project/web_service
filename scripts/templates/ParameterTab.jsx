import { useEffect, useState } from 'react'
import { Button, Input, Icon, SubTabs, Modal } from 'lilak-ui'
import { get, post } from '../api'

/* ──────────────────────────────────────────────────────────────────────────
 * Parameter editor — kit-native redesign of `lilak par`
 * (macros/lilak_parameter_editor.py). Logic ports the web editor; the UI is
 * rebuilt on the lilak-ui kit (Tailwind-free: inline styles + CSS tokens) so it
 * matches the purple shell. Run features live in the 실행 tab, not here.
 *
 * FILE  : new open clone save save-as close restore
 * VIEW  : default group rich raw
 * PAR   : par comment remove up down top end copy paste
 * Rows are multi-selectable (checkbox OR row background; select-all in header
 * and per-group in group view); the PAR ops act on the whole selection.
 * ────────────────────────────────────────────────────────────────────────── */

let nextFileId = 1

function emptyFile(name = null) {
  return { id: nextFileId++, path: '', name: name || `untitled_${nextFileId}.par`, rows: [], dirty: false, savedAt: '' }
}

const isEnabled = (r) => (r.unit || '').trim() !== '#' && r.enabled !== false
const fullName = (r) => (r.group ? `${r.group}/${r.name}` : r.name)
const docURL = (cls) => `https://lilak-project.github.io/lilak_doxygen/class${cls}.html`
const FLAG_LABELS = { '!': 'rewrite', '*': 'temporary', '&': 'multiple', '@': 'conditional', '<': 'include' }
// per-section toolbar icon colors (labels keep the default text color);
// close + remove are red as destructive actions.
const C = { file: '#9333ea', view: '#0d9488', par: '#d97706', danger: '#dc2626' }

/* ── style tokens (kit CSS variables; purple comes from the shell theme) ──── */
const S = {
  page: { height: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: 12, boxSizing: 'border-box' },
  bar: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 10,
    backgroundColor: 'var(--surface)', border: '1px solid var(--border-default)' },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', minWidth: 0 },
  rowLabel: { width: 46, flexShrink: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-muted)', fontWeight: 700 },
  panel: { borderRadius: 10, border: '1px solid var(--border-default)', backgroundColor: 'var(--surface)' },
  th: { position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--nav-bg)', color: 'var(--nav-text)',
    textAlign: 'left', fontSize: 11, fontWeight: 600, padding: '7px 10px', letterSpacing: '.04em', whiteSpace: 'nowrap' },
  td: { padding: '3px 8px', verticalAlign: 'middle', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.05))' },
  cellInput: { width: '100%', height: 26, fontSize: 12, fontFamily: 'var(--font-mono)' },
  groupHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600,
    color: 'var(--text-secondary)', backgroundColor: 'var(--surface-2)', borderRadius: 6, margin: '8px 8px 2px' },
  empty: { padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' },
}

const COLS = [
  { key: 'idx', label: '#', width: 40, align: 'center' },
  { key: 'on', label: '', width: 34, align: 'center' },
  { key: 'group', label: 'GROUP', width: 170 },
  { key: 'name', label: 'NAME', width: 190 },
  { key: 'value', label: 'VALUE' },
  { key: 'unit', label: 'UNIT', width: 90 },
  { key: 'comment', label: 'COMMENT', width: 230 },
]

const VIEWS = [
  { id: 'default', ic: 'table' },
  { id: 'group', ic: 'tree' },
  { id: 'rich', ic: 'edit' },
  { id: 'raw', ic: 'terminal' },
]

/** Controlled, click-through checkbox (pointer events pass to the row/cell). */
function Check({ on, indeterminate }) {
  return (
    <input type="checkbox" checked={!!on} readOnly
      ref={(el) => { if (el) el.indeterminate = !!indeterminate }}
      style={{ pointerEvents: 'none', cursor: 'pointer' }} />
  )
}

export default function ParameterEditor() {
  const [files, setFiles] = useState([emptyFile()])
  const [activeId, setActiveId] = useState(files[0].id)
  const [viewMode, setViewMode] = useState('default')
  const [selected, setSelected] = useState(() => new Set())   // multi-select row indices
  const [clipboard, setClipboard] = useState([])
  const [closedGroups, setClosedGroups] = useState({})
  const [rawText, setRawText] = useState('')
  const [message, setMessage] = useState('')
  const [findOpen, setFindOpen] = useState(false)

  const file = files.find((f) => f.id === activeId) ?? files[0]
  const rows = file?.rows ?? []

  function patchFile(id, patch) { setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f))) }
  function setRows(newRows, dirty = true) { patchFile(file.id, { rows: newRows, dirty }) }

  /* ── selection ─────────────────────────────────────────────────────── */
  const isSel = (i) => selected.has(i)
  const clearSel = () => setSelected(new Set())
  function toggleSel(i) { setSelected((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n }) }
  function setGroupSel(idxs, on) { setSelected((s) => { const n = new Set(s); idxs.forEach((i) => (on ? n.add(i) : n.delete(i))); return n }) }
  function toggleAll() { setSelected((s) => (rows.length && s.size >= rows.length ? new Set() : new Set(rows.map((_, i) => i)))) }

  /* ── FILE ──────────────────────────────────────────────────────────── */
  function fileNew() { const f = emptyFile(); setFiles((fs) => [...fs, f]); setActiveId(f.id); clearSel() }

  async function openPath(relPath) {
    try {
      const d = await get('/api/params/file?path=' + encodeURIComponent(relPath))
      const existing = files.find((f) => f.path === relPath)
      if (existing) {
        patchFile(existing.id, { rows: d.rows, dirty: false })
        setActiveId(existing.id)
      } else {
        const f = { ...emptyFile(), path: relPath, name: relPath.split('/').pop(), rows: d.rows }
        setFiles((fs) => (fs.length === 1 && !fs[0].path && !fs[0].rows.length ? [f] : [...fs, f]))
        setActiveId(f.id)
      }
      setFindOpen(false); clearSel(); setMessage('')
    } catch (e) { setMessage('open error: ' + e.message) }
  }

  function fileClone() {
    const f = { ...emptyFile(), name: 'copy_of_' + file.name, rows: structuredClone(rows), dirty: true }
    setFiles((fs) => [...fs, f]); setActiveId(f.id); clearSel()
  }

  async function fileSave(asPath) {
    let target = asPath ?? file.path
    if (!target) {
      target = window.prompt('Save as (path relative to lilak root):', 'macros/' + file.name)
      if (!target) return null
    }
    try {
      const d = await post('/api/params/file', { path: target, rows })
      patchFile(file.id, { path: target, name: target.split('/').pop(), rows: d.rows, dirty: false, savedAt: new Date().toLocaleTimeString() })
      setMessage('saved: ' + target); return target
    } catch (e) { setMessage('save error: ' + e.message); return null }
  }

  function closeFile(id) {
    const f = files.find((x) => x.id === id)
    if (f && f.dirty && !window.confirm(`${f.name} has unsaved changes. Close anyway?`)) return
    setFiles((fs) => {
      const next = fs.filter((x) => x.id !== id)
      if (next.length === 0) next.push(emptyFile())
      if (id === activeId) { setActiveId(next[next.length - 1].id); clearSel() }
      return next
    })
  }
  const fileClose = () => closeFile(activeId)

  async function fileRestore() {
    if (!file.path) return setMessage('no saved file to restore from')
    await openPath(file.path); setMessage('restored from disk')
  }

  /* ── VIEW ──────────────────────────────────────────────────────────── */
  async function switchView(mode) {
    if (mode === viewMode) return
    if (mode === 'raw') {
      const d = await post('/api/params/serialize', { rows }); setRawText(d.content)
    } else if (viewMode === 'raw') {
      const d = await post('/api/params/parse', { content: rawText }); setRows(d.rows)
    }
    setViewMode(mode); clearSel()
  }

  /* ── PARAMETER row ops (act on the whole selection) ────────────────── */
  function updateRow(i, patch) { setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))) }

  function insertRow(row) {
    const arr = [...selected]
    const at = arr.length ? Math.max(...arr) + 1 : rows.length
    setRows([...rows.slice(0, at), row, ...rows.slice(at)])
    setSelected(new Set([at]))
  }
  const addParameter = () => insertRow({ kind: 'parameter', enabled: true, group: '', name: 'name', value: '', unit: '', comment: '' })
  const addComment = () => insertRow({ kind: 'comment', enabled: false, group: '', name: '', value: '', unit: '', comment: 'comment' })

  function removeRow() {
    if (!selected.size) return
    setRows(rows.filter((_, j) => !selected.has(j))); clearSel()
  }

  function moveRow(to) {
    if (!selected.size) return
    const idxs = [...selected].sort((a, b) => a - b)
    const picked = idxs.map((i) => rows[i])
    const rest = rows.filter((_, i) => !selected.has(i))
    const first = idxs[0]
    const at = to === 'top' ? 0 : to === 'end' ? rest.length
      : to === 'up' ? Math.max(0, first - 1) : Math.min(rest.length, first + 1)
    setRows([...rest.slice(0, at), ...picked, ...rest.slice(at)])
    setSelected(new Set(picked.map((_, k) => at + k)))
  }

  function copyRow() {
    if (!selected.size) return
    const idxs = [...selected].sort((a, b) => a - b)
    setClipboard(idxs.map((i) => structuredClone(rows[i])))
    setMessage(`copied ${idxs.length} row(s)`)
  }
  function pasteRows() {
    if (!clipboard.length) return
    const arr = [...selected]
    const at = arr.length ? Math.max(...arr) + 1 : rows.length
    const clip = structuredClone(clipboard)
    setRows([...rows.slice(0, at), ...clip, ...rows.slice(at)])
    setSelected(new Set(clip.map((_, k) => at + k)))
  }

  /* ── row renderers ─────────────────────────────────────────────────── */
  const stop = (e) => e.stopPropagation()   // keep field edits from toggling selection

  function ParamRow({ r, i }) {
    const sel = isSel(i)
    const dimmed = r.kind === 'parameter' && !isEnabled(r)
    const base = { cursor: 'pointer', backgroundColor: sel ? 'var(--info-bg)' : 'transparent', opacity: dimmed ? 0.5 : 1 }
    if (r.kind === 'comment') {
      return (
        <tr onClick={() => toggleSel(i)} style={base}>
          <td style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{i + 1}</td>
          <td style={{ ...S.td, textAlign: 'center' }}><Check on={sel} /></td>
          <td style={S.td} colSpan={5}>
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>#&nbsp;</span>
            <Input onClick={stop} value={r.comment} onChange={(e) => updateRow(i, { comment: e.target.value })}
              style={{ ...S.cellInput, width: '90%', color: 'var(--text-muted)' }} />
          </td>
        </tr>
      )
    }
    return (
      <tr onClick={() => toggleSel(i)} style={base}>
        <td style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{i + 1}</td>
        <td style={{ ...S.td, textAlign: 'center' }}><Check on={sel} /></td>
        <td style={S.td}><Input onClick={stop} value={r.group} placeholder="group" onChange={(e) => updateRow(i, { group: e.target.value })} style={S.cellInput} /></td>
        <td style={S.td}><Input onClick={stop} value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} style={S.cellInput} /></td>
        <td style={S.td}><Input onClick={stop} value={r.value} onChange={(e) => updateRow(i, { value: e.target.value })} style={S.cellInput} /></td>
        <td style={S.td}>
          <Input onClick={stop} value={r.unit} placeholder="—" onChange={(e) => updateRow(i, { unit: e.target.value })}
            title={[...(r.unit || '')].map((c) => FLAG_LABELS[c] || c).join(', ')}
            style={{ ...S.cellInput, textAlign: 'center' }} />
        </td>
        <td style={S.td}><Input onClick={stop} value={r.comment} placeholder="#" onChange={(e) => updateRow(i, { comment: e.target.value })}
          style={{ ...S.cellInput, color: 'var(--text-muted)' }} /></td>
      </tr>
    )
  }

  function RichRow({ r, i }) {
    if (r.kind === 'comment') return <ParamRow r={r} i={i} />
    const parts = (r.value || '').trim() === '' ? [] : r.value.trim().split(/\s+/)
    const setParts = (ps) => updateRow(i, { value: ps.join('  ') })
    return (
      <tr onClick={() => toggleSel(i)} style={{ cursor: 'pointer', backgroundColor: isSel(i) ? 'var(--info-bg)' : 'transparent', opacity: isEnabled(r) ? 1 : 0.5 }}>
        <td style={{ ...S.td, textAlign: 'center' }}><Check on={isSel(i)} /></td>
        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{fullName(r)}</td>
        <td style={S.td}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {parts.map((p, pi) => (
              <span key={pi} style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={stop}>
                <Input value={p} onChange={(e) => setParts(parts.map((q, qi) => (qi === pi ? e.target.value : q)))}
                  style={{ ...S.cellInput, width: Math.max(4, p.length + 2) + 'ch' }} />
                <Button variant="ghost" size="sm" onClick={() => setParts(parts.filter((_, qi) => qi !== pi))}>✕</Button>
              </span>
            ))}
            <Button variant="secondary" size="sm" onClick={(e) => { stop(e); setParts([...parts, '']) }}>+ value</Button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{parts.length} values</span>
          </div>
        </td>
        <td style={S.td}><Input onClick={stop} value={r.comment} placeholder="#" onChange={(e) => updateRow(i, { comment: e.target.value })}
          style={{ ...S.cellInput, color: 'var(--text-muted)' }} /></td>
      </tr>
    )
  }

  function groupedRows() {
    const groups = []; const index = {}
    rows.forEach((r, i) => {
      const g = r.kind === 'comment' ? '#' : r.group || '(no group)'
      if (!(g in index)) { index[g] = groups.length; groups.push({ name: g, items: [] }) }
      groups[index[g]].items.push([r, i])
    })
    return groups
  }

  const allSel = rows.length > 0 && selected.size >= rows.length
  const someSel = selected.size > 0 && !allSel

  const TableHead = ({ cols = COLS }) => (
    <thead>
      <tr>{cols.map((c) => (
        <th key={c.key} onClick={c.key === 'on' ? toggleAll : undefined}
          style={{ ...S.th, width: c.width, textAlign: c.align || 'left', cursor: c.key === 'on' ? 'pointer' : 'default' }}
          title={c.key === 'on' ? 'select all' : undefined}>
          {c.key === 'on' ? <Check on={allSel} indeterminate={someSel} /> : c.label}
        </th>
      ))}</tr>
    </thead>
  )

  /* ── toolbar button helper: icon (colored) + label ─────────────────── */
  const IB = ({ ic, children, active, iconColor = C.file, ...rest }) => (
    <Button variant={active ? 'primary' : 'secondary'} size="sm" {...rest}>
      <Icon name={ic} size={13} color={active ? undefined : iconColor} />{children}
    </Button>
  )

  return (
    <div style={S.page}>
      {/* toolbar — FILE / VIEW / PAR, one row each */}
      <div style={{ ...S.bar, flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' }}>
        <div style={S.row}>
          <span style={S.rowLabel}>FILE</span>
          <IB ic="plus" onClick={fileNew}>new</IB>
          <IB ic="folder" onClick={() => setFindOpen(true)}>open</IB>
          <IB ic="copy" onClick={fileClone}>clone</IB>
          <IB ic="save" onClick={() => fileSave()}>save</IB>
          <IB ic="download" onClick={() => fileSave(window.prompt('Save as:', file.path || 'macros/' + file.name))}>save as</IB>
          <IB ic="close" iconColor={C.danger} onClick={fileClose}>close</IB>
          <IB ic="refresh" onClick={fileRestore}>restore</IB>
        </div>
        <div style={S.row}>
          <span style={S.rowLabel}>VIEW</span>
          {VIEWS.map((v) => <IB key={v.id} ic={v.ic} iconColor={C.view} active={viewMode === v.id} onClick={() => switchView(v.id)}>{v.id}</IB>)}
        </div>
        <div style={S.row}>
          <span style={S.rowLabel}>PAR</span>
          <IB ic="plus" iconColor={C.par} onClick={addParameter}>par</IB>
          <IB ic="hash" iconColor={C.par} onClick={addComment}>comment</IB>
          <IB ic="trash" iconColor={C.danger} onClick={removeRow}>remove</IB>
          <IB ic="caret-up" iconColor={C.par} onClick={() => moveRow('up')}>up</IB>
          <IB ic="caret-down" iconColor={C.par} onClick={() => moveRow('down')}>down</IB>
          <IB ic="caret-up" iconColor={C.par} onClick={() => moveRow('top')}>top</IB>
          <IB ic="caret-down" iconColor={C.par} onClick={() => moveRow('end')}>end</IB>
          <IB ic="copy" iconColor={C.par} onClick={copyRow}>copy</IB>
          <IB ic="paste" iconColor={C.par} onClick={pasteRows}>paste</IB>
          <div style={{ flex: 1 }} />
          {message && <span style={{ fontSize: 11, color: 'var(--warning-text)' }}>{message}</span>}
        </div>
      </div>

      {/* file tabs (each with a close ×) */}
      <SubTabs active={activeId} onChange={(id) => { setActiveId(id); clearSel() }}
        tabs={files.map((f) => ({
          id: f.id,
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {f.name}{f.dirty ? ' ●' : ''}
              <span role="button" title="close" onClick={(e) => { e.stopPropagation(); closeFile(f.id) }}
                style={{ display: 'inline-flex', cursor: 'pointer', opacity: 0.55, fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</span>
            </span>
          ),
        }))} />

      {/* editor area */}
      <section style={{ ...S.panel, flex: 1, minHeight: 0, overflow: 'auto' }}>
        {viewMode === 'raw' ? (
          <textarea value={rawText} spellCheck={false}
            onChange={(e) => { setRawText(e.target.value); patchFile(file.id, { dirty: true }) }}
            style={{ width: '100%', height: '100%', minHeight: '100%', padding: 10, boxSizing: 'border-box', border: 'none', outline: 'none',
              resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 12, backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)' }} />
        ) : viewMode === 'group' ? (
          <div style={{ paddingBottom: 8 }}>
            {groupedRows().map((g) => {
              const closed = closedGroups[g.name]
              const isClassName = /^[A-Z]/.test(g.name) && g.name !== '(no group)'
              const gIdx = g.items.map(([, i]) => i)
              const gAll = gIdx.length > 0 && gIdx.every((i) => isSel(i))
              const gSome = gIdx.some((i) => isSel(i)) && !gAll
              return (
                <div key={g.name}>
                  <div style={S.groupHead}>
                    <button onClick={() => setClosedGroups((c) => ({ ...c, [g.name]: !closed }))}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>{closed ? '▸' : '▾'}</button>
                    <span role="button" title="select group" onClick={() => setGroupSel(gIdx, !gAll)} style={{ display: 'inline-flex', cursor: 'pointer' }}>
                      <Check on={gAll} indeterminate={gSome} />
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{g.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({g.items.length})</span>
                    {isClassName && <a href={docURL(g.name)} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: 'var(--text-link)' }}>doc ↗</a>}
                  </div>
                  {!closed && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>{g.items.map(([r, i]) => <ParamRow key={i} r={r} i={i} />)}</tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <TableHead cols={viewMode === 'rich' ? [COLS[1], { key: 'nm', label: 'NAME' }, { key: 'value', label: 'VALUES' }, COLS[6]] : COLS} />
            <tbody>
              {rows.map((r, i) => (viewMode === 'rich' ? <RichRow key={i} r={r} i={i} /> : <ParamRow key={i} r={r} i={i} />))}
            </tbody>
          </table>
        )}
        {rows.length === 0 && viewMode !== 'raw' && (
          <div style={S.empty}>empty — open a file (FILE → open) or add parameters (PAR → par)</div>
        )}
      </section>

      {findOpen && <OpenModal onPick={openPath} onClose={() => setFindOpen(false)} />}
    </div>
  )
}

/* ── open-file browser ─────────────────────────────────────────────────────
 * Two ways to find a file: (1) type to search ALL param files by name, or
 * (2) browse the LILAK directory tree — jump straight into a sub-project
 * (atomx / stark / … via /api/params/projects) or walk folders with the
 * breadcrumb + ↑ up. Directories navigate, files open. */
function chip(active) {
  return {
    height: 24, padding: '0 10px', borderRadius: 999, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)',
    borderWidth: 1, borderStyle: 'solid',
    borderColor: active ? 'var(--btn-primary-bg)' : 'var(--border-default)',
    background: active ? 'var(--btn-primary-bg)' : 'var(--surface-2)',
    color: active ? 'var(--btn-primary-text, #fff)' : 'var(--text-secondary)',
  }
}
const rowBtn = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '5px 8px', borderRadius: 6,
  border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)',
}

function OpenModal({ onPick, onClose }) {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState([])
  const [projects, setProjects] = useState([])
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])

  useEffect(() => { get('/api/params/projects').then((d) => setProjects(d.projects || [])).catch(() => {}) }, [])
  const browse = (dir) => get('/api/params/browse?dir=' + encodeURIComponent(dir))
    .then((d) => { setCwd(d.cwd); setEntries(d.entries) }).catch(() => {})
  useEffect(() => { browse('') }, [])
  useEffect(() => {
    if (!query.trim()) { setMatches([]); return }
    const t = setTimeout(() => { get('/api/params/find?q=' + encodeURIComponent(query)).then((d) => setMatches(d.matches)).catch(() => {}) }, 250)
    return () => clearTimeout(t)
  }, [query])

  const searching = query.trim().length > 0
  const parent = cwd ? cwd.split('/').slice(0, -1).join('/') : ''
  const crumbs = cwd ? cwd.split('/') : []

  return (
    <Modal title="Open parameter file" onClose={onClose}>
      <Input autoFocus placeholder="search all files by name…" value={query} onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }} />

      {!searching && (
        <>
          {/* sub-projects */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', fontWeight: 700 }}>projects</span>
            <button onClick={() => browse('')} style={chip(cwd === '')}>root</button>
            {projects.map((p) => (
              <button key={p.path} onClick={() => browse(p.path)}
                style={chip(cwd === p.path || cwd.startsWith(p.path + '/'))}>{p.name}</button>
            ))}
          </div>
          {/* breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontFamily: 'var(--font-mono)', flexWrap: 'wrap' }}>
            <button onClick={() => browse(parent)} disabled={!cwd}
              style={{ ...rowBtn, width: 'auto', padding: '2px 8px', color: cwd ? 'var(--text-link)' : 'var(--text-muted)', cursor: cwd ? 'pointer' : 'default' }}>
              <Icon name="caret-up" size={13} /> up
            </button>
            <span onClick={() => browse('')} style={{ cursor: 'pointer', color: cwd ? 'var(--text-link)' : 'var(--text-secondary)' }}>lilak</span>
            {crumbs.map((seg, i) => {
              const p = crumbs.slice(0, i + 1).join('/')
              const last = i === crumbs.length - 1
              return <span key={p} style={{ color: 'var(--text-muted)' }}>/&nbsp;
                <span onClick={() => !last && browse(p)} style={{ cursor: last ? 'default' : 'pointer', color: last ? 'var(--text-primary)' : 'var(--text-link)' }}>{seg}</span>
              </span>
            })}
          </div>
        </>
      )}

      <div style={{ overflowY: 'auto', maxHeight: '48vh', borderTop: '1px solid var(--border-default)', paddingTop: 4 }}>
        {searching ? (
          matches.length
            ? matches.map((p) => (
              <button key={p} onClick={() => onPick(p)} title={p} style={{ ...rowBtn, color: 'var(--text-link)', overflowWrap: 'anywhere' }}>{p}</button>
            ))
            : <div style={{ fontSize: 12, padding: 8, color: 'var(--text-muted)' }}>no matches</div>
        ) : (
          entries.length
            ? entries.map((e) => (
              e.is_dir
                ? <button key={e.path} onClick={() => browse(e.path)} style={{ ...rowBtn, color: 'var(--text-secondary)' }}>
                    <Icon name="folder" size={15} color={C.file} /><span style={{ flex: 1 }}>{e.name}</span><span style={{ color: 'var(--text-muted)' }}>/</span>
                  </button>
                : <button key={e.path} onClick={() => onPick(e.path)} title={e.path} style={{ ...rowBtn, color: 'var(--text-link)' }}>
                    <span style={{ width: 15, flexShrink: 0 }} /><span>{e.name}</span>
                  </button>
            ))
            : <div style={{ fontSize: 12, padding: 8, color: 'var(--text-muted)' }}>empty folder</div>
        )}
      </div>
    </Modal>
  )
}
