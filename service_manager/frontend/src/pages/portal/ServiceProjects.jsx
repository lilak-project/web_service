import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ServiceProjects — INLINE project panel for a multi-project service, expanded
 * inside the service box (no popup).
 *
 * Everyone: the project list — enter / start the projects you're allowed, or
 * request access to the ones you aren't (per project, not all-or-nothing).
 * Managers also get: create a project, drag-and-drop (or pick) a .zip to import,
 * and export each project. Deletion lives in the admin Services screen.
 */
export default function ServiceProjects({ service, canManage }) {
  const { t } = useLang()
  const svc = service.name
  const canIE = !!service.import_export
  const [projects, setProjects] = useState(null)   // null = loading
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)
  const fileRef = useRef(null)

  async function load() {
    try { setProjects((await launcher.get(`/services/${svc}/projects`)).data) }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_load_fail')) }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  function enter(proj) {
    // SSO handoff (same origin): hand the self-UI service the portal token.
    const tok = localStorage.getItem('lilak_portal_token')
    if (tok) localStorage.setItem('elog_token', tok)
    window.open(`/pp/${svc}/${proj}/`, '_blank')
  }

  async function start(proj) {
    setBusy(proj); setErr('')
    try { await launcher.post(`/services/${svc}/projects/${proj}/start`); enter(proj); await load() }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_start_fail')) }
    finally { setBusy('') }
  }
  async function stop(proj) {
    setBusy(proj)
    try { await launcher.post(`/services/${svc}/projects/${proj}/stop`); await load() }
    finally { setBusy('') }
  }
  async function requestAccess(proj) {
    setBusy(proj); setErr('')
    try { await launcher.post('/access-requests', { service: svc, project: proj }); await load() }
    catch (e) { setErr(e?.response?.data?.detail || t('projects_request_fail')) }
    finally { setBusy('') }
  }

  // ── manager: create / import / export ──
  async function create() {
    const name = newName.trim()
    if (!name) return
    setBusy('+'); setErr('')
    try { await launcher.post(`/services/${svc}/projects`, { name }); setNewName(''); await load() }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_create_fail')) }
    finally { setBusy('') }
  }
  async function importFile(file, name) {
    if (!file) return
    setBusy('import'); setErr('')
    const fd = new FormData()
    fd.append('file', file)
    if ((name || newName).trim()) fd.append('name', (name || newName).trim())
    try { await launcher.post(`/services/${svc}/projects/import`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); setNewName(''); await load() }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_import_fail')) }
    finally { setBusy('') }
  }

  const dropProps = (canManage && canIE) ? {
    onDragOver: (e) => { e.preventDefault(); setDrag(true) },
    onDragLeave: (e) => { e.preventDefault(); setDrag(false) },
    onDrop: (e) => {
      e.preventDefault(); setDrag(false)
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.name.endsWith('.zip'))
      if (f) importFile(f, f.name.replace(/\.zip$/i, ''))
    },
  } : {}

  const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border-subtle)' }
  const inputStyle = { height: 32, flex: 1, minWidth: 0, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 10px', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }

  return (
    <div {...dropProps}
      style={{ padding: '16px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)',
        outline: drag ? '2px dashed var(--btn-primary-bg, #4c6ef5)' : 'none', outlineOffset: -4, borderRadius: 6 }}>
      {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--fs-small, 12px)', marginBottom: 6 }}>{err}</div>}

      {/* manager: create a project + import a .zip (drag onto this box, or pick) */}
      {canManage && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <input placeholder={t('portal_proj_new_ph')} value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create() }} style={inputStyle} />
          <Button size="sm" variant="primary" disabled={!newName.trim() || busy === '+'} onClick={create}>{t('portal_proj_create')}</Button>
          {canIE && (
            <>
              <Button size="sm" variant="ghost" disabled={busy === 'import'} onClick={() => fileRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="download" size={14} style={{ transform: 'rotate(180deg)' }} /> {t('portal_proj_import')}
              </Button>
              <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => importFile(e.target.files?.[0])} />
            </>
          )}
        </div>
      )}
      {canManage && canIE && (
        <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 6 }}>{t('portal_proj_drop_hint')}</div>
      )}

      {projects === null ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>…</div>
      ) : projects.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)', padding: '6px 0' }}>{t('portal_proj_empty')}</div>
      ) : projects.map((p) => {
        const viewOnly = p.view_only && !p.can_enter
        return (
          <div key={p.name} style={row}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: (p.can_enter && p.running) ? 'var(--ok-text, #2f9e44)' : 'var(--border-strong, #bbb)' }} />
            <span title={p.label ? p.name : undefined} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--fs-small, 13px)', color: 'var(--text-primary)' }}>{p.label || p.name}</span>
            <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>
              {viewOnly ? t('portal_proj_view_only')
                : p.can_enter ? (p.running ? t('projects_running', p.port) : t('projects_stopped'))
                : ''}
            </span>
            <div style={{ flex: 1 }} />
            {p.can_enter ? (
              <Button size="sm" variant="primary" disabled={busy === p.name}
                onClick={() => (p.running ? enter(p.name) : start(p.name))}>
                {p.running ? t('portal_proj_open') : t('portal_proj_start')}
              </Button>
            ) : p.can_request ? (
              <Button size="sm" variant="secondary" disabled={busy === p.name || p.requested}
                onClick={() => requestAccess(p.name)} style={{ minWidth: 96, justifyContent: 'center' }}>
                {p.requested ? t('projects_requested') : t('projects_request')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled>{t('portal_proj_open')}</Button>
            )}
            {canManage && p.can_enter && p.running && <Button size="sm" variant="secondary" disabled={busy === p.name} onClick={() => stop(p.name)}>{t('projects_stop')}</Button>}
            {/* Data download (export) moved to Home "manage mode". */}
          </div>
        )
      })}
    </div>
  )
}
