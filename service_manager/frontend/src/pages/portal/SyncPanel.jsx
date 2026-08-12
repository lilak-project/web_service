import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * SyncPanel — cross-portal mirroring for ONE service, inside manage mode.
 *
 * main: this server owns the data; it shows the URL + token to paste into the sub.
 * sub:  this server mirrors another portal — it pulls on demand and (by default)
 *       serves the copy read-only, because the next pull overwrites local edits.
 *
 * Only project data syncs; accounts and permissions stay per-server.
 */
const input = { height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', flex: 1, minWidth: 140,
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const sel = { ...input, flex: 'none', minWidth: 120 }
const lbl = { fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 78 }
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const btn = { height: 32, borderRadius: 8, padding: '0 14px', fontSize: 'var(--fs-small, 12px)', justifyContent: 'center', flexShrink: 0 }

export default function SyncPanel({ service }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const svc = service.name
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({ main_url: '', token: '', read_only: true })
  const [msg, setMsg] = useState('')
  const [job, setJob] = useState(null)
  const poll = useRef(null)

  async function load() {
    try {
      const { data } = await launcher.get(`/admin/services/${svc}/sync`)
      setCfg(data)
      setForm((f) => ({ main_url: data.main_url || f.main_url, token: data.token || f.token,
        read_only: data.read_only !== false }))
    } catch { /* not configured yet */ }
  }
  useEffect(() => { load(); return () => clearInterval(poll.current) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const running = job && (job.status === 'queued' || job.status === 'running')

  async function save(role) {
    setMsg('')
    try {
      const body = role === 'sub'
        ? { role, main_url: form.main_url.trim(), token: form.token.trim(), read_only: form.read_only }
        : { role }
      const { data } = await launcher.put(`/admin/services/${svc}/sync`, body)
      setCfg(data)
      setMsg(L('저장됨', 'saved'))
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  async function rotate() {
    try { setCfg((await launcher.post(`/admin/services/${svc}/sync/rotate`)).data); setMsg(L('토큰 재발급됨 — sub 를 다시 연결하세요', 'token rotated — re-pair the sub')) }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  async function runNow() {
    setMsg('')
    try {
      const { data } = await launcher.post(`/admin/services/${svc}/sync/run`)
      setJob({ status: 'queued', log: [] })
      clearInterval(poll.current)
      poll.current = setInterval(async () => {
        try {
          const r = await launcher.get(`/admin/services/${svc}/sync/jobs/${data.job_id}`)
          setJob(r.data)
          if (r.data.status === 'done' || r.data.status === 'error') { clearInterval(poll.current); load() }
        } catch { /* keep polling */ }
      }, 1200)
    } catch (e) { setMsg(e?.response?.data?.detail || L('동기화를 시작하지 못했습니다', 'failed to start sync')) }
  }

  const copy = (v) => { try { navigator.clipboard.writeText(v) } catch { /* ignore */ } setMsg(L('복사됨', 'copied')) }
  const role = cfg?.role || ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px dashed var(--border-subtle)' }}>
      <div style={row}>
        <span style={lbl}>{L('동기화', 'Sync')}</span>
        <select value={role} onChange={(e) => save(e.target.value)} style={sel}>
          <option value="">{L('사용 안 함', 'off')}</option>
          <option value="main">{L('main (원본)', 'main (source)')}</option>
          <option value="sub">{L('sub (미러)', 'sub (mirror)')}</option>
        </select>
        {cfg?.last_sync && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
          {L('마지막', 'last')}: {cfg.last_sync}
        </span>}
      </div>

      {role === 'main' && (
        <>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {L('아래 두 값을 sub 서버의 같은 서비스에 붙여넣으세요.',
              'Paste these two values into the same service on the sub server.')}
          </div>
          <div style={row}>
            <span style={lbl}>{L('주소', 'URL')}</span>
            <input readOnly value={cfg.pair_url || ''} style={input} />
            <Button variant="secondary" style={btn} onClick={() => copy(cfg.pair_url || '')}>{L('복사', 'Copy')}</Button>
          </div>
          <div style={row}>
            <span style={lbl}>{L('토큰', 'Token')}</span>
            <input readOnly value={cfg.token || ''} style={{ ...input, fontFamily: 'var(--font-mono)' }} />
            <Button variant="secondary" style={btn} onClick={() => copy(cfg.token || '')}>{L('복사', 'Copy')}</Button>
            <Button variant="dangerSoft" style={btn} onClick={rotate}>{L('재발급', 'Rotate')}</Button>
          </div>
        </>
      )}

      {role === 'sub' && (
        <>
          <div style={row}>
            <span style={lbl}>{L('main 주소', 'main URL')}</span>
            <input value={form.main_url} placeholder="https://s2.example.org"
              onChange={(e) => setForm((f) => ({ ...f, main_url: e.target.value }))} style={input} />
          </div>
          <div style={row}>
            <span style={lbl}>{L('토큰', 'Token')}</span>
            <input value={form.token} placeholder={L('main 에서 복사', 'copy from main')}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
              style={{ ...input, fontFamily: 'var(--font-mono)' }} />
          </div>
          <div style={row}>
            <span style={lbl} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.read_only}
                onChange={(e) => setForm((f) => ({ ...f, read_only: e.target.checked }))} />
              {L('읽기 전용으로 잠그기 (권장)', 'lock read-only (recommended)')}
            </label>
          </div>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {L('동기화하면 main 에 있는 프로젝트가 이 서버 것을 덮어씁니다. main 에 없는 프로젝트는 그대로 둡니다.',
              'A sync overwrites this server\'s copy with main\'s projects. Projects absent on main are left alone.')}
          </div>
          <div style={row}>
            <span style={lbl} />
            <Button variant="secondary" style={btn} onClick={() => save('sub')}>{L('연결 저장', 'Save link')}</Button>
            <Button variant="primary" style={btn} disabled={running} onClick={runNow}>
              {running ? L('동기화 중…', 'syncing…') : L('지금 동기화', 'Sync now')}
            </Button>
          </div>
          {job && (
            <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 'var(--fs-micro, 10px)', lineHeight: 1.5,
              backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap' }}>
              {(job.log || []).join('\n') || '…'}{job.error ? `\n! ${job.error}` : ''}
            </pre>
          )}
        </>
      )}

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</div>}
    </div>
  )
}
