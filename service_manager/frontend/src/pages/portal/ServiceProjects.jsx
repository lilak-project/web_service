import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Row, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/**
 * ServiceProjects — INLINE project panel for a multi-project service, expanded
 * inside the service box (no popup).
 *
 * Everyone: the project list — enter / start the projects you're allowed, or
 * request access to the ones you aren't (per project, not all-or-nothing).
 * Managers also get: create a project, drag-and-drop (or pick) a .zip to import,
 * and export each project. Deletion lives in the admin Services screen.
 */
export default function ServiceProjects({ service, canManage, manage = false, onChanged }) {
  const { t } = useLang()
  const svc = service.name
  const canIE = !!service.import_export
  const [projects, setProjects] = useState(null)   // null = loading
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState('')
  const setErr = (m) => m && notify(m, 'bad')
  const [drag, setDrag] = useState(false)
  const fileRef = useRef(null)
  // Which project the service's own card opens, "" = none (the list is shown).
  const [entry, setEntry] = useState(service.entry_project || '')

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
  // manager: delete a project — stops it, drops its data dir + per-project grants.
  async function remove(proj) {
    if (!window.confirm(t('portal_proj_delete_confirm', proj))) return
    setBusy(proj); setErr('')
    try { await launcher.delete(`/services/${svc}/projects/${proj}`); await load(); onChanged?.() }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_delete_fail')) }
    finally { setBusy('') }
  }
  /** A manager nominates one project as the service's entrance — or clears it.
   *  It changes what the card does for everyone, so it is a manager's call. */
  async function setEntryProject(proj) {
    const want = proj === entry ? '' : proj
    setBusy(proj); setErr('')
    try {
      await launcher.put(`/services/${svc}/entry`, { project: want })
      setEntry(want)
      onChanged?.()
    } catch (e) { setErr(e?.response?.data?.detail || t('portal_entry_fail')) }
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

  return (
    <div {...dropProps} className={`svc-mg${drag ? ' dropping' : ''}`}>
      {/* manager: create a project + import a .zip (drag onto this box, or pick) */}
      {canManage && (
        <Panel title={t('portal_proj_create')} hint={canIE ? t('portal_proj_drop_hint') : undefined}>
          <Field label={t('portal_proj_new_ph')}>
            <input placeholder={t('portal_proj_new_ph')} value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create() }}
              style={{ ...fieldInput, flex: 1 }} />
          </Field>
          <FieldActions>
            <Button variant="primary" disabled={!newName.trim() || busy === '+'} onClick={create}>{t('portal_proj_create')}</Button>
            {canIE && (
              <>
                <Button variant="secondary" disabled={busy === 'import'} onClick={() => fileRef.current?.click()}>
                  <Icon name="download" size={14} style={{ transform: 'rotate(180deg)' }} /> {t('portal_proj_import')}
                </Button>
                <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => importFile(e.target.files?.[0])} />
              </>
            )}
          </FieldActions>
        </Panel>
      )}

      <Panel bare title={t('portal_proj_title')} hint={projects ? String(projects.length) : '…'}>
        {canManage && manage && <Row className="empty">{t('portal_entry_hint')}</Row>}
        {projects === null && <Row className="empty">…</Row>}
        {projects?.length === 0 && <Row className="empty">{t('portal_proj_empty')}</Row>}
        {(projects || []).map((p) => {
          const viewOnly = p.view_only && !p.can_enter
          return (
            <Row key={p.name}>
              <span className="mono">{p.label || p.name}</span>
              {viewOnly ? <Pill>{t('portal_proj_view_only')}</Pill>
                : p.can_enter ? (p.running
                    ? <Pill tone="ok">{t('projects_running', p.port)}</Pill>
                    : <Pill>{t('projects_stopped')}</Pill>)
                  : null}
              <span className="sp" />
              {p.can_enter ? (
                <Button variant="primary" disabled={busy === p.name}
                  onClick={() => (p.running ? enter(p.name) : start(p.name))}>
                  {p.running ? t('portal_proj_open') : t('portal_proj_start')}
                </Button>
              ) : p.can_request ? (
                <Button variant="secondary" disabled={busy === p.name || p.requested}
                  onClick={() => requestAccess(p.name)}>
                  {p.requested ? t('projects_requested') : t('projects_request')}
                </Button>
              ) : (
                <Button variant="primary" disabled>{t('portal_proj_open')}</Button>
              )}
              {manage && p.can_enter && p.running && (
                <Button variant="warning" disabled={busy === p.name} onClick={() => stop(p.name)}>{t('projects_stop')}</Button>
              )}
              {canManage && manage && (
                <Button variant={entry === p.name ? 'primary' : 'secondary'} disabled={busy === p.name}
                  title={t('portal_entry_hint')} onClick={() => setEntryProject(p.name)}>
                  {entry === p.name ? `${t('portal_entry_on')} · ${t('portal_entry_clear')}` : t('portal_entry_set')}
                </Button>
              )}
              {canManage && manage && (
                <Button variant="dangerSoft" disabled={busy === p.name} title={t('portal_proj_delete')}
                  onClick={() => remove(p.name)}><Icon name="trash" size={15} /></Button>
              )}
            </Row>
          )
        })}
      </Panel>
    </div>
  )
}
