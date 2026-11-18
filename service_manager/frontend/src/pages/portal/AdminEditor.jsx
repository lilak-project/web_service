import { useEffect, useState } from 'react'
import { tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { Row, Pill, Field, fieldChip, fieldInput, fieldMuted, FIELD_CARD_CLASS } from './Field'

/**
 * AdminEditor — who administers a scope, and adding or taking them off.
 * `scopes`: [{ svc, proj }] — one (a service: proj '', or one project) or many (a
 * share set's projects, all changed together). Managers only (the API is theirs) —
 * except a set (`setKey`): its own endpoints, open to whoever administers every project
 * of it, so a project admin edits their set too. Where the person may not, it draws nothing.
 * Taking someone off drops the admin flag and keeps their way in, as Accounts does.
 * Admins through a user group show the group and are changed in User groups.
 */
// Every editor on the page asks once; a change asks again.
let cache = null
const users = (fresh) => (fresh || !cache ? (cache = launcher.get('/admin/users').then((r) => r.data || [])) : cache)
  .catch((e) => { cache = null; throw e })

export default function AdminEditor({ scopes, setKey, boxed = false }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(false)
  const load = (fresh) => (setKey
    ? launcher.get('/share-sets/admins', { params: { set: setKey } }).then((r) => r.data || [])
    : users(fresh)
  ).then(setList).catch((e) => (e?.response?.status === 403 ? setDenied(true) : setErr(errText(e))))
  useEffect(() => { load(false) }, [])

  const same = (p, s) => p.service === s.svc && (p.project || '') === (s.proj || '')
  // Per user: how many of the scopes they administer directly, and through which groups.
  const rows = (list || []).filter((u) => u.is_active !== false && u.role !== 'manager').map((u) => ({
    u,
    n: scopes.filter((s) => (u.admin_scopes || []).some((p) => same(p, s))).length,
    via: [...new Set((u.inherited_permissions || []).filter((p) => scopes.some((s) => same(p, s))).map((p) => p.group))],
  }))
  const admins = rows.filter((r) => r.n > 0)
  const managers = (list || []).filter((u) => u.role === 'manager').map((u) => u.username)
  const words = q.trim().toLowerCase()
  const candidates = words ? rows.filter((r) => r.n < scopes.length
    && `${r.u.username} ${r.u.display_name || ''} ${r.u.email || ''}`.toLowerCase().includes(words)).slice(0, 8) : []

  const set = async (u, admin) => {
    setBusy(true); setErr('')
    try {
      for (const s of scopes) {
        const has = (u.admin_scopes || []).some((p) => same(p, s))
        if (setKey) break
        if (has !== admin) await launcher.post('/admin/permissions', { user_id: u.id, service: s.svc, project: s.proj || '', admin })
      }
      if (setKey) await launcher.post('/share-sets/admins', { set: setKey, user_id: u.id, admin })
      setQ('')
      await load(true)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  if (denied) return null
  if (!list) return <Row className="sub">{err || '…'}</Row>
  // The RACK field grid, like every other panel: a label column, then the value.
  return (
    <div className={FIELD_CARD_CLASS}>
      {/* One line per person: the label column names the first only. */}
      {(() => {
        const lines = [
          ...admins.map(({ u, n }) => (
            <>
              <span>{u.username}</span>
              {u.display_name && u.display_name !== u.username && <span style={fieldMuted}>{u.display_name}</span>}
              {scopes.length > 1 && <span style={fieldMuted}>{n}/{scopes.length}</span>}
              <span className="sp" style={{ flex: 1 }} />
              <button type="button" disabled={busy} title={tr('p_adm_remove')} onClick={() => set(u, false)}>{tr('p_adm_remove_short')}</button>
            </>
          )),
          ...rows.filter((r) => r.via.length).map(({ u, via }) => (
            <><span>{u.username}</span><span style={fieldMuted}>{tr('p_adm_via', via.join(', '))}</span></>
          )),
          ...managers.map((m) => <><span>{m}</span><span style={fieldMuted}>{tr('p_adm_manager_all')}</span></>),
        ]
        return (lines.length ? lines : [<span style={fieldMuted}>—</span>]).map((line, i) => (
          <Field key={i} label={i === 0 ? tr('p_adm_title') : ''}>{line}</Field>
        ))
      })()}
      <Field label={tr('p_adm_add_label')}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('p_adm_add')} aria-label={tr('p_adm_add')}
          // Enter adds the one person the search narrowed to.
          onKeyDown={(e) => { if (e.key === 'Enter' && candidates.length === 1 && !busy) { e.preventDefault(); set(candidates[0].u, true) } }}
          style={{ ...fieldInput, flex: '1 1 220px', maxWidth: 320 }} />
        {/* Buttons, not a <select>: in the portal frame a native menu swallowed the next click. */}
        {candidates.map(({ u, n }) => (
          <button key={u.id} type="button" disabled={busy} onClick={() => set(u, true)}>
            + {u.username}{n > 0 ? ` (${n}/${scopes.length})` : ''}
          </button>
        ))}
        {words && !candidates.length && <span style={fieldMuted}>{tr('p_adm_none')}</span>}
        {err && <Pill tone="bad">{err}</Pill>}
      </Field>
    </div>
  )
}
