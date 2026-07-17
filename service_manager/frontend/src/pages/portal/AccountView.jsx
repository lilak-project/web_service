import { useEffect, useState } from 'react'
import { Button, Icon, Avatar } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import GroupsAdmin from './GroupsAdmin'
import InvitesAdmin from './InvitesAdmin'
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
const badge = { fontSize: 'var(--fs-micro, 10px)', padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)' }
const fieldLbl = { minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }
const secLbl = { fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', marginBottom: 4 }   // group-style section label
const line = { fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }                 // section body text (consistent)
const actions = { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }                         // buttons on their own left-aligned line
const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-micro, 10px)', padding: '2px 4px 2px 8px', borderRadius: 999, border: '1px solid var(--border-default)', background: 'var(--surface)' }
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
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-primary)', marginBottom: 10 }}>{title}</div>
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

export default function AccountView({ isManager, onChanged, onAccountGone }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [services, setServices] = useState([])
  const [requests, setRequests] = useState([])
  const [groupFilter, setGroupFilter] = useState('')
  const [tab, setTab] = useState('me')                 // 'me' | 'accounts' | 'groups' | 'invites'
  const [msg, setMsg] = useState('')
  const [f, setF] = useState({ code: '', cur: '', npw: '', email: '' })
  const [dname, setDname] = useState('')               // display-name edit field (login id stays fixed)
  const [openUser, setOpenUser] = useState(null)       // accounts: expanded user id
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
  const adminRole = (u) => { const to = u.role === 'manager' ? 'user' : 'manager'; run(launcher.post(`/admin/users/${u.id}/role`, { role: to }), () => L(`${u.username} → ${to}`, `${u.username} → ${to}`)) }
  const adminActive = (u) => run(launcher.post(`/admin/users/${u.id}/active`, { active: u.is_active === false }), () => L(u.is_active === false ? '활성화됨' : '비활성화됨', u.is_active === false ? 'activated' : 'deactivated'))
  const removeFromGroup = (u, g) => run(launcher.delete(`/admin/groups/${g.id}/members/${u.id}`), () => L(`${g.name}에서 제외됨`, `removed from ${g.name}`))
  const resolveReq = (rid, action) => run(launcher.post(`/admin/access-requests/${rid}`, { action }), () => action === 'approve' ? L('승인됨', 'approved') : L('거절됨', 'rejected'))

  if (!me) return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-small,12px)' }}>{msg || '…'}</div>

  const verifyText = (ago, left) => (ago == null ? L('미인증', 'unverified')
    : L(`인증 ${ago}일 전 · ${left}일 남음`, `verified ${ago}d ago · ${left}d left`))
  const verifyChip = me.verification_current
    ? <span style={{ ...badge, background: 'var(--ok-bg, #e6f4ea)', color: 'var(--ok-text, #2f9e44)' }}>{verifyText(me.verify_days_ago, me.verify_days_left)}</span>
    : <span style={{ ...badge, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}{me.verify_days_ago != null ? ` (${me.verify_days_ago}d)` : ''}</span>
  const grpBadge = { ...badge, background: 'var(--btn-primary-bg)', color: '#fff' }

  const MENU = [
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

  const MyAccount = (
    <div style={card}>
      <div style={{ ...rowS, marginBottom: 10 }}>
        <Avatar icon={me.profile_shape} color={me.profile_color} seed={me.username} size={26} />
        <b style={{ fontSize: 'var(--fs-body, 13px)' }}>{me.display_name || me.username}</b>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>@{me.username}</span>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{me.email}</span>
        <span style={badge}>{me.role}</span>
        {verifyChip}
        {(me.groups || []).map((g) => <span key={g.id} style={{ ...badge, display: 'inline-flex', alignItems: 'center', gap: 4 }}><GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}</span>)}
        {me.pending_email && <span style={badge}>{L('변경대기', 'pending')}: {me.pending_email}</span>}
      </div>

      <div style={{ marginBottom: 10 }}><ProfileEditor me={me} onSaved={load} /></div>

      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={fieldLbl}>{L('표시 이름', 'Display name')}</span>
        <input value={dname} onChange={(e) => setDname(e.target.value)} placeholder={me.username} style={{ ...input, flex: 1 }}
          onKeyDown={(e) => e.key === 'Enter' && changeName()}
          name="portal-display-name" autoComplete="off" data-1p-ignore data-lpignore="true" />
        <Button size="sm" variant="secondary" disabled={dname.trim() === (me.display_name || me.username || '')} onClick={changeName}>{L('변경', 'Update')}</Button>
        <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', flexBasis: '100%' }}>{L(`로그인 아이디: ${me.username} (변경 불가)`, `Login ID: ${me.username} (fixed)`)}</span>
      </div>

      {isManager && (
        <div style={{ ...rowS, marginBottom: 10 }}>
          <span style={fieldLbl}>{L('이메일 인증', 'Email verification')}</span>
          {!me.verification_current && (
            <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{L('인증이 만료되어 프로젝트는 보기 전용입니다.', 'Verification lapsed — projects are view-only.')}</span>
          )}
          <Button size="sm" variant={me.verification_current ? 'secondary' : 'primary'} onClick={reverify}>{L('인증 요청 (임시)', 'Request verification (temp)')}</Button>
        </div>
      )}
      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={fieldLbl}>{L('초대 코드 (프로젝트/그룹)', 'Invite code (project/group)')}</span>
        <input value={f.code} onChange={setField('code')} placeholder="XXXXXXXX" style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && redeem()}
          name="portal-invite-code" autoComplete="off" data-1p-ignore data-lpignore="true" />
        <Button size="sm" variant="primary" disabled={!f.code.trim()} onClick={redeem}>{L('등록', 'Redeem')}</Button>
      </div>
      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={fieldLbl}>{L('비밀번호 변경', 'Change password')}</span>
        <input type="password" value={f.cur} onChange={setField('cur')} placeholder={L('현재', 'current')} style={{ ...input, flex: 1 }}
          name="portal-cur-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
        <input type="password" value={f.npw} onChange={setField('npw')} placeholder={L('새 비밀번호', 'new')} style={{ ...input, flex: 1 }}
          name="portal-new-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
        <Button size="sm" variant="secondary" disabled={!f.cur || !f.npw} onClick={changePw}>{L('변경', 'Update')}</Button>
      </div>
      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={fieldLbl}>{L('이메일 변경', 'Change email')}</span>
        <input value={f.email} onChange={setField('email')} placeholder={L('새 이메일 (관리자 승인)', 'new email (admin-approved)')} style={{ ...input, flex: 1 }}
          name="portal-new-email" autoComplete="off" data-1p-ignore data-lpignore="true" />
        <Button size="sm" variant="secondary" disabled={!f.email.trim()} onClick={requestEmail}>{L('요청', 'Request')}</Button>
      </div>
      <div style={{ ...rowS, marginTop: 10 }}>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="dangerSoft" onClick={deleteSelf}>{L('계정 삭제', 'Delete account')}</Button>
      </div>
    </div>
  )

  const Accounts = (
    <div>
      {requests.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 6px' }}>{L('접근 요청', 'Access requests')}</div>
          {requests.map((r) => (
            <div key={r.id} style={{ ...rowS, padding: '7px 12px', border: '1px solid var(--border-default)', borderRadius: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 'var(--fs-small, 12px)' }}><b>{r.username}</b> → <span style={{ fontFamily: 'var(--font-mono)' }}>{r.service}{r.project ? '/' + r.project : ''}</span></span>
              <div style={{ flex: 1 }} />
              <Button size="sm" variant="primary" onClick={() => resolveReq(r.id, 'approve')}>{L('승인', 'Approve')}</Button>
              <Button size="sm" variant="ghost" onClick={() => resolveReq(r.id, 'reject')}>{L('거절', 'Reject')}</Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ ...rowS, marginBottom: 8 }}>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('그룹별 보기', 'By group')}</span>
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
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* verification */}
              <div>
                <div style={secLbl}>{L('이메일 · 인증', 'Email · verification')}</div>
                <div style={line}>{u.email} · {u.verification_current === false ? <span style={{ color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}</span>
                  : (u.verify_days_left != null ? L(`인증됨 · ${u.verify_days_left}일 남음`, `verified · ${u.verify_days_left}d left`) : L('미인증', 'unverified'))}</div>
                <div style={actions}>
                  <Button size="sm" variant="secondary" onClick={() => adminRequestVerify(u)}>{L('메일 인증 요청', 'Request verification')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => adminVerify(u)}>{L('매니저 인증', 'Verify')}</Button>
                </div>
              </div>
              {/* pending email change */}
              {u.pending_email && (
                <div>
                  <div style={secLbl}>{L('이메일 변경 대기', 'Pending email change')}</div>
                  <div style={line}>{u.pending_email}</div>
                  <div style={actions}>
                    <Button size="sm" variant="primary" onClick={() => adminApprove(u, true)}>{L('승인', 'Approve')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => adminApprove(u, false)}>{L('거절', 'Reject')}</Button>
                  </div>
                </div>
              )}
              {/* role */}
              <div>
                <div style={secLbl}>{L('역할', 'Role')}</div>
                <div style={line}><b>{u.role}</b></div>
                <div style={actions}>
                  <Button size="sm" variant="secondary" onClick={() => adminRole(u)}>{u.role === 'manager' ? L('매니저 해제', 'Revoke manager') : L('매니저 부여', 'Grant manager')}</Button>
                </div>
              </div>
              {/* groups — chips (like the groups admin) */}
              <div>
                <div style={secLbl}>{L('그룹', 'Groups')}</div>
                {(u.groups || []).length === 0
                  ? <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>—</span>
                  : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(u.groups || []).map((g) => (
                        <span key={g.id} style={chip}>
                          <GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}
                          <Button size="sm" variant="ghost" icon onClick={() => removeFromGroup(u, g)} title={L('제외', 'Remove')} style={{ minWidth: 0, padding: '0 2px' }}>✕</Button>
                        </span>
                      ))}
                    </div>}
              </div>
              {/* service permissions — direct grants vs group-inherited, shown separately */}
              <div>
                <div style={secLbl}>{L('직접 부여 권한', 'Direct permissions')}</div>
                {(u.permissions || []).length === 0
                  ? <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{L('직접 부여된 권한 없음', 'no direct grants')}</span>
                  : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(u.permissions || []).map((p, i) => (
                        <span key={i} style={{ ...badge, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'}</span>
                      ))}
                    </div>}
              </div>
              <div>
                <div style={secLbl}>{L('그룹 상속 권한', 'Inherited (group) permissions')}</div>
                {(u.inherited_permissions || []).length === 0
                  ? <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{L('그룹에서 상속받은 권한 없음', 'no inherited grants')}</span>
                  : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(u.inherited_permissions || []).map((p, i) => (
                        <span key={i} style={{ ...badge, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + L('전체', 'all') + ')'}{p.group ? ` · ${p.group}` : ''}</span>
                      ))}
                    </div>}
              </div>
              {/* password */}
              <div>
                <div style={secLbl}>{L('비밀번호', 'Password')}</div>
                <div style={actions}>
                  <Button size="sm" variant="secondary" onClick={() => adminResetPwEmail(u)}>{L('이메일로 새 비번 발송', 'Change password via email')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => adminSetPw(u)}>{L('비밀번호 직접 설정', 'Set password')}</Button>
                </div>
              </div>
              {/* deactivate / delete — own left-aligned row */}
              <div style={{ ...actions, borderTop: '1px solid var(--border-subtle)', paddingTop: 10, marginTop: 0 }}>
                <Button size="sm" variant="ghost" onClick={() => adminActive(u)}>{u.is_active === false ? L('활성화', 'Activate') : L('비활성화', 'Deactivate')}</Button>
                <Button size="sm" variant="dangerSoft" onClick={() => adminDelete(u)}><Icon name="trash" size={14} /> {L('계정 삭제', 'Delete account')}</Button>
              </div>
            </div>
        </ExpandBox>
      ))}
      {users.filter((u) => u.id !== me.id).length === 0 && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('다른 계정 없음', 'no other accounts')}</div>}
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
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150, flexShrink: 0,
          borderRight: '1px solid var(--border-subtle)', paddingRight: 8 }}>
          {MENU.map(menuBtn)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
      </div>
    </div>
  )
}
