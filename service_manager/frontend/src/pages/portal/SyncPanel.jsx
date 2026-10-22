import { useEffect, useRef, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
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
      setMsg(tr("p_saved"))
      if (data.role === 'sub' && !project) loadChoices()
      onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed")) }
  }

  async function rotate() {
    try { setCfg((await launcher.post(`${base}/rotate`)).data); setMsg(tr("p_new_code_earlier_ones_stop")) }
    catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed")) }
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
    catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed_to_start_sync")) }
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
        ? tr("p_linked_project_first_sync_running", data.project, data.made ? '를 만들고' : '에', data.two_way ? ' (양방향)' : '', data.made ? 'made and ' : '', data.two_way ? ' (two-way)' : '')
        : tr("p_linked_the_whole_service_first", data.two_way ? ' (양방향)' : '', data.two_way ? ' (two-way)' : ''))
      load(); onChanged?.()
      window.dispatchEvent(new Event('portal:projects'))
      if (data.job_id) watch(data.job_id)
    } catch (e) { setMsg(e?.response?.data?.detail || tr("p_could_not_join")) }
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
          setMsg(tr("p_approved_and_linked_first_sync", p.project ? ` — '${p.project}'` : ''))
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
      setMsg(tr("p_request_sent_tell_main_s", data.pin))
      loadPending()
    } catch (e) { setMsg(e?.response?.data?.detail || tr("p_could_not_send_the_request")) }
  }
  async function decide(r, action, acceptPush) {
    try {
      await launcher.post(`/admin/services/${svc}/sync/requests/${r.id}`, { action, accept_push: acceptPush })
      setMsg(action === 'approve' ? tr("p_approved_the_other_server_links")
        : tr("p_rejected"))
      loadAsked(); load(); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed")) }
  }
  const forget = (r) => launcher.delete(`/admin/services/${svc}/sync/pending/${r.id}`).then(loadPending)
  const STATUS = { pending: tr("p_waiting"), joined: tr("p_linked"), rejected: tr("p_rejected_2"),
    expired: tr("p_expired"), failed: tr("p_failed") }

  async function loadGrants(apply) {
    setMsg('')
    try {
      const { data } = await launcher.post(`/admin/services/${svc}/sync/grants?apply=${apply ? 'true' : 'false'}${project ? `&project=${project}` : ''}`)
      setGrants(data)
      if (apply) setMsg(tr("p_grant_s_applied", data.applied))
    } catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed")) }
  }

  const copy = (v) => { try { navigator.clipboard.writeText(v) } catch { /* ignore */ } setMsg(tr("p_copied")) }
  const role = pick ?? (cfg?.role || '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px dashed var(--border-subtle)' }}>
      <div style={row}>
        <span style={lbl}>{tr("p_sync")}</span>
        {/* off and main need nothing typed, so they save on the spot; sub
            opens its form and waits for 연결 저장. */}
        <select value={role} style={sel}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'sub' && cfg?.role !== 'sub') {
              setPick('sub')
              setMsg(tr("p_type_main_s_address_and"))
            } else { setPick(null); save(v) }
          }}>
          <option value="">{tr("p_off")}</option>
          <option value="main">{tr("p_main_source")}</option>
          <option value="sub">{tr("p_sub_mirror")}</option>
        </select>
        {cfg?.last_sync && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
          {tr("p_last")}: {cfg.last_sync}
        </span>}
      </div>
      <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
        {project
          ? tr("p_a_link_for_project_alone", project)
          : (cfg?.own_links?.length
            ? tr("p_projects_linked_on_their_own", cfg.own_links.join(', '))
            : tr("p_applies_to_every_project_to"))}
      </div>

      {role === 'main' && (
        <>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {tr("p_paste_the_connection_code_into")}
          </div>
          <div style={row}>
            <span style={lbl}>{tr("p_url")}</span>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} style={input}
              placeholder="http://kiki.local:8025" />
          </div>
          {addrLocal && (
            <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--warning-text, #b45309)' }}>
              {tr("p_localhost_cannot_be_reached_from")}
            </div>
          )}
          <div style={row}>
            <span style={lbl}>{tr("p_code")}</span>
            <input readOnly value={code} style={{ ...input, fontFamily: 'var(--font-mono)' }} onFocus={(e) => e.target.select()} />
            <Button variant="primary" style={btn} disabled={!code} onClick={() => copy(code)}>{tr("p_copy")}</Button>
            {/* A code that leaked: a new token, and every earlier code stops working. */}
            <Button variant="dangerSoft" style={btn} title={tr("p_new_code_earlier_ones_stop_2")}
              onClick={rotate}>{tr("p_rotate")}</Button>
          </div>
          <div style={row}>
            <span style={lbl}>{tr("p_two_way")}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!cfg.accept_push}
                onChange={(e) => save('main', { accept_push: e.target.checked })} />
              {tr("p_accept_edits_made_on_the")}
            </label>
          </div>
        </>
      )}

      {/* Other servers asking to follow this one: approve (it becomes main
          for that link) or reject. The pin is the one the asker sees. */}
      {asked.filter((r) => r.status === 'pending' && mine(r)).map((r) => (
        <div key={r.id} style={{ ...row, padding: 8, borderRadius: 8, background: 'var(--surface-2)' }}>
          <span style={{ fontSize: 'var(--fs-small, 12px)', flex: 1, minWidth: 220 }}>
            <b>{tr("p_link_request")}</b> · {r.from_name || '?'} <span style={{ color: 'var(--text-muted)' }}>({r.from_url || '?'})</span>
            {' · '}{r.by || '?'} · {r.project ? tr("p_project", r.project) : tr("p_whole_service")}
            {' · '}{tr("p_pin")} <b style={{ fontFamily: 'var(--font-mono)' }}>{r.pin}</b>
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>
            <input type="checkbox" defaultChecked={!!r.two_way} id={`ap-${r.id}`} /> {tr("p_allow_two_way")}
          </label>
          <Button variant="primary" style={btn}
            onClick={() => decide(r, 'approve', document.getElementById(`ap-${r.id}`)?.checked)}>{tr("p_approve")}</Button>
          <Button variant="dangerSoft" style={btn} onClick={() => decide(r, 'reject')}>{tr("p_reject")}</Button>
        </div>
      ))}

      {/* The way in: main's address (it asks; main approves) or main's code. */}
      {role !== 'main' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 6, borderBottom: '1px dashed var(--border-subtle)' }}>
          <div style={row}>
            <span style={lbl}>{tr("p_link_to")}</span>
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
              placeholder={tr("p_main_address_http_8025_or")}
              style={{ ...input, fontFamily: 'var(--font-mono)' }} />
          </div>
          {joinCode.trim() && (
            <div style={row}>
              <span style={lbl} />
              {!isCode && (<>
                <input value={askProj} onChange={(e) => setAskProj(e.target.value)} disabled={!!project}
                  placeholder={tr("p_project_empty_whole_service")}
                  style={{ ...input, flex: 'none', width: 220, fontFamily: 'var(--font-mono)' }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={askTwo} onChange={(e) => setAskTwo(e.target.checked)} />
                  {tr("p_two_way_2")}
                </label>
              </>)}
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={joinLive} onChange={(e) => setJoinLive(e.target.checked)} />
                {tr("p_live")}
              </label>
              <Button variant="primary" style={btn} disabled={running} onClick={isCode ? join : ask}>
                {isCode ? tr("p_join") : tr("p_ask")}
              </Button>
            </div>
          )}
          {pending.filter(mine).map((p) => (
            <div key={p.id} style={{ ...row, fontSize: 'var(--fs-small, 12px)' }}>
              <span style={lbl} />
              <span style={{ flex: 1 }}>
                {p.url} · {p.project || tr("p_whole_service")} · <b>{STATUS[p.status] || p.status}</b>
                {p.status === 'pending' && <> · {tr("p_pin")} <b style={{ fontFamily: 'var(--font-mono)' }}>{p.pin}</b></>}
                {p.error ? ` — ${p.error}` : ''}
              </span>
              <Button variant="secondary" style={btn} onClick={() => forget(p)}>
                {p.status === 'pending' ? tr("p_cancel") : tr("p_dismiss")}
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
            <span style={lbl}>{tr("p_direction")}</span>
            <select value={form.two_way ? 'two' : 'one'} style={sel}
              onChange={(e) => setForm((f) => ({ ...f, two_way: e.target.value === 'two' }))}>
              <option value="one">{tr("p_main_here_mirror")}</option>
              <option value="two">{tr("p_two_way_2")}</option>
            </select>
            {!form.two_way && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.read_only}
                  onChange={(e) => setForm((f) => ({ ...f, read_only: e.target.checked }))} />
                {tr("p_lock_read_only_recommended")}
              </label>
            )}
          </div>
          {/* None ticked = every project, as before. Main's and this server's
              are both offered: two-way sends a project made here too. */}
          {choices && !project && (
            <div style={{ ...row, alignItems: 'flex-start' }}>
              <span style={lbl}>{tr("p_projects")}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', flex: 1 }}>
                {[...new Set([...(choices.main || []), ...(form.two_way ? choices.local || [] : [])])].sort().map((p) => (
                  <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.projects.includes(p)}
                      onChange={(e) => setForm((f) => ({ ...f, projects: e.target.checked
                        ? [...f.projects, p] : f.projects.filter((x) => x !== p) }))} />
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{p}</span>
                    {!(choices.main || []).includes(p) && <span style={{ color: 'var(--text-muted)' }}>{tr("p_here_only")}</span>}
                  </label>
                ))}
                <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', flexBasis: '100%' }}>
                  {choices.error || (form.projects.length
                    ? tr("p_only_these", form.projects.length)
                    : tr("p_none_ticked_every_project"))}
                </span>
              </div>
            </div>
          )}
          <div style={row}>
            <span style={lbl}>{tr("p_auto")}</span>
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
              <option value="live">{tr("p_live_within_seconds")}</option>
              <option value={0}>{tr("p_manual_only")}</option>
              <option value={1}>{tr("p_every_1_min")}</option>
              <option value={5}>{tr("p_every_5_min")}</option>
              <option value={15}>{tr("p_every_15_min")}</option>
              <option value={60}>{tr("p_hourly")}</option>
            </select>
            <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
              {tr("p_takes_effect_on_save")}
            </span>
          </div>
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>
            {form.two_way
              ? tr("p_edits_on_either_side_reach")
              : tr("p_a_sync_overwrites_this_server")}
          </div>
          <div style={row}>
            <span style={lbl} />
            <Button variant="secondary" style={btn} onClick={() => save('sub')}>{tr("p_save_settings")}</Button>
            <Button variant="primary" style={btn} disabled={running} onClick={runNow}>
              {running ? tr("p_syncing") : tr("p_sync_now")}
            </Button>
          </div>
          <div style={{ ...row, paddingTop: 4, borderTop: '1px dashed var(--border-subtle)' }}>
            <span style={lbl}>{tr("p_grants")}</span>
            <Button variant="secondary" style={btn} onClick={() => loadGrants(false)}>
              {tr("p_check_main")}
            </Button>
            {grants && grants.matched.length > 0 && (
              <Button variant="primary" style={btn} onClick={() => loadGrants(true)}>
                {tr("p_apply_here")}
              </Button>
            )}
          </div>
          {grants && (
            <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)',
              background: 'var(--surface-2)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {grants.matched.length === 0 && grants.skipped.length === 0 && <span>{tr("p_no_grants_on_main")}</span>}
              {grants.matched.map((m, i) => (
                <span key={'m' + i}>
                  ✓ {m.local_user} · {m.project || tr("p_whole_service")}
                  {m.is_admin ? tr("p_admin") : ''}
                  {m.already ? tr("p_already") : ''}
                  {m.matched_by === 'email' ? tr("p_matched_by_email") : ''}
                  {m.email_differs ? tr("p_email_differs") : ''}
                </span>
              ))}
              {grants.skipped.map((s2, i) => (
                <span key={'s' + i} style={{ opacity: 0.75 }}>
                  – {s2.username} · {tr("p_no_local_account_skipped")}
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
