import { useEffect, useState } from 'react'
import { Icon, Button, CoverPage, CoverCard, PROJECT_ICONS } from 'lilak-ui'
import { launcher, setExperiment } from '../api'
import { useLang } from '../context/LangContext'
import AccountView from './portal/AccountView'
import ServiceManagePanel from './portal/ServiceManagePanel'
import IconLabView from './portal/IconLabView'
import NewServiceView from './portal/NewServiceView'
import GuideView from './portal/GuideView'
import ServiceProjects from './portal/ServiceProjects'
import ServiceSingle from './portal/ServiceSingle'

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
function HeaderMark({ size = 36 }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Icon name="lilak" size={size} style={{ height: size, width: 'auto' }} />
  return <img src="/lilak-header.svg" alt="" height={size} style={{ height: size, width: 'auto' }} onError={() => setFailed(true)} />
}

// Stable per-name fallback icon so services without a stored icon still look
// distinct (e.g. ones created before icons existed).
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const iconFor = (name, stored) => stored || PROJECT_ICONS[hashStr(name) % PROJECT_ICONS.length]

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', borderRadius: 8, fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-body, 13px)', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--input-border)', outline: 'none',
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

  if (pending) {
    return (
      <div style={{ maxWidth: 360, margin: '28px auto 0', display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>✉️</div>
        <div style={{ fontWeight: 600 }}>{pending.message || '인증 메일을 확인하세요.'}</div>
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{pending.email}</div>
        {pending.verify_url && (
          <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', wordBreak: 'break-all',
            border: '1px dashed var(--border, #ccc)', borderRadius: 8, padding: 8 }}>
            DEV — 메일 대신 인증 링크:&nbsp;
            <a href={pending.verify_url} target="_blank" rel="noreferrer">{pending.verify_url}</a>
          </div>
        )}
        <Button onClick={() => { setPending(null); setMode('login'); setErr('') }}
          style={{ justifyContent: 'center' }}>{t('projects_login_title')}</Button>
      </div>
    )
  }

  const tabBtn = (m, label) => (
    <Button variant={mode === m ? 'primary' : 'ghost'} onClick={() => { setMode(m); setErr('') }}
      style={{ flex: 1, justifyContent: 'center' }}>{label}</Button>
  )

  return (
    <div style={{ maxWidth: 360, margin: '28px auto 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', textAlign: 'center' }}>
        {t('projects_login_prompt')}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {tabBtn('login', t('projects_login_title'))}
        {tabBtn('signup', t('projects_signup'))}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input autoFocus placeholder={t('projects_login_user')} value={f.username} onChange={set('username')} style={inputStyle} />
        {mode === 'signup' && (
          <input placeholder={t('projects_signup_email')} value={f.email} onChange={set('email')} style={inputStyle} />
        )}
        {mode === 'signup' && (
          <input placeholder={t('projects_signup_code')} value={f.invite_code} onChange={set('invite_code')} style={inputStyle} />
        )}
        <input type="password" placeholder={t('projects_login_pass')} value={f.password} onChange={set('password')} style={inputStyle} />
        {err && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</div>}
        {mode === 'signup' && (
          <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{t('projects_signup_admin_hint')}</div>
        )}
        <Button type="submit" style={{ justifyContent: 'center', marginTop: 2 }}
          disabled={busy || !f.username.trim() || !f.password || (mode === 'signup' && !f.email.trim())}>
          {t(mode === 'login' ? 'projects_login_submit' : 'projects_signup_submit')}
        </Button>
      </form>
    </div>
  )
}

export default function ProjectsPage() {
  const { t } = useLang()

  // ── Portal auth (central accounts at the launcher) ──
  const [user, setUser] = useState(null)        // null = logged out
  const [authReady, setAuthReady] = useState(false)
  const isManager = user?.role === 'manager'

  // No popups: the app is a single page with logged-in screens, switched here.
  const [view, setView] = useState('home')          // 'home' | 'account' | 'guide'
  const [expanded, setExpanded] = useState(null)         // multi-project svc expanded inline
  const [manage, setManage] = useState(false)            // admin Home "manage mode"

  const [projects, setProjects] = useState(null)   // null = loading
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')             // name currently acting on

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
    } catch {
      setProjects([]); setError(t('projects_unreachable'))
    }
  }
  useEffect(() => { refresh() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function requestAccess(name) {
    setBusy(name)
    try { await launcher.post('/access-requests', { service: name }); await refresh() }
    catch (err) { setError(err?.response?.data?.detail || t('projects_request_fail')) }
    finally { setBusy('') }
  }

  // Manage mode: move a service up/down in the list, persisting the new order.
  async function move(name, dir) {
    const names = (projects || []).map((p) => p.name)
    const i = names.indexOf(name), j = i + dir
    if (i < 0 || j < 0 || j >= names.length) return
    ;[names[i], names[j]] = [names[j], names[i]]
    setProjects((ps) => names.map((n) => ps.find((p) => p.name === n)).filter(Boolean))  // optimistic
    try { await launcher.put('/admin/service-order', { names }); await refresh() }
    catch { await refresh() }
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

  // The nav/tab bar lives in CoverPage's FIXED subheader (outside the scroll), with
  // a divider under it; only the tab CONTENT below scrolls.
  const navBar = user ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '2px 0 12px', borderBottom: '1px solid var(--border-default)' }}>
      {/* tabs — left */}
      {navBtn('home', 'home', t('portal_nav_home'))}
      {navBtn('account', 'user', t('portal_nav_account'))}
      {isManager && navBtn('guide', 'plug', t('portal_nav_handshake'))}
      <div style={{ flex: 1 }} />
      {/* account name + logout — right */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>
        <Icon name="user" size={14} /> {user.username}{isManager ? ' · admin' : ''}
      </span>
      <Button variant="ghost" onClick={logout}>{t('projects_logout')}</Button>
    </div>
  ) : null

  return (
    <CoverPage
      fill
      icon={<HeaderMark />}
      title={t('projects_title')}
      subtitle={t('projects_subtitle')}
      subheader={navBar}
    >
      {/* Login-first; then one of three logged-in screens — no popups. */}
      {!authReady ? null : !user ? (
        <AuthCard t={t} onAuthed={(u) => { setUser(u); setView('home'); refresh() }} />
      ) : view === 'account' ? (
        <AccountView isManager={isManager} onChanged={refresh} onAccountGone={logout} />
      ) : view === 'guide' && isManager ? (
        <GuideView onChanged={refresh} />
      ) : (
        <>
          {error && (
            <div style={{ margin: '8px 0', padding: '10px 12px', borderRadius: 8, fontSize: 'var(--fs-small, 12px)',
              backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)', border: '1px solid var(--danger-border, transparent)' }}>
              {error}
            </div>
          )}
          {isManager && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 16px' }}>
              <span style={{ flex: 1, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
                {manage ? t('manage_hint') : t('projects_register_hint')}
              </span>
              <Button variant="ghost" onClick={() => { setManage((m) => !m); setExpanded(null) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: manage ? 'var(--btn-primary-bg)' : undefined }}>
                <Icon name={manage ? 'toggle-right' : 'toggle-left'} size={22}
                  color={manage ? 'var(--btn-primary-bg)' : 'var(--text-muted)'} /> {t('portal_manage')}
              </Button>
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(isManager ? [ICON_SERVICE, ...(projects || []), CREATE_SERVICE] : (projects || [])).map((p) => {
              const isOpen = expanded === p.name
              const isBuiltin = !!p.builtin
              const realIdx = isBuiltin ? -1 : (projects || []).findIndex((x) => x.name === p.name)
              const realCount = (projects || []).length
              return (
                <div key={p.name} style={{
                  // The OUTER box always carries the border (the inner card's own
                  // border is removed below); it highlights when open.
                  border: '1.5px solid ' + (isOpen ? 'var(--btn-primary-bg)' : '#000'),
                  borderRadius: 12, overflow: 'hidden', backgroundColor: 'var(--surface)',
                }}>
                  <CoverCard
                    icon={<Icon name={iconFor(p.name, p.icon)} size={22} weight="duotone"
                      color={p.color || 'var(--text-primary)'} style={{ flexShrink: 0 }} />}
                    title={p.builtin === 'newservice' ? t('newsvc_title') : (p.label || p.name)}
                    active={false}
                    style={{ border: 'none', borderRadius: 0 }}
                    badge={(
                      <span style={{ fontSize: 'var(--fs-micro, 10px)', padding: '1px 6px', borderRadius: 999, backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                        {p.kind || '?'}
                      </span>
                    )}
                    statusOn={isBuiltin || p.multi_project ? undefined : p.running}
                    statusText={isBuiltin ? (p.builtin === 'newservice' ? t('newsvc_card_hint') : t('iconlab_card_hint'))
                      : p.multi_project ? t('portal_proj_open_svc')
                      : (p.running ? t('projects_running', p.port) : t('projects_stopped'))}
                    actions={
                      <>
                        {p.can_enter ? (
                          // Every service opens its inline panel first; you Enter
                          // (and start/stop) from inside — single services too.
                          <Button variant={isOpen ? 'secondary' : 'primary'}
                            onClick={() => setExpanded(isOpen ? null : p.name)}
                            style={{ minWidth: 72, justifyContent: 'center' }}>
                            {isOpen ? t('portal_proj_close') : t('projects_open')}
                          </Button>
                        ) : p.can_request ? (
                          <Button variant="secondary" disabled={p.requested || busy === p.name} onClick={() => requestAccess(p.name)}
                            style={{ minWidth: 112, justifyContent: 'center' }}>
                            {p.requested ? t('projects_requested') : t('projects_request')}
                          </Button>
                        ) : null}
                        {/* Icon / name / colour / data-download / reorder now live
                            in Home "manage mode" (the gear above the list). */}
                      </>
                    }
                  />
                  {/* Inline expansion: builtin tool → editor; service → its projects. */}
                  {isOpen && isBuiltin && p.builtin === 'iconlab' && (
                    <div style={{ padding: '6px 14px 16px' }}><IconLabView /></div>
                  )}
                  {isOpen && isBuiltin && p.builtin === 'newservice' && (
                    <NewServiceView onCreated={refresh} />
                  )}
                  {isOpen && !isBuiltin && manage && isManager && (
                    <ServiceManagePanel service={p} initialIcon={iconFor(p.name, p.icon)}
                      first={realIdx <= 0} last={realIdx < 0 || realIdx >= realCount - 1}
                      onMove={(dir) => move(p.name, dir)} onChanged={refresh} />
                  )}
                  {isOpen && !isBuiltin && !(manage && isManager) && p.multi_project && (
                    <ServiceProjects service={p} canManage={isManager} />
                  )}
                  {isOpen && !isBuiltin && !(manage && isManager) && !p.multi_project && (
                    <ServiceSingle service={p} canManage={isManager} onChanged={refresh} />
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </CoverPage>
  )
}
