import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_CHOICES } from './IconPick'
import GroupMark from './GroupMark'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

// Per-group icon + colour editor (the square group mark). Staged; applied on Save.
function GroupProfile({ group, onSaved }) {
  const [icon, setIcon] = useState(group.icon || 'users')
  const [color, setColor] = useState(group.color || '#64748b')
  const [msg, setMsg] = useState('')
  const dirty = icon !== (group.icon || 'users') || color !== (group.color || '#64748b')
  const save = async () => {
    try { await launcher.put(`/admin/groups/${group.id}`, { icon, color }); setMsg('✓'); onSaved?.() }
    catch (e) { setMsg(e?.response?.data?.detail || '✕') }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <GroupMark icon={icon} color={color} size={30} />
      <IconPick value={icon} onChange={setIcon} color={color} />
      <ColorPicker value={color} onChange={setColor} />
      <Button size="sm" variant="secondary" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }} title="random"><Icon name="refresh" size={13} /></Button>
      <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>{'Save'}</Button>
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
  const [msg, setMsg] = useState('')

  async function load() {
    try { setGroups((await launcher.get('/admin/groups')).data) }
    catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) setMsg(ok(r)); await load(); onChanged?.() } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) } }

  const createGroup = () => newName.trim() && run(launcher.post('/admin/groups', { name: newName.trim(), icon: rnd(ICON_CHOICES), color: rnd(AVATAR_COLORS) }), () => { setNewName(''); return L('그룹 생성됨', 'group created') })
  const delGroup = (g) => { if (window.confirm(L(`그룹 '${g.name}' 삭제?`, `Delete group '${g.name}'?`))) run(launcher.delete(`/admin/groups/${g.id}`), () => L('삭제됨', 'deleted')) }
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

      {groups.length === 0 ? <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('그룹 없음', 'no groups')}</div>
        : groups.map((g) => {
          const isOpen = open === g.id
          return (
            <div key={g.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <GroupMark icon={g.icon} color={g.color} size={22} />
                <b style={{ fontSize: 'var(--fs-small, 13px)' }}>{g.name}</b>
                <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{g.members} {L('명', 'members')} · {g.permissions.length} {L('권한', 'perms')}</span>
                <div style={{ flex: 1 }} />
                <Button size="sm" variant={isOpen ? 'secondary' : 'ghost'} onClick={() => setOpen(isOpen ? null : g.id)}>{isOpen ? L('닫기', 'Close') : L('관리', 'Manage')}</Button>
                <Button size="sm" variant="dangerSoft" icon title={L('삭제', 'delete')} onClick={() => delGroup(g)}><Icon name="trash" size={13} /></Button>
              </div>

              {isOpen && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* group mark (icon + colour) */}
                  <div>
                    <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('그룹 아이콘 · 색상', 'Group icon · colour')}</div>
                    <GroupProfile group={g} onSaved={load} />
                  </div>
                  {/* members */}
                  <div>
                    <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('멤버', 'Members')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                      {membersOf(g.id).length === 0 ? <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>—</span>
                        : membersOf(g.id).map((u) => (
                          <span key={u.id} style={chip}>{u.username}
                            <button onClick={() => removeMember(g.id, u.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'inline-flex' }}>×</button>
                          </span>))}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select value={add.uid} onChange={(e) => setAdd((s) => ({ ...s, uid: e.target.value }))} style={{ ...input, maxWidth: 200 }}>
                        <option value="">{L('계정 선택…', 'select account…')}</option>
                        {nonMembers(g.id).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                      </select>
                      <Button size="sm" variant="ghost" disabled={!add.uid} onClick={() => addMember(g.id, add.uid)}>{L('멤버 추가', 'Add member')}</Button>
                    </div>
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
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}
