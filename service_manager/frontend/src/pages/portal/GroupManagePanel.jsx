import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Row, Pill, fieldInput, fieldMuted, fieldChip } from './Field'
import { notify } from './settingsMsg'

/**
 * GroupManagePanel — a service group's settings, in the same panels the account
 * screens are built from. It replaces ServiceGroupBand's header tools for the
 * sidebar cover: the band there IS the group, so its tools do not have to live
 * in its header, and a modal for access was one layer too many.
 * (ServiceGroupBand still carries the classic cover's band, untouched.)
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
    notify(hidden ? L(`${n} 숨김`, `${n} hidden`) : L(`${n} 표시됨`, `${n} shown`), 'ok')
    onChanged?.()
  } catch (e) { notify(errText(e, L('실패', 'failed')), 'bad') }
}

/** One member of a band: what it is, whether the cover shows it, and the toggle. */
function MemberRow({ card, L, onChanged }) {
  return (
    <Row>
      <Icon name={card.icon || 'circle'} size={16} color={card.color || 'var(--text-secondary)'} weight="fill" />
      <span>{card.label || card.name}</span>
      {card.hidden ? <Pill tone="warn">{L('숨김', 'hidden')}</Pill> : <Pill tone="ok">{L('표시됨', 'shown')}</Pill>}
      <span className="sp" />
      <Button variant={card.hidden ? 'warning' : 'secondary'}
        onClick={() => setCardHidden(card, !card.hidden, L, onChanged)}>
        <Icon name={card.hidden ? 'eye' : 'eye-off'} size={15} />
        {card.hidden ? L('다시 표시', 'Show') : L('숨기기', 'Hide')}
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
    catch (e) { notify(errText(e, L('실패', 'failed')), 'bad') }
  }
  const patch = (body, ok) => run(launcher.put(`/admin/service-groups/${group.id}`, body), ok)
  const save = () => patch({ name: name.trim() || undefined }, L('그룹 저장됨', 'group saved'))
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
      <Panel title={L('그룹', 'Group')}>
        <Field label={L('이름', 'Name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L('그룹 이름', 'group name')}
            style={{ ...fieldInput, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && dirty && save()} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
        </FieldActions>

        <Field label={L('홈 화면', 'Home screen')}>
          {group.hidden ? <Pill tone="warn">{L('숨김', 'hidden')}</Pill> : <Pill tone="ok">{L('표시됨', 'shown')}</Pill>}
          <span style={fieldMuted}>{L('그룹을 숨기면 안에 있는 카드도 함께 사라집니다.', 'Hiding the group takes its cards with it.')}</span>
        </Field>
        <FieldActions>
          <Button variant={group.hidden ? 'warning' : 'secondary'}
            onClick={() => patch({ hidden: !group.hidden }, group.hidden ? L('다시 표시됨', 'shown again') : L('숨김', 'hidden'))}>
            <Icon name={group.hidden ? 'eye' : 'eye-off'} size={15} />
            {group.hidden ? L('다시 표시', 'Show') : L('숨기기', 'Hide')}
          </Button>
        </FieldActions>
      </Panel>

      {/* The members, with the one setting each of them has of its own. */}
      <Panel bare title={L('멤버', 'Members')} hint={String(members.length)}>
        {members.length === 0 && (
          <Row className="empty">{L('아직 없습니다 — 왼쪽에서 카드를 끌어다 놓으세요.', 'None yet — drag a card onto the band.')}</Row>
        )}
        {members.map((c) => <MemberRow key={c.name} card={c} L={L} onChanged={onChanged} />)}
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
            {system ? L('내장 도구가 없습니다.', 'No builtin tools.')
              : L('그룹에 들어가지 않은 카드가 없습니다.', 'Every card is in a group.')}
          </Row>
        )}
        {members.map((c) => <MemberRow key={c.name} card={c} L={L} onChanged={onChanged} />)}
      </Panel>

      <Panel title={L('이 묶음에 대하여', 'About this band')}>
        <Field label={L('이름 · 아이콘', 'Name · icon')}>
          <span style={fieldMuted}>
            {system ? L('포털이 직접 들고 있는 도구들이라 이름과 아이콘이 고정입니다.', 'The portal keeps these itself, so the band has a fixed name and icon.')
              : L('어느 그룹에도 안 들어간 카드가 모이는 자리라 고칠 이름이 없습니다.', 'This is simply where ungrouped cards land, so there is no name to change.')}
          </span>
        </Field>
        <Field label={L('공개 범위 · 접근 권한', 'Visibility · access')}>
          <span style={fieldMuted}>
            {system ? L('내장 도구는 서비스가 아니라 포털 자신의 화면이라 공개 범위와 권한이 없습니다. 관리자에게만 보입니다.',
                'Builtin tools are the portal\u2019s own screens, not services: they have no visibility tier and no grants. Managers see them.')
              : L('카드마다 다르므로 각 카드의 관리 화면에서 정합니다.', 'They differ per card, so each card sets its own on its own page.')}
          </span>
        </Field>
        <Field label={L('카드별 설정', 'Per card')}>
          <span style={fieldMuted}>{L('왼쪽에서 카드를 누르면 그 카드의 관리 화면이 열립니다.', 'Press a card on the left for its own page.')}</span>
        </Field>
      </Panel>
    </div>
  )
}
