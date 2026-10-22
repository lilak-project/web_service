import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

const input = { ...fieldInput, width: 100 }

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
    </>
  )
}
