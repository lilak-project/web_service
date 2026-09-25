import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick from './IconPick'
import GroupMark from './GroupMark'
import { Panel, Field, FieldActions, Row, Pill, fieldInput, fieldMuted, fieldChip } from './Field'
import { notify } from './settingsMsg'

/**
 * GroupManagePanel — a service group's settings, in the same panels the account
 * screens are built from. It replaces ServiceGroupBand's header tools for the
 * sidebar cover: the band there IS the group, so its tools do not have to live
 * in its header, and a modal for access was one layer too many.
 * (ServiceGroupBand still carries the classic cover's band, untouched.)
 */
const VIS = [[1, 'portal_vis_private'], [2, 'portal_vis_protected'], [3, 'portal_vis_admin']]

export default function GroupManagePanel({ group, members = [], onChanged }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [name, setName] = useState(group.name || '')
  const [icon, setIcon] = useState(group.icon || 'stack')
  const [color, setColor] = useState(group.color || '#475569')
  const [users, setUsers] = useState([])
  const [info, setInfo] = useState(null)       // { services, grants }
  const [pick, setPick] = useState('')
  const [asAdmin, setAsAdmin] = useState(false)

  useEffect(() => {
    setName(group.name || ''); setIcon(group.icon || 'stack'); setColor(group.color || '#475569')
  }, [group.id, group.name, group.icon, group.color])

  const dirty = name.trim() !== (group.name || '') || icon !== (group.icon || 'stack') || color !== (group.color || '#475569')

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
    catch (e) { notify(errText(e, L('실패', 'failed')), 'bad') }
  }
  const patch = (body, ok) => run(launcher.put(`/admin/service-groups/${group.id}`, body), ok)
  const save = () => patch({ name: name.trim() || undefined, icon, color }, L('그룹 저장됨', 'group saved'))
  const setVis = (v) => v && run(launcher.put(`/admin/service-groups/${group.id}/visibility`, { visibility: Number(v) }),
    L('멤버 전체에 적용됨', 'applied to every member'))
  const grant = () => pick && run(launcher.post(`/admin/service-groups/${group.id}/permissions`, { user_id: Number(pick), admin: asAdmin }),
    L('권한 부여됨', 'granted')).then(() => { setPick(''); setAsAdmin(false) })
  const revoke = (uid) => run(launcher.delete(`/admin/service-groups/${group.id}/permissions`, { data: { user_id: uid } }),
    L('권한 해제됨', 'revoked'))
  function remove() {
    if (!window.confirm(L(`'${group.name}' 그룹을 없앨까요? 안에 있던 카드들은 그룹 밖으로 나옵니다.`,
      `Remove group '${group.name}'? Its cards come back out of it.`))) return
    run(launcher.delete(`/admin/service-groups/${group.id}`), L('그룹 삭제됨', 'group deleted'))
  }

  const grants = info?.grants || info?.users || []

  return (
    <div className="svc-mg">
      <Panel title={L('그룹', 'Group')} hint={`${members.length}`}>
        <Field label={L('아이콘 · 색', 'Icon · colour')}>
          <GroupMark icon={icon} color={color} size={30} />
          <IconPick value={icon} onChange={setIcon} color={color} />
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <Field label={L('이름', 'Name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L('그룹 이름', 'group name')}
            style={{ ...fieldInput, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && dirty && save()} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
        </FieldActions>

        <Field label={L('멤버', 'Members')} align="start">
          {members.length === 0
            ? <span style={fieldMuted}>{L('아직 없습니다 — 왼쪽에서 카드를 끌어다 놓으세요.', 'None yet — drag a card onto the band.')}</span>
            : members.map((c) => (
                <span key={c.name} style={fieldChip}>
                  <Icon name={c.icon || 'circle'} size={13} color={c.color || 'var(--text-secondary)'} weight="fill" />
                  {c.label || c.name}
                </span>
              ))}
        </Field>

        <Field label={L('홈 화면', 'Home screen')}>
          {group.hidden ? <Pill tone="warn">{L('숨김', 'hidden')}</Pill> : <Pill tone="ok">{L('표시됨', 'shown')}</Pill>}
          <span style={fieldMuted}>{L('그룹을 숨기면 안에 있는 카드도 함께 사라집니다.', 'Hiding the group takes its cards with it.')}</span>
        </Field>
        <FieldActions>
          <Button variant={group.hidden ? 'warning' : 'secondary'}
            onClick={() => patch({ hidden: !group.hidden }, group.hidden ? L('다시 표시됨', 'shown again') : L('숨김', 'hidden'))}>
            <Icon name={group.hidden ? 'eye' : 'eye-slash'} size={15} />
            {group.hidden ? L('다시 표시', 'Show') : L('숨기기', 'Hide')}
          </Button>
        </FieldActions>
      </Panel>

      {/* Everything here lands on EVERY member service at once — the reason a
          group is worth making in the first place. */}
      <Panel title={L('멤버 전체에 한 번에', 'To every member at once')}
        hint={(info?.services || []).join(', ') || '—'}>
        <Field label={L('공개 범위', 'Visibility')}>
          <select defaultValue="" onChange={(e) => { setVis(e.target.value); e.target.value = '' }}
            style={{ ...fieldInput, maxWidth: 220 }}>
            <option value="">{L('일괄 적용…', 'Apply to all…')}</option>
            {VIS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
          </select>
        </Field>

        <Field label={L('접근 권한', 'Access')} align="start">
          {grants.length === 0
            ? <span style={fieldMuted}>{L('부여된 계정 없음', 'nobody yet')}</span>
            : grants.map((g) => (
                <span key={g.user_id ?? g.id ?? g.username} style={fieldChip}>
                  {g.username}{g.admin ? ' · admin' : ''}
                  <button type="button" className="set-plain set-x" title={L('해제', 'Revoke')}
                    onClick={() => revoke(g.user_id ?? g.id)}>✕</button>
                </span>
              ))}
        </Field>
        <FieldActions>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...fieldInput, maxWidth: 220 }}>
            <option value="">{L('계정 선택…', 'Pick an account…')}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.role === 'manager' ? ' · admin' : ''}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
            {L('관리자로', 'as admin')}
          </label>
          <Button variant="primary" disabled={!pick} onClick={grant}>{L('권한 부여', 'Grant')}</Button>
        </FieldActions>
      </Panel>

      <Panel danger title={L('되돌릴 수 없는 것', 'Cannot be undone')}>
        <Field label={L('그룹 삭제', 'Delete group')}>
          {L('그룹만 사라지고 안에 있던 카드는 그대로 남습니다.', 'Only the group goes; the cards inside it stay.')}
        </Field>
        <FieldActions>
          <Button variant="dangerSoft" onClick={remove}><Icon name="trash" size={15} /> {L('그룹 삭제', 'Delete group')}</Button>
        </FieldActions>
      </Panel>
    </div>
  )
}
