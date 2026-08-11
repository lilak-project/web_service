import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * StoreView — the "Service Manager" builtin card body (admins only).
 *
 * Lists the install catalog (app/store_catalog.json): each known service shows its
 * installed state and an Install button that runs the backend job (git clone →
 * build → register) with a live log; when it finishes the Home list refreshes and
 * the new service card appears. A second section rebuilds the portal frontend
 * itself (optionally after a git pull).
 */
const btn = { height: 32, borderRadius: 8, padding: '0 14px', fontSize: 'var(--fs-small, 12px)',
  justifyContent: 'center', flexShrink: 0, whiteSpace: 'nowrap' }
const badge = { fontSize: 'var(--fs-micro, 10px)', padding: '2px 8px', borderRadius: 999 }

export default function StoreView({ onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [items, setItems] = useState(null)      // null = loading
  const [job, setJob] = useState(null)          // {id, name, status, log, error}
  const [pull, setPull] = useState(false)       // build-portal: git pull first
  const [err, setErr] = useState('')
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
    ? <span style={{ ...badge, background: 'var(--ok-bg, #e6f4ea)', color: 'var(--ok-text, #2f9e44)' }}>{L('설치됨', 'installed')}</span>
    : s.code_present
      ? <span style={{ ...badge, background: 'var(--info-bg, var(--surface-2))', color: 'var(--info-text, var(--text-secondary))' }}>{L('코드만 있음', 'code only')}</span>
      : <span style={{ ...badge, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{L('미설치', 'not installed')}</span>

  return (
    <div style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
        {L('카탈로그의 서비스를 내려받아(git) 빌드하고 포털에 등록합니다. 설치가 끝나면 홈에 카드가 나타납니다.',
          'Download (git), build and register catalog services. The service card appears on Home when the install finishes.')}
      </div>
      {err && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</div>}

      {/* catalog */}
      {items === null ? (
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>…</div>
      ) : items.map((s) => (
        <div key={s.name} style={{ border: '1px solid var(--border-default)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Icon name={s.icon || 'circle'} size={20} weight="fill" color={s.color || 'var(--text-primary)'} style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: 'var(--fs-medium, 14px)' }}>{s.label || s.name}</span>
            {stateBadge(s)}
            {s.private && (
              <span style={{ ...badge, background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                title={L('비공개 레포 — 서버에 SSH 키 필요', 'private repo — needs an SSH key on the server')}>
                {L('비공개', 'private')}
              </span>
            )}
            <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L(s.ko, s.en)}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {s.registered ? (
              <Button variant="secondary" style={btn} disabled={running} onClick={() => update(s.name)}
                title={L('git pull 후 다시 빌드', 'git pull, then rebuild')}>
                {L('업데이트', 'Update')}
              </Button>
            ) : (
              <Button variant="primary" style={btn} disabled={running} onClick={() => install(s.name)}>
                {L('설치', 'Install')}
              </Button>
            )}
            <span style={{ fontSize: 'var(--fs-micro, 10px)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.repo.replace(/^https?:\/\//, '')}
            </span>
          </div>
        </div>
      ))}

      {/* portal build */}
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Icon name="lilak" size={20} style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 'var(--fs-medium, 14px)' }}>{L('포털', 'Portal')}</span>
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
            {L('포털 프론트엔드를 다시 빌드합니다. 빌드 후 새로고침하면 반영됩니다.',
              'Rebuild the portal frontend; refresh after it finishes.')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" style={btn} disabled={running} onClick={buildPortal}>{L('포털 빌드', 'Build portal')}</Button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            {L('git pull 먼저 (--ff-only)', 'git pull first (--ff-only)')}
          </label>
        </div>
      </div>

      {/* live job log */}
      {job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-small, 12px)', fontWeight: 600 }}>
            {running && <Icon name="loader" size={14} />}
            {job.status === 'done' && <Icon name="check" size={14} style={{ color: 'var(--success-text, #2e7d32)' }} />}
            {job.status === 'error' && <Icon name="x" size={14} style={{ color: 'var(--danger-text)' }} />}
            <span>
              {job.name === 'portal' ? L('포털 빌드', 'portal build') : job.name}
              {' · '}
              {running ? L('진행 중…', 'running…') : job.status === 'done' ? L('완료', 'done') : L('실패', 'failed')}
            </span>
          </div>
          {job.error && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{job.error}</div>}
          <pre ref={logBox} style={{
            margin: 0, maxHeight: 220, overflow: 'auto', fontSize: 'var(--fs-micro, 10px)', lineHeight: 1.5,
            backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap',
          }}>{(job.log || []).join('\n') || '…'}</pre>
        </div>
      )}
    </div>
  )
}
