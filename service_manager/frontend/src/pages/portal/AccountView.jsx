import { useEffect, useState } from 'react'
import { Button, Icon, Avatar, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import GroupsAdmin from './GroupsAdmin'
import InvitesAdmin from './InvitesAdmin'
import { Field, FieldActions, Panel, Row, Pill, fieldGrid, fieldInput, fieldMuted, fieldChip, FIELD_TEXT, FIELD_CARD_CLASS } from './Field'
import SystemAdmin from './SystemAdmin'
import SyncAll from './SyncAll'
import { notify } from './settingsMsg'
import FeedbackView from './FeedbackView'
import GuideView from './GuideView'
import ProfileEditor from './ProfileEditor'
import GroupMark from './GroupMark'
import ExpandBox from './ExpandBox'

const LANG_NAMES = { ko: '한국어', en: 'English', ja: '日本語', zh: '中文' }

/**
 * AccountView — account settings. A LEFT vertical menu switches between sub-tabs:
 * "My account" (everyone) and, for admins, "Accounts" / "Groups" / "Invite codes".
 * (The vertical menu is intentionally distinct from the horizontal main nav tabs.)
 */

// Card chrome moved to .set-card (settings.css); this is just the gap below one.
const card = { marginBottom: 10 }
const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const input = { ...fieldInput }
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
          <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="primary" onClick={() => onSubmit(v)}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

// The settings sub-menu, shared so the header can drive it on narrow screens.
export function settingsMenu(isManager, lang) {
  return [
    ['me', 'user', tr("p_my_account")],
    ['feedback', 'chats', tr("p_feedback")],
    ...(isManager ? [
      ['accounts', 'users', tr("p_accounts")],
      ['groups', 'tree', tr("p_groups")],
      ['invites', 'key', tr("p_invite_codes")],
      ['system', 'sliders', tr("p_system")],
      ['sync', 'link', tr("p_sa_tab")],
      ['handshake', 'plug', tr("p_handshake")],
    ] : []),
  ]
}

// tab/onTab make the active sub-tab controllable from the header; hideMenu drops
// the left sidebar (the header dropdown navigates instead) on narrow screens.
export default function AccountView({ isManager, onChanged, onAccountGone, tab: tabProp, onTab, hideMenu = false }) {
  const { lang, setLang, langs } = useLang()
  async function signOutEverywhere() {
    try {
      await launcher.post('/account/sign-out-everywhere')
      window.dispatchEvent(new Event('portal:signed-out'))   // this one went too
    } catch (e) { notify(e?.response?.data?.detail || tr('p_failed'), 'bad') }
  }
  // The language is the account's: saved on it, so it follows the person.
  async function changeLang(v) {
    setLang(v)
    try { await launcher.put('/account/prefs', { lang: v }); notify(tr('p_language_saved'), 'ok') }
    catch (e) { notify(e?.response?.data?.detail || tr('p_failed'), 'bad') }
  }
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
    } catch (e) { const m = e?.response?.data?.detail || 'load failed'; setMsg(m); notify(m, 'bad') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me) setDname(me.display_name || me.username || '') }, [me?.display_name, me?.username])

  const say = (m, tone) => { setMsg(m); notify(m, tone) }
  async function run(p, ok) { try { const r = await p; say(ok(r), 'ok'); await load(); onChanged?.() } catch (e) { say(e?.response?.data?.detail || tr("p_failed"), 'bad') } }

  // ── self actions ──
  const redeem = () => f.code.trim() && run(launcher.post('/invite-codes/redeem', { code: f.code.trim() }),
    (r) => {
      setF((s) => ({ ...s, code: '' }))
      const d = r.data
      return d.kind === 'group' ? tr("p_joined_group", d.group)
        : tr("p_granted", d.service, d.project ? '/' + d.project : '')
    })
  const changePw = () => (f.cur && f.npw) && run(launcher.post('/account/password', { current_password: f.cur, new_password: f.npw }),
    (r) => {
      setF((s) => ({ ...s, cur: '', npw: '' }))
      // Every other session ended; this one carries on with the new token.
      if (r.data?.access_token) window.dispatchEvent(new CustomEvent('portal:token', { detail: r.data.access_token }))
      return tr("p_password_changed")
    })
  // Change only the display name (shown in the portal, nptoy, community). The login
  // id (username) is intentionally left fixed.
  const changeName = () => dname.trim() !== (me.display_name || me.username || '') && run(launcher.post('/account/profile', { display_name: dname.trim() || null }),
    () => tr("p_display_name_changed"))
  const requestEmail = () => f.email.trim() && run(launcher.post('/account/request-email', { new_email: f.email.trim() }),
    () => { setF((s) => ({ ...s, email: '' })); return tr("p_email_change_requested_awaiting_admin") })
  const reverify = () => run(launcher.post('/account/verify'), () => tr("p_email_verified_temp"))
  async function deleteSelf() {
    if (!window.confirm(tr("p_delete_your_account_this_cannot"))) return
    try { await launcher.delete('/account'); onAccountGone?.() } catch (e) { say(e?.response?.data?.detail || tr("p_failed"), 'bad') }
  }

  // ── admin actions on a user ──
  const adminSetPw = async (u) => { const p = await askPassword(tr("p_new_password_for", u.username)); if (p) run(launcher.post(`/admin/users/${u.id}/password`, { new_password: p }), () => tr("p_password_reset")) }
  const adminVerify = (u) => run(launcher.post(`/admin/users/${u.id}/verify`), () => tr("p_verified", u.username))
  const adminRequestVerify = (u) => run(launcher.post(`/admin/users/${u.id}/request-verify`), (r) => r.data.verify_url ? tr("p_verify_link_dev", r.data.verify_url) : tr("p_verification_requested"))
  const adminResetPwEmail = (u) => { if (!window.confirm(tr("p_issue_a_new_random_password", u.username))) return; run(launcher.post(`/admin/users/${u.id}/reset-password-email`), (r) => r.data.password ? tr("p_new_password_dev", r.data.password) : tr("p_emailed")) }
  const adminApprove = (u, approve) => run(launcher.post(`/admin/users/${u.id}/approve-email`, { approve }), () => approve ? tr("p_email_approved") : tr("p_rejected_2"))
  const adminDelete = async (u) => { const pw = await askPassword(tr("p_delete_enter_your_password_to", u.username)); if (pw == null) return; run(launcher.delete(`/admin/users/${u.id}`, { data: { password: pw } }), () => tr("p_deleted")) }
  const adminRole = (u) => {
    const to = u.role === 'manager' ? 'user' : 'manager'
    // Promoting to manager = GLOBAL admin over every service and project — warn first.
    if (to === 'manager' && !window.confirm(tr("p_promote_to_global_manager_a", u.username))) return
    run(launcher.post(`/admin/users/${u.id}/role`, { role: to }), () => tr("p_from_to", u.username, to))
  }
  const adminActive = (u) => run(launcher.post(`/admin/users/${u.id}/active`, { active: u.is_active === false }), () => (u.is_active === false ? tr('p_user_activated') : tr('p_user_deactivated')))
  const removeFromGroup = (u, g) => run(launcher.delete(`/admin/groups/${g.id}/members/${u.id}`), () => tr("p_removed_from", g.name))
  const resolveReq = (rid, action) => run(launcher.post(`/admin/access-requests/${rid}`, { action }), () => action === 'approve' ? tr("p_approved") : tr("p_rejected_2"))
  // scoped (service/project) admin: grant sets is_admin (also grants access); revoke drops admin, keeps access.
  const grantScopedAdmin = (u) => agrant.svc && run(launcher.post('/admin/permissions', { user_id: u.id, service: agrant.svc, project: agrant.proj.trim(), admin: true }), () => { setAgrant({ svc: '', proj: '' }); return tr("p_admin_granted") })
  const revokeScopedAdmin = (u, p) => run(launcher.post('/admin/permissions', { user_id: u.id, service: p.service, project: p.project || '', admin: false }), () => tr("p_admin_revoked"))
  // Selecting a service loads its project list once, for the project dropdown
  // (a single-project service 404s → empty list → only "whole service" remains).
  async function agrantPickSvc(svc) {
    setAgrant({ svc, proj: '' })
    if (svc && !projCache[svc]) {
      try { const r = await launcher.get(`/services/${svc}/projects`); setProjCache((c) => ({ ...c, [svc]: r.data })) }
      catch { setProjCache((c) => ({ ...c, [svc]: [] })) }
    }
  }

  if (!me) return <div style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-small,12px)' }}>{msg || '…'}</div>

  const verifyText = (ago, left) => (ago == null ? tr("p_unverified")
    : tr("p_verified_d_ago_d_left", ago, left))
  const verifyChip = me.verification_current
    ? <Pill tone="ok">{verifyText(me.verify_days_ago, me.verify_days_left)}</Pill>
    : <Pill tone="bad">{tr("p_re_verify")}{me.verify_days_ago != null ? ` (${me.verify_days_ago}d)` : ''}</Pill>

  const MENU = settingsMenu(isManager, lang)
  const menuBtn = ([key, icon, label]) => {
    const on = tab === key
    return (
      <button key={key} type="button" onClick={() => setTab(key)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '7px 4px', cursor: 'pointer', fontSize: 'var(--fs-medium, 14px)',
        border: 'none', background: 'transparent',
        color: on ? 'var(--text-primary)' : 'var(--text-primary)', fontWeight: on ? 600 : 400,
        textDecoration: on ? 'underline' : 'none', textUnderlineOffset: 4, textDecorationThickness: 2 }}><Icon name={icon} size={15} /> {label}</button>
    )
  }

  const permChips = (list, keyPrefix) => list.map((p, i) => (
    <span key={keyPrefix + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>
      {p.service}{p.project ? '/' + p.project : ' (' + tr("p_all") + ')'}{p.group ? ' · ' + p.group : ''}
    </span>
  ))

  const MyAccount = (
    <>
      <Panel title={tr("p_account")} hint={`@${me.username}${isManager ? ' · ' + tr("p_manager") : ''}`}>
        <Field label={tr("p_name")}>
          <span>{me.display_name || me.username}</span>
          {(me.groups || []).map((g) => (
            <span key={g.id} style={fieldChip}><GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}</span>
          ))}
        </Field>

        <Field label={tr("p_profile_avatar")} align="start">
          <ProfileEditor me={me} onSaved={load} />
        </Field>

        <Field label={tr("p_display_name")}>
          <input value={dname} onChange={(e) => setDname(e.target.value)} placeholder={me.username} style={{ ...input, flex: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && changeName()}
            name="portal-display-name" autoComplete="off" data-1p-ignore data-lpignore="true" />
        </Field>
        <FieldActions>
          <Button variant="secondary" disabled={dname.trim() === (me.display_name || me.username || '')} onClick={changeName}>{tr("p_update")}</Button>
          <span style={fieldMuted}>{tr("p_login_id_fixed", me.username)}</span>
        </FieldActions>

        <Field label={tr('p_language')}>
          {/* Each language by its own name, so it can be found in any of them. */}
          <select value={lang} onChange={(e) => changeLang(e.target.value)} style={{ ...input, flex: 'none', minWidth: 160 }}>
            {(langs || ['ko', 'en']).map((l) => <option key={l} value={l}>{LANG_NAMES[l] || l}</option>)}
          </select>
          <span style={fieldMuted}>{tr('p_language_hint')}</span>
        </Field>
      </Panel>

      <Panel title={tr("p_email_password")}>
        <Field label={tr("p_email")}>
          <span>{me.email}</span>
          {verifyChip}
          {me.pending_email && <span style={fieldChip}>{tr("p_pending")}: {me.pending_email}</span>}
        </Field>

        <Field label={tr("p_change_email")}>
          <input value={f.email} onChange={setField('email')} placeholder={tr("p_new_email_admin_approved")} style={{ ...input, flex: 1 }}
            name="portal-new-email" autoComplete="off" data-1p-ignore data-lpignore="true" />
        </Field>
        <FieldActions>
          <Button variant="secondary" disabled={!f.email.trim()} onClick={requestEmail}>{tr("p_request")}</Button>
        </FieldActions>

        {isManager && (
          <>
            <Field label={tr("p_email_verification")}>
              {me.verification_current
                ? <span>{tr("p_verified_2")}</span>
                : <span style={{ color: 'var(--danger-text)' }}>{tr("p_verification_lapsed_projects_are_view")}</span>}
            </Field>
            <FieldActions>
              <Button variant={me.verification_current ? 'secondary' : 'primary'} onClick={reverify}>{tr("p_request_verification_temp")}</Button>
            </FieldActions>
          </>
        )}

        <Field label={tr("p_change_password")}>
          <input type="password" value={f.cur} onChange={setField('cur')} placeholder={tr("p_current")} style={{ ...input, flex: 1 }}
            name="portal-cur-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
          <input type="password" value={f.npw} onChange={setField('npw')} placeholder={tr("p_new")} style={{ ...input, flex: 1 }}
            name="portal-new-pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
        </Field>
        <FieldActions>
          <Button variant="secondary" disabled={!f.cur || !f.npw} onClick={changePw}>{tr("p_update")}</Button>
        </FieldActions>

        {/* Every session this account has, here and on any other machine. */}
        <Field label={tr('p_sessions')}>
          <span style={fieldMuted}>{tr('p_sessions_hint')}</span>
        </Field>
        <FieldActions>
          <Button variant="dangerSoft" onClick={signOutEverywhere}>{tr('p_sign_out_everywhere')}</Button>
        </FieldActions>
      </Panel>

      <Panel title={tr("p_access")} hint={tr("p_granted_by_an_administrator")}>
        <Field label={tr("p_my_access")} align="start">
          {((me.permissions || []).length + (me.inherited_permissions || []).length) === 0
            ? <span style={fieldMuted}>{tr("p_no_access_yet")}</span>
            : <>{permChips(me.permissions || [], 'd')}{permChips(me.inherited_permissions || [], 'g')}</>}
        </Field>
        {(me.role === 'manager' || (me.admin_scopes || []).length > 0) && (
          <Field label={tr("p_i_administer")} align="start">
            {me.role === 'manager'
              ? tr("p_everything_manager")
              : permChips(me.admin_scopes || [], 'a')}
          </Field>
        )}

        <Field label={tr("p_invite_code")}>
          <input value={f.code} onChange={setField('code')} placeholder="XXXXXXXX" style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && redeem()}
            name="portal-invite-code" autoComplete="off" data-1p-ignore data-lpignore="true" />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!f.code.trim()} onClick={redeem}>{tr("p_add")}</Button>
          <span style={fieldMuted}>{tr("p_a_code_you_were_given")}</span>
        </FieldActions>
      </Panel>

      {/* Signing out belongs with the account, not on the cover's account card:
          it is something you do TO this account, like changing its password. */}
      <Panel danger title={tr("p_cannot_be_undone")}>
        <Field label={tr("p_delete_account")}>{tr("p_the_account_goes_what_it")}</Field>
        <FieldActions>
          <Button variant="dangerSoft" onClick={deleteSelf}>{tr("p_delete_account")}</Button>
        </FieldActions>
      </Panel>
    </>
  )


  const shownUsers = users.filter((u) => u.id !== me.id)
    .filter((u) => !groupFilter || (u.groups || []).some((g) => String(g.id) === String(groupFilter)))

  const Accounts = (
    <>
      {requests.length > 0 && (
        <Panel bare title={tr("p_access_requests")} hint={String(requests.length)}>
          {requests.map((r) => (
            <Row key={r.id}>
              <span>{r.username}</span>
              <span className="sub mono">→ {r.service}{r.project ? '/' + r.project : ''}</span>
              <span className="sp" />
              <Button variant="primary" onClick={() => resolveReq(r.id, 'approve')}>{tr("p_approve")}</Button>
              <Button variant="secondary" onClick={() => resolveReq(r.id, 'reject')}>{tr("p_reject")}</Button>
            </Row>
          ))}
        </Panel>
      )}
      <Panel bare title={tr("p_accounts")} hint={`${shownUsers.length}`}
        right={
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={{ ...input, maxWidth: 200 }}>
            <option value="">{tr("p_by_group_all")}</option>
            {Array.from(new Map(users.flatMap((u) => u.groups || []).map((g) => [g.id, g])).values())
              .map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>}>
      <div className="set-list">
      {shownUsers.map((u) => (
        <ExpandBox key={u.id} open={openUser === u.id}
          onToggle={() => setOpenUser(openUser === u.id ? null : u.id)}
          outerProps={{ className: openUser === u.id ? 'on' : undefined }}
          style={{ opacity: u.is_active === false ? 0.6 : 1 }}
          icon={<Avatar icon={u.profile_shape} color={u.profile_color} seed={u.username} size={26} />}
          title={u.username}
          badges={<>
            <Pill tone={u.role === 'manager' ? 'warn' : undefined}>{u.role}</Pill>
            {u.is_active === false && <Pill tone="bad">{tr("p_inactive")}</Pill>}
          </>}
        >
            <div className={FIELD_CARD_CLASS}>
              <Field label={tr("p_email_verification_2")}>
                {u.email} · {u.verification_current === false ? <span style={{ color: 'var(--danger-text)' }}>{tr("p_re_verify")}</span>
                  : (u.verify_days_left != null ? tr("p_verified_d_left", u.verify_days_left) : tr("p_unverified"))}
              </Field>
              <FieldActions>
                <Button variant="secondary" onClick={() => adminRequestVerify(u)}>{tr("p_request_verification")}</Button>
                <Button variant="secondary" onClick={() => adminVerify(u)}>{tr("p_verify")}</Button>
              </FieldActions>

              {u.pending_email && (
                <>
                  <Field label={tr("p_pending_email_change")}>{u.pending_email}</Field>
                  <FieldActions>
                    <Button variant="primary" onClick={() => adminApprove(u, true)}>{tr("p_approve")}</Button>
                    <Button variant="secondary" onClick={() => adminApprove(u, false)}>{tr("p_reject")}</Button>
                  </FieldActions>
                </>
              )}

              <Field label={tr("p_role")}>{u.role}</Field>
              <FieldActions>
                <Button variant="secondary" onClick={() => adminRole(u)}>{u.role === 'manager' ? tr("p_revoke_manager") : tr("p_grant_manager")}</Button>
              </FieldActions>

              <Field label={tr("p_groups")} align="start">
                {(u.groups || []).length === 0
                  ? <span style={fieldMuted}>—</span>
                  : (u.groups || []).map((g) => (
                      <span key={g.id} style={fieldChip}>
                        <GroupMark icon={g.icon} color={g.color} size={13} /> {g.name}
                        <button type="button" className="set-plain set-x" onClick={() => removeFromGroup(u, g)} title={tr("p_remove")}>✕</button>
                      </span>
                    ))}
              </Field>

              {/* service permissions — direct grants vs group-inherited, shown separately */}
              <Field label={tr("p_direct_permissions")} align="start">
                {(u.permissions || []).length === 0
                  ? <span style={fieldMuted}>{tr("p_no_direct_grants")}</span>
                  : permChips(u.permissions || [], 'd')}
              </Field>
              <Field label={tr("p_inherited_group_permissions")} align="start">
                {(u.inherited_permissions || []).length === 0
                  ? <span style={fieldMuted}>{tr("p_no_inherited_grants")}</span>
                  : permChips(u.inherited_permissions || [], 'g')}
              </Field>

              {/* scoped (service/project) admin grants */}
              <Field label={tr("p_admin_service_project")} align="start">
                {(u.permissions || []).filter((p) => p.admin).length === 0 && (u.inherited_permissions || []).filter((p) => p.admin).length === 0
                  ? <span style={fieldMuted}>{tr("p_no_admin_grants")}</span>
                  : <>
                      {(u.permissions || []).filter((p) => p.admin).map((p, i) => (
                        <span key={'d' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>{p.service}{p.project ? '/' + p.project : ' (' + tr("p_all") + ')'}
                          <button type="button" className="set-plain set-x" onClick={() => revokeScopedAdmin(u, p)} title={tr("p_revoke")}>✕</button>
                        </span>
                      ))}
                      {/* group-inherited admin: revoked from the group, not per-user — no ✕ here */}
                      {(u.inherited_permissions || []).filter((p) => p.admin).map((p, i) => (
                        <span key={'g' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }} title={tr("p_inherited_from_group")}>
                          {p.service}{p.project ? '/' + p.project : ' (' + tr("p_all") + ')'} · {p.group}
                        </span>
                      ))}
                    </>}
              </Field>
              {openUser === u.id && (
                <FieldActions>
                  <select value={agrant.svc} onChange={(e) => agrantPickSvc(e.target.value)} style={{ ...input, height: 28, maxWidth: 180 }}>
                    <option value="">{tr("p_service")}</option>
                    {services.map((s) => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
                  </select>
                  <select value={agrant.proj} onChange={(e) => setAgrant((s) => ({ ...s, proj: e.target.value }))} disabled={!agrant.svc} style={{ ...input, height: 28, flex: 1, minWidth: 140 }}>
                    <option value="">{tr("p_all_whole_service")}</option>
                    {(projCache[agrant.svc] || []).map((p) => <option key={p.name} value={p.name}>{p.label || p.name}</option>)}
                  </select>
                  <Button variant="secondary" disabled={!agrant.svc} onClick={() => grantScopedAdmin(u)}>{tr("p_grant_admin")}</Button>
                </FieldActions>
              )}

              <Field label={tr("p_password")}>
                {tr("p_mail_a_new_one_or")}
              </Field>
              <FieldActions>
                <Button variant="secondary" onClick={() => adminResetPwEmail(u)}>{tr("p_change_password_via_email")}</Button>
                <Button variant="secondary" onClick={() => adminSetPw(u)}>{tr("p_set_password")}</Button>
              </FieldActions>

              <Field label={tr("p_account")}>
                {tr("p_turn_this_account_off_or")}
              </Field>
              <FieldActions>
                <Button variant="warning" onClick={() => adminActive(u)}>{u.is_active === false ? tr("p_activate") : tr("p_deactivate")}</Button>
                <Button variant="dangerSoft" onClick={() => adminDelete(u)}><Icon name="trash" size={14} /> {tr("p_delete_account")}</Button>
              </FieldActions>
            </div>
        </ExpandBox>
      ))}
      {shownUsers.length === 0 && <Row className="empty">{tr("p_no_other_accounts")}</Row>}
      </div>
      </Panel>
    </>
  )

  const content = tab === 'me' ? MyAccount
    : tab === 'feedback' ? <FeedbackView isManager={isManager} />
    : tab === 'accounts' ? Accounts
    : tab === 'groups' ? <GroupsAdmin users={users} services={services} onChanged={load} />
    : tab === 'invites' ? <InvitesAdmin services={services} onChanged={load} />
    : tab === 'system' ? <SystemAdmin />
    : tab === 'sync' ? <SyncAll />
    : tab === 'handshake' ? <GuideView onChanged={onChanged} />
    : MyAccount

  return (
    <div>
      {pwAsk && (
        <PwPrompt title={pwAsk.title} confirmLabel={tr("p_ok")} cancelLabel={tr("p_cancel")}
          onSubmit={(v) => { pwAsk.resolve(v); setPwAsk(null) }}
          onCancel={() => { pwAsk.resolve(null); setPwAsk(null) }} />
      )}
      {/* The page's one size change: its name. Every other word on the page is
          the same size, so this is what tells you where you are. */}
      {hideMenu && <h1 className="set-title">{(MENU.find(([k]) => k === tab) || MENU[0])[2]}</h1>}
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
