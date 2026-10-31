import { useEffect, useRef, useState } from 'react'
import { Button, PROJECT_ICONS } from 'lilak-ui'
import { launcher, errText, store, PORTAL_TOKEN_KEY } from '../api'
import { useLang } from '../context/LangContext'
import SidebarPortal from './portal/SidebarPortal'
import { Panel, Field, FieldActions, fieldInput, fieldMuted } from './portal/Field'
import { notify } from './portal/settingsMsg'

/**
 * ProjectsPage — the portal's cover: who you are, what you may open, and the
 * sidebar cover that shows it.
 *
 * It used to carry two covers — the classic card grid and the sidebar — and a
 * layout switch between them, plus a roomy/compact size switch the sidebar never
 * read. The sidebar has everything the grid had (access requests, the archive,
 * logs, versions — brought across before the grid was removed), so this page is
 * now the data and the sign-in, and SidebarPortal is the screen.
 *
 * What lives here: the session (restore, sign in, sign out, the ?next= return),
 * the card list (services + builtins, in the saved order, with their groups),
 * and the writes that reorder and regroup it.
 */

// Builtins: portal tools listed like services. Only the links card is for
// everyone (and only once it has something in it); the rest are a manager's.
const ICON_SERVICE = { name: 'lilak icon', kind: 'tool', builtin: 'iconlab', icon: 'images', can_enter: true }
const CREATE_SERVICE = { name: 'new-service', kind: 'tool', builtin: 'newservice', icon: 'plus', can_enter: true }
const LINKS_SERVICE = { name: 'links', kind: 'tool', builtin: 'links', icon: 'link', can_enter: true }
const RACK_SERVICE = { name: 'rack', kind: 'tool', builtin: 'rack', icon: 'wall', can_enter: true }

// Stable per-name fallback icon so a service without a stored icon still looks
// distinct.
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const iconFor = (name, stored) => stored || PROJECT_ICONS[hashStr(name) % PROJECT_ICONS.length]

// A card's stable key (builtins use "@iconlab"…; services use the name).
const cardKey = (p) => (p.builtin ? '@' + p.builtin : p.name)
// Sort by the admin-saved order; anything not listed keeps its default place.
function sortByHome(cards, order) {
  const def = new Map(cards.map((c, i) => [cardKey(c), i]))
  const pos = (c) => { const o = order.indexOf(cardKey(c)); return o >= 0 ? o : 1000 + def.get(cardKey(c)) }
  return [...cards].sort((a, b) => pos(a) - pos(b))
}

// The auth card's inputs and its width — it is written in the same panels as
// the rest of the portal; this is only how wide it sits and where.
const inputStyle = { ...fieldInput, width: '100%', fontFamily: 'var(--font-mono)' }
const cardStyle = { width: '100%', maxWidth: 420, margin: '28px auto 0' }

// Attach / clear the portal bearer token on the shared launcher axios.
function setPortalToken(token) {
  if (token) {
    store.set(PORTAL_TOKEN_KEY, token)
    launcher.defaults.headers.common['Authorization'] = `Bearer ${token}`
    // Also a cookie so the reverse proxies (/p, /pp) can authorize a top-level
    // navigation (which carries no Authorization header) for per-project gating.
    // Secure over HTTPS so the token never rides plain HTTP (omitted on
    // http://localhost, where Secure cookies are rejected in dev).
    const secure = location.protocol === 'https:' ? ' Secure;' : ''
    document.cookie = `${PORTAL_TOKEN_KEY}=${token}; path=/; SameSite=Lax;${secure} max-age=86400`
  } else {
    store.remove(PORTAL_TOKEN_KEY)
    delete launcher.defaults.headers.common['Authorization']
    document.cookie = `${PORTAL_TOKEN_KEY}=; path=/; max-age=0`
  }
}

export function AuthCard({ t, onAuthed, needsSetup, info }) {
  const [mode, setMode] = useState('login')   // 'login' | 'signup'
  const [f, setF] = useState({ username: '', password: '', email: '', invite_code: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(null)   // awaiting the emailed code
  const [verifyCode, setVerifyCode] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const signup = mode === 'signup'
  const locked = busy || !!pending    // the account rows are settled once a code is out

  async function finish(token) {
    setPortalToken(token)                      // authorize the follow-up /auth/me
    const me = await launcher.get('/auth/me')
    onAuthed(me.data)
  }

  async function submit(e) {
    e?.preventDefault()
    setBusy(true); setErr('')
    try {
      if (needsSetup) {
        // First run: no accounts yet — set the built-in superuser's password.
        const res = await launcher.post('/auth/setup', { password: f.password })
        await finish(res.data.access_token)
        return
      }
      if (!signup) {
        const res = await launcher.post('/auth/login', { username: f.username.trim(), password: f.password })
        await finish(res.data.access_token)
        return
      }
      // display_name is left unset → the backend defaults it to username.
      const res = await launcher.post('/auth/register', {
        username: f.username.trim(), email: f.email.trim(), password: f.password,
        invite_code: f.invite_code.trim() || undefined,
      })
      if (res.data.verify_required) { setVerifyCode(''); setPending(res.data) }
      else await finish(res.data.access_token)   // verification disabled → straight in
    } catch (e2) {
      const detail = e2?.response?.data?.detail
      if (detail && typeof detail === 'object' && detail.code === 'verify_required') {
        // Correct password, but the email is still unverified. Open the code row
        // in place rather than dead-ending on an error message — and switch to
        // the sign-up side, because that is the sign-up being finished.
        setVerifyCode(''); setMode('signup')
        if (detail.email) setF((s) => ({ ...s, email: detail.email }))
        setPending(detail)
        return
      }
      setErr((typeof detail === 'string' && detail) ||
        t(signup ? 'projects_signup_fail' : 'projects_login_fail'))
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
      await finish(res.data.access_token)
    } catch {
      setErr(t('auth_verify_fail'))
    } finally { setBusy(false) }
  }

  // Give up on a pending signup: delete the unverified account (username/email
  // become free again) and fold the code row back up. Needs the password from
  // the form state — present in both paths that open the row.
  async function cancelSignup() {
    setBusy(true); setErr('')
    try {
      await launcher.post('/auth/register-cancel', {
        username: pending?.username || f.username.trim(), password: f.password,
      })
      setPending(null); setVerifyCode('')
    } catch {
      setErr(t('auth_verify_cancel_fail'))
    } finally { setBusy(false) }
  }

  // First run: no accounts exist, so there is nothing to sign in to and no point
  // offering sign-up — just set the built-in superuser's password.
  if (needsSetup) {
    return (
      <form className="set-auth" onSubmit={submit} autoComplete="off" style={cardStyle}>
        <Panel title={t('setup_submit')}>
          <Field label="admin"><span style={fieldMuted}>{t('setup_hint')}</span></Field>
          <Field label={t('setup_pw')}>
            <input type="password" autoFocus placeholder={t('setup_pw')} value={f.password} onChange={set('password')}
              style={inputStyle} name="su_pw" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
          </Field>
          <FieldActions>
            <Button type="submit" variant="primary" disabled={busy || !f.password}>{t('setup_submit')}</Button>
            {err && <span style={{ color: 'var(--danger-text)' }}>{err}</span>}
          </FieldActions>
        </Panel>
      </form>
    )
  }

  // The two modes live in the panel's own strip — the choice happens where the
  // title would be, not as a pair of buttons wedged in beside it.
  const tab = (m, label) => (
    <button type="button" className="set-plain" aria-pressed={mode === m} disabled={locked}
      onClick={() => { setMode(m); setErr('') }}>{label}</button>
  )
  const host = info && `${info.host || '?'}${info.version ? ` · ${info.version}` : ''}`
  const canSubmit = !busy && f.username.trim() && f.password && (!signup || f.email.trim())

  return (
    /* On signup we deliberately break the browser's login autofill (off /
       new-password) so it doesn't drop the saved sign-in id and password into
       the new-account fields. */
    <form className="set-auth" onSubmit={pending ? submitVerifyCode : submit}
      autoComplete={signup ? 'off' : 'on'} style={cardStyle}>
      {host && <span className="set-host">{host}</span>}
      <Panel strip={<>{tab('login', t('projects_login_title'))}{tab('signup', t('projects_signup'))}</>}>
        <Field label={t('projects_login_user')}>
          <input autoFocus placeholder={t('projects_login_user')} value={f.username} onChange={set('username')}
            style={inputStyle} disabled={locked}
            name={signup ? 'su_id' : 'username'}
            autoComplete={signup ? 'off' : 'username'}
            {...(signup ? { 'data-1p-ignore': true, 'data-lpignore': 'true' } : {})} />
        </Field>
        <Field label={t('projects_login_pass')}>
          <input type="password" placeholder={t('projects_login_pass')} value={f.password} onChange={set('password')}
            style={inputStyle} disabled={locked}
            name={signup ? 'su_pw' : 'password'}
            autoComplete={signup ? 'new-password' : 'current-password'}
            {...(signup ? { 'data-1p-ignore': true, 'data-lpignore': 'true' } : {})} />
        </Field>
        {signup && (
          <Field label={t('projects_signup_email')}>
            <input placeholder={t('projects_signup_email')} value={f.email} onChange={set('email')}
              style={inputStyle} disabled={locked}
              name="su_email" autoComplete="off" data-1p-ignore data-lpignore="true" />
            <span style={fieldMuted}>{t('auth_email_hint')}</span>
          </Field>
        )}
        {signup && (
          <Field label={t('projects_signup_code')}>
            <input placeholder={t('projects_signup_code')} value={f.invite_code} onChange={set('invite_code')}
              style={inputStyle} disabled={locked}
              name="su_code" autoComplete="off" data-1p-ignore data-lpignore="true" />
            <span style={fieldMuted}>{t('auth_invite_hint')}</span>
          </Field>
        )}
        {pending && (
          <Field label={t('auth_verify_label')}>
            <input autoFocus className="keep-font" inputMode="numeric" maxLength={6} placeholder="------"
              value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              style={{ ...inputStyle, width: 150, textAlign: 'center', letterSpacing: 5 }} />
            <span style={fieldMuted}>{t('auth_verify_hint')}</span>
          </Field>
        )}
        {pending && (pending.verify_code || pending.verify_url) && (
          <Field label="DEV">
            {pending.verify_code && <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>{pending.verify_code}</span>}
            {pending.verify_url && (
              <a href={pending.verify_url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{pending.verify_url}</a>
            )}
            <span style={fieldMuted}>{t('auth_verify_dev')}</span>
          </Field>
        )}
        <FieldActions>
          {pending ? (<>
            <Button type="submit" variant="primary" disabled={busy || verifyCode.length !== 6}>{t('auth_verify_submit')}</Button>
            <Button variant="secondary" disabled={busy} onClick={cancelSignup}>{t('auth_verify_cancel')}</Button>
          </>) : (
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {t(signup ? 'projects_signup_submit' : 'projects_login_submit')}
            </Button>
          )}
          {err && <span style={{ color: 'var(--danger-text)' }}>{err}</span>}
        </FieldActions>
      </Panel>
    </form>
  )
}

export default function ProjectsPage() {
  const { t, lang, setLang } = useLang()

  // ── the session ──
  const [user, setUser] = useState(null)        // null = signed out
  // Signed in: the account's language wins over this browser's last choice.
  useEffect(() => {
    let want = ''
    try { want = JSON.parse(user?.preferences_json || '{}').lang || '' } catch { /* none */ }
    if (want && want !== lang) setLang(want)
  }, [user?.id, user?.preferences_json])  // eslint-disable-line react-hooks/exhaustive-deps
  const [authReady, setAuthReady] = useState(false)
  const isManager = user?.role === 'manager'
  const [settingsTab, setSettingsTab] = useState('me')

  // PWA / deep-link return: the proxies bounce an unauthenticated page navigation
  // here as /projects?next=<original-url>. Once a session exists — fresh sign-in
  // or restored token, both of which re-set the proxy cookie — go back. Same-origin
  // paths only: one '/' then anything but '/', '\' or whitespace (browsers read
  // '//x', '/\x' and '/<tab>/x' as another host) — never an open redirect.
  const nextParam = (() => {
    const v = new URLSearchParams(window.location.search).get('next') || ''
    return /^\/[^/\\\s]/.test(v) ? v : ''
  })()
  useEffect(() => {
    if (user && nextParam) window.location.replace(nextParam)
  }, [user])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── what the cover shows ──
  const [projects, setProjects] = useState(null)   // null = loading
  const [homeCfg, setHomeCfg] = useState(null)     // manager: builtin overrides + card order
  const [groups, setGroups] = useState([])
  const [links, setLinks] = useState(null)
  const [portalInfo, setPortalInfo] = useState(null)   // { host, version } — which server this is
  const [publicCards, setPublicCards] = useState([])   // the signed-out bar
  const [publicLive, setPublicLive] = useState([])     // …and its live wall (what managers opened to visitors)

  useEffect(() => {
    launcher.get('/health').then((r) => setPortalInfo(r.data)).catch(() => {})
  }, [])
  // The signed-OUT bar's contents: its own call, because /services is
  // auth-aware and there is no session yet; an untouched portal answers [].
  useEffect(() => {
    if (user) return
    launcher.get('/public-services').then((r) => setPublicCards(r.data || [])).catch(() => setPublicCards([]))
    launcher.get('/public-live').then((r) => setPublicLive(r.data || [])).catch(() => setPublicLive([]))
  }, [user])
  // Restore a saved session.
  // Only a refused token (401/403) is dropped; any other failure (a 502 while
  // the backend restarts) keeps it and tries again, signed out meanwhile.
  useEffect(() => {
    const tok = store.get(PORTAL_TOKEN_KEY)
    if (!tok) { setAuthReady(true); return }
    setPortalToken(tok)
    let alive = true, timer = null
    const tryMe = () => {
      // Signed in or out by hand since: that session wins.
      if (!alive || launcher.defaults.headers.common.Authorization !== `Bearer ${tok}`) return
      launcher.get('/auth/me')
        .then((r) => { if (alive) setUser(r.data) })
        .catch((e) => {
          const st = e?.response?.status
          if (st === 401 || st === 403) setPortalToken(null)
          else if (alive) timer = setTimeout(tryMe, 5000)
        })
        .finally(() => { if (alive) setAuthReady(true) })
    }
    tryMe()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  // Each refresh takes a number; only the latest one's answers are applied, so
  // a slow, older response cannot overwrite a newer one (or a sign-out).
  const refreshSeq = useRef(0)
  async function refresh() {
    const seq = ++refreshSeq.current
    const live = () => seq === refreshSeq.current
    try {
      const svcs = (await launcher.get('/services')).data   // auth-aware, flagged list
      if (!live()) return
      setProjects(svcs)
      // Every role: the links card and its appearance come from one call, because
      // /admin/home (which holds the appearance) is admin-only.
      try { const d = (await launcher.get('/links')).data; if (live()) setLinks(d) } catch { /* optional */ }
      try { const d = (await launcher.get('/service-groups')).data; if (live()) setGroups(d || []) } catch { /* optional */ }
      if (isManager) { try { const d = (await launcher.get('/admin/home')).data; if (live()) setHomeCfg(d) } catch { /* optional */ } }
    } catch {
      if (live()) setProjects([])
    }
  }
  useEffect(() => { if (user) refresh() }, [user])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isManager) return
    launcher.get('/admin/home').then((r) => setHomeCfg(r.data)).catch(() => {})
  }, [isManager])

  // Signing out forgets everything the account loaded, so the next person on a
  // shared PC does not see the last one's cards; any refresh in flight is dropped.
  function signedOut() {
    setPortalToken(null)
    refreshSeq.current++
    setUser(null); setProjects(null); setGroups([]); setHomeCfg(null); setLinks(null); setSettingsTab('me')
  }
  function logout() {
    launcher.post('/auth/logout').catch(() => {})   // best-effort
    signedOut()
  }

  // ── the session ending under us ──
  // A request refused for want of a session (api.js), or the portal's own
  // sign-in page loading inside a service's frame (that frame's request was
  // refused): the account is gone, so the whole cover drops to signed out —
  // not the old account's sidebar, profile and manage mode with nothing behind them.
  useEffect(() => {
    const out = () => signedOut()
    const onMsg = (e) => { if (e.origin === window.location.origin && e.data?.type === 'lilak-portal-signed-out') out() }
    // A password change ends every session and hands this one a new token.
    const onToken = (e) => { if (e.detail) setPortalToken(e.detail) }
    window.addEventListener('portal:signed-out', out)
    window.addEventListener('portal:token', onToken)
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('portal:signed-out', out)
      window.removeEventListener('portal:token', onToken)
      window.removeEventListener('message', onMsg)
    }
  }, [])
  // Kept fresh while in use: a new token now and every half hour, and when the
  // tab comes back after a while — so a day's work does not end at the 24-hour
  // mark. A session left alone still runs out.
  useEffect(() => {
    if (!user) return
    let last = 0
    const renew = () => {
      if (Date.now() - last < 10 * 60 * 1000) return
      last = Date.now()
      launcher.post('/auth/refresh').then((r) => r.data?.access_token && setPortalToken(r.data.access_token)).catch(() => {})
    }
    renew()
    const timer = setInterval(renew, 30 * 60 * 1000)
    const onShow = () => { if (document.visibilityState === 'visible') renew() }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onShow) }
  }, [user?.id])
  // This page inside another portal page's frame (a service whose request was
  // refused, sent here to sign in): tell the outer cover, and draw nothing of
  // our own — a second sidebar inside the first is what that looked like.
  const framed = typeof window !== 'undefined' && window.self !== window.top
  useEffect(() => {
    if (framed && authReady && !user) {
      try { window.parent.postMessage({ type: 'lilak-portal-signed-out' }, window.location.origin) } catch { /* cross-origin parent */ }
    }
  }, [framed, authReady, user])

  // ── the cards ──
  // Builtins with the manager's saved label / icon / colour overrides applied.
  const bi = homeCfg?.builtins || {}
  const iconCard = { ...ICON_SERVICE, label: bi.iconlab?.label || ICON_SERVICE.name, icon: bi.iconlab?.icon || ICON_SERVICE.icon, color: bi.iconlab?.color, hidden: !!bi.iconlab?.hidden }
  const createCard = { ...CREATE_SERVICE, label: bi.newservice?.label || t('newsvc_title'), icon: bi.newservice?.icon || CREATE_SERVICE.icon, color: bi.newservice?.color, hidden: !!bi.newservice?.hidden }
  // Service Manager is part of home now; home keeps the card's colour.
  const homeIcon = { icon: 'home', color: bi.store?.color }
  const rackCard = { ...RACK_SERVICE, label: bi.rack?.label || t('rack_title'), icon: bi.rack?.icon || RACK_SERVICE.icon, color: bi.rack?.color, hidden: !!bi.rack?.hidden }
  const linkCfg = links?.card || {}
  const linksCard = { ...LINKS_SERVICE, label: linkCfg.label || t('links_title'), icon: linkCfg.icon || LINKS_SERVICE.icon, color: linkCfg.color, hidden: !!linkCfg.hidden, count: (links?.links || []).length }
  // Every card, hidden ones included: the sidebar has its own manage mode and
  // does its own hiding — filtering here meant a card hidden from the bar
  // vanished from manage mode too, with no way left to bring it back.
  const cardsAll = isManager
    ? sortByHome([iconCard, linksCard, ...(projects || []), createCard, rackCard], homeCfg?.order || [])
    : sortByHome([...(linksCard.hidden || !linksCard.count ? [] : [linksCard]), ...(projects || [])], homeCfg?.order || [])
  const cards = isManager ? cardsAll.filter((c) => !c.hidden) : cardsAll

  const groupKey = (g) => `#g:${g.id}`
  const memberOf = {}
  for (const g of groups) for (const m of g.members || []) memberOf[m] = g
  // Where a key sits: a manager by the saved order; everyone else by the order
  // mirrored into manifests (services) and group records (groups).
  const savedOrder = homeCfg?.order || []
  const defaultPos = new Map(cards.map((c, i) => [cardKey(c), i]))
  const orderOf = (key) => {
    if (isManager) { const o = savedOrder.indexOf(key); if (o >= 0) return o }
    if (key.startsWith('#g:')) { const g = groups.find((x) => groupKey(x) === key); return 1000 + (g?.order ?? 1000) }
    const c = cards.find((x) => cardKey(x) === key)
    if (!c) return 9999
    return isManager ? 1000 + (defaultPos.get(key) ?? 0) : (c.builtin ? -1 : 1000 + (c.order ?? 1000))
  }
  const fullOrder = [...cards.map(cardKey), ...groups.map(groupKey)].sort((a, b) => orderOf(a) - orderOf(b))

  // ── the writes the sidebar's manage mode makes ──
  async function regroup(key, gid) {
    if (!key || key.startsWith('#g:')) return
    const from = groups.find((g) => (g.members || []).includes(key))
    if ((from?.id || null) === (gid || null)) return
    if (from) await launcher.put(`/admin/service-groups/${from.id}`, { members: (from.members || []).filter((m) => m !== key) })
    if (gid) { const g = groups.find((x) => x.id === gid); await launcher.put(`/admin/service-groups/${gid}`, { members: [...(g?.members || []), key] }) }
  }
  async function saveOrder(keys) {
    setHomeCfg((c) => ({ ...(c || { builtins: {} }), order: keys }))   // optimistic
    try { await launcher.put('/admin/home-order', { keys }); await refresh() }
    catch { await refresh() }
  }
  // A band draws its cards in its group's member order: a move inside a group
  // is that list, rewritten.
  async function setMembers(gid, members) {
    try { await launcher.put(`/admin/service-groups/${gid}`, { members }); await refresh() }
    catch { await refresh() }
  }
  async function createGroup(name, members) {
    try {
      const body = { name: name || t('p_group_n', groups.filter((g) => !g.loose).length + 1) }
      const { data } = await launcher.post('/admin/service-groups', body)
      // A group made WITH members (the System band materialising, say) needs a
      // second call: create takes the name, membership is a patch.
      if (members?.length && data?.id) await launcher.put(`/admin/service-groups/${data.id}`, { members })
      await refresh()
    } catch (e) { notify(errText(e, t('p_failed')), 'bad') }
  }

  // Live mode: only live-capable services (no builtins, nothing hidden, nothing
  // inside a hidden group), in the cover's order, on a full-screen wall.
  const liveCards = fullOrder
    .map((k) => cards.find((c) => cardKey(c) === k))
    .filter((c) => c && c.live && !c.builtin && !c.hidden && !c.live_hidden && !memberOf[cardKey(c)]?.hidden)

  if (!authReady) return null
  if (framed && !user) {
    return <p style={{ padding: 24, color: 'var(--text-muted)' }}>{t('p_signed_out_framed')}</p>
  }

  // Signed out: the bar lists the services a manager marked PUBLIC (an untouched
  // portal has none, so the bar is simply empty) and the panel is the sign-in.
  if (!user) {
    return (
      <SidebarPortal
        user={null} isManager={false} cards={publicCards} iconFor={iconFor}
        groups={[]} liveCards={publicLive} links={[]} fullOrder={publicCards.map(cardKey)} info={portalInfo}
        authCard={<AuthCard t={t} info={portalInfo} needsSetup={!!portalInfo?.needs_setup}
          onAuthed={(u) => setUser(u)} />}
      />
    )
  }

  // The bar gets every card — builtins included, in the saved order — so nothing
  // is reachable through one route and invisible on the cover.
  const at = (c) => { const i = fullOrder.indexOf(cardKey(c)); return i < 0 ? 9999 : i }
  const sideCards = [...cardsAll].sort((a, b) => at(a) - at(b))
  return (
    <SidebarPortal
      user={user} isManager={isManager} cards={sideCards} iconFor={iconFor}
      groups={groups} liveCards={liveCards} links={links?.links || []}
      fullOrder={fullOrder}
      onLogout={logout} onRefresh={refresh}
      onSaveOrder={saveOrder} onRegroup={regroup} onCreateGroup={createGroup} onSetMembers={setMembers}
      settingsTab={settingsTab} onSettingsTab={setSettingsTab} info={portalInfo} homeIcon={homeIcon}
    />
  )
}
