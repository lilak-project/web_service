import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
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
    catch (e) { setErr(e?.response?.data?.detail || L('목록을 불러오지 못했습니다.', 'failed to load catalog')) }
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
  const install = (name) => run('install', name, L('설치를 시작하지 못했습니다.', 'failed to start install'))
  const update = (name) => run('update', name, L('업데이트를 시작하지 못했습니다.', 'failed to start update'))

  async function buildPortal() {
    setErr('')
    try {
      const { data } = await launcher.post('/admin/store/build-portal', { pull })
      watch(data.job_id, 'portal')
    } catch (e) { setErr(e?.response?.data?.detail || L('빌드를 시작하지 못했습니다.', 'failed to start build')) }
  }

  const stateBadge = (s) => s.registered
    ? <Pill tone="ok">{L('설치됨', 'installed')}</Pill>
    : s.code_present
      ? <Pill tone="warn">{L('코드만 있음', 'code only')}</Pill>
      : <Pill>{L('미설치', 'not installed')}</Pill>

  return (
    <div className="svc-mg">
      <Panel bare title={L('서비스 카탈로그', 'Service catalogue')}
        hint={items ? String(items.length) : '…'}>
        {/* A grid, not a flex line: fourteen rows only read as a list if the
            state, the description and the button start at the same x on each. */}
        <Row className="cols head" style={COLS}>
          <span />
          <span>{L('서비스', 'Service')}</span>
          <span>{L('상태', 'State')}</span>
          <span>{L('설명', 'What it is')}</span>
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
              {s.private && <Pill tone="warn">{L('비공개', 'private')}</Pill>}
            </span>
            <span className="sub ell">{L(s.ko, s.en)}</span>
            {s.registered ? (
              <Button variant="secondary" disabled={running} onClick={() => update(s.name)}
                title={L('git pull 후 다시 빌드', 'git pull, then rebuild')}>
                {L('업데이트', 'Update')}
              </Button>
            ) : (
              <Button variant="primary" disabled={running} onClick={() => install(s.name)}>
                {L('설치', 'Install')}
              </Button>
            )}
          </Row>
        ))}
      </Panel>

      <Panel title={L('포털', 'Portal')}>
        <Field label={L('프론트엔드 빌드', 'Rebuild frontend')}>
          {L('빌드가 끝난 뒤 새로고침하면 반영됩니다.', 'Refresh once it finishes and the new build is live.')}
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={running} onClick={buildPortal}>{L('포털 빌드', 'Build portal')}</Button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            {L('git pull 먼저 (--ff-only)', 'git pull first (--ff-only)')}
          </label>
        </FieldActions>
      </Panel>

      {/* live job log */}
      {job && (
        <Panel bare
          title={job.name === 'portal' ? L('포털 빌드', 'portal build') : job.name}
          hint={running ? L('진행 중…', 'running…') : job.status === 'done' ? L('완료', 'done') : L('실패', 'failed')}>
          {job.error && <div className="set-row" style={{ color: 'var(--danger-text)' }}>{job.error}</div>}
          <pre ref={logBox} style={{
            margin: 14, maxHeight: 240, overflow: 'auto', fontSize: 'var(--fs-small, 13px)', lineHeight: 1.5,
            backgroundColor: 'var(--surface-2)', color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-lg, 5px)', padding: 10, whiteSpace: 'pre-wrap',
          }}>{(job.log || []).join('\n') || '…'}</pre>
        </Panel>
      )}
    </div>
  )
}
