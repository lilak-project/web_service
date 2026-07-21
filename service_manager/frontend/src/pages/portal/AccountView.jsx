import { useEffect, useState } from 'react'
import { Button, Icon, Avatar } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import GroupsAdmin from './GroupsAdmin'
import InvitesAdmin from './InvitesAdmin'
import { Field, FieldActions, fieldGrid, fieldMuted, fieldChip, FIELD_TEXT } from './Field'
import SystemAdmin from './SystemAdmin'
import FeedbackView from './FeedbackView'
import GuideView from './GuideView'
import ProfileEditor from './ProfileEditor'
import GroupMark from './GroupMark'
import ExpandBox from './ExpandBox'

/**
 * AccountView — account settings. A LEFT vertical menu switches between sub-tabs:
 * "My account" (everyone) and, for admins, "Accounts" / "Groups" / "Invite codes".
 * (The vertical menu is intentionally distinct from the horizontal main nav tabs.)
 */

const card = { border: '1px solid var(--border-default)', borderRadius: 8, padding: 12, marginBottom: 10 }
const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const input = { height: 32, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 10px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)', minWidth: 0 }
const badge = { ...FIELD_TEXT, padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)' }
const pwOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const pwDialog = { background: 'var(--surface-1, #fff)', border: '1px solid var(--border-default)', borderRadius: 8, padding: 16, width: 320, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }

/**
 * Masked password prompt — replaces window.prompt() for anything that asks for a
 * password (window.prompt echoes input as plaintext and can't be masked).
 */
function PwPrompt({ title, confirmLabel, cancelLabel, onSubmit, onCancel }) {
  const [v, setV] = useState('')
  return (
    <div style={pwOverlay} onClick={onCancel}>
      <div style={pwDialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...FIELD_TEXT, color: 'var(--text-primary)', marginBottom: 10 }}>{title}</div>
        <input type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(v); if (e.key === 'Escape') onCancel() }}
          name="portal-confirm-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true"
          style={{ ...input, width: '100%', marginBottom: 12 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button size="sm" variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
          <Button size="sm" variant="primary" onClick={() => onSubmit(v)}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

// The settings sub-menu, shared so the header can drive it on narrow screens.
export function settingsMenu(isManager, lang) {
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  return [
    ['me', 'user', L('내 계정', 'My account')],
    ['feedback', 'chats', L('피드백', 'Feedback')],
    ...(isManager ? [
      ['accounts', 'users', L('계정', 'Accounts')],
      ['groups', 'tree', L('그룹', 'Groups')],
      ['invites', 'key', L('초대 코드', 'Invite codes')],
      ['system', 'sliders', L('시스템', 'System')],
      ['handshake', 'plug', L('핸드셰이크', 'Handshake')],
    ] : []),
  ]
}

// tab/onTab make the active sub-tab controllable from the header; hideMenu drops
// the left sidebar (the header dropdown navigates instead) on narrow screens.
export default function AccountView({ isManager, onChanged, onAccountGone, tab: tabProp, onTab, hideMenu = false }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [services, setServices] = useState([])
  const [requests, setRequests] = useState([])
  const [groupFilter, setGroupFilter] = useState('')
  const [tabInner, setTabInner] = useState('me')       // uncontrolled fallback
  const tab = tabProp ?? tabInner                      // 'me' | 'feedback' | 'accounts' | …
  const setTab = onTab ?? setTabInner
  const [msg, setMsg] = useState('')
  const [f, setF] = useState({ code: '', cur: '', npw: '', email: '' })
  const [dname, setDname] = useState('')               // display-name edit field (login id stays fixed)
  const [openUser, setOpenUser] = useState(null)       // accounts: expanded user id
  const [agrant, setAgrant] = useState({ svc: '', proj: '' })   // scoped-admin grant form (open user)
  const [projCache, setProjCache] = useState({})                // svc -> [projects] for the grant dropdown
  const [pwAsk, setPwAsk] = useState(null)             // masked password prompt: { title, resolve }
  const setField = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  // Promise-based replacement for window.prompt() for password entry (masked input).
  const askPassword = (title) => new Promise((resolve) => setPwAsk({ title, resolve }))

  async function load() {
    try {
      setMe((await launcher.get('/account')).data)
      if (isManager) {
        setUsers((await launcher.get('/admin/users?detail=1')).data)
        setRequests((await launcher.get('/admin/access-requests')).data)
        setServices((await launcher.get('/admin/services')).data)
      }
    } catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me) setDname(me.display_name || me.username || '') }, [me?.display_name, me?.username])

  const say = (m) => { setMsg(m) }
  async function run(p, ok) { try { const r = await p; say(ok(r)); await load(); onChanged?.() } catch (e) { say(e?.response?.data?.detail || L('실패', 'failed')) } }

  // ── self actions ──
  const redeem = () => f.code.trim() && run(launcher.post('/invite-codes/redeem', { code: f.code.trim() }),
    (r) => {
      setF((s) => ({ ...s, code: '' }))
      const d = r.data
      return d.kind === 'group' ? L(`그룹 가입: ${d.group}`, `joined group: ${d.group}`)
        : L(`권한 획득: ${d.service}${d.project ? '/' + d.project : ''}`, `granted: ${d.service}${d.project ? '/' + d.project : ''}`)
    })
  const changePw = () => (f.cur && f.npw) && run(launcher.post('/account/password', { current_password: f.cur, new_password: f.npw }),
    () => { setF((s) => ({ ...s, cur: '', npw: '' })); return L('비밀번호 변경됨', 'password changed') })
  // Change only the display name (shown in the portal, nptoy, community). The login
  // id (username) is intentionally left fixed.
  const changeName = () => dname.trim() !== (me.display_name || me.username || '') && run(launcher.post('/account/profile', { display_name: dname.trim() || null }),
    () => L('표시 이름 변경됨', 'display name changed'))
  const requestEmail = () => f.email.trim() && run(launcher.post('/account/request-email', { new_email: f.email.trim() }),
    () => { setF((s) => ({ ...s, email: '' })); return L('이메일 변경 요청됨 (관리자 승인 대기)', 'email change requested (awaiting admin)') })
  const reverify = () => run(launcher.post('/account/verify'), () => L('이메일 인증됨 (임시)', 'email verified (temp)'))
  async function deleteSelf() {
    if (!window.confirm(L('정말 계정을 삭제할까요? 되돌릴 수 없습니다.', 'Delete your account? This cannot be undone.'))) return
    try { await launcher.delete('/account'); onAccountGone?.() } catch (e) { say(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  // ── admin actions on a user ──
  const adminSetPw = async (u) => { const p = await askPassword(L(`${u.username}의 새 비밀번호`, `New password for ${u.username}`)); if (p) run(launcher.post(`/admin/users/${u.id}/password`, { new_password: p }), () => L('비밀번호 재설정됨', 'password reset')) }
  const adminVerify = (u) => run(launcher.post(`/admin/users/${u.id}/verify`), () => L(`${u.username} 인증됨`, `${u.username} verified`))
  const adminRequestVerify = (u) => run(launcher.post(`/admin/users/${u.id}/request-verify`), (r) => r.data.verify_url ? L(`인증 링크(개발): ${r.data.verify_url}`, `verify link (dev): ${r.data.verify_url}`) : L('인증 메일 요청됨', 'verification requested'))
  const adminResetPwEmail = (u) => { if (!window.confirm(L(`${u.username}에게 새 임의 비밀번호를 발급할까요?`, `Issue a new random password for ${u.username}?`))) return; run(launcher.post(`/admin/users/${u.id}/reset-password-email`), (r) => r.data.password ? L(`새 비밀번호(개발): ${r.data.password}`, `new password (dev): ${r.data.password}`) : L('이메일로 발송됨', 'emailed')) }
  const adminApprove = (u, approve) => run(launcher.post(`/admin/users/${u.id}/approve-email`, { approve }), () => approve ? L('이메일 변경 승인됨', 'email approved') : L('거절됨', 'rejected'))
  const adminDelete = async (u) => { const pw = await askPassword(L(`${u.username} 삭제 — 확인을 위해 내 비밀번호를 입력하세요.`, `Delete ${u.username} — enter YOUR password to confirm.`)); if (pw == null) return; run(launcher.delete(`/admin/users/${u.id}`, { data: { password: pw } }), () => L('삭제됨', 'deleted')) }
  const adminRole = (u) => {
    const to = u.role === 'manager' ? 'user' : 'manager'
    // Promoting to manager = GLOBAL admin over every service and project — warn first.
    if (to === 'manager' && !window.confirm(L(
      `${u.username}을(를) 전체 관리자(매니저)로 승격할까요?\n\n매니저는 모든 서비스·프로젝트·계정에 대한 관리 권한을 갖습니다. 특정 서비스만 맡기려면 아래의 "관리 권한 (서비스/프로젝트)"를 사용하세요.`,
      `Promote ${u.username} to GLOBAL manager?\n\nA manager can administer every service, project and account. To delegate just one service, use "Admin (service / project)" below instead.`))) return
    run(launcher.post(`/admin/users/${u.id}/role`, { role: to }), () => L(`${u.username} → ${to}`, `${u.username} → ${to}`))
  }
  const adminActive = (u) => run(launcher.post(`/admin/users/${u.id}/active`, { active: u.is_active === false }), () => L(u.is_active === false ? '활성화됨' : '비활성화됨', u.is_active === false ? 'activated' : 'deactivated'))
  const removeFromGroup = (u, g) => run(launcher.delete(`/admin/groups/${g.id}/members/${u.id}`), () => L(`${g.name}에서 제외됨`, `removed from ${g.name}`))
  const resolveReq = (rid, action) => run(launcher.post(`/admin/access-requests/${rid}`, { action }), () => action === 'approve' ? L('승인됨', 'approved') : L('거절됨', 'rejected'))
  // scoped (service/project) admin: grant sets is_admin (also grants access); revoke drops admin, keeps access.
  const grantScopedAdmin = (u) => agrant.svc && run(launcher.post('/admin/permissions', { user_id: u.id, service: agrant.svc, project: agrant.proj.trim(), admin: true }), () => { setAgrant({ svc: '', proj: '' }); return L('관리 권한 부여됨', 'admin granted') })
  const revokeScopedAdmin = (u, p) => run(launcher.post('/admin/permissions', { user_id: u.id, service: p.service, project: p.project || '', admin: false }), () => L('관리 권한 해제됨', 'admin revoked'))
  // Selecting a service loads its project list once, for the project dropdown
  // (a single-project service 404s → empty list → only "whole service" remains).
  async function agrantPickSvc(svc) {
    setAgrant({ svc, proj: '' })
    if (svc && !projCache[svc]) {
      try { const r = await launcher.get(`/services/${svc}/projects`); setProjCache((c) => ({ ...c, [svc]: r.data })) }
      catch { setProjCache((c) => ({ ...c, [svc]: [] })) }
    }
  }

  if (!me) return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-small,12px)' }}>{msg || '…'}</div>

  const verifyText = (ago, left) => (ago == null ? L('미인증', 'unverified')
    : L(`인증 ${ago}일 전 · ${left}일 남음`, `verified ${ago}d ago · ${left}d left`))
  const verifyChip = me.verification_current
    ? <span style={{ ...badge, background: 'var(--ok-bg, #e6f4ea)', color: 'var(--ok-text, #2f9e44)' }}>{verifyText(me.verify_days_ago, me.verify_days_left)}</span>
    : <span style={{ ...badge, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}{me.verify_days_ago != null ? ` (${me.verify_days_ago}d)` : ''}</span>
  const grpBadge = { ...badge, background: 'var(--btn-primary-bg)', color: '#fff' }

  const MENU = settingsMenu(isManager, lang)
  const menuBtn = ([key, icon, label]) => {
    const on = tab === key
    return (
      <button key={key} type="button" onClick={() => setTab(key)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '7px 4px', cursor: 'pointer', fontSize: 'var(--fs-small, 12px)',
        border: 'none', background: 'transparent',
        color: on ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: on ? 600 : 400,
        textDecoration: on ? 'underline' : 'none', textUnderlineOffset: 4, textDecorationThickness: 2,
      }}><Icon name={icon} size={15} /> {label}</button>
    )
  }

  const permChips = (list, keyPrefix) => list.map((p, i) => (
    <span key={keyPrefix + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>
      {p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'}{p.group ? ' · ' + p.group : ''}
    </span>
  ))

  const MyAccount = (
    <div style={{ ...card, ...fieldGrid }}>
      {/* Identity only — avatar/email/role/verified live in their own fields below. */}
      <Field label={L('계정', 'Account')}>
        <b>{me.display_name || me.username}</b>
        <span style={{ color: 'var(--text-muted)' }}>@{me.username}</span>
        {(me.groups || []).map((g) => (
          <span key={g.id} style={fieldChip}><GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}</span>
        ))}
      </Field>

      <Field label={L('프로필 아바타', 'Profile avatar')} align="start">
        <ProfileEditor me={me} onSaved={load} />
      </Field>

      {/* my access + what I administer (#5) */}
      <Field label={L('내 접근 권한', 'My access')} align="start">
        {((me.permissions || []).length + (me.inherited_permissions || []).length) === 0
          ? <span style={fieldMuted}>{L('접근 가능한 서비스 없음', 'no access yet')}</span>
          : <>{permChips(me.permissions || [], 'd')}{permChips(me.inherited_permissions || [], 'g')}</>}
      </Field>
      {(me.role === 'manager' || (me.admin_scopes || []).length > 0) && (
        <Field label={L('내 관리 범위', 'I administer')} align="start">
          {me.role === 'manager'
            ? L('전체 (관리자)', 'everything (manager)')
            : permChips(me.admin_scopes || [], 'a')}
        </Field>
      )}

      <Field label={L('표시 이름', 'Display name')}>
        <input value={dname} onChange={(e) => setDname(e.target.value)} placeholder={me.username} style={{ ...input, flex: 1 }}
          onKeyDown={(e) => e.key === 'Enter' && changeName()}
          name="portal-display-name" autoComplete="off" data-1p-ignore data-lpignore="true" />
      </Field>
      <FieldActions>
        <Button size="sm" variant="secondary" disabled={dname.trim() === (me.display_name || me.username || '')} onClick={changeName}>{L('변경', 'Update')}</Button>
        <span style={fieldMuted}>{L(`로그인 아이디: ${me.username} (변경 불가)`, `Login ID: ${me.username} (fixed)`)}</span>
      </FieldActions>

      {isManager && (
        <>
          <Field label={L('이메일 인증', 'Email verification')}>
            {me.verification_current
              ? <span style={fieldMuted}>{L('인증됨', 'verified')}</span>
              : <span style={{ color: 'var(--danger-text)' }}>{L('인증이 만료되어 프로젝트는 보기 전용입니다.', 'Verification lapsed — projects are view-only.')}</span>}
          </Field>
          <FieldActions>
            <Button size="sm" variant={me.verification_current ? 'secondary' : 'primary'} onClick={reverify}>{L('인증 요청 (임시)', 'Request verification (temp)')}</Button>
          </FieldActions>
        </>
      )}

      <Field label={L('초대 코드 (프로젝트/그룹)', 'Invite code (project/group)')}>
        <input value={f.code} onChange={setField('code')} placeholder="XXXXXXXX" style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && redeem()}
          name="portal-invite-code" autoComplete="off" data-1p-ignore data-lpignore="true" />
      </Field>
      <FieldActions>
        <Button size="sm" variant="primary" disabled={!f.code.trim()} onClick={redeem}>{L('등록', 'Redeem')}</Button>
      </FieldActions>

      <Field label={L('비밀번호 변경', 'Change password')}>
        <input type="password" value={f.cur} onChange={setField('cur')} placeholder={L('현재', 'current')} style={{ ...input, flex: 1 }}
          name="portal-cur-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
        <input type="password" value={f.npw} onChange={setField('npw')} placeholder={L('새 비밀번호', 'new')} style={{ ...input, flex: 1 }}
          name="portal-new-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
      </Field>
      <FieldActions>
        <Button size="sm" variant="secondary" disabled={!f.cur || !f.npw} onClick={changePw}>{L('변경', 'Update')}</Button>
      </FieldActions>

      <Field label={L('이메일', 'Email')}>
        <span style={{ color: 'var(--text-muted)' }}>{me.email}</span>
        {verifyChip}
        {me.pending_email && <span style={fieldChip}>{L('변경대기', 'pending')}: {me.pending_email}</span>}
      </Field>

      <Field label={L('이메일 변경', 'Change email')}>
        <input value={f.email} onChange={setField('email')} placeholder={L('새 이메일 (관리자 승인)', 'new email (admin-approved)')} style={{ ...input, flex: 1 }}
          name="portal-new-email" autoComplete="off" data-1p-ignore data-lpignore="true" />
      </Field>
      <FieldActions>
        <Button size="sm" variant="secondary" disabled={!f.email.trim()} onClick={requestEmail}>{L('요청', 'Request')}</Button>
      </FieldActions>

      <Field label={L('계정 삭제', 'Delete account')} />
      <FieldActions>
        <Button size="sm" variant="dangerSoft" onClick={deleteSelf}>{L('계정 삭제', 'Delete account')}</Button>
      </FieldActions>
    </div>
  )

  const Accounts = (
    <div>
      {requests.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...FIELD_TEXT, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 6px' }}>{L('접근 요청', 'Access requests')}</div>
          {requests.map((r) => (
            <div key={r.id} style={{ ...rowS, padding: '7px 12px', border: '1px solid var(--border-default)', borderRadius: 8, marginBottom: 6 }}>
              <span style={FIELD_TEXT}><b>{r.username}</b> → <span style={{ fontFamily: 'var(--font-mono)' }}>{r.service}{r.project ? '/' + r.project : ''}</span></span>
              <div style={{ flex: 1 }} />
              <Button size="sm" variant="primary" onClick={() => resolveReq(r.id, 'approve')}>{L('승인', 'Approve')}</Button>
              <Button size="sm" variant="ghost" onClick={() => resolveReq(r.id, 'reject')}>{L('거절', 'Reject')}</Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={{ ...FIELD_TEXT, color: 'var(--text-secondary)' }}>{L('그룹별 보기', 'By group')}</span>
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={{ ...input, height: 28, maxWidth: 200 }}>
          <option value="">{L('전체', 'all')}</option>
          {Array.from(new Map(users.flatMap((u) => u.groups || []).map((g) => [g.id, g])).values())
            .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      {users.filter((u) => u.id !== me.id)
        .filter((u) => !groupFilter || (u.groups || []).some((g) => String(g.id) === String(groupFilter)))
        .map((u) => (
        <ExpandBox key={u.id} open={openUser === u.id}
          onToggle={() => setOpenUser(openUser === u.id ? null : u.id)}
          style={{ opacity: u.is_active === false ? 0.6 : 1 }}
          icon={<Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={26} />}
          title={u.username}
          badges={<>
            <span style={badge}>{u.role}</span>
            {u.is_active === false && <span style={{ ...badge, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{L('비활성', 'inactive')}</span>}
          </>}
        >
            <div style={{ padding: '12px 14px', ...fieldGrid }}>
              <Field label={L('이메일 · 인증', 'Email · verification')}>
                {u.email} · {u.verification_current === false ? <span style={{ color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}</span>
                  : (u.verify_days_left != null ? L(`인증됨 · ${u.verify_days_left}일 남음`, `verified · ${u.verify_days_left}d left`) : L('미인증', 'unverified'))}
              </Field>
              <FieldActions>
                <Button size="sm" variant="secondary" onClick={() => adminRequestVerify(u)}>{L('메일 인증 요청', 'Request verification')}</Button>
                <Button size="sm" variant="secondary" onClick={() => adminVerify(u)}>{L('매니저 인증', 'Verify')}</Button>
              </FieldActions>

              {u.pending_email && (
                <>
                  <Field label={L('이메일 변경 대기', 'Pending email change')}>{u.pending_email}</Field>
                  <FieldActions>
                    <Button size="sm" variant="primary" onClick={() => adminApprove(u, true)}>{L('승인', 'Approve')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => adminApprove(u, false)}>{L('거절', 'Reject')}</Button>
                  </FieldActions>
                </>
              )}

              <Field label={L('역할', 'Role')}><b>{u.role}</b></Field>
              <FieldActions>
                <Button size="sm" variant="secondary" onClick={() => adminRole(u)}>{u.role === 'manager' ? L('매니저 해제', 'Revoke manager') : L('매니저 부여', 'Grant manager')}</Button>
              </FieldActions>

              <Field label={L('그룹', 'Groups')} align="start">
                {(u.groups || []).length === 0
                  ? <span style={fieldMuted}>—</span>
                  : (u.groups || []).map((g) => (
                      <span key={g.id} style={fieldChip}>
                        <GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}
                        <Button size="sm" variant="ghost" icon onClick={() => removeFromGroup(u, g)} title={L('제외', 'Remove')} style={{ minWidth: 0, padding: '0 2px' }}>✕</Button>
                      </span>
                    ))}
              </Field>

              {/* service permissions — direct grants vs group-inherited, shown separately */}
              <Field label={L('직접 부여 권한', 'Direct permissions')} align="start">
                {(u.permissions || []).length === 0
                  ? <span style={fieldMuted}>{L('직접 부여된 권한 없음', 'no direct grants')}</span>
                  : permChips(u.permissions || [], 'd')}
              </Field>
              <Field label={L('그룹 상속 권한', 'Inherited (group) permissions')} align="start">
                {(u.inherited_permissions || []).length === 0
                  ? <span style={fieldMuted}>{L('그룹에서 상속받은 권한 없음', 'no inherited grants')}</span>
                  : permChips(u.inherited_permissions || [], 'g')}
              </Field>

              {/* scoped (service/project) admin grants */}
              <Field label={L('관리 권한 (서비스/프로젝트)', 'Admin (service / project)')} align="start">
                {(u.permissions || []).filter((p) => p.admin).length === 0 && (u.inherited_permissions || []).filter((p) => p.admin).length === 0
                  ? <span style={fieldMuted}>{L('부여된 관리 권한 없음', 'no admin grants')}</span>
                  : <>
                      {(u.permissions || []).filter((p) => p.admin).map((p, i) => (
                        <span key={'d' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'}
                          <Button size="sm" variant="ghost" icon onClick={() => revokeScopedAdmin(u, p)} title={L('해제', 'Revoke')} style={{ minWidth: 0, padding: '0 2px' }}>✕</Button>
                        </span>
                      ))}
                      {/* group-inherited admin: revoked from the group, not per-user — no ✕ here */}
                      {(u.inherited_permissions || []).filter((p) => p.admin).map((p, i) => (
                        <span key={'g' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }} title={L('그룹에서 상속됨', 'inherited from group')}>
                          {p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'} · {p.group}
                        </span>
                      ))}
                    </>}
              </Field>
              {openUser === u.id && (
                <FieldActions>
                  <select value={agrant.svc} onChange={(e) => agrantPickSvc(e.target.value)} style={{ ...input, height: 28, maxWidth: 180 }}>
                    <option value="">{L('서비스 선택', 'service…')}</option>
                    {services.map((s) => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
                  </select>
                  <select value={agrant.proj} onChange={(e) => setAgrant((s) => ({ ...s, proj: e.target.value }))} disabled={!agrant.svc} style={{ ...input, height: 28, flex: 1, minWidth: 140 }}>
                    <option value="">{L('전체 (서비스 전체)', 'all (whole service)')}</option>
                    {(projCache[agrant.svc] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
                  </select>
                  <Button size="sm" variant="secondary" disabled={!agrant.svc} onClick={() => grantScopedAdmin(u)}>{L('관리자 부여', 'Grant admin')}</Button>
                </FieldActions>
              )}

              <Field label={L('비밀번호', 'Password')} />
              <FieldActions>
                <Button size="sm" variant="secondary" onClick={() => adminResetPwEmail(u)}>{L('이메일로 새 비번 발송', 'Change password via email')}</Button>
                <Button size="sm" variant="secondary" onClick={() => adminSetPw(u)}>{L('비밀번호 직접 설정', 'Set password')}</Button>
              </FieldActions>

              <Field label={L('계정', 'Account')} />
              <FieldActions>
                <Button size="sm" variant="ghost" onClick={() => adminActive(u)}>{u.is_active === false ? L('활성화', 'Activate') : L('비활성화', 'Deactivate')}</Button>
                <Button size="sm" variant="dangerSoft" onClick={() => adminDelete(u)}><Icon name="trash" size={14} /> {L('계정 삭제', 'Delete account')}</Button>
              </FieldActions>
            </div>
        </ExpandBox>
      ))}
      {users.filter((u) => u.id !== me.id).length === 0 && <div style={fieldMuted}>{L('다른 계정 없음', 'no other accounts')}</div>}
    </div>
  )

  const content = tab === 'me' ? MyAccount
    : tab === 'feedback' ? <FeedbackView isManager={isManager} />
    : tab === 'accounts' ? Accounts
    : tab === 'groups' ? <GroupsAdmin users={users} services={services} onChanged={load} />
    : tab === 'invites' ? <InvitesAdmin services={services} onChanged={load} />
    : tab === 'system' ? <SystemAdmin />
    : tab === 'handshake' ? <GuideView onChanged={onChanged} />
    : MyAccount

  return (
    <div>
      {pwAsk && (
        <PwPrompt title={pwAsk.title} confirmLabel={L('확인', 'OK')} cancelLabel={L('취소', 'Cancel')}
          onSubmit={(v) => { pwAsk.resolve(v); setPwAsk(null) }}
          onCancel={() => { pwAsk.resolve(null); setPwAsk(null) }} />
      )}
      {msg && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', marginBottom: 8 }}>{msg}</div>}
      {/* Narrow: the header button is icon-only, so name the current section here. */}
      {hideMenu && (() => {
        const cur = MENU.find(([k]) => k === tab) || MENU[0]
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 10px',
            fontSize: 'var(--fs-medium, 14px)', fontWeight: 600, color: 'var(--text-primary)' }}>
            <Icon name={cur[1]} size={16} /> {cur[2]}
          </div>
        )
      })()}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Narrow screens drop the sidebar — the header's settings dropdown navigates. */}
        {!hideMenu && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150, flexShrink: 0,
            borderRight: '1px solid var(--border-subtle)', paddingRight: 8 }}>
            {MENU.map(menuBtn)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
      </div>
    </div>
  )
}
