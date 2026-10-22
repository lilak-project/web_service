import { useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Row, Pill, fieldInput, fieldMuted, fieldChip } from './Field'
import { notify } from './settingsMsg'

/**
 * GroupManagePanel — a service group's settings, in the same panels the account
 * screens are built from. The sidebar's band IS the group, so its tools do not
 * have to live in its header, and a modal for access was one layer too many.
 */
const VIS = [[0, 'portal_vis_public'], [1, 'portal_vis_private'], [2, 'portal_vis_protected'], [3, 'portal_vis_admin']]

/** Show / hide one card on the cover. The endpoint differs for a builtin, the
 *  meaning does not — and it is the one setting every band's members share, so
 *  both panels below offer it on the member row itself. */
async function setCardHidden(card, hidden, L, onChanged) {
  const builtin = !!card.builtin
  try {
    await launcher.put(builtin ? '/admin/home-builtin' : '/admin/home-service',
      builtin ? { key: card.builtin, hidden } : { name: card.name, hidden })
    const n = card.label || card.name
    notify(hidden ? tr("p_hidden_2", n) : tr("p_shown_2", n), 'ok')
    onChanged?.()
  } catch (e) { notify(errText(e, tr("p_failed")), 'bad') }
}

/** One member of a band: what it is, whether the cover shows it, and the toggle. */
function MemberRow({ card, L, onChanged }) {
  return (
    <Row>
      <Icon name={card.icon || 'circle'} size={16} color={card.color || 'var(--text-secondary)'} weight="fill" />
      <span>{card.label || card.name}</span>
      {card.hidden ? <Pill tone="warn">{tr("p_hidden")}</Pill> : <Pill tone="ok">{tr("p_shown")}</Pill>}
      <span className="sp" />
      <Button variant={card.hidden ? 'warning' : 'secondary'}
        onClick={() => setCardHidden(card, !card.hidden, L, onChanged)}>
        <Icon name={card.hidden ? 'eye' : 'eye-off'} size={15} />
        {card.hidden ? tr("p_show") : tr("p_hide")}
      </Button>
    </Row>
  )
}

export default function GroupManagePanel({ group, members = [], onChanged }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [name, setName] = useState(group.name || '')
  const [users, setUsers] = useState([])
  const [info, setInfo] = useState(null)       // { services, grants }
  const [pick, setPick] = useState('')
  const [asAdmin, setAsAdmin] = useState(false)

  useEffect(() => { setName(group.name || '') }, [group.id, group.name])

  const dirty = name.trim() !== (group.name || '')

  async function load() {
    try {
      const [u, p] = await Promise.all([
        launcher.get('/admin/users'),
        launcher.get(`/admin/service-groups/${group.id}/permissions`),
      ])
      setUsers(u.data || []); setInfo(p.data)
    } catch (e) { notify(errText(e, 'load failed'), 'bad') }
  }
  useEffect(() => { load() }, [group.id])  // eslint-disable-line react-hooks/exhaustive-deps

  async function run(p, ok) {
    try { await p; if (ok) notify(ok, 'ok'); await load(); onChanged?.() }
    catch (e) { notify(errText(e, tr("p_failed")), 'bad') }
  }
  const patch = (body, ok) => run(launcher.put(`/admin/service-groups/${group.id}`, body), ok)
  const save = () => patch({ name: name.trim() || undefined }, tr("p_group_saved_2"))
  const setVis = (v) => v && run(launcher.put(`/admin/service-groups/${group.id}/visibility`, { visibility: Number(v) }),
    tr("p_applied_to_every_member"))
  const grant = () => pick && run(launcher.post(`/admin/service-groups/${group.id}/permissions`, { user_id: Number(pick), admin: asAdmin }),
    tr("p_granted_2")).then(() => { setPick(''); setAsAdmin(false) })
  const revoke = (uid) => run(launcher.delete(`/admin/service-groups/${group.id}/permissions`, { data: { user_id: uid } }),
    tr("p_revoked"))
  function remove() {
    if (!window.confirm(tr("p_remove_group_its_cards_come", group.name))) return
    run(launcher.delete(`/admin/service-groups/${group.id}`), tr("p_group_deleted"))
  }

  const grants = info?.grants || info?.users || []

  return (
    <div className="svc-mg">
      <Panel title={tr("p_group")}>
        <Field label={tr("p_name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("p_group_name")}
            style={{ ...fieldInput, flex: 1 }} onKeyUp={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && dirty && save()} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty} onClick={save}>{tr("p_save")}</Button>
        </FieldActions>

        <Field label={tr("p_home_screen")}>
          {group.hidden ? <Pill tone="warn">{tr("p_hidden")}</Pill> : <Pill tone="ok">{tr("p_shown")}</Pill>}
          <span style={fieldMuted}>{tr("p_hiding_the_group_takes_its")}</span>
        </Field>
        <FieldActions>
          <Button variant={group.hidden ? 'warning' : 'secondary'}
            onClick={() => patch({ hidden: !group.hidden }, group.hidden ? tr("p_shown_again") : tr("p_hidden"))}>
            <Icon name={group.hidden ? 'eye' : 'eye-off'} size={15} />
            {group.hidden ? tr("p_show") : tr("p_hide")}
          </Button>
        </FieldActions>
      </Panel>

      {/* The members, with the one setting each of them has of its own. */}
      <Panel bare title={tr("p_members_2")} hint={String(members.length)}>
        {members.length === 0 && (
          <Row className="empty">{tr("p_none_yet_drag_a_card")}</Row>
        )}
        {members.map((c) => <MemberRow key={c.name} card={c} L={L} onChanged={onChanged} />)}
      </Panel>

      {/* Everything here lands on EVERY member service at once — the reason a
          group is worth making in the first place. */}
      <Panel title={tr("p_to_every_member_at_once")}
        hint={(info?.services || []).join(', ') || '—'}>
        <Field label={tr("p_visibility")}>
          <select defaultValue="" onChange={(e) => { setVis(e.target.value); e.target.value = '' }}
            style={{ ...fieldInput, maxWidth: 220 }}>
            <option value="">{tr("p_apply_to_all")}</option>
            {VIS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
          </select>
        </Field>

        <Field label={tr("p_access")} align="start">
          {grants.length === 0
            ? <span style={fieldMuted}>{tr("p_nobody_yet")}</span>
            : grants.map((g) => (
                <span key={g.user_id ?? g.id ?? g.username} style={fieldChip}>
                  {g.username}{g.admin ? ' · admin' : ''}
                  <button type="button" className="set-plain set-x" title={tr("p_revoke")}
                    onClick={() => revoke(g.user_id ?? g.id)}>✕</button>
                </span>
              ))}
        </Field>
        <FieldActions>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...fieldInput, maxWidth: 220 }}>
            <option value="">{tr("p_pick_an_account")}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.role === 'manager' ? ' · admin' : ''}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
            {tr("p_as_admin")}
          </label>
          <Button variant="primary" disabled={!pick} onClick={grant}>{tr("p_grant")}</Button>
        </FieldActions>
      </Panel>

      <Panel danger title={tr("p_cannot_be_undone")}>
        <Field label={tr("p_delete_group_2")}>
          {tr("p_only_the_group_goes_the")}
        </Field>
        <FieldActions>
          <Button variant="dangerSoft" onClick={remove}><Icon name="trash" size={15} /> {tr("p_delete_group_2")}</Button>
        </FieldActions>
      </Panel>
    </div>
  )
}

/**
 * FixedGroupPanel — the manage screen for the two bands the portal keeps for
 * itself, System and No group. Neither is a stored group, so it has no name,
 * icon or grants of its own and nothing to delete. What its members DO have is
 * a Home-screen setting each, so that is what this page is: one row per card,
 * shown or hidden, settable here. Everything else about a card stays on the
 * card's own page, one click away in the bar.
 */
export function FixedGroupPanel({ band, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const system = band.g.fixed
  const members = band.items || []


  return (
    <div className="svc-mg">
      <Panel bare title={band.g.name} hint={String(members.length)}>
        {members.length === 0 && (
          <Row className="empty">
            {system ? tr("p_no_builtin_tools")
              : tr("p_every_card_is_in_a")}
          </Row>
        )}
        {members.map((c) => <MemberRow key={c.name} card={c} L={L} onChanged={onChanged} />)}
      </Panel>

      <Panel title={tr("p_about_this_band")}>
        <Field label={tr("p_name_icon")}>
          <span style={fieldMuted}>
            {system ? tr("p_the_portal_keeps_these_itself")
              : tr("p_this_is_simply_where_ungrouped")}
          </span>
        </Field>
        <Field label={tr("p_visibility_access")}>
          <span style={fieldMuted}>
            {system ? tr("p_builtin_tools_are_the_portal")
              : tr("p_they_differ_per_card_so")}
          </span>
        </Field>
        <Field label={tr("p_per_card")}>
          <span style={fieldMuted}>{tr("p_press_a_card_on_the")}</span>
        </Field>
      </Panel>
    </div>
  )
}
