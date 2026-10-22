import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS, Avatar, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_CHOICES } from './IconPick'
import GroupMark from './GroupMark'
import ExpandBox from './ExpandBox'
import { Field, FieldActions, Panel, Row, fieldGrid, fieldInput, fieldMuted, fieldChip, FIELD_TEXT, FIELD_CARD_CLASS } from './Field'
import { notify } from './settingsMsg'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

// Per-group name + icon + colour editor. Staged; applied on Save.
function GroupProfile({ group, onSaved }) {
  const { lang } = useLang()
  const [name, setName] = useState(group.name)
  const [icon, setIcon] = useState(group.icon || 'users')
  const [color, setColor] = useState(group.color || '#64748b')
  const dirty = name.trim() !== group.name || icon !== (group.icon || 'users') || color !== (group.color || '#64748b')
  const save = async () => {
    try { await launcher.put(`/admin/groups/${group.id}`, { name: name.trim() || undefined, icon, color }); notify(tr("p_group_saved", name.trim()), 'ok'); onSaved?.() }
    catch (e) { notify(e?.response?.data?.detail || tr("p_failed"), 'bad') }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <GroupMark icon={icon} color={color} size={30} />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("p_group_name")} style={{ ...fieldInput, minWidth: 120 }} />
      <IconPick value={icon} onChange={setIcon} color={color} />
      <ColorPicker value={color} onChange={setColor} />
      <Button variant="secondary" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }} title={tr("p_random")}><Icon name="refresh" size={13} /></Button>
      <Button variant="primary" disabled={!dirty} onClick={save}>{tr("p_save")}</Button>
    </div>
  )
}

/**
 * GroupsAdmin — admin panel (in the Account screen) to manage groups: create,
 * add/remove members, and grant a group access to a service / project. Every
 * member inherits the group's grants (resolved in app/permissions.py), so this is
 * the convenient bulk way to give a whole lab/team a project.
 */
const input = { ...fieldInput }
const card = { border: '1px solid var(--border-default)', borderRadius: 8, padding: 10, marginBottom: 8 }

export default function GroupsAdmin({ users, services, onChanged }) {
  const { lang } = useLang()
  const [groups, setGroups] = useState([])
  const [open, setOpen] = useState(null)            // expanded group id
  const [newName, setNewName] = useState('')
  const [projCache, setProjCache] = useState({})    // svc -> [projects]
  const [add, setAdd] = useState({ uid: '', svc: '', proj: '', admin: false })
  const [mSearch, setMSearch] = useState('')          // member add: search accounts by text

  async function load() {
    try { setGroups((await launcher.get('/admin/groups')).data) }
    catch (e) { notify(e?.response?.data?.detail || 'load failed', 'bad') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) notify(ok(r), 'ok'); await load(); onChanged?.() } catch (e) { notify(e?.response?.data?.detail || tr("p_failed"), 'bad') } }

  const createGroup = () => newName.trim() && run(launcher.post('/admin/groups', { name: newName.trim(), icon: rnd(ICON_CHOICES), color: rnd(AVATAR_COLORS) }), () => { setNewName(''); return tr("p_group_created") })
  const delGroup = (g) => { if (window.confirm(tr("p_delete_group", g.name))) run(launcher.delete(`/admin/groups/${g.id}`), () => tr("p_deleted")) }
  const deactivateGroup = (g) => { if (window.confirm(tr("p_deactivate_all_members_except_admins", g.name))) run(launcher.post(`/admin/groups/${g.id}/deactivate`), (r) => tr("p_deactivated", r.data.deactivated)) }
  const resetGroupPerms = (g) => { if (window.confirm(tr("p_clear_direct_service_permissions_of", g.name))) run(launcher.post(`/admin/groups/${g.id}/reset-permissions`), (r) => tr("p_cleared_direct_permissions_for_users", r.data.users)) }
  const clearGroupPerms = (g) => { if (window.confirm(tr("p_clear_all_grants_of_group", g.name))) run(launcher.post(`/admin/groups/${g.id}/clear-permissions`), (r) => tr("p_cleared_inherited_grants", r.data.cleared)) }
  const addMember = (gid, uid) => uid && run(launcher.post(`/admin/groups/${gid}/members`, { user_id: Number(uid) }), () => { setAdd((s) => ({ ...s, uid: '' })); return tr("p_member_added") })
  const removeMember = (gid, uid) => run(launcher.delete(`/admin/groups/${gid}/members/${uid}`), () => tr("p_member_removed"))
  const grantPerm = (gid) => add.svc && run(launcher.post('/admin/group-permissions', { group_id: gid, service: add.svc, project: add.proj, admin: add.admin }), () => { setAdd((s) => ({ ...s, svc: '', proj: '', admin: false })); return tr("p_granted_2") })
  const revokePerm = (gid, p) => run(launcher.delete('/admin/group-permissions', { data: { group_id: gid, service: p.service, project: p.project || '' } }), () => tr("p_revoked"))

  async function pickSvc(svc) {
    setAdd((s) => ({ ...s, svc, proj: '' }))
    if (svc && !projCache[svc]) {
      try { const r = await launcher.get(`/services/${svc}/projects`); setProjCache((c) => ({ ...c, [svc]: r.data })) }
      catch { setProjCache((c) => ({ ...c, [svc]: [] })) }
    }
  }

  const membersOf = (gid) => users.filter((u) => (u.groups || []).some((g) => g.id === gid))
  const nonMembers = (gid) => users.filter((u) => u.role !== 'manager' && !(u.groups || []).some((g) => g.id === gid))

  return (
    <>
      <Panel title={tr("p_new_group_2")}>
        <Field label={tr("p_name")}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={tr("p_e_g_cens_lab_a")} style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && createGroup()} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!newName.trim()} onClick={createGroup}>{tr("p_create_group")}</Button>
        </FieldActions>
      </Panel>

      <Panel bare title={tr("p_groups")} hint={String(groups.length + 1)}>
      <div className="set-list">
      {/* Administrators — a virtual, always-present, read-only group: just who is a manager */}
      {(() => {
        const admins = users.filter((u) => u.role === 'manager')
        const isOpen = open === 'admins'
        return (
          <ExpandBox open={isOpen} onToggle={() => setOpen(isOpen ? null : 'admins')}
            outerProps={{ className: isOpen ? 'on' : undefined }}
            icon={<GroupMark icon="key" color="#111827" size={26} />}
            title={tr("p_administrators")}
            subtitle={`${admins.length} ${tr("p_members")}`}
          >
            <div className={FIELD_CARD_CLASS}>
              <Field label={tr("p_membership")}>
                <span style={fieldMuted}>{tr("p_auto_collected_accounts_with_role")}</span>
              </Field>
              <Field label={tr("p_members_2")} align="start">
                {admins.length === 0 ? <span style={fieldMuted}>—</span>
                  : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                      {admins.map((u) => (
                        <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={18} />
                          <span>{u.display_name || u.username}</span>
                          <span style={{ color: 'var(--text-primary)' }}>@{u.username} · {u.email}</span>
                        </div>))}
                    </div>}
              </Field>
            </div>
          </ExpandBox>
        )
      })()}

      {groups.map((g) => {
          const isOpen = open === g.id
          return (
            <ExpandBox key={g.id} open={isOpen}
              onToggle={() => setOpen(isOpen ? null : g.id)}
              outerProps={{ className: isOpen ? 'on' : undefined }}
              icon={<GroupMark icon={g.icon} color={g.color} size={26} />}
              title={g.name}
              subtitle={`${g.members} ${tr("p_members")} · ${g.permissions.length} ${tr("p_perms")}`}
            >
                <div className={FIELD_CARD_CLASS}>
                  <Field label={tr("p_group_icon_colour")} align="start">
                    <GroupProfile group={g} onSaved={load} />
                  </Field>

                  <Field label={tr("p_members_2")} align="start">
                    {membersOf(g.id).length === 0 ? <span style={fieldMuted}>—</span>
                      : <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                          {membersOf(g.id).map((u) => (
                            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: u.is_active === false ? 0.55 : 1 }}>
                              <Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={18} />
                              <span>{u.username}</span>
                              <span style={{ color: 'var(--text-primary)' }}>{u.email}</span>
                              {u.is_active === false && <span style={{ color: 'var(--danger-text)' }}>{tr("p_inactive")}</span>}
                              <div style={{ flex: 1 }} />
                              <Button variant="dangerSoft" onClick={() => removeMember(g.id, u.id)}>{tr("p_remove")}</Button>
                            </div>))}
                        </div>}
                  </Field>
                  <FieldActions>
                    <input value={mSearch} onChange={(e) => setMSearch(e.target.value)} placeholder={tr("p_search_accounts_to_add")} style={{ ...input, maxWidth: 220 }} />
                    {mSearch.trim() && (() => {
                      const q = mSearch.trim().toLowerCase()
                      const hits = nonMembers(g.id).filter((u) => u.username.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)).slice(0, 12)
                      return hits.length === 0 ? <span style={fieldMuted}>{tr("p_no_match")}</span>
                        : hits.map((u) => (
                            <Button key={u.id} variant="success" onClick={() => { addMember(g.id, u.id); setMSearch('') }}>
                              <Icon name="plus" size={12} /> {u.username}
                            </Button>))
                    })()}
                  </FieldActions>

                  <Field label={tr("p_group_access_service_project")} align="start">
                    {g.permissions.length === 0 ? <span style={fieldMuted}>—</span>
                      : g.permissions.map((p, i) => (
                        <span key={i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + tr("p_all") + ')'}
                          {p.admin && <span style={{ color: 'var(--warning-text, #b45309)' }} title={tr("p_every_member_administers_this_scope")}>· admin</span>}
                          <button type="button" className="set-plain set-x" onClick={() => revokePerm(g.id, p)} title={tr("p_revoke")}>✕</button>
                        </span>))}
                  </Field>
                  <FieldActions>
                    <select value={add.svc} onChange={(e) => pickSvc(e.target.value)} style={{ ...input, maxWidth: 160 }}>
                      <option value="">{tr("p_service_3")}</option>
                      {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                    <select value={add.proj} onChange={(e) => setAdd((s) => ({ ...s, proj: e.target.value }))} style={{ ...input, maxWidth: 160 }} disabled={!add.svc}>
                      <option value="">{tr("p_all_whole_service")}</option>
                      {(projCache[add.svc] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
                    </select>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-medium, 14px)', color: 'var(--text-primary)', cursor: 'pointer' }}
                      title={tr("p_every_member_administers_this_scope")}>
                      <input type="checkbox" checked={add.admin} onChange={(e) => setAdd((s) => ({ ...s, admin: e.target.checked }))} />
                      {tr("p_as_admin")}
                    </label>
                    <Button variant="primary" disabled={!add.svc} onClick={() => grantPerm(g.id)}>{tr("p_grant")}</Button>
                  </FieldActions>

                  <Field label={tr("p_whole_group")}>
                    {tr("p_these_apply_to_every_member")}
                  </Field>
                  <FieldActions>
                    <Button variant="warning" onClick={() => deactivateGroup(g)}>{tr("p_deactivate_all_members")}</Button>
                    <Button variant="warning" onClick={() => resetGroupPerms(g)}>{tr("p_clear_direct_permissions")}</Button>
                    <Button variant="warning" onClick={() => clearGroupPerms(g)}>{tr("p_clear_inherited_permissions")}</Button>
                    <Button variant="dangerSoft" onClick={() => delGroup(g)}><Icon name="trash" size={13} /> {tr("p_delete_group_2")}</Button>
                  </FieldActions>
                </div>
            </ExpandBox>
          )
        })}
      {groups.length === 0 && <Row className="empty">{tr("p_no_groups_yet_only_administrators")}</Row>}
      </div>
      </Panel>
    </>
  )
}
