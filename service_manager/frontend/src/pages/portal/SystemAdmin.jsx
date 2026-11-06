import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

const input = { ...fieldInput, width: 100 }

// Manager-only: the tokens Claude and Codex use at /mcp. A new one is shown once,
// here, and cannot be read back; only its hash is kept.
function McpTokens() {
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState({ name: '', can_write: false, days: 180, scope: '' })
  const [made, setMade] = useState(null)
  const [sure, setSure] = useState(null)
  const fail = (e) => notify(e?.response?.data?.detail || String(e), 'bad')
  const load = () => launcher.get('/admin/mcp-tokens').then((r) => setRows(r.data)).catch(fail)
  useEffect(() => { load() }, [])

  const issue = async () => {
    try {
      const r = await launcher.post('/admin/mcp-tokens', { ...form, days: Number(form.days) })
      setMade({ name: form.name.trim(), token: r.data.token })
      setForm({ name: '', can_write: false, days: 180, scope: '' })
      load()
    } catch (e) { fail(e) }
  }
  const revoke = async (id) => {
    setSure(null)
    try { await launcher.delete(`/admin/mcp-tokens/${id}`); load() } catch (e) { fail(e) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(made.token); notify(tr('p_mcp_copied'), 'ok') }
    catch { notify(tr('p_mcp_copy_failed'), 'bad') }
  }
  const state = (t) => (t.revoked ? <Pill tone="bad">{tr('p_mcp_revoked')}</Pill>
    : t.expired ? <Pill tone="warn">{tr('p_mcp_expired')}</Pill> : <Pill tone="ok">{tr('p_mcp_active')}</Pill>)
  // Stored in UTC without saying so.
  const day = (iso) => (iso ? new Date(`${iso}Z`).toLocaleString('sv').slice(0, 16) : tr('p_mcp_never'))

  return (
    <Panel title={tr('p_mcp_tokens')} right={<Button variant="secondary" onClick={load}>{tr('p_refresh')}</Button>}>
      <Field label={tr('p_what_this_is')}>{tr('p_mcp_hint')}</Field>
      <Field label={tr('p_mcp_new')}>
        <input style={{ ...fieldInput, width: 140 }} placeholder={tr('p_mcp_name')} aria-label={tr('p_mcp_name')} value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={{ ...fieldInput, width: 240 }} placeholder={tr('p_mcp_scope')} aria-label={tr('p_mcp_scope')} value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value })} />
        <input style={input} type="number" min="1" max="3650" aria-label={tr('p_mcp_days')} value={form.days}
          onChange={(e) => setForm({ ...form, days: e.target.value })} />
        <span style={fieldMuted}>{tr('p_mcp_days')}</span>
        <label style={fieldMuted}>
          <input type="checkbox" checked={form.can_write} onChange={(e) => setForm({ ...form, can_write: e.target.checked })} /> {tr('p_mcp_write')}
        </label>
        <Button variant="primary" disabled={!form.name.trim()} onClick={issue}>{tr('p_mcp_issue')}</Button>
      </Field>
      {made && (
        <Field label={made.name}>
          <input style={{ ...fieldInput, flex: 1, minWidth: 200, fontFamily: 'var(--font-mono)' }} readOnly value={made.token}
            aria-label={tr('p_mcp_tokens')} onFocus={(e) => e.target.select()} />
          <Button variant="primary" onClick={copy}>{tr('p_mcp_copy')}</Button>
          <Button variant="secondary" onClick={() => setMade(null)}>{tr('p_mcp_done')}</Button>
          <span style={fieldMuted}>{tr('p_mcp_once')}</span>
        </Field>
      )}
      {(rows || []).map((t) => (
        <Field key={t.id} label={t.name}>
          {state(t)}
          <Pill>{t.can_write ? tr('p_mcp_write') : tr('p_mcp_read')}</Pill>
          <span style={fieldMuted}>{t.scope || tr('p_mcp_all')} · {t.owner} · {tr('p_mcp_until')} {t.expires_at.slice(0, 10)} · {tr('p_mcp_used')} {day(t.last_used_at)}</span>
          {!t.revoked && (sure === t.id
            ? <>
                <Button variant="primary" onClick={() => revoke(t.id)}>{tr('p_mcp_revoke_confirm')}</Button>
                <Button variant="secondary" onClick={() => setSure(null)}>{tr('p_cancel')}</Button>
              </>
            : <Button variant="secondary" onClick={() => setSure(t.id)}>{tr('p_mcp_revoke')}</Button>)}
        </Field>
      ))}
    </Panel>
  )
}

// Manager-only: the managed-service port window. Widening it lets more sessions
// run at once (each launched service claims one loopback port from this range).
export default function SystemAdmin() {
  const { lang } = useLang()
  const [d, setD] = useState(null)          // server status
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [msg, setMsg] = useState('')
  const flash = (m, tone) => { setMsg(m); notify(m, tone); setTimeout(() => setMsg(''), 3000) }

  const load = () => launcher.get('/admin/system/ports').then((r) => {
    setD(r.data); setStart(String(r.data.start)); setEnd(String(r.data.end))
  }).catch((e) => flash(e?.response?.data?.detail || String(e), 'bad'))
  useEffect(() => { load() }, [])

  const save = async () => {
    try {
      const r = await launcher.put('/admin/system/ports', { start: Number(start), end: Number(end) })
      setD(r.data); flash(tr("p_port_range_saved"), 'ok')
    } catch (e) { flash(e?.response?.data?.detail || String(e), 'bad') }
  }

  const [restarting, setRestarting] = useState(null)   // names being restarted
  const [sure, setSure] = useState(false)              // two-step: no window.confirm in the portal frame
  const restart = async () => {
    setSure(false)
    try {
      const r = await launcher.post('/admin/system/restart')
      setRestarting(r.data.restarting)
      flash(tr('p_restart_started', r.data.restarting.length), 'ok')
    } catch (e) { flash(e?.response?.data?.detail || String(e), 'bad') }
  }

  if (!d) return <div className="set-msg">{msg || '…'}</div>

  const slots = (Number(end) - Number(start) + 1)
  const dirty = Number(start) !== d.start || Number(end) !== d.end
  const bad = !(start && end) || Number(end) < Number(start) || slots < 1

  return (
    <>
      <Panel title={tr("p_service_port_pool")} hint={msg}
        right={<Button variant="secondary" onClick={load}>{tr("p_refresh")}</Button>}>
        <Field label={tr("p_in_use")}>
          <Pill>{tr("p_total")} {d.total}</Pill>
          <Pill tone="warn">{tr("p_in_use_2")} {d.in_use}</Pill>
          <Pill tone={d.free ? 'ok' : 'bad'}>{tr("p_free")} {d.free}</Pill>
        </Field>

        <Field label={tr("p_range")}>
          <input style={input} type="number" value={start} onChange={(e) => setStart(e.target.value)} />
          <span style={fieldMuted}>–</span>
          <input style={input} type="number" value={end} onChange={(e) => setEnd(e.target.value)} />
          <span style={{ color: bad ? 'var(--danger-text)' : 'var(--text-secondary)' }}>
            = {Number.isFinite(slots) ? slots : '?'} {tr("p_slots")}
          </span>
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty || bad} onClick={save}>{tr("p_save")}</Button>
          <span style={fieldMuted}>
            {tr("p_default_allowed_up_to_slots", d.default_start, d.default_end, d.min, d.max, d.max_slots)}
          </span>
        </FieldActions>

        <Field label={tr("p_what_this_is")}>
          {tr("p_each_running_session_claims_one", d.portal_port)}
        </Field>
      </Panel>

      <McpTokens />

      <Panel title={tr('p_restart_all')}>
        <Field label={tr('p_what_this_is')}>{tr('p_restart_all_hint')}</Field>
        <FieldActions>
          {sure
            ? <>
                <Button variant="primary" onClick={restart}>{tr('p_restart_confirm')}</Button>
                <Button variant="secondary" onClick={() => setSure(false)}>{tr('p_cancel')}</Button>
              </>
            : <Button variant="secondary" onClick={() => setSure(true)}>{tr('p_restart_all')}</Button>}
          {restarting && <span style={fieldMuted}>{restarting.join(', ') || tr('p_restart_none')}</span>}
        </FieldActions>
      </Panel>
    </>
  )
}
