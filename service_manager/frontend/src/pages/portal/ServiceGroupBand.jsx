import { useEffect, useState } from 'react'
import { Button, Icon, Modal } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { MasonryGrid } from './MasonryGrid'
import IconPick from './IconPick'

/**
 * ServiceGroupBand — one service group on the Home cover: a full-width band
 * holding its member cards (laid out in the same column grid), with a header
 * that collapses it. It widens with its members because it IS a grid of them.
 *
 * In group-manage mode the band is also a drop target (drag a card onto it to
 * add it) and its header grows the group tools: rename, icon/colour, collapse,
 * hide, a visibility tier for every member service at once, grants for every
 * member at once, and delete (members return to the cover).
 */
const VIS = [[1, 'portal_vis_private'], [2, 'portal_vis_protected'], [3, 'portal_vis_admin']]

export default function ServiceGroupBand({ group, cards, manageGroups, isManager, big, onChanged, dragKey, onDropCard, dim }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  // Collapse is persisted for managers (a group setting); everyone else just folds it locally.
  const [collapsed, setCollapsed] = useState(!!group.collapsed)
  useEffect(() => { setCollapsed(!!group.collapsed) }, [group.collapsed])
  const [over, setOver] = useState(false)
  const [name, setName] = useState(group.name || '')
  const [editing, setEditing] = useState(false)
  const [perm, setPerm] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { setName(group.name || '') }, [group.name])

  async function patch(body) {
    try { await launcher.put(`/admin/service-groups/${group.id}`, body); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    if (isManager && manageGroups) await patch({ collapsed: next })
  }
  async function setVis(v) {
    try { await launcher.put(`/admin/service-groups/${group.id}/visibility`, { visibility: Number(v) }); setMsg(L('적용됨', 'applied')); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function remove() {
    if (!window.confirm(L(`'${group.name}' 그룹을 없앨까요? 카드들은 홈으로 돌아갑니다.`, `Remove group '${group.name}'? Its cards return to the cover.`))) return
    try { await launcher.delete(`/admin/service-groups/${group.id}`); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  const color = group.color || 'var(--text-secondary)'
  const border = `1.5px ${manageGroups ? 'dashed' : 'solid'} ${over ? 'var(--btn-primary-bg)' : 'var(--border-strong, #94a3b8)'}`
  const n = cards.length

  return (
    <section
      onDragOver={manageGroups && dragKey ? (e) => { e.preventDefault(); if (!over) setOver(true) } : undefined}
      onDragLeave={manageGroups ? () => setOver(false) : undefined}
      onDrop={manageGroups && dragKey ? (e) => { e.preventDefault(); setOver(false); onDropCard?.(dragKey, group.id) } : undefined}
      style={{ border, borderRadius: 18, background: over ? 'var(--selection-bg, var(--surface-2))' : 'var(--surface-2)',
        padding: big ? '10px 12px 12px' : '8px 10px 10px', opacity: dim ? 0.5 : 1, transition: 'background .12s, border-color .12s' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 6px 8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={toggleCollapse} title={collapsed ? L('펼치기', 'Expand') : L('접기', 'Collapse')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--text-primary)' }}>
          <Icon name="caret-right" size={15} color="var(--text-muted)" style={{ transition: 'transform .2s', transform: collapsed ? 'none' : 'rotate(90deg)' }} />
          <Icon name={group.icon || 'stack'} size={big ? 26 : 20} weight="fill" color={color} />
          {editing ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onClick={(e) => e.stopPropagation()}
              onBlur={() => { setEditing(false); if (name.trim() !== group.name) patch({ name: name.trim() }) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(group.name); setEditing(false) } }}
              style={{ font: 'inherit', fontSize: big ? 'var(--fs-large, 16px)' : 'var(--fs-medium, 14px)', fontWeight: 600, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--input-border)', background: 'var(--surface)', color: 'var(--text-primary)' }} />
          ) : (
            <span style={{ fontSize: big ? 'var(--fs-large, 16px)' : 'var(--fs-medium, 14px)', fontWeight: 600 }}>{group.name || L('그룹', 'Group')}</span>
          )}
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{n}</span>
          {group.hidden && <span style={{ fontSize: 'var(--fs-micro, 11px)', padding: '1px 7px', borderRadius: 999, background: 'var(--surface)', color: 'var(--text-muted)' }}>{L('숨김', 'hidden')}</span>}
        </button>
        <span style={{ flex: 1 }} />
        {manageGroups && isManager && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)} title={L('이름 바꾸기', 'Rename')}><Icon name="edit" size={14} /></Button>
            <IconPick value={group.icon || 'stack'} onChange={(v) => patch({ icon: v })} />
            <input type="color" value={group.color || '#475569'} onChange={(e) => patch({ color: e.target.value })} title={L('색', 'Colour')}
              style={{ width: 28, height: 28, padding: 0, border: '1px solid var(--border-default)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }} />
            <select defaultValue="" onChange={(e) => { if (e.target.value) { setVis(e.target.value); e.target.value = '' } }}
              title={L('멤버 서비스 전체의 공개 범위', 'Visibility for every member service')}
              style={{ height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 6px', background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }}>
              <option value="">{L('공개 범위 일괄…', 'Visibility for all…')}</option>
              {VIS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
            </select>
            <Button variant="ghost" size="sm" onClick={() => setPerm(true)}><Icon name="key" size={14} /> {L('권한', 'Access')}</Button>
            <Button variant="ghost" size="sm" onClick={() => patch({ hidden: !group.hidden })} title={group.hidden ? L('홈에 다시 표시', 'Show on the cover') : L('홈에서 숨기기', 'Hide from the cover')}>
              <Icon name={group.hidden ? 'eye' : 'eye-slash'} size={14} /> {group.hidden ? L('표시', 'Show') : L('숨김', 'Hide')}
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} style={{ color: 'var(--danger-text)' }}><Icon name="trash" size={14} /></Button>
            {msg && <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{msg}</span>}
          </div>
        )}
      </div>
      {!collapsed && (
        n > 0 ? <MasonryGrid>{cards}</MasonryGrid>
          : <div style={{ padding: '14px 8px', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', textAlign: 'center', border: '1px dashed var(--border-default)', borderRadius: 12 }}>
              {manageGroups ? L('카드를 여기로 끌어다 놓으세요', 'Drag cards here') : L('빈 그룹', 'Empty group')}
            </div>
      )}
      {perm && <GroupAccessModal group={group} onClose={() => setPerm(false)} L={L} />}
    </section>
  )
}

/** Grant / revoke a whole-service permission on every member service at once. */
function GroupAccessModal({ group, onClose, L }) {
  const [users, setUsers] = useState([])
  const [info, setInfo] = useState(null)
  const [pick, setPick] = useState('')
  const [admin, setAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function load() {
    try {
      const [u, p] = await Promise.all([launcher.get('/admin/users'), launcher.get(`/admin/service-groups/${group.id}/permissions`)])
      setUsers(u.data || []); setInfo(p.data)
    } catch (e) { setErr(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [group.id])  // eslint-disable-line react-hooks/exhaustive-deps
  async function grant() {
    if (!pick) return
    setBusy(true); setErr('')
    try { await launcher.post(`/admin/service-groups/${group.id}/permissions`, { user_id: Number(pick), admin }); await load() }
    catch (e) { setErr(e?.response?.data?.detail || 'failed') } finally { setBusy(false) }
  }
  async function revoke(uid) {
    setBusy(true); setErr('')
    try { await launcher.delete(`/admin/service-groups/${group.id}/permissions`, { data: { user_id: uid } }); await load() }
    catch (e) { setErr(e?.response?.data?.detail || 'failed') } finally { setBusy(false) }
  }
  const chip = { fontSize: 'var(--fs-small, 12px)', padding: '3px 10px', borderRadius: 999, background: 'var(--surface-2)', display: 'inline-flex', gap: 6, alignItems: 'center' }
  return (
    <Modal title={`${group.name} · ${L('권한', 'Access')}`} onClose={onClose} width={560}>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 'var(--fs-small, 12px)' }}>
        <div style={{ color: 'var(--text-muted)' }}>
          {L('이 그룹의 서비스 전체에 한 번에 권한을 줍니다', 'Grants apply to every service in this group at once')}: <code>{(info?.services || []).join(', ') || '—'}</code>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ height: 30, borderRadius: 6, padding: '0 6px', background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--input-border)', minWidth: 180 }}>
            <option value="">{L('계정 선택…', 'Pick an account…')}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.role === 'manager' ? ' · admin' : ''}</option>)}
          </select>
          <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> {L('관리자 권한으로', 'as service admin')}</label>
          <Button variant="primary" size="sm" disabled={!pick || busy} onClick={grant}>{L('부여', 'Grant')}</Button>
        </div>
        {err && <div style={{ color: 'var(--danger-text)' }}>{err}</div>}
        <div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{L('그룹 전체에 권한 있음', 'Has access to the whole group')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(info?.all || []).map((u) => (
              <span key={u.user_id} style={chip}>{u.username}{u.admin ? ' · admin' : ''}
                <button type="button" disabled={busy} onClick={() => revoke(u.user_id)} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--danger-text)', padding: 0, display: 'inline-flex' }}><Icon name="close" size={12} /></button></span>
            ))}
            {(info?.all || []).length === 0 && <span style={{ color: 'var(--text-muted)' }}>—</span>}
          </div>
        </div>
        {(info?.some || []).length > 0 && (
          <div>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{L('일부 서비스에만 권한 있음', 'Access to some members only')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {info.some.map((u) => <span key={u.user_id} style={chip} title={u.services.join(', ')}>{u.username} · {u.services.length}/{info.services.length}</span>)}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
