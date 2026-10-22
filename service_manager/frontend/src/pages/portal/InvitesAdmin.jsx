import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Row, Pill, Field, FieldActions, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/**
 * InvitesAdmin — admin invite-code manager (in the Account screen). One place to
 * mint, list, extend and revoke every code. Two kinds:
 *   project — grants a service / single project on redeem.
 *   group   — joins the redeemer to a group, inheriting that group's project grants.
 * The code may be auto-generated or admin-chosen (8–64 chars). Expiry 1–365 days.
 */
const input = fieldInput

export default function InvitesAdmin({ services, onChanged }) {
  const { lang } = useLang()
  const [codes, setCodes] = useState([])
  const [groups, setGroups] = useState([])
  const [projCache, setProjCache] = useState({})
  const [f, setF] = useState({ kind: 'project', service: '', project: '', group_id: '', days: 7, code: '', max_uses: 0, count: 1, no_verify: false })
  const setF1 = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function load() {
    try {
      const [c, g] = await Promise.all([launcher.get('/admin/invite-codes'), launcher.get('/admin/groups')])
      setCodes(c.data); setGroups(g.data)
    } catch (e) { notify(e?.response?.data?.detail || 'load failed', 'bad') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) notify(ok(r), 'ok'); await load(); onChanged?.() } catch (e) { notify(e?.response?.data?.detail || tr("p_failed"), 'bad') } }

  async function pickSvc(svc) {
    setF((s) => ({ ...s, service: svc, project: '' }))
    if (svc && !projCache[svc]) {
      try { const r = await launcher.get(`/services/${svc}/projects`); setProjCache((c) => ({ ...c, [svc]: r.data })) }
      catch { setProjCache((c) => ({ ...c, [svc]: [] })) }
    }
  }

  function create() {
    const count = Math.max(1, Math.min(100, Number(f.count) || 1))
    const body = { kind: f.kind, days: Number(f.days) || 7, code: f.code.trim() || undefined,
      max_uses: Math.max(0, Number(f.max_uses) || 0), count, no_verify: !!f.no_verify }
    if (f.kind === 'project') { body.service = f.service; body.project = f.project }
    else body.group_id = Number(f.group_id)
    if (f.kind === 'project' ? !f.service : !f.group_id) { notify(tr("p_pick_a_target"), 'bad'); return }
    run(launcher.post('/admin/invite-codes', body), (r) => {
      setF((s) => ({ ...s, code: '' }))
      const codes = (r.data.codes || []).map((c) => c.code)
      return codes.length > 1 ? tr("p_created", codes.length, codes.join(', '))
        : tr("p_code_2", codes[0] || r.data.code)
    })
  }
  const extend = (c) => { const d = window.prompt(tr("p_extend_by_days_1_365"), '7'); if (d) run(launcher.put(`/admin/invite-codes/${c.id}`, { days: Number(d) }), () => tr("p_extended")) }
  const pruneExpired = () => run(launcher.post('/admin/invite-codes/prune-expired'), (r) => tr("p_expired_codes_deleted", r.data.deleted))
  const del = (c) => { if (window.confirm(tr("p_delete_code", c.code))) run(launcher.delete(`/admin/invite-codes/${c.id}`), () => tr("p_deleted")) }
  const copy = (code) => { try { navigator.clipboard.writeText(code) } catch { /* ignore */ } notify(tr("p_copied_2", code), 'ok') }
  const fmt = (iso) => { try { return new Date(iso).toLocaleDateString() } catch { return iso } }

  return (
    <div>
      {/* create — one aligned control per row (label column + input column) */}
      <Panel title={tr("p_new_code")}>
        <Field label={tr("p_kind")}>
          <select value={f.kind} onChange={setF1('kind')} style={{ ...input, maxWidth: 220 }}>
            <option value="project">{tr("p_project_service")}</option>
            <option value="group">{tr("p_group_2")}</option>
          </select>
        </Field>

        <Field label={tr("p_target")}>
          {f.kind === 'project' ? (
            <>
              <select value={f.service} onChange={(e) => pickSvc(e.target.value)} style={{ ...input, maxWidth: 150 }}>
                <option value="">{tr("p_service_3")}</option>
                {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <select value={f.project} onChange={setF1('project')} style={{ ...input, maxWidth: 150 }} disabled={!f.service}>
                <option value="">{tr("p_all")}</option>
                {(projCache[f.service] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
              </select>
            </>
          ) : (
            <select value={f.group_id} onChange={setF1('group_id')} style={{ ...input, maxWidth: 200 }}>
              <option value="">{tr("p_group_3")}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </Field>

        <Field label={tr("p_custom_code")}>
          <input value={f.code} onChange={setF1('code')} disabled={Number(f.count) > 1}
            placeholder={Number(f.count) > 1 ? tr("p_auto_for_bulk") : tr("p_optional_8_chars")}
            style={{ ...input, maxWidth: 260, opacity: Number(f.count) > 1 ? 0.5 : 1 }} />
        </Field>

        <Field label={tr("p_valid_for")}>
          <input type="number" min={1} max={365} value={f.days} onChange={setF1('days')} style={{ ...input, width: 80 }} />
          <span style={fieldMuted}>{tr("p_days")}</span>
        </Field>

        <Field label={tr("p_max_uses")}>
          <input type="number" min={0} max={100000} value={f.max_uses} onChange={setF1('max_uses')} style={{ ...input, width: 80 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={Number(f.max_uses) === 1} onChange={(e) => setF((s) => ({ ...s, max_uses: e.target.checked ? 1 : 0 }))} />
            {tr("p_single_use")}
          </label>
          <span style={fieldMuted}>{tr("p_0_unlimited")}</span>
        </Field>

        <Field label={tr("p_how_many")}>
          <input type="number" min={1} max={100} value={f.count} onChange={setF1('count')} style={{ ...input, width: 80 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!f.no_verify} onChange={(e) => setF((s) => ({ ...s, no_verify: e.target.checked }))} />
            {tr("p_skip_email_verify")}
          </label>
        </Field>

        <FieldActions>
          <Button variant="primary" onClick={create}>{tr("p_generate")}</Button>
        </FieldActions>
      </Panel>

      {/* list — one ROW per issued code, so ten codes read as a list and not as
          ten boxes. The code, what it grants, its state, what you can do to it. */}
      <Panel bare title={tr("p_issued_codes")} hint={String(codes.length)}
        right={codes.some((c) => c.status === 'expired')
          ? <Button variant="dangerSoft" onClick={pruneExpired}>{tr("p_delete_expired")}</Button>
          : null}>
        {codes.length === 0 && <Row className="empty">{tr("p_no_codes")}</Row>}
        {codes.map((c) => (
          <Row key={c.id}>
            <span className="mono">{c.code}</span>
            <Pill>{c.kind === 'group' ? `${tr("p_group_2")}: ${c.group}` : `${c.service}${c.project ? '/' + c.project : ''}`}</Pill>
            {c.no_verify && <Pill tone="warn">{tr("p_no_verify")}</Pill>}
            <Pill tone={c.status === 'active' ? 'ok' : 'bad'}>{c.status}</Pill>
            <span className="sub">
              {c.uses}/{c.max_uses ? c.max_uses : '∞'}{tr("p_x")}{c.max_uses === 1 ? tr("p_single") : ''} · ~{fmt(c.expires_at)}
            </span>
            <span className="sp" />
            <Button variant="secondary" onClick={() => copy(c.code)}>{tr("p_copy")}</Button>
            <Button variant="secondary" onClick={() => extend(c)}>{tr("p_extend")}</Button>
            <Button variant="dangerSoft" onClick={() => del(c)}>{tr("p_remove_2")}</Button>
          </Row>
        ))}
      </Panel>
    </div>
  )
}
