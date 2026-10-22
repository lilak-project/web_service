import { useEffect, useRef, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Row, Pill, fieldMuted } from './Field'
import { notify } from './settingsMsg'

// icon · name · state · what it is · the one button
// The state column is a fixed width, not `auto`: "installed" and "not
// installed" are different lengths, so an auto column started the description
// at two different x down the list.
const COLS = { gridTemplateColumns: '20px minmax(120px, 210px) 128px minmax(0, 1fr) 96px' }

/**
 * StoreView — the "Service Manager" builtin card body (admins only).
 *
 * Lists the install catalog (app/store_catalog.json): each known service shows its
 * installed state and an Install button that runs the backend job (git clone →
 * build → register) with a live log; when it finishes the Home list refreshes and
 * the new service card appears. A second section rebuilds the portal frontend
 * itself (optionally after a git pull).
 */

export default function StoreView({ onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [items, setItems] = useState(null)      // null = loading
  const [job, setJob] = useState(null)          // {id, name, status, log, error}
  const [pull, setPull] = useState(false)       // build-portal: git pull first
  const setErr = (m) => m && notify(m, 'bad')
  const poll = useRef(null)
  const logBox = useRef(null)

  async function load() {
    try { setItems((await launcher.get('/admin/store')).data.services) }
    catch (e) { setErr(e?.response?.data?.detail || tr("p_failed_to_load_catalog")) }
  }
  useEffect(() => { load(); return () => clearInterval(poll.current) }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight }, [job])

  const running = job && (job.status === 'queued' || job.status === 'running')

  function watch(jobId, name) {
    setJob({ id: jobId, name, status: 'queued', log: [], error: null })
    clearInterval(poll.current)
    poll.current = setInterval(async () => {
      try {
        const { data } = await launcher.get(`/admin/store/jobs/${jobId}`)
        setJob({ id: jobId, name, ...data })
        if (data.status === 'done' || data.status === 'error') {
          clearInterval(poll.current)
          if (data.status === 'done') { await load(); onChanged?.() }
        }
      } catch { /* keep polling */ }
    }, 1200)
  }

  async function run(path, name, failMsg) {
    setErr('')
    try {
      const { data } = await launcher.post(`/admin/store/${path}`, { name })
      watch(data.job_id, name)
    } catch (e) { setErr(e?.response?.data?.detail || failMsg) }
  }
  const install = (name) => run('install', name, tr("p_failed_to_start_install"))
  const update = (name) => run('update', name, tr("p_failed_to_start_update"))

  async function buildPortal() {
    setErr('')
    try {
      const { data } = await launcher.post('/admin/store/build-portal', { pull })
      watch(data.job_id, 'portal')
    } catch (e) { setErr(e?.response?.data?.detail || tr("p_failed_to_start_build")) }
  }

  const stateBadge = (s) => s.registered
    ? <Pill tone="ok">{tr("p_installed")}</Pill>
    : s.code_present
      ? <Pill tone="warn">{tr("p_code_only")}</Pill>
      : <Pill>{tr("p_not_installed")}</Pill>

  return (
    <div className="svc-mg">
      <Panel bare title={tr("p_service_catalogue")}
        hint={items ? String(items.length) : '…'}>
        {/* A grid, not a flex line: fourteen rows only read as a list if the
            state, the description and the button start at the same x on each. */}
        <Row className="cols head" style={COLS}>
          <span />
          <span>{tr("p_service_4")}</span>
          <span>{tr("p_state_2")}</span>
          <span>{tr("p_detail")}</span>
          <span />
        </Row>
        {items === null && <Row className="empty">…</Row>}
        {(items || []).map((s) => (
          <Row key={s.name} className="cols" style={COLS}>
            {/* The icon is the service's identity — it belongs to something that
                exists on this portal. Until it is installed the row keeps the
                slot (so the labels stay aligned) but shows nothing. */}
            {s.registered
              ? <Icon name={s.icon || 'circle'} size={18} weight="fill" color={s.color || 'var(--text-primary)'} />
              : <span aria-hidden="true" />}
            {/* The repo is on the name's tooltip, not in the row: it is the
                longest thing here and the least often read. */}
            <span className="ell" title={s.repo}>{s.label || s.name}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {stateBadge(s)}
              {s.private && <Pill tone="warn">{tr("p_private")}</Pill>}
            </span>
            {/* Truncated with an ellipsis rather than wrapping the row; the
                whole sentence is on the cell's own tooltip. */}
            <span className="sub ell" title={L(s.ko, s.en)}>{L(s.ko, s.en)}</span>
            {s.registered ? (
              <Button variant="secondary" disabled={running} onClick={() => update(s.name)}
                title={tr("p_git_pull_then_rebuild")}>
                {tr("p_update_2")}
              </Button>
            ) : (
              <Button variant="primary" disabled={running} onClick={() => install(s.name)}>
                {tr("p_install")}
              </Button>
            )}
          </Row>
        ))}
      </Panel>

      <Panel title={tr("p_portal")}>
        <Field label={tr("p_rebuild_frontend")}>
          {tr("p_refresh_once_it_finishes_and")}
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={running} onClick={buildPortal}>{tr("p_build_portal")}</Button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            {tr("p_git_pull_first_ff_only")}
          </label>
        </FieldActions>
      </Panel>

      {/* live job log */}
      {job && (
        <Panel bare
          title={job.name === 'portal' ? tr("p_portal_build") : job.name}
          hint={running ? tr("p_running") : job.status === 'done' ? tr("p_done_2") : tr("p_failed")}>
          {job.error && <div className="set-row" style={{ color: 'var(--danger-text)' }}>{job.error}</div>}
          <pre ref={logBox} style={{
            margin: 14, maxHeight: 240, overflow: 'auto', fontSize: 'var(--fs-small, 13px)', lineHeight: 1.5,
            backgroundColor: 'var(--surface-2)', color: 'var(--text-secondary)',
            borderRadius: 'var(--rack-radius, 0)', padding: 10, whiteSpace: 'pre-wrap',
          }}>{(job.log || []).join('\n') || '…'}</pre>
        </Panel>
      )}
    </div>
  )
}
