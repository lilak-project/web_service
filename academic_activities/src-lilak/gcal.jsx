import './strings.js'
import { useCallback, useEffect, useState } from 'react'
import { PORTAL_BASE, authHeaders } from 'lilak-ui/racklist'
import './gcal.css'
import { tr } from 'lilak-ui'

/**
 * 구글 캘린더 — step 1, read only (backend/gcal.py). Connect, say which
 * calendar is which, choose calendars to show read-only on the calendar tab,
 * and see how the activities and the two calendars line up before anything
 * is ever synced. Nothing here writes to Google, or to the activities.
 */
const api = async (p, o = {}) => {
  const r = await fetch(`${PORTAL_BASE}/api/gcal${p}`, {
    ...o, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(o.headers || {}) },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.detail || `${r.status}`)
  return body
}
const SIDE = { etc: tr('aa_gc_side_etc'), main: tr('aa_gc_side_main') }
const PART = { main: tr('aa_gc_part_main'), submit: tr('aa_gc_part_submit') }
const days = (a, b) => (a === b ? a : `${a} ~ ${b}`)

export function GcalPanel() {
  const [st, setSt] = useState(null)
  const [cals, setCals] = useState(null)
  const [form, setForm] = useState({ client_id: '', client_secret: '', redirect_uri: '' })
  const [pick, setPick] = useState({ etc: '', main: '' })
  const [over, setOver] = useState([])
  const [rep, setRep] = useState(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const say = (e) => setMsg(String(e?.message || e))

  const load = useCallback(async () => {
    try {
      const s = await api('/status')
      setSt(s)
      setForm((f) => ({ ...f, client_id: s.client_id || f.client_id,
        redirect_uri: s.redirect_uri || `${window.location.origin}${PORTAL_BASE}/api/gcal/callback` }))
      setPick({ etc: s.calendars?.etc || '', main: s.calendars?.main || '' })
      setOver(s.overlays || [])
      if (s.connected) setCals(await api('/calendars'))
    } catch (e) { say(e) }
  }, [])
  useEffect(() => { load() }, [load])
  // The window Google sends back says when it is done.
  useEffect(() => {
    const on = (e) => { if (e.data === 'gcal:done') load() }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [load])

  const run = async (what, f) => {
    setBusy(what); setMsg('')
    try { await f() } catch (e) { say(e) } finally { setBusy('') }
  }
  const saveClient = () => run('client', async () => { setSt(await api('/config', { method: 'PUT', body: JSON.stringify(form) })); setMsg(tr("aa_saved")) })
  const connect = () => run('auth', async () => { window.open((await api('/auth')).url, 'gcal', 'width=520,height=680') })
  const saveCals = () => run('cals', async () => {
    setSt(await api('/config', { method: 'PUT', body: JSON.stringify({ calendars: pick, overlays: over }) }))
    setMsg(tr("aa_gc_saved"))
  })
  const preview = () => run('preview', async () => setRep(await api('/preview')))
  const toggleOver = (c) => setOver((o) => (o.some((x) => x.id === c.id) ? o.filter((x) => x.id !== c.id)
    : [...o, { id: c.id, name: c.name, color: c.color }]))

  if (!st) return <div className="gc"><p className="rl-msg">{msg || tr("aa_loading")}</p></div>
  return (
    <div className="gc">
      <h2>{tr("aa_gc_title")}</h2>
      <p className="rl-hint">{tr("aa_gc_stage1")}</p>

      <h3>{tr("aa_gc_step1")}</h3>
      <div className="gc-grid">
        <label>{tr("aa_gc_client_id")}</label>
        <input className="rl-in" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
        <label>{tr("aa_gc_client_secret")}</label>
        <input className="rl-in" type="password" placeholder={st.configured ? tr("aa_gc_secret_saved") : ''}
          value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
        <label>{tr("aa_gc_redirect")}</label>
        <input className="rl-in rl-mono" value={form.redirect_uri} onChange={(e) => setForm({ ...form, redirect_uri: e.target.value })} />
      </div>
      <p className="rl-hint">{tr("aa_gc_redirect_hint")}</p>
      <button type="button" className="rl-btn" disabled={!!busy} onClick={saveClient}>{tr("aa_save")}</button>

      <h3>{tr("aa_gc_step2")}</h3>
      <p>{st.connected ? tr("aa_gc_connected_ro") : tr("aa_gc_not_connected")}</p>
      <button type="button" className="rl-btn" disabled={!st.configured || !!busy} onClick={connect}>
        {st.connected ? tr("aa_gc_reconnect") : tr("aa_gc_connect_ro")}</button>

      {st.connected && cals && (
        <>
          <h3>{tr("aa_gc_step3")}</h3>
          <div className="gc-grid">
            {Object.entries(SIDE).map(([k, l]) => (
              <span key={k} style={{ display: 'contents' }}>
                <label>{l} {k === 'etc' ? tr("aa_gc_for_other") : tr("aa_gc_for_rest")}</label>
                <select className="rl-in" value={pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.value })}>
                  <option value="">—</option>
                  {cals.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? tr("aa_gc_default") : ''}</option>)}
                </select>
              </span>
            ))}
          </div>
          <p className="rl-hint">{tr("aa_gc_overlay")}</p>
          <div className="gc-over">
            {cals.filter((c) => c.id !== pick.etc && c.id !== pick.main).map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={over.some((x) => x.id === c.id)} onChange={() => toggleOver(c)} />
                <i style={{ background: c.color }} />{c.name}
              </label>
            ))}
          </div>
          <button type="button" className="rl-btn" disabled={!!busy} onClick={saveCals}>{tr("aa_gc_save_calendars")}</button>

          <h3>{tr("aa_gc_step4")}</h3>
          <button type="button" className="rl-btn" disabled={!st.calendars?.etc || !st.calendars?.main || !!busy} onClick={preview}>
            {busy === 'preview' ? tr("aa_loading") : tr("aa_gc_compare")}</button>
          {rep && <Report rep={rep} />}

          <h3>{tr("aa_gc_step5", cals.find((c) => c.id === st.calendars?.etc)?.name || tr("aa_gc_side_etc_word"))}</h3>
          {!st.can_write ? (
            <>
              <p className="rl-hint">{tr("aa_gc_need_write")}</p>
              <button type="button" className="rl-btn" disabled={!!busy} onClick={connect}>{tr("aa_gc_reconnect_write")}</button>
            </>
          ) : (
            <>
              <SyncSide side="etc" />
              <h3>{tr("aa_gc_step6", cals.find((c) => c.id === st.calendars?.main)?.name || tr("aa_gc_side_main_word"))}</h3>
              <p className="rl-hint">{tr("aa_gc_step6_hint")}</p>
              <SyncSide side="main" />
              <h3>{tr("aa_gc_step7")}</h3>
              <Auto st={st} save={(v) => run('auto', async () => setSt(await api('/config', { method: 'PUT', body: JSON.stringify(v) })))} />
            </>
          )}
        </>
      )}
      {msg && <p className="rl-hint">{msg}</p>}
    </div>
  )
}

function Report({ rep }) {
  const c = rep.counts
  return (
    <div className="gc-rep">
      <p>{tr("aa_gc_counts", c.activities, c.parts, c.events, c.repeating)}</p>
      <Section title={tr("aa_gc_same", rep.linked.length)} rows={rep.linked} pair />
      <Section title={tr("aa_gc_unsure", rep.unsure.length)} rows={rep.unsure} pair />
      <Section title={tr("aa_gc_here_only", rep.here_only.length)} rows={rep.here_only}
        cols={[tr("aa_kind"), tr("aa_name"), tr("aa_gc_date"), tr("aa_gc_calendar")]}
        cell={(r) => [`${r.kind} · ${PART[r.part]}`, r.name, days(r.from, r.to), SIDE[r.side]]} />
      <Section title={tr("aa_gc_google_only", rep.google_only.length)} rows={rep.google_only}
        cols={[tr("aa_gc_calendar"), tr("aa_gc_title_col"), tr("aa_gc_date"), tr("aa_place")]}
        cell={(r) => [SIDE[r.side], r.title, `${days(r.from, r.to)}${r.time ? ` ${r.time}` : ''}`, r.location]} />
      <Section title={tr("aa_gc_repeating", rep.repeating.length)} rows={rep.repeating}
        cols={[tr("aa_gc_calendar"), tr("aa_gc_title_col"), tr("aa_gc_first"), tr("aa_gc_rule")]} cell={(r) => [SIDE[r.side], r.title, r.start, r.rule]} />
    </div>
  )
}

function Section({ title, rows, pair, cols, cell }) {
  const [open, setOpen] = useState(rows.length > 0 && rows.length <= 40)
  return (
    <section>
      <h4><button type="button" className="rl-lnk" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {title}</button></h4>
      {open && rows.length > 0 && (
        <table>
          <thead><tr>{(pair ? [tr("aa_gc_here"), tr("aa_gc_date"), tr("aa_gc_google"), tr("aa_gc_date"), tr("aa_gc_diff"), tr("aa_gc_score")] : cols).map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {(pair ? [
                  `${r.name} (${r.kind} · ${PART[r.part]})`, days(r.from, r.to),
                  `${r.event.title} [${SIDE[r.event.side]}]`, `${days(r.event.from, r.event.to)}${r.event.time ? ` ${r.event.time}` : ''}`,
                  r.diffs.join(', '), r.score,
                ] : cell(r)).map((v, j) => <td key={j}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const EVERY = [[0, tr("aa_gc_off")], [1, tr("aa_gc_1m")], [5, tr("aa_gc_5m")], [15, tr("aa_gc_15m")], [30, tr("aa_gc_30m")], [60, tr("aa_gc_1h")]]
const at = (t) => (t ? new Date(typeof t === 'number' ? t * 1000 : t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '—')

/** The timer (backend ticker): how often, and how its last round went. It
 *  applies a plan by itself unless the plan deletes or moves many at once;
 *  then it holds and says so, for a person to look at in 5. */
function Auto({ st, save }) {
  return (
    <div className="gc-sync">
      <label className="gc-edit">
        <input type="checkbox" checked={!!st.onEdit} onChange={(e) => save({ onEdit: e.target.checked })} />{tr("aa_gc_push_on_edit")}</label>
      <label className="gc-edit">{tr("aa_gc_full_sync", ' ')}<select className="rl-in gc-every" value={st.auto || 0} onChange={(e) => save({ auto: Number(e.target.value) })}>
          {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <p className="rl-hint">{tr("aa_gc_full_sync_hint")}</p>
      {Object.entries(st.sync || {}).map(([side, s]) => (
        <div key={side}>
          <p>{tr("aa_gc_status", side === 'etc' ? tr('aa_g_other') : tr('aa_kind_event'), at(s.lastRun), at(s.autoAt), s.pushAt ? tr("aa_gc_last_push", at(s.pushAt)) : '')}</p>
          {s.held && <p className="rl-warn">{tr("aa_gc_waiting", s.held.why, Object.entries(s.held.counts).map(([k, n]) => `${OP[k] || k} ${n}`).join(' · '))}</p>}
          {s.error && <p className="rl-warn">{tr("aa_gc_auto_failed", s.error)}</p>}
        </div>
      ))}
    </div>
  )
}

const OP = {
  import: tr("aa_gc_op_import"), create_google: tr("aa_gc_op_create"), update_google: tr("aa_gc_op_update_goog"),
  update_here: tr("aa_gc_op_update_here"), delete_google: tr("aa_gc_op_delete_goog"), delete_here: tr("aa_gc_op_delete_here"),
  unlink: tr("aa_gc_op_unlink"),  relink: tr("aa_gc_op_relink"),
}

/** One calendar's sync: what it would do (the plan), then — asked twice — doing it. */
function SyncSide({ side }) {
  const [plan, setPlan] = useState(null)
  const [log, setLog] = useState(null)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const run = async (what, f) => { setBusy(what); setMsg(''); try { await f() } catch (e) { setMsg(String(e.message || e)) } finally { setBusy('') } }
  const look = () => run('plan', async () => { setLog(null); setSure(false); setPlan(await api('/plan', { method: 'POST', body: JSON.stringify({ side }) })) })
  const go = () => run('apply', async () => {
    const r = await api('/apply', { method: 'POST', body: JSON.stringify({ side }) })
    setLog(r.log); setPlan(null); setSure(false)
  })
  const groups = plan ? Object.keys(OP).filter((k) => plan.counts[k]) : []
  return (
    <div className="gc-sync">
      <p className="rl-hint">{tr("aa_gc_plan_hint")}</p>
      <button type="button" className="rl-btn" disabled={!!busy} onClick={look}>{busy === 'plan' ? tr("aa_gc_planning") : tr("aa_gc_show_plan")}</button>
      {plan && (
        <>
          <p>{groups.length ? groups.map((k) => `${OP[k]} ${plan.counts[k]}`).join(' · ') : tr("aa_gc_nothing")}</p>
          {groups.map((k) => (
            <details key={k} open={plan.counts[k] <= 30}>
              <summary>{OP[k]} ({plan.counts[k]})</summary>
              <ul>{plan.ops.filter((o) => o.op === k).map((o, i) => (
                <li key={i}>{o.when} {o.name}{o.rule ? ` ↻ ${o.rule}` : ''}{o.orig ? tr("aa_gc_occurrence", o.orig) : ''}{o.conflict ? tr("aa_gc_both_changed") : ''}</li>
              ))}</ul>
            </details>
          ))}
          {groups.length > 0 && (sure ? (
            <span className="gc-sure">{tr("aa_gc_really_apply", ' ')}<button type="button" className="rl-btn rl-danger" disabled={!!busy} onClick={go}>{busy === 'apply' ? tr("aa_gc_applying") : tr("aa_gc_apply")}</button>{' '}
              <button type="button" className="rl-btn" onClick={() => setSure(false)}>{tr("aa_cancel")}</button>
            </span>
          ) : <button type="button" className="rl-btn" onClick={() => setSure(true)}>{tr("aa_gc_apply_dots")}</button>)}
        </>
      )}
      {log && (
        <details open>
          <summary>{tr("aa_gc_result", log.length)}</summary>
          <ul>{log.map((l, i) => <li key={i} className={l.startsWith('실패') ? 'rl-warn' : ''}>{l}</li>)}</ul>
        </details>
      )}
      {msg && <p className="rl-hint rl-warn">{msg}</p>}
    </div>
  )
}
