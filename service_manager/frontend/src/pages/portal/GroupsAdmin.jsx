import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS, Avatar } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_CHOICES } from './IconPick'
import GroupMark from './GroupMark'
import ExpandBox from './ExpandBox'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

// Per-group name + icon + colour editor. Staged; applied on Save.
function GroupProfile({ group, onSaved }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [name, setName] = useState(group.name)
  const [icon, setIcon] = useState(group.icon || 'users')
  const [color, setColor] = useState(group.color || '#64748b')
  const [msg, setMsg] = useState('')
  const dirty = name.trim() !== group.name || icon !== (group.icon || 'users') || color !== (group.color || '#64748b')
  const save = async () => {
    try { await launcher.put(`/admin/groups/${group.id}`, { name: name.trim() || undefined, icon, color }); setMsg('✓'); onSaved?.() }
    catch (e) { setMsg(e?.response?.data?.detail || '✕') }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <GroupMark icon={icon} color={color} size={30} />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L('그룹 이름', 'group name')} style={{ height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', minWidth: 120, background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }} />
      <IconPick value={icon} onChange={setIcon} color={color} />
      <ColorPicker value={color} onChange={setColor} />
      <Button size="sm" variant="secondary" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }} title={L('랜덤', 'random')}><Icon name="refresh" size={13} /></Button>
      <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
      {msg && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</span>}
    </div>
  )
}

/**
 * GroupsAdmin — admin panel (in the Account screen) to manage groups: create,
 * add/remove members, and grant a group access to a service / project. Every
 * member inherits the group's grants (resolved in app/permissions.py), so this is
 * the convenient bulk way to give a whole lab/team a project.
 */
const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-micro, 10px)', padding: '2px 4px 2px 8px', borderRadius: 999, border: '1px solid var(--border-default)', background: 'var(--surface)' }
const input = { height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const card = { border: '1px solid var(--border-default)', borderRadius: 8, padding: 10, marginBottom: 8 }

export default function GroupsAdmin({ users, services, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [groups, setGroups] = useState([])
  const [open, setOpen] = useState(null)            // expanded group id
  const [newName, setNewName] = useState('')
  const [projCache, setProjCache] = useState({})    // svc -> [projects]
  const [add, setAdd] = useState({ uid: '', svc: '', proj: '' })
  const [mSearch, setMSearch] = useState('')          // member add: search accounts by text
  const [msg, setMsg] = useState('')

  async function load() {
    try { setGroups((await launcher.get('/admin/groups')).data) }
    catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) setMsg(ok(r)); await load(); onChanged?.() } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) } }

  const createGroup = () => newName.trim() && run(launcher.post('/admin/groups', { name: newName.trim(), icon: rnd(ICON_CHOICES), color: rnd(AVATAR_COLORS) }), () => { setNewName(''); return L('그룹 생성됨', 'group created') })
  const delGroup = (g) => { if (window.confirm(L(`그룹 '${g.name}' 삭제?`, `Delete group '${g.name}'?`))) run(launcher.delete(`/admin/groups/${g.id}`), () => L('삭제됨', 'deleted')) }
  const deactivateGroup = (g) => { if (window.confirm(L(`'${g.name}'의 모든 멤버(관리자 제외)를 비활성화할까요?`, `Deactivate all members (except admins) of '${g.name}'?`))) run(launcher.post(`/admin/groups/${g.id}/deactivate`), (r) => L(`${r.data.deactivated}명 비활성화됨`, `${r.data.deactivated} deactivated`)) }
  const resetGroupPerms = (g) => { if (window.confirm(L(`'${g.name}'의 모든 멤버(관리자 제외)의 '직접 부여' 서비스 권한을 지울까요?`, `Clear DIRECT service permissions of all members (except admins) of '${g.name}'?`))) run(launcher.post(`/admin/groups/${g.id}/reset-permissions`), (r) => L(`${r.data.users}명의 직접 권한 지워짐`, `cleared direct permissions for ${r.data.users} users`)) }
  const clearGroupPerms = (g) => { if (window.confirm(L(`'${g.name}' 그룹이 부여한 상속 권한을 모두 지울까요? (멤버들이 상속받던 권한이 사라집니다)`, `Clear all grants of group '${g.name}'? (members stop inheriting them)`))) run(launcher.post(`/admin/groups/${g.id}/clear-permissions`), (r) => L(`상속 권한 ${r.data.cleared}개 지워짐`, `cleared ${r.data.cleared} inherited grants`)) }
  const addMember = (gid, uid) => uid && run(launcher.post(`/admin/groups/${gid}/members`, { user_id: Number(uid) }), () => { setAdd((s) => ({ ...s, uid: '' })); return L('멤버 추가됨', 'member added') })
  const removeMember = (gid, uid) => run(launcher.delete(`/admin/groups/${gid}/members/${uid}`), () => L('멤버 제거됨', 'member removed'))
  const grantPerm = (gid) => add.svc && run(launcher.post('/admin/group-permissions', { group_id: gid, service: add.svc, project: add.proj }), () => { setAdd((s) => ({ ...s, svc: '', proj: '' })); return L('권한 부여됨', 'granted') })
  const revokePerm = (gid, p) => run(launcher.delete('/admin/group-permissions', { data: { group_id: gid, service: p.service, project: p.project || '' } }), () => L('권한 해제됨', 'revoked'))

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
    <div>
      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginBottom: 6 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={L('새 그룹 이름 (예: cens, lab-a)', 'new group name')} style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && createGroup()} />
        <Button size="sm" variant="primary" disabled={!newName.trim()} onClick={createGroup}>{L('그룹 생성', 'Create group')}</Button>
      </div>

      {/* Administrators — a virtual, always-present, read-only group: just who is a manager */}
      {(() => {
        const admins = users.filter((u) => u.role === 'manager')
        const isOpen = open === 'admins'
        return (
          <ExpandBox open={isOpen} onToggle={() => setOpen(isOpen ? null : 'admins')}
            icon={<GroupMark icon="key" color="#111827" size={26} />}
            title={L('관리자', 'Administrators')}
            subtitle={`${admins.length} ${L('명', 'members')}`}
          >
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('역할이 manager인 계정을 자동으로 모아 보여줍니다 (읽기 전용).', 'Auto-collected accounts with role = manager (read-only).')}</div>
              {admins.length === 0 ? <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>—</span>
                : admins.map((u) => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-small, 12px)' }}>
                    <Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={18} />
                    <span>{u.display_name || u.username}</span>
                    <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>@{u.username} · {u.email}</span>
                  </div>))}
            </div>
          </ExpandBox>
        )
      })()}

      {groups.length === 0 ? <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('그룹 없음', 'no groups')}</div>
        : groups.map((g) => {
          const isOpen = open === g.id
          return (
            <ExpandBox key={g.id} open={isOpen}
              onToggle={() => setOpen(isOpen ? null : g.id)}
              icon={<GroupMark icon={g.icon} color={g.color} size={26} />}
              title={g.name}
              subtitle={`${g.members} ${L('명', 'members')} · ${g.permissions.length} ${L('권한', 'perms')}`}
            >
                <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* group mark (icon + colour) */}
                  <div>
                    <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('그룹 아이콘 · 색상', 'Group icon · colour')}</div>
                    <GroupProfile group={g} onSaved={load} />
                  </div>
                  {/* members */}
                  <div>
                    <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('멤버', 'Members')}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                      {membersOf(g.id).length === 0 ? <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>—</span>
                        : membersOf(g.id).map((u) => (
                          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-small, 12px)', opacity: u.is_active === false ? 0.55 : 1 }}>
                            <Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={18} />
                            <span>{u.username}</span>
                            <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{u.email}</span>
                            {u.is_active === false && <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--danger-text)' }}>{L('비활성', 'inactive')}</span>}
                            <div style={{ flex: 1 }} />
                            <Button size="sm" variant="ghost" onClick={() => removeMember(g.id, u.id)}>{L('제외', 'Remove')}</Button>
                          </div>))}
                    </div>
                    <input value={mSearch} onChange={(e) => setMSearch(e.target.value)} placeholder={L('계정 검색해서 추가…', 'search accounts to add…')} style={{ ...input, maxWidth: 220 }} />
                    {mSearch.trim() && (() => {
                      const q = mSearch.trim().toLowerCase()
                      const hits = nonMembers(g.id).filter((u) => u.username.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)).slice(0, 12)
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {hits.length === 0 ? <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{L('일치하는 계정 없음', 'no match')}</span>
                            : hits.map((u) => (
                              <Button key={u.id} size="sm" variant="ghost" onClick={() => { addMember(g.id, u.id); setMSearch('') }}>
                                <Icon name="plus" size={12} /> {u.username}
                              </Button>))}
                        </div>
                      )
                    })()}
                  </div>
                  {/* permissions */}
                  <div>
                    <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('그룹 권한 (서비스 · 프로젝트)', 'Group access (service · project)')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                      {g.permissions.length === 0 ? <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>—</span>
                        : g.permissions.map((p, i) => (
                          <span key={i} style={{ ...chip, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'}
                            <button onClick={() => revokePerm(g.id, p)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger-text)', padding: 0, display: 'inline-flex' }}>×</button>
                          </span>))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <select value={add.svc} onChange={(e) => pickSvc(e.target.value)} style={{ ...input, maxWidth: 160 }}>
                        <option value="">{L('서비스…', 'service…')}</option>
                        {services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                      <select value={add.proj} onChange={(e) => setAdd((s) => ({ ...s, proj: e.target.value }))} style={{ ...input, maxWidth: 160 }} disabled={!add.svc}>
                        <option value="">{L('전체 (서비스 전체)', 'all (whole service)')}</option>
                        {(projCache[add.svc] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
                      </select>
                      <Button size="sm" variant="primary" disabled={!add.svc} onClick={() => grantPerm(g.id)}>{L('권한 부여', 'Grant')}</Button>
                    </div>
                  </div>
                  {/* deactivate all members / delete group (in manage) */}
                  <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="ghost" onClick={() => deactivateGroup(g)}>{L('멤버 전체 비활성화', 'Deactivate all members')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => resetGroupPerms(g)}>{L('직접 부여 권한 지우기', 'Clear direct permissions')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => clearGroupPerms(g)}>{L('그룹 상속 권한 지우기', 'Clear inherited permissions')}</Button>
                    <div style={{ flex: 1 }} />
                    <Button size="sm" variant="dangerSoft" onClick={() => delGroup(g)}><Icon name="trash" size={13} /> {L('그룹 삭제', 'Delete group')}</Button>
                  </div>
                </div>
            </ExpandBox>
          )
        })}
    </div>
  )
}
