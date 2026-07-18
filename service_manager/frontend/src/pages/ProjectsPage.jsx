import { useEffect, useState } from 'react'
import { Icon, Button, CoverPage, PROJECT_ICONS, Avatar, MANAGER_COLOR, Modal } from 'lilak-ui'
import ExpandBox from './portal/ExpandBox'
import { launcher, setExperiment } from '../api'
import { useLang } from '../context/LangContext'
import AccountView from './portal/AccountView'
import ArchivePanel from './portal/ArchivePanel'
import ServiceManagePanel from './portal/ServiceManagePanel'
import IconLabView from './portal/IconLabView'
import NewServiceView from './portal/NewServiceView'
import ServiceProjects from './portal/ServiceProjects'
import ServiceSingle from './portal/ServiceSingle'
import ScaleToggle from './portal/ScaleToggle'
import { usePortalScale } from '../portalScale'

/**
 * ProjectsPage — the LILAK portal cover page.
 *
 * Lists the services (elog projects today; other apps later) and gates them
 * behind a PORTAL account. Portal accounts are central, living at the launcher
 * (separate from each service's own users), so this page is login-first: you
 * sign in / sign up here, then see the list.
 *
 * Auth always targets the portal through the `launcher` axios
 * (`/launcher/api/auth/*` → the launcher's own `/api/auth/*`), independent of any
 * selected experiment — so it works whether the app is served by the launcher
 * or by the Vite dev proxy.
 */

const PORTAL_TOKEN_KEY = 'lilak_portal_token'

// A built-in, admin-only "service": not a web app but listed like one. Opening
// its card expands the icon editor inline (no proxy, no backend service entry).
const ICON_SERVICE = { name: 'lilak icon', kind: 'tool', builtin: 'iconlab', icon: 'images', can_enter: true }
// Admin-only builtin: opening it expands a form that scaffolds + builds + registers
// a new lilak_ui-based service (see NewServiceView).
const CREATE_SERVICE = { name: 'new-service', kind: 'tool', builtin: 'newservice', icon: 'plus', can_enter: true }

// The mark next to the title. Uses the editable /lilak-header.svg (set from the
// icon editor); falls back to the kit logo when that file isn't there yet.
function HeaderMark({ size = 42 }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Icon name="lilak" size={size} style={{ height: size, width: 'auto' }} />
  return <img src="/lilak-header.svg" alt="" height={size} style={{ height: size, width: 'auto' }} onError={() => setFailed(true)} />
}

// Stable per-name fallback icon so services without a stored icon still look
// distinct (e.g. ones created before icons existed).
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const iconFor = (name, stored) => stored || PROJECT_ICONS[hashStr(name) % PROJECT_ICONS.length]

// A card's stable key (builtins use "@iconlab"/"@newservice"; services use the name).
const cardKey = (p) => (p.builtin ? '@' + p.builtin : p.name)
// Sort the combined card list by the admin-saved order; anything not listed keeps
// its default position (after the ordered ones).
function sortByHome(cards, order) {
  const def = new Map(cards.map((c, i) => [cardKey(c), i]))
  const pos = (c) => { const o = order.indexOf(cardKey(c)); return o >= 0 ? o : 1000 + def.get(cardKey(c)) }
  return [...cards].sort((a, b) => pos(a) - pos(b))
}

// Every control on the auth card — inputs, the mode tabs, the submit — is one
// height, so the card reads as a single stack of equal rows (and stays a
// comfortable tap target on a phone).
const CTRL_H = 46
const CTRL_R = 10
const inputStyle = {
  width: '100%', height: CTRL_H, padding: '0 14px', borderRadius: CTRL_R, fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-medium, 14px)', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--input-border)', outline: 'none',
}
// The card's own side padding, on top of the page Container's 16px — on a phone
// the column is the full width, and the controls shouldn't run up to the glass.
const cardStyle = {
  maxWidth: 360, margin: '28px auto 0', padding: '0 12px',
  display: 'flex', flexDirection: 'column', gap: 10,
}
const authBtnStyle = {
  width: '100%', height: CTRL_H, borderRadius: CTRL_R,
  fontSize: 'var(--fs-medium, 14px)', justifyContent: 'center',
}

// Attach / clear the portal bearer token on the shared launcher axios.
function setPortalToken(token) {
  if (token) {
    localStorage.setItem(PORTAL_TOKEN_KEY, token)
    launcher.defaults.headers.common['Authorization'] = `Bearer ${token}`
    // Also a cookie so the reverse proxies (/p, /pp) can authorize a top-level
    // navigation (which carries no Authorization header) for per-project gating.
    document.cookie = `${PORTAL_TOKEN_KEY}=${token}; path=/; SameSite=Lax; max-age=86400`
  } else {
    localStorage.removeItem(PORTAL_TOKEN_KEY)
    delete launcher.defaults.headers.common['Authorization']
    document.cookie = `${PORTAL_TOKEN_KEY}=; path=/; max-age=0`
  }
}

// ── Login / Sign-up card (shown when logged out) ──────────────────────────────
function AuthCard({ t, onAuthed }) {
  const [mode, setMode] = useState('login')   // 'login' | 'signup'
  const [f, setF] = useState({ username: '', password: '', email: '', invite_code: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(null)   // email-verification notice
  const [verifyCode, setVerifyCode] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function login() {
    const res = await launcher.post('/auth/login', { username: f.username.trim(), password: f.password })
    setPortalToken(res.data.access_token)        // authorize the follow-up /auth/me
    const me = await launcher.get('/auth/me')
    onAuthed(me.data)
  }

  async function submit(e) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      if (mode === 'login') { await login(); return }
      // display_name is left unset → the backend defaults it to username.
      const res = await launcher.post('/auth/register', {
        username: f.username.trim(), email: f.email.trim(), password: f.password,
        invite_code: f.invite_code.trim() || undefined,
      })
      if (res.data.verify_required) {
        setVerifyCode('')
        setPending(res.data)                     // show "check your email" notice
      } else {
        setPortalToken(res.data.access_token)    // verification disabled → log in
        const me = await launcher.get('/auth/me')
        onAuthed(me.data)
      }
    } catch (e2) {
      setErr(e2?.response?.data?.detail || t(mode === 'login' ? 'projects_login_fail' : 'projects_signup_fail'))
    } finally { setBusy(false) }
  }

  async function submitVerifyCode(e) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      const res = await launcher.post('/auth/verify-code', {
        username: pending?.username || f.username.trim(),
        code: verifyCode.trim(),
      })
      setPortalToken(res.data.access_token)
      const me = await launcher.get('/auth/me')
      onAuthed(me.data)
    } catch (e2) {
      setErr(e2?.response?.data?.detail || '인증 코드가 올바르지 않습니다.')
    } finally { setBusy(false) }
  }

  if (pending) {
    return (
      <div style={{ ...cardStyle, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>✉️</div>
        <div style={{ fontWeight: 600 }}>{pending.message || '인증 메일을 확인하세요.'}</div>
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{pending.email}</div>
        <form onSubmit={submitVerifyCode} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            autoFocus
            className="keep-font"
            inputMode="numeric"
            maxLength={6}
            placeholder="6자리 인증 코드"
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            style={{ ...inputStyle, textAlign: 'center', letterSpacing: 4, fontSize: 18 }}
          />
          {err && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</div>}
          <Button type="submit" disabled={busy || verifyCode.length !== 6}
            style={{ justifyContent: 'center' }}>인증하고 로그인</Button>
        </form>
        {pending.verify_code && (
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', wordBreak: 'break-all',
            border: '1px dashed var(--border, #ccc)', borderRadius: 8, padding: 8 }}>
            DEV — 메일 대신 인증 코드: {pending.verify_code}
          </div>
        )}
        {pending.verify_url && (
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', wordBreak: 'break-all',
            border: '1px dashed var(--border, #ccc)', borderRadius: 8, padding: 8 }}>
            DEV — 메일 대신 인증 링크:&nbsp;
            <a href={pending.verify_url} target="_blank" rel="noreferrer">{pending.verify_url}</a>
          </div>
        )}
        <Button onClick={() => { setPending(null); setMode('login'); setErr('') }}
          style={authBtnStyle}>{t('projects_login_title')}</Button>
      </div>
    )
  }

  const tabBtn = (m, label) => (
    <Button variant={mode === m ? 'primary' : 'ghost'} onClick={() => { setMode(m); setErr('') }}
      style={{ ...authBtnStyle, flex: 1,
        // The unselected mode is a ghost (no fill), so give it a faint outline to
        // still read as a button. The selected one keeps a transparent border of
        // the same width, so switching modes can't nudge the layout.
        border: mode === m ? '1px solid transparent' : '1px solid var(--border-default)' }}>{label}</Button>
  )

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 6 }}>
        {tabBtn('login', t('projects_login_title'))}
        {tabBtn('signup', t('projects_signup'))}
      </div>
      {/* Order: id, email, password, code. On signup we deliberately break the
          browser's login autofill (off / new-password) so it doesn't drop the
          saved sign-in id/password into the new-account fields. */}
      <form onSubmit={submit} autoComplete={mode === 'signup' ? 'off' : 'on'}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input autoFocus placeholder={t('projects_login_user')} value={f.username} onChange={set('username')} style={inputStyle}
          name={mode === 'signup' ? 'su_id' : 'username'}
          autoComplete={mode === 'signup' ? 'off' : 'username'}
          {...(mode === 'signup' ? { 'data-1p-ignore': true, 'data-lpignore': 'true' } : {})} />
        {mode === 'signup' && (
          <input placeholder={t('projects_signup_email')} value={f.email} onChange={set('email')} style={inputStyle}
            name="su_email" autoComplete="off" data-1p-ignore data-lpignore="true" />
        )}
        <input type="password" placeholder={t('projects_login_pass')} value={f.password} onChange={set('password')} style={inputStyle}
          name={mode === 'signup' ? 'su_pw' : 'password'}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          {...(mode === 'signup' ? { 'data-1p-ignore': true, 'data-lpignore': 'true' } : {})} />
        {mode === 'signup' && (
          <input placeholder={t('projects_signup_code')} value={f.invite_code} onChange={set('invite_code')} style={inputStyle}
            name="su_code" autoComplete="off" data-1p-ignore data-lpignore="true" />
        )}
        {err && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</div>}
        <Button type="submit" style={{ ...authBtnStyle, marginTop: 2 }}
          disabled={busy || !f.username.trim() || !f.password || (mode === 'signup' && !f.email.trim())}>
          {t(mode === 'login' ? 'projects_login_submit' : 'projects_signup_submit')}
        </Button>
      </form>
    </div>
  )
}

export default function ProjectsPage() {
  const { t } = useLang()
  const { big } = usePortalScale()   // roomy UI toggle (default compact)

  // ── Portal auth (central accounts at the launcher) ──
  const [user, setUser] = useState(null)        // null = logged out
  const [authReady, setAuthReady] = useState(false)
  const isManager = user?.role === 'manager'

  // PWA / deep-link return: the proxies bounce an unauthenticated page navigation
  // here as /projects?next=<original-url> (e.g. a home-screen app whose isolated
  // webview has no cookie yet). Once a session exists — fresh login or restored
  // token, both of which re-set the proxy cookie — go back where the user came
  // from. Same-origin paths only (no '//'): never an open redirect.
  const nextParam = (() => {
    const v = new URLSearchParams(window.location.search).get('next') || ''
    return v.startsWith('/') && !v.startsWith('//') ? v : ''
  })()
  useEffect(() => {
    if (user && nextParam) window.location.replace(nextParam)
  }, [user])  // eslint-disable-line react-hooks/exhaustive-deps

  // No popups: the app is a single page with logged-in screens, switched here.
  const [view, setView] = useState('home')          // 'home' | 'settings'
  const [expanded, setExpanded] = useState(null)         // multi-project svc expanded inline
  const [manage, setManage] = useState(false)            // admin Home "manage mode"

  const [projects, setProjects] = useState(null)   // null = loading
  const [homeCfg, setHomeCfg] = useState(null)     // admin: builtin overrides + card order
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')             // name currently acting on
  const [reloadTick, setReloadTick] = useState(0)  // bumped on refresh → re-loads the archive
  const [portalInfo, setPortalInfo] = useState(null)  // { host, version } — tells servers apart
  const [logFor, setLogFor] = useState(null)          // service whose service.log modal is open
  const [logData, setLogData] = useState(null)        // { text, path }
  const [logBusy, setLogBusy] = useState(false)

  // Public host + portal git-version for the header (identifies the deployment).
  useEffect(() => {
    launcher.get('/health').then((r) => setPortalInfo(r.data)).catch(() => {})
  }, [])

  // Tail a managed service's captured stdout/stderr (data/<name>/service.log).
  async function openLog(name) {
    setLogFor(name); setLogBusy(true)
    try { setLogData((await launcher.get(`/admin/services/${name}/log`)).data) }
    catch (e) { setLogData({ text: `로그를 불러오지 못했습니다: ${e?.response?.data?.detail || e.message}`, path: '' }) }
    finally { setLogBusy(false) }
  }

  // Restore a saved portal session.
  useEffect(() => {
    const tok = localStorage.getItem(PORTAL_TOKEN_KEY)
    if (!tok) { setAuthReady(true); return }
    setPortalToken(tok)
    launcher.get('/auth/me')
      .then((r) => setUser(r.data))
      .catch(() => setPortalToken(null))
      .finally(() => setAuthReady(true))
  }, [])

  async function refresh() {
    try {
      const r = await launcher.get('/services')   // auth-aware filtered + flagged list
      setProjects(r.data); setError('')
      if (isManager) { try { setHomeCfg((await launcher.get('/admin/home')).data) } catch { /* optional */ } }
    } catch {
      setProjects([]); setError(t('projects_unreachable'))
    } finally {
      setReloadTick((n) => n + 1)   // let the archive panel re-fetch after any change
    }
  }
  useEffect(() => { refresh() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // Load builtin overrides + saved card order once we know the user is an admin.
  useEffect(() => {
    if (!isManager) return
    launcher.get('/admin/home').then((r) => setHomeCfg(r.data)).catch(() => {})
  }, [isManager])

  async function requestAccess(name) {
    setBusy(name)
    try { await launcher.post('/access-requests', { service: name }); await refresh() }
    catch (err) { setError(err?.response?.data?.detail || t('projects_request_fail')) }
    finally { setBusy('') }
  }


  // Single (non-multi) service: enter directly via /p/<name>/, handing over the token.
  function enter(name) {
    const tok = localStorage.getItem(PORTAL_TOKEN_KEY)
    if (tok) localStorage.setItem('elog_token', tok)
    localStorage.removeItem('elog_user')
    setExperiment(name)
    window.location.assign('/p/' + name + '/')
  }

  function logout() {
    launcher.post('/auth/logout').catch(() => {})   // best-effort
    setPortalToken(null); setUser(null); setView('home')
  }

  async function stop(name) {
    if (!isManager) return
    setBusy(name)
    try { await launcher.post(`/projects/${name}/stop`); await refresh() }
    catch { /* surfaced on refresh */ } finally { setBusy('') }
  }
  async function remove(name) {
    if (!isManager) return
    if (!window.confirm(t('projects_delete_confirm', name))) return
    setBusy(name)
    try { await launcher.delete(`/projects/${name}`); await refresh() }
    catch { /* surfaced on refresh */ } finally { setBusy('') }
  }
  function exportProject(name) {
    const a = document.createElement('a')
    a.href = `${launcher.defaults.baseURL}/projects/${name}/export`
    a.download = `${name}.zip`; document.body.appendChild(a); a.click(); a.remove()
  }

  // Header nav button — the active tab gets a filled box with a visible border so
  // you can always tell which screen you're on.
  const navBtn = (id, icon, label) => {
    const active = view === id
    // Roomy: render exactly like the login card's Sign in / Sign up tabs — active is
    // a filled primary with a transparent border; inactive is a ghost with a faint
    // outline. Same height / radius / font as those buttons (CTRL_H / CTRL_R / medium).
    if (big) {
      return (
        <Button variant={active ? 'primary' : 'ghost'} onClick={() => setView(id)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            height: CTRL_H, borderRadius: CTRL_R, padding: '0 18px', fontSize: 'var(--fs-medium, 14px)',
            border: active ? '1px solid transparent' : '1px solid var(--border-default)',
          }}>
          <Icon name={icon} size={17} /> {label}
        </Button>
      )
    }
    return (
      <Button variant={active ? 'secondary' : 'ghost'} onClick={() => setView(id)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          border: active ? '1.5px solid var(--btn-primary-bg, #4c6ef5)' : '1.5px solid transparent',
          backgroundColor: active ? 'var(--surface-2)' : undefined,
        }}>
        <Icon name={icon} size={14} /> {label}
      </Button>
    )
  }

  // Built-in cards, with the admin's saved label/icon/colour overrides applied.
  const bi = homeCfg?.builtins || {}
  const iconCard = { ...ICON_SERVICE, label: bi.iconlab?.label || ICON_SERVICE.name, icon: bi.iconlab?.icon || ICON_SERVICE.icon, color: bi.iconlab?.color }
  const createCard = { ...CREATE_SERVICE, label: bi.newservice?.label || t('newsvc_title'), icon: bi.newservice?.icon || CREATE_SERVICE.icon, color: bi.newservice?.color }
  // The full home card list (builtins + services), ordered by the admin's saved order.
  const cards = isManager
    ? sortByHome([iconCard, ...(projects || []), createCard], homeCfg?.order || [])
    : (projects || [])

  // Manage mode: move any card (builtin or service) up/down; persist the unified order.
  async function move(key, dir) {
    const keys = cards.map(cardKey)
    const i = keys.indexOf(key), j = i + dir
    if (i < 0 || j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    setHomeCfg((c) => ({ ...(c || { builtins: {} }), order: keys }))   // optimistic
    try { await launcher.put('/admin/home-order', { keys }); await refresh() }
    catch { await refresh() }
  }

  // Roomy: Log out is a real button shaped like the nav tabs, just a different
  // colour (secondary grey vs the tabs' blue). Compact keeps the plain ghost link.
  const logoutBtn = big ? (
    <Button variant="secondary" onClick={logout}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
        height: CTRL_H, borderRadius: CTRL_R, padding: '0 18px', fontSize: 'var(--fs-medium, 14px)',
        border: '1px solid transparent' }}>
      <Icon name="logout" size={17} /> {t('projects_logout')}
    </Button>
  ) : (
    <Button variant="ghost" onClick={logout}>{t('projects_logout')}</Button>
  )

  // The UI-size toggle sits on its own right-aligned line ABOVE the nav bar (for
  // now — easy to relocate/hide). Same in both modes.
  const scaleRow = user ? (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 0 6px' }}>
      <ScaleToggle style={big ? { fontSize: 'var(--fs-medium, 14px)' } : undefined} />
    </div>
  ) : null

  // The nav/tab bar lives in CoverPage's FIXED subheader (outside the scroll), with
  // a divider under it; only the tab CONTENT below scrolls.
  const navBar = user ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '2px 0 12px', borderBottom: '1px solid var(--border-default)' }}>
      {/* tabs — left */}
      {navBtn('home', 'home', t('portal_nav_home'))}
      {navBtn('settings', 'settings', t('portal_nav_settings'))}
      <div style={{ flex: 1 }} />
      {/* account (name only — the avatar colour already carries the role) + logout */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: big ? 'var(--fs-medium, 14px)' : 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>
        <Avatar icon={user.profile_shape} color={isManager ? MANAGER_COLOR : user.profile_color} seed={user.username} size={big ? 32 : 22} />
        {big ? (user.username) : `${user.username}${isManager ? ' · admin' : ''}`}
      </span>
      {logoutBtn}
    </div>
  ) : null

  // The Home "manage mode" toggle. Lives in the FIXED subheader (outside the
  // scroll) so it stays reachable no matter how far the service list is scrolled.
  const manageBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 2px' }}>
      <span style={{ flex: 1, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
        {manage ? t('manage_hint') : t('projects_register_hint')}
      </span>
      {/* Keep any open box open — its content switches between the normal panel
          and the manage panel with `manage` (no close on toggle). */}
      <Button variant="ghost" onClick={() => setManage((m) => !m)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-body, 13px)',
          padding: '8px 15px', color: manage ? 'var(--btn-primary-bg)' : undefined }}>
        <Icon name={manage ? 'toggle-right' : 'toggle-left'} size={26} weight={manage ? 'fill' : 'regular'}
          color={manage ? 'var(--btn-primary-bg)' : 'var(--text-muted)'} /> {t('portal_manage')}
      </Button>
    </div>
  )

  return (
    <CoverPage
      fill
      // Centred brand (mark alone, title under) on the login screen — and, in the
      // roomy theme, on the logged-in home too, so it reads like the login page.
      center={!user || big}
      // Big landing mark logged out; also big in the roomy theme. Only the compact
      // logged-in header keeps the small leading-icon size.
      icon={<HeaderMark size={(user && !big) ? 42 : 64} />}
      title={t('projects_title')}
      subtitle={portalInfo
        ? `${portalInfo.host || '?'}${portalInfo.version ? ` · ${portalInfo.version}` : ''}`
        : t('projects_subtitle')}
      subheader={user ? <>{scaleRow}{navBar}{view === 'home' && isManager && manageBar}</> : null}
    >
      {/* Login-first; then one of three logged-in screens — no popups. */}
      {!authReady ? null : !user ? (
        <AuthCard t={t} onAuthed={(u) => { setUser(u); setView('home'); refresh() }} />
      ) : view === 'settings' ? (
        <AccountView isManager={isManager} onChanged={refresh} onAccountGone={logout} />
      ) : (
        <>
          {error && (
            <div style={{ margin: '8px 0', padding: '10px 12px', borderRadius: 8, fontSize: 'var(--fs-small, 12px)',
              backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border, transparent)' }}>
              {error}
            </div>
          )}

          {projects === null && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>{t('home_loading')}</div>
          )}
          {projects && projects.length === 0 && !error && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>
              {t('projects_empty')}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {cards.map((p, i) => {
              const key = cardKey(p)
              const isOpen = expanded === key
              const isBuiltin = !!p.builtin
              // In manage mode admins can open every card (to manage it); otherwise
              // only enterable services toggle — request-only cards stay inert.
              const canToggle = (manage && isManager) || !!p.can_enter
              const statusText = isBuiltin ? (p.builtin === 'newservice' ? t('newsvc_card_hint') : t('iconlab_card_hint'))
                : p.multi_project ? t('portal_proj_open_svc')
                : (p.running ? t('projects_running', p.port) : t('projects_stopped'))
              return (
                <ExpandBox key={key} open={isOpen} manage={manage && isManager}
                  toggleable={canToggle} divider={false}
                  onToggle={() => setExpanded(isOpen ? null : key)}
                  icon={<Icon name={iconFor(p.name, p.icon)} size={26} weight="fill"
                    color={p.color || 'var(--text-primary)'} />}
                  title={p.builtin === 'newservice' ? (p.label || t('newsvc_title')) : (p.label || p.name)}
                  badges={(isManager && p.version?.sha) ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro, 11px)', padding: '2px 8px', borderRadius: 999, backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }}>{p.version.sha}</span> : null}
                  subtitle={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {(!isBuiltin && !p.multi_project) && <span style={{ width: 8, height: 8, borderRadius: 999, background: p.running ? 'var(--ok-text, #2f9e44)' : 'var(--text-muted)' }} />}
                    {statusText}
                  </span>}
                  right={
                    p.can_enter ? (
                      <Button variant={isOpen ? 'secondary' : 'primary'} onClick={() => setExpanded(isOpen ? null : key)}
                        style={{ minWidth: 76, justifyContent: 'center' }}>
                        {isOpen ? t('portal_proj_close') : t('projects_open')}
                      </Button>
                    ) : p.can_request ? (
                      <Button variant="secondary" disabled={p.requested || busy === p.name} onClick={() => requestAccess(p.name)}
                        style={{ minWidth: 112, justifyContent: 'center' }}>
                        {p.requested ? t('projects_requested') : t('projects_request')}
                      </Button>
                    ) : null
                  }
                >
                  {/* Top strip (managers only): repo + exact-commit links + a log viewer. */}
                  {isManager && (p.version?.url || (p.mode === 'managed' && !isBuiltin)) && (
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', padding: '8px 14px 8px 46px', borderTop: '1px solid var(--border-subtle)', fontSize: 'var(--fs-small, 12px)' }}>
                      {p.version?.url && (
                        <a href={p.version.url} target="_blank" rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--info-text)', textDecoration: 'none' }}>
                          <Icon name="folder" size={14} /> {p.version.url.replace(/^https?:\/\//, '')} ↗
                        </a>
                      )}
                      {p.version?.url && (p.version.pushed ? (
                        <a href={`${p.version.url}/commit/${p.version.sha}`} target="_blank" rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', color: 'var(--info-text)', textDecoration: 'none' }}>
                          <Icon name="tag" size={14} /> {p.version.sha} ↗
                        </a>
                      ) : (
                        <span title="아직 원격에 푸시되지 않은 로컬 커밋"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                          <Icon name="tag" size={14} /> {p.version.sha} · 로컬
                        </span>
                      ))}
                      {isManager && p.mode === 'managed' && !isBuiltin && (
                        <button type="button" onClick={() => openLog(p.name)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-small, 12px)', color: 'var(--info-text)' }}>
                          <Icon name="file" size={14} /> 로그
                        </button>
                      )}
                    </div>
                  )}
                  {/* Inline expansion: manage mode → management panel (builtins too);
                      otherwise the builtin tool / the service's own panel. */}
                  {manage && isManager ? (
                    <>
                      <ServiceManagePanel service={p} builtinKey={isBuiltin ? p.builtin : null}
                        initialIcon={iconFor(p.name, p.icon)}
                        first={i === 0} last={i === cards.length - 1}
                        onMove={(dir) => move(key, dir)} onChanged={refresh} />
                      {/* manage mode: per-project management incl. delete */}
                      {p.multi_project && !isBuiltin && <ServiceProjects service={p} canManage={isManager} manage onChanged={refresh} />}
                    </>
                  ) : isBuiltin && p.builtin === 'iconlab' ? (
                    <div style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)' }}><IconLabView /></div>
                  ) : isBuiltin && p.builtin === 'newservice' ? (
                    <NewServiceView onCreated={refresh} />
                  ) : p.multi_project ? (
                    <ServiceProjects service={p} canManage={isManager} />
                  ) : (
                    <ServiceSingle service={p} canManage={isManager} onChanged={refresh} />
                  )}
                </ExpandBox>
              )
            })}
          </div>
          {isManager && <ArchivePanel signal={reloadTick} onChanged={refresh} />}
        </>
      )}

      {logFor && (
        <Modal title={`${logFor} · service.log`} width={880}
          onClose={() => { setLogFor(null); setLogData(null) }}
          footer={<Button size="sm" variant="secondary" onClick={() => openLog(logFor)} disabled={logBusy}>{logBusy ? '불러오는 중…' : '새로고침'}</Button>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {logData?.path && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{logData.path}</div>}
            <pre style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)', lineHeight: 1.5, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12, color: 'var(--text-primary)' }}>
              {logBusy ? '불러오는 중…' : (logData?.text || '(로그 없음 — 아직 시작되지 않았거나 멀티프로젝트 서비스라 프로젝트별 로그를 씁니다)')}
            </pre>
          </div>
        </Modal>
      )}
    </CoverPage>
  )
}
