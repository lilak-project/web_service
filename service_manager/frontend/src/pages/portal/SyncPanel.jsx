import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * SyncPanel — cross-portal mirroring for ONE service, inside manage mode.
 *
 * main: this server owns the data; it shows ONE connection code (address +
 *       token + project) to paste into the sub. Nobody has to see the token.
 * sub:  this server mirrors another portal — it pulls on demand and (by default)
 *       serves the copy read-only, because the next pull overwrites local edits.
 *       Or, two-way: edits here go to main too (main has to accept them), and a
 *       file changed on both sides is merged rather than overwritten.
 *
 * Only project data syncs; accounts and permissions stay per-server.
 */
const input = { height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', flex: 1, minWidth: 140,
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const sel = { ...input, flex: 'none', minWidth: 120 }
const lbl = { fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 78 }
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const btn = { height: 32, borderRadius: 8, padding: '0 14px', fontSize: 'var(--fs-small, 12px)', justifyContent: 'center', flexShrink: 0 }

export default function SyncPanel({ service, project = '', onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const svc = service.name
  // One project linked on its own, or the service as a whole.
  const base = project ? `/admin/services/${svc}/projects/${project}/sync` : `/admin/services/${svc}/sync`
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({ main_url: '', token: '', read_only: true, interval_min: 0, live: false, two_way: false, projects: [] })
  const [msg, setMsg] = useState('')
  const [job, setJob] = useState(null)
  const [grants, setGrants] = useState(null)   // permission-transfer preview
  // A role CHOSEN but not yet saved: sub has nothing to save until main's
  // code is pasted, so picking it only points at the code box.
  const [pick, setPick] = useState(null)
  const poll = useRef(null)

  async function load() {
    try {
      const { data } = await launcher.get(base)
      setCfg(data)
      setForm((f) => ({ main_url: data.main_url || f.main_url, token: '',
        read_only: data.read_only !== false, interval_min: data.interval_min ?? 0, live: !!data.live,
        two_way: !!data.two_way, projects: data.projects || [] }))
      if (data.role === 'sub' && !project) loadChoices()
    } catch { /* not configured yet */ }
  }
  // Which projects there are to choose from: main's and this server's.
  const [choices, setChoices] = useState(null)
  async function loadChoices() {
    try { setChoices((await launcher.get(`/admin/services/${svc}/sync/projects`)).data) } catch { /* not paired yet */ }
  }
  useEffect(() => { load(); return () => clearInterval(poll.current) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const running = job && (job.status === 'queued' || job.status === 'running')

  async function save(role, extra = {}) {
    setMsg('')
    try {
      const body = role === 'sub'
        ? { role, main_url: form.main_url.trim(), token: form.token.trim(),
            read_only: form.read_only, interval_min: Number(form.interval_min) || 0, live: !!form.live,
            two_way: !!form.two_way, projects: form.projects }
        : role === 'main' ? { role, accept_push: !!cfg?.accept_push, ...extra } : { role }
      const { data } = await launcher.put(base, body)
      setCfg(data)
      setPick(null)
      setMsg(L('저장됨', 'saved'))
      if (data.role === 'sub' && !project) loadChoices()
      onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  async function rotate() {
    try { setCfg((await launcher.post(`${base}/rotate`)).data); setMsg(L('새 코드 발급됨 — 이전 코드는 막혔습니다. sub 에 새 코드를 붙여넣으세요', 'new code — earlier ones stop working; paste it on the sub')) }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  function watch(jobId) {
    setJob({ status: 'queued', log: [] })
    clearInterval(poll.current)
    poll.current = setInterval(async () => {
      try {
        const r = await launcher.get(`/admin/services/${svc}/sync/jobs/${jobId}`)
        setJob(r.data)
        if (r.data.status === 'done' || r.data.status === 'error') {
          clearInterval(poll.current); load()
          // A sync can bring projects: the list beside this panel reads again.
          window.dispatchEvent(new Event('portal:projects'))
        }
      } catch { /* keep polling */ }
    }, 1200)
  }

  async function runNow() {
    setMsg('')
    try { watch((await launcher.post(`${base}/run`)).data.job_id) }
    catch (e) { setMsg(e?.response?.data?.detail || L('동기화를 시작하지 못했습니다', 'failed to start sync')) }
  }

  // ── the connection code: main hands out one line, a sub pastes it ──
  // Main's own idea of its address is often localhost, which another server
  // cannot reach — so the address is editable before the code is copied.
  const [addr, setAddr] = useState('')
  useEffect(() => {
    if (cfg?.role !== 'main') return
    const local = (u) => /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u || '')
    setAddr((a) => a || (local(cfg.pair_url) && !local(window.location.origin) ? window.location.origin : (cfg.pair_url || '')))
  }, [cfg?.role, cfg?.pair_url])
  const b64url = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const code = cfg?.role === 'main' && cfg.token
    ? 'lilak-sync:' + b64url(JSON.stringify({ v: 1, url: addr.trim().replace(/\/+$/, ''), svc,
      ...(project ? { proj: project } : {}), token: cfg.token, two_way: !!cfg.accept_push }))
    : ''
  const addrLocal = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(addr)

  const [joinCode, setJoinCode] = useState('')
  const [joinLive, setJoinLive] = useState(true)
  async function join() {
    setMsg('')
    try {
      const { data } = await launcher.post(`/admin/services/${svc}/sync/join`, { code: joinCode.trim(), live: joinLive })
      setJoinCode('')
      setMsg(data.project
        ? L(`'${data.project}' 프로젝트${data.made ? '를 만들고' : '에'} 연결했습니다${data.two_way ? ' (양방향)' : ''} — 첫 동기화 중`,
          `${data.made ? 'made and ' : ''}linked project '${data.project}'${data.two_way ? ' (two-way)' : ''} — first sync running`)
        : L(`서비스 전체를 연결했습니다${data.two_way ? ' (양방향)' : ''} — 첫 동기화 중`,
          `linked the whole service${data.two_way ? ' (two-way)' : ''} — first sync running`))
      load(); onChanged?.()
      window.dispatchEvent(new Event('portal:projects'))
      if (data.job_id) watch(data.job_id)
    } catch (e) { setMsg(e?.response?.data?.detail || L('연결하지 못했습니다', 'could not join')) }
  }

  // ── by request (handshake): an address, an approval on main, nothing pasted ──
  const isCode = joinCode.trim().startsWith('lilak-sync:')
  const [askProj, setAskProj] = useState(project)
  const [askTwo, setAskTwo] = useState(true)
  const [pending, setPending] = useState([])     // what this server asked for
  const [asked, setAsked] = useState([])         // what other servers asked of this one
  const mine = (r) => !project || r.project === project
  const loadPending = () => launcher.get(`/admin/services/${svc}/sync/pending`).then((r) => {
    setPending((was) => {
      // One that just got through: say so, and show what it brought.
      for (const p of r.data) {
        const before = was.find((x) => x.id === p.id)
        if (before?.status === 'pending' && p.status === 'joined') {
          setMsg(L(`승인되어 연결했습니다${p.project ? ` — '${p.project}'` : ''}. 첫 동기화 중`,
            `approved and linked${p.project ? ` — '${p.project}'` : ''}; first sync running`))
          load(); onChanged?.(); window.dispatchEvent(new Event('portal:projects'))
          if (p.job_id) watch(p.job_id)
        }
      }
      return r.data
    })
  }).catch(() => {})
  const loadAsked = () => launcher.get(`/admin/services/${svc}/sync/requests`).then((r) => setAsked(r.data)).catch(() => {})
  useEffect(() => { loadPending(); loadAsked() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // Waiting on main: ask every few seconds. Requests here: every ten.
  const waiting = pending.some((p) => p.status === 'pending' && mine(p))
  useEffect(() => {
    const a = waiting ? setInterval(loadPending, 4000) : null
    const b = setInterval(loadAsked, 10000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [waiting])  // eslint-disable-line react-hooks/exhaustive-deps

  async function ask() {
    setMsg('')
    try {
      const { data } = await launcher.post(`/admin/services/${svc}/sync/request`,
        { url: joinCode.trim(), project: askProj.trim(), two_way: askTwo, live: joinLive })
      setJoinCode('')
      setMsg(L(`요청을 보냈습니다. main 관리자에게 확인 번호 ${data.pin} 를 알려 주세요 — 승인되면 저절로 연결됩니다.`,
        `request sent. Tell main's admin the pin ${data.pin} — it links itself once approved.`))
      loadPending()
    } catch (e) { setMsg(e?.response?.data?.detail || L('요청하지 못했습니다', 'could not send the request')) }
  }
  async function decide(r, action, acceptPush) {
    try {
      await launcher.post(`/admin/services/${svc}/sync/requests/${r.id}`, { action, accept_push: acceptPush })
      setMsg(action === 'approve' ? L('승인했습니다 — 상대 서버가 곧 연결합니다', 'approved — the other server links in a moment')
        : L('거절했습니다', 'rejected'))
      loadAsked(); load(); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  const forget = (r) => launcher.delete(`/admin/services/${svc}/sync/pending/${r.id}`).then(loadPending)
  const STATUS = { pending: L('승인 대기', 'waiting'), joined: L('연결됨', 'linked'), rejected: L('거절됨', 'rejected'),
    expired: L('만료됨', 'expired'), failed: L('실패', 'failed') }

  async function loadGrants(apply) {
    setMsg('')
    try {
      const { data } = await launcher.post(`/admin/services/${svc}/sync/grants?apply=${apply ? 'true' : 'false'}${project ? `&project=${project}` : ''}`)
      setGrants(data)
      if (apply) setMsg(L(`권한 ${data.applied}건 적용됨`, `${data.applied} grant(s) applied`))
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  const copy = (v) => { try { navigator.clipboard.writeText(v) } catch { /* ignore */ } setMsg(L('복사됨', 'copied')) }
  const role = pick ?? (cfg?.role || '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px dashed var(--border-subtle)' }}>
      <div style={row}>
        <span style={lbl}>{L('동기화', 'Sync')}</span>
        {/* off and main need nothing typed, so they save on the spot; sub
            opens its form and waits for 연결 저장. */}
        <select value={role} style={sel}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'sub' && cfg?.role !== 'sub') {
              setPick('sub')
              setMsg(L('main 주소를 넣고 연결 요청을 누르세요 (연결 코드가 있으면 그것을 붙여넣고 받기).',
                'type main\'s address and press Ask (or paste a connection code and press Join)'))
            } else { setPick(null); save(v) }
          }}>
          <option value="">{L('사용 안 함', 'off')}</option>
          <option value="main">{L('main (원본)', 'main (source)')}</option>
          <option value="sub">{L('sub (미러)', 'sub (mirror)')}</option>
        </select>
        {cfg?.last_sync && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
          {L('마지막', 'last')}: {cfg.last_sync}
        </span>}
      </div>
      <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
        {project
          ? L(`프로젝트 ${project} 만의 연결입니다. 켜면 서비스 전체 설정 대신 이것을 씁니다 — 상대 서버·토큰·방향이 따로입니다.`,
            `A link for project ${project} alone. When on, it replaces the service's — its own partner, token and direction.`)
          : (cfg?.own_links?.length
            ? L(`따로 연결된 프로젝트(${cfg.own_links.join(', ')})는 이 설정에서 빠집니다.`,
              `Projects linked on their own (${cfg.own_links.join(', ')}) are left out of this one.`)
            : L('서비스의 모든 프로젝트에 적용됩니다. 프로젝트마다 따로 하려면 아래 프로젝트 줄의 Sync 를 누르세요.',
              'Applies to every project. To link one project on its own, press Sync on its row below.'))}
      </div>

      {role === 'main' && (
        <>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {L('연결 코드 하나를 sub 서버의 같은 서비스 → 동기화 → "연결 코드"에 붙여넣으면 프로젝트를 만들고 바로 동기화합니다. 코드에는 토큰이 들어 있으니 비밀번호처럼 다루세요.',
              'Paste the connection code into the same service on the sub server (Sync → "Connection code"): it makes the project and syncs at once. The code holds the token — treat it like a password.')}
          </div>
          <div style={row}>
            <span style={lbl}>{L('주소', 'URL')}</span>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} style={input}
              placeholder="http://kiki.local:8025" />
          </div>
          {addrLocal && (
            <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--warning-text, #b45309)' }}>
              {L('localhost 는 다른 서버에서 닿지 않습니다 — 이 서버의 이름(kiki.local)이나 IP로 고치세요.',
                'localhost cannot be reached from another server — use this server\'s name or IP.')}
            </div>
          )}
          <div style={row}>
            <span style={lbl}>{L('연결 코드', 'Code')}</span>
            <input readOnly value={code} style={{ ...input, fontFamily: 'var(--font-mono)' }} onFocus={(e) => e.target.select()} />
            <Button variant="primary" style={btn} disabled={!code} onClick={() => copy(code)}>{L('복사', 'Copy')}</Button>
            {/* A code that leaked: a new token, and every earlier code stops working. */}
            <Button variant="dangerSoft" style={btn} title={L('새 코드를 만들고 이전 코드는 막습니다', 'new code; earlier ones stop working')}
              onClick={rotate}>{L('재발급', 'Rotate')}</Button>
          </div>
          <div style={row}>
            <span style={lbl}>{L('양방향', 'Two-way')}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!cfg.accept_push}
                onChange={(e) => save('main', { accept_push: e.target.checked })} />
              {L('sub 에서 고친 것도 받기', 'accept edits made on the sub')}
            </label>
          </div>
        </>
      )}

      {/* Other servers asking to follow this one: approve (it becomes main
          for that link) or reject. The pin is the one the asker sees. */}
      {asked.filter((r) => r.status === 'pending' && mine(r)).map((r) => (
        <div key={r.id} style={{ ...row, padding: 8, borderRadius: 8, background: 'var(--surface-2)' }}>
          <span style={{ fontSize: 'var(--fs-small, 12px)', flex: 1, minWidth: 220 }}>
            <b>{L('연결 요청', 'Link request')}</b> · {r.from_name || '?'} <span style={{ color: 'var(--text-muted)' }}>({r.from_url || '?'})</span>
            {' · '}{r.by || '?'} · {r.project ? L(`프로젝트 ${r.project}`, `project ${r.project}`) : L('서비스 전체', 'whole service')}
            {' · '}{L('확인 번호', 'pin')} <b style={{ fontFamily: 'var(--font-mono)' }}>{r.pin}</b>
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>
            <input type="checkbox" defaultChecked={!!r.two_way} id={`ap-${r.id}`} /> {L('양방향 허용', 'allow two-way')}
          </label>
          <Button variant="primary" style={btn}
            onClick={() => decide(r, 'approve', document.getElementById(`ap-${r.id}`)?.checked)}>{L('승인', 'Approve')}</Button>
          <Button variant="dangerSoft" style={btn} onClick={() => decide(r, 'reject')}>{L('거절', 'Reject')}</Button>
        </div>
      ))}

      {/* The way in: main's address (it asks; main approves) or main's code. */}
      {role !== 'main' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 6, borderBottom: '1px dashed var(--border-subtle)' }}>
          <div style={row}>
            <span style={lbl}>{L('main 연결', 'Link to')}</span>
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
              placeholder={L('main 주소 (http://…:8025) 또는 연결 코드', 'main address (http://…:8025) or a code')}
              style={{ ...input, fontFamily: 'var(--font-mono)' }} />
          </div>
          {joinCode.trim() && (
            <div style={row}>
              <span style={lbl} />
              {!isCode && (<>
                <input value={askProj} onChange={(e) => setAskProj(e.target.value)} disabled={!!project}
                  placeholder={L('프로젝트 (비우면 서비스 전체)', 'project (empty = whole service)')}
                  style={{ ...input, flex: 'none', width: 220, fontFamily: 'var(--font-mono)' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={askTwo} onChange={(e) => setAskTwo(e.target.checked)} />
                  {L('양방향', 'two-way')}
                </label>
              </>)}
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={joinLive} onChange={(e) => setJoinLive(e.target.checked)} />
                {L('실시간', 'live')}
              </label>
              <Button variant="primary" style={btn} disabled={running} onClick={isCode ? join : ask}>
                {isCode ? L('받기', 'Join') : L('연결 요청', 'Ask')}
              </Button>
            </div>
          )}
          {pending.filter(mine).map((p) => (
            <div key={p.id} style={{ ...row, fontSize: 'var(--fs-small, 12px)' }}>
              <span style={lbl} />
              <span style={{ flex: 1 }}>
                {p.url} · {p.project || L('서비스 전체', 'whole service')} · <b>{STATUS[p.status] || p.status}</b>
                {p.status === 'pending' && <> · {L('확인 번호', 'pin')} <b style={{ fontFamily: 'var(--font-mono)' }}>{p.pin}</b></>}
                {p.error ? ` — ${p.error}` : ''}
              </span>
              <Button variant="secondary" style={btn} onClick={() => forget(p)}>
                {p.status === 'pending' ? L('취소', 'Cancel') : L('지우기', 'Dismiss')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {role === 'sub' && cfg?.role === 'sub' && (
        <>
          {/* Who this copy follows. The token stays on the server; another
              partner is a new code pasted above. */}
          <div style={row}>
            <span style={lbl}>main</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)' }}>{cfg?.main_url}</span>
          </div>
          <div style={row}>
            <span style={lbl}>{L('방향', 'Direction')}</span>
            <select value={form.two_way ? 'two' : 'one'} style={sel}
              onChange={(e) => setForm((f) => ({ ...f, two_way: e.target.value === 'two' }))}>
              <option value="one">{L('main → 여기 (미러)', 'main → here (mirror)')}</option>
              <option value="two">{L('양방향', 'two-way')}</option>
            </select>
            {!form.two_way && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.read_only}
                  onChange={(e) => setForm((f) => ({ ...f, read_only: e.target.checked }))} />
                {L('읽기 전용으로 잠그기 (권장)', 'lock read-only (recommended)')}
              </label>
            )}
          </div>
          {/* None ticked = every project, as before. Main's and this server's
              are both offered: two-way sends a project made here too. */}
          {choices && !project && (
            <div style={{ ...row, alignItems: 'flex-start' }}>
              <span style={lbl}>{L('프로젝트', 'Projects')}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', flex: 1 }}>
                {[...new Set([...(choices.main || []), ...(form.two_way ? choices.local || [] : [])])].sort().map((p) => (
                  <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.projects.includes(p)}
                      onChange={(e) => setForm((f) => ({ ...f, projects: e.target.checked
                        ? [...f.projects, p] : f.projects.filter((x) => x !== p) }))} />
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{p}</span>
                    {!(choices.main || []).includes(p) && <span style={{ color: 'var(--text-muted)' }}>{L('(이 서버만)', '(here only)')}</span>}
                  </label>
                ))}
                <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', flexBasis: '100%' }}>
                  {choices.error || (form.projects.length
                    ? L(`${form.projects.length}개만 동기화합니다`, `only these ${form.projects.length}`)
                    : L('아무것도 고르지 않으면 전부 동기화합니다', 'none ticked = every project'))}
                </span>
              </div>
            </div>
          )}
          <div style={row}>
            <span style={lbl}>{L('자동', 'Auto')}</span>
            {/* Live is not "a shorter interval": it asks main every few seconds
                which projects changed — a stat on main's side — and pulls only
                those, so a mirror trails main by seconds without re-reading the
                whole project each time. */}
            <select value={form.live ? 'live' : form.interval_min}
              onChange={(e) => {
                const v = e.target.value
                setForm((f) => (v === 'live' ? { ...f, live: true, interval_min: 0 }
                  : { ...f, live: false, interval_min: Number(v) }))
              }} style={sel}>
              <option value="live">{L('실시간 (몇 초 안에)', 'live (within seconds)')}</option>
              <option value={0}>{L('수동만', 'manual only')}</option>
              <option value={1}>{L('1분마다', 'every 1 min')}</option>
              <option value={5}>{L('5분마다', 'every 5 min')}</option>
              <option value={15}>{L('15분마다', 'every 15 min')}</option>
              <option value={60}>{L('1시간마다', 'hourly')}</option>
            </select>
            <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
              {L('저장해야 적용됩니다', 'takes effect on save')}
            </span>
          </div>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {form.two_way
              ? L('양쪽에서 고친 것이 서로에게 갑니다. 같은 항목을 양쪽에서 고치면 필드별로 합치고, 노트·파일은 사본을 남깁니다. main 에서 "sub 에서 고친 것도 받기"를 켜야 합니다. 데이터베이스를 쓰는 서비스(elog)는 양방향이 안 됩니다.',
                'Edits on either side reach the other. The same record edited on both is merged field by field; notes and files keep a copy. Main must tick "accept edits made on the sub". Services on a database (elog) cannot go two-way.')
              : L('동기화하면 main 에 있는 프로젝트가 이 서버 것을 덮어씁니다. main 에 없는 프로젝트는 그대로 둡니다.',
                'A sync overwrites this server\'s copy with main\'s projects. Projects absent on main are left alone.')}
          </div>
          <div style={row}>
            <span style={lbl} />
            <Button variant="secondary" style={btn} onClick={() => save('sub')}>{L('설정 저장', 'Save settings')}</Button>
            <Button variant="primary" style={btn} disabled={running} onClick={runNow}>
              {running ? L('동기화 중…', 'syncing…') : L('지금 동기화', 'Sync now')}
            </Button>
          </div>
          <div style={{ ...row, paddingTop: 4, borderTop: '1px dashed var(--border-subtle)' }}>
            <span style={lbl}>{L('권한', 'Grants')}</span>
            <Button variant="secondary" style={btn} onClick={() => loadGrants(false)}>
              {L('main 권한 확인', 'Check main')}
            </Button>
            {grants && grants.matched.length > 0 && (
              <Button variant="primary" style={btn} onClick={() => loadGrants(true)}>
                {L('이 서버 계정에 적용', 'Apply here')}
              </Button>
            )}
          </div>
          {grants && (
            <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)',
              background: 'var(--surface-2)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {grants.matched.length === 0 && grants.skipped.length === 0 && <span>{L('main 에 권한이 없습니다.', 'no grants on main')}</span>}
              {grants.matched.map((m, i) => (
                <span key={'m' + i}>
                  ✓ {m.local_user} · {m.project || L('서비스 전체', 'whole service')}
                  {m.is_admin ? L(' · 관리', ' · admin') : ''}
                  {m.already ? L(' (이미 있음)', ' (already)') : ''}
                  {m.matched_by === 'email' ? L(' [이메일로 매칭]', ' [matched by email]') : ''}
                  {m.email_differs ? L(' [이메일 다름]', ' [email differs]') : ''}
                </span>
              ))}
              {grants.skipped.map((s2, i) => (
                <span key={'s' + i} style={{ opacity: 0.75 }}>
                  – {s2.username} · {L('이 서버에 계정 없음 — 건너뜀', 'no local account — skipped')}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</div>}
      {/* The last sync's log — after a join too, while the role still reads off. */}
      {job && (
        <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 'var(--fs-micro, 10px)', lineHeight: 1.5,
          backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap' }}>
          {(job.log || []).join('\n') || '…'}{job.error ? `\n! ${job.error}` : ''}
        </pre>
      )}
    </div>
  )
}
