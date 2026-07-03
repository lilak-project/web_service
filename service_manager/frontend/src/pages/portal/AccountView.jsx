import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import GroupsAdmin from './GroupsAdmin'
import InvitesAdmin from './InvitesAdmin'
import ProfileEditor from './ProfileEditor'

/**
 * AccountView — account settings, visible to every signed-in account (replaces
 * the old admin-only Users screen).
 *
 * Self-service (everyone): redeem a project invite code, change password, request
 * an email change (admin-approved), re-verify email (yearly), delete the account.
 * Admins additionally get a list of all accounts with the same controls plus
 * email-change approval. Per-project permissions live in the Services screen.
 */

const sectionHdr = { fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', margin: '16px 0 8px' }
const card = { border: '1px solid var(--border-default)', borderRadius: 8, padding: 12, marginBottom: 10 }
const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const input = { height: 32, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 10px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)', minWidth: 0 }
const badge = { fontSize: 'var(--fs-micro, 10px)', padding: '1px 7px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)' }

export default function AccountView({ isManager, onChanged, onAccountGone }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [services, setServices] = useState([])
  const [requests, setRequests] = useState([])
  const [groupFilter, setGroupFilter] = useState('')   // '' = all; otherwise group id
  const [adminTab, setAdminTab] = useState('accounts')  // 'accounts' | 'groups' | 'invites'
  const [msg, setMsg] = useState('')
  const [f, setF] = useState({ code: '', cur: '', npw: '', email: '' })
  const setField = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

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

  const say = (m) => { setMsg(m); }
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
  const requestEmail = () => f.email.trim() && run(launcher.post('/account/request-email', { new_email: f.email.trim() }),
    () => { setF((s) => ({ ...s, email: '' })); return L('이메일 변경 요청됨 (관리자 승인 대기)', 'email change requested (awaiting admin)') })
  const reverify = () => run(launcher.post('/account/verify'), () => L('이메일 인증됨 (임시)', 'email verified (temp)'))
  async function deleteSelf() {
    if (!window.confirm(L('정말 계정을 삭제할까요? 되돌릴 수 없습니다.', 'Delete your account? This cannot be undone.'))) return
    try { await launcher.delete('/account'); onAccountGone?.() } catch (e) { say(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  // ── admin actions on a user ──
  const adminSetPw = (u) => { const p = window.prompt(L(`${u.username}의 새 비밀번호`, `New password for ${u.username}`)); if (p) run(launcher.post(`/admin/users/${u.id}/password`, { new_password: p }), () => L('비밀번호 재설정됨', 'password reset')) }
  const adminVerify = (u) => run(launcher.post(`/admin/users/${u.id}/verify`), () => L(`${u.username} 인증됨`, `${u.username} verified`))
  const adminApprove = (u, approve) => run(launcher.post(`/admin/users/${u.id}/approve-email`, { approve }), () => approve ? L('이메일 변경 승인됨', 'email approved') : L('거절됨', 'rejected'))
  const adminDelete = (u) => { if (window.confirm(L(`${u.username} 계정을 삭제할까요?`, `Delete ${u.username}?`))) run(launcher.delete(`/admin/users/${u.id}`), () => L('삭제됨', 'deleted')) }
  const resolveReq = (rid, action) => run(launcher.post(`/admin/access-requests/${rid}`, { action }), () => action === 'approve' ? L('승인됨', 'approved') : L('거절됨', 'rejected'))

  if (!me) return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-small,12px)' }}>{msg || '…'}</div>

  const verifyText = (ago, left) => (ago == null ? L('미인증', 'unverified')
    : L(`인증 ${ago}일 전 · ${left}일 남음`, `verified ${ago}d ago · ${left}d left`))
  const verifyChip = me.verification_current
    ? <span style={{ ...badge, background: 'var(--ok-bg, #e6f4ea)', color: 'var(--ok-text, #2f9e44)' }}>{verifyText(me.verify_days_ago, me.verify_days_left)}</span>
    : <span style={{ ...badge, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}{me.verify_days_ago != null ? ` (${me.verify_days_ago}d)` : ''}</span>
  const grpBadge = { ...badge, background: 'var(--btn-primary-bg)', color: '#fff' }

  return (
    <div>
      {msg && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', marginBottom: 8 }}>{msg}</div>}

      {/* ── my account ── */}
      <div style={sectionHdr}>{L('내 계정', 'My account')}</div>
      <div style={card}>
        <div style={{ ...rowS, marginBottom: 10 }}>
          <Icon name="user" size={15} />
          <b style={{ fontSize: 'var(--fs-body, 13px)' }}>{me.username}</b>
          <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{me.email}</span>
          <span style={badge}>{me.role}</span>
          {verifyChip}
          {(me.groups || []).map((g) => <span key={g.id} style={grpBadge}>{g.name}</span>)}
          {me.pending_email && <span style={badge}>{L('변경대기', 'pending')}: {me.pending_email}</span>}
        </div>

        {/* profile avatar (shared with elog via SSO) */}
        <div style={{ marginBottom: 10 }}>
          <ProfileEditor me={me} onSaved={load} />
        </div>

        {/* email verification — request anytime; required yearly to keep entering */}
        <div style={{ ...rowS, marginBottom: 10 }}>
          <span style={{ minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('이메일 인증', 'Email verification')}</span>
          {!me.verification_current && (
            <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{L('인증이 만료되어 프로젝트는 보기 전용입니다.', 'Verification lapsed — projects are view-only.')}</span>
          )}
          <Button size="sm" variant={me.verification_current ? 'secondary' : 'primary'} onClick={reverify}>
            {L('인증 요청 (임시)', 'Request verification (temp)')}
          </Button>
        </div>

        {/* redeem invite code */}
        <div style={{ ...rowS, marginBottom: 8 }}>
          <span style={{ minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('초대 코드 (프로젝트/그룹)', 'Invite code (project/group)')}</span>
          <input value={f.code} onChange={setField('code')} placeholder="XXXXXXXX" style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && redeem()} />
          <Button size="sm" variant="primary" disabled={!f.code.trim()} onClick={redeem}>{L('등록', 'Redeem')}</Button>
        </div>

        {/* change password */}
        <div style={{ ...rowS, marginBottom: 8 }}>
          <span style={{ minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('비밀번호 변경', 'Change password')}</span>
          <input type="password" value={f.cur} onChange={setField('cur')} placeholder={L('현재', 'current')} style={{ ...input, flex: 1 }} />
          <input type="password" value={f.npw} onChange={setField('npw')} placeholder={L('새 비밀번호', 'new')} style={{ ...input, flex: 1 }} />
          <Button size="sm" variant="secondary" disabled={!f.cur || !f.npw} onClick={changePw}>{L('변경', 'Update')}</Button>
        </div>

        {/* request email change */}
        <div style={{ ...rowS, marginBottom: 8 }}>
          <span style={{ minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('이메일 변경', 'Change email')}</span>
          <input value={f.email} onChange={setField('email')} placeholder={L('새 이메일 (관리자 승인)', 'new email (admin-approved)')} style={{ ...input, flex: 1 }} />
          <Button size="sm" variant="secondary" disabled={!f.email.trim()} onClick={requestEmail}>{L('요청', 'Request')}</Button>
        </div>

        <div style={{ ...rowS, marginTop: 10 }}>
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="dangerSoft" onClick={deleteSelf}>{L('계정 삭제', 'Delete account')}</Button>
        </div>
      </div>

      {/* ── admin: pending access requests ── */}
      {isManager && requests.length > 0 && (
        <>
          <div style={sectionHdr}>{L('접근 요청', 'Access requests')}</div>
          {requests.map((r) => (
            <div key={r.id} style={{ ...rowS, padding: '7px 12px', border: '1px solid var(--border-default)', borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--fs-small, 12px)' }}>
                <b>{r.username}</b> → <span style={{ fontFamily: 'var(--font-mono)' }}>{r.service}{r.project ? '/' + r.project : ''}</span>
              </span>
              <div style={{ flex: 1 }} />
              <Button size="sm" variant="primary" onClick={() => resolveReq(r.id, 'approve')}>{L('승인', 'Approve')}</Button>
              <Button size="sm" variant="ghost" onClick={() => resolveReq(r.id, 'reject')}>{L('거절', 'Reject')}</Button>
            </div>
          ))}
        </>
      )}

      {/* ── admin area: accounts / groups / invite codes ── */}
      {isManager && (
        <>
          <div style={{ ...sectionHdr, display: 'flex', alignItems: 'center', gap: 6 }}>
            {[['accounts', L('계정', 'Accounts')], ['groups', L('그룹', 'Groups')], ['invites', L('초대 코드', 'Invite codes')]].map(([k, lbl]) => (
              <Button key={k} size="sm" variant={adminTab === k ? 'secondary' : 'ghost'} onClick={() => setAdminTab(k)}
                style={{ border: adminTab === k ? '1.5px solid var(--btn-primary-bg)' : '1.5px solid transparent' }}>{lbl}</Button>
            ))}
          </div>

          {adminTab === 'groups' && <GroupsAdmin users={users} services={services} onChanged={load} />}
          {adminTab === 'invites' && <InvitesAdmin services={services} onChanged={load} />}
          {adminTab === 'accounts' && (
            <>
              {/* view accounts by group */}
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
                <div key={u.id} style={card}>
                  <div style={{ ...rowS, marginBottom: 8 }}>
                    <Icon name="user" size={14} />
                    <b style={{ fontSize: 'var(--fs-small, 13px)' }}>{u.username}</b>
                    <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{u.email}</span>
                    <span style={badge}>{u.role}</span>
                    {u.verification_current === false
                      ? <span style={{ ...badge, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{L('재인증 필요', 're-verify')}</span>
                      : (u.verify_days_left != null && <span style={badge}>{L(`${u.verify_days_left}일 남음`, `${u.verify_days_left}d left`)}</span>)}
                    {(u.groups || []).map((g) => <span key={g.id} style={grpBadge}>{g.name}</span>)}
                    {u.pending_email && <span style={badge}>{L('변경대기', 'pending')}: {u.pending_email}</span>}
                  </div>
                  <div style={rowS}>
                    <Button size="sm" variant="ghost" onClick={() => adminSetPw(u)}>{L('비번 재설정', 'Set password')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => adminVerify(u)}>{L('인증 처리', 'Verify')}</Button>
                    {u.pending_email && <>
                      <Button size="sm" variant="primary" onClick={() => adminApprove(u, true)}>{L('이메일 승인', 'Approve email')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => adminApprove(u, false)}>{L('거절', 'Reject')}</Button>
                    </>}
                    <div style={{ flex: 1 }} />
                    <Button size="sm" variant="dangerSoft" icon title={L('삭제', 'delete')} onClick={() => adminDelete(u)}><Icon name="trash" size={14} /></Button>
                  </div>
                </div>
              ))}
              {users.filter((u) => u.id !== me.id).length === 0 && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('다른 계정 없음', 'no other accounts')}</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}
