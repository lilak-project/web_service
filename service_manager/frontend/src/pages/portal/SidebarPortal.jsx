import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon, MANAGER_COLOR, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { HOME_MODES } from './HomeModeMenu'
import AccountView, { settingsMenu } from './AccountView'
import { SettingsStatus } from './settingsMsg'
import LiveWall from './LiveWall'
import ServiceManagePanel from './ServiceManagePanel'
import ServiceProjects from './ServiceProjects'
import ServiceSingle from './ServiceSingle'
import GroupManagePanel, { FixedGroupPanel } from './GroupManagePanel'
import LinksView from './LinksView'
import StoreView from './StoreView'
import NewServiceView from './NewServiceView'
import IconLabView from './IconLabView'
import RackView from './RackView'
import ArchivePanel from './ArchivePanel'
import './sidebar.css'

/** A card's stable key — the same one the cover and the saved order use, so a
 *  builtin ("@links") and a service ("elog") can share one list. */
const cardKey = (c) => (c.builtin ? '@' + c.builtin : c.name)

/** The portal's own tools always band together: they are things you do TO the
 *  portal, not services it runs, and an admin should not have to file them. */
const SYSTEM_KEYS = ['@iconlab', '@newservice', '@store', '@rack']
const SYSTEM_ID = '@system'
const NOGROUP_ID = '@none'
// The name a materialised System band is stored under. Until something is
// dragged into it the band is synthetic — there is nothing to store, because
// its members are the same three builtins on every portal.
const SYSTEM_NAME = 'System'

/** The second bar: it steps out of the service bar, and folds back into it.
 *  Kept mounted through the fold — with the last contents it had, since the
 *  caller has already stopped passing them by then. */
function StepOut({ open, kind, children }) {
  // `live` is what is ON SCREEN, which lags `kind` by one fold: asked for a
  // different bar, this one folds away first and the next steps out after it,
  // so settings closing and manage opening read as two motions rather than a
  // column whose contents changed under you.
  const [live, setLive] = useState(open ? kind : null)
  const last = useRef(children)
  if (open && live === kind) last.current = children
  useEffect(() => { if (open && live === null) setLive(kind) }, [open, kind, live])
  const folding = live !== null && (!open || live !== kind)
  // The swap waits on animationend, which never fires if the browser is not
  // painting — a tab put in the background mid-fold left the OLD bar standing
  // (settings showing while manage mode was on). The same backstop the project
  // list has. The fold is --b2t (.38s); 600ms leaves room for a late frame, so
  // the timer only ever finishes a fold the browser abandoned.
  useEffect(() => {
    if (!folding) return
    const t = setTimeout(() => setLive(open ? kind : null), 600)
    return () => clearTimeout(t)
  }, [folding, open, kind])
  if (live === null) return null
  return (
    // Keyed on what it holds, so swapping remounts it and the step-out plays
    // again instead of the browser reusing a finished animation.
    <aside key={live} className={`pl-bar2${folding ? ' folding' : ''}`}
      onAnimationEnd={(e) => {
        // The box and its contents both animate; one of them is enough.
        if (folding && e.target === e.currentTarget) setLive(open ? kind : null)
      }}>
      <div className="pl-b2in">{last.current}</div>
    </aside>
  )
}

/** The order list with `key` lifted out and dropped next to `target`. */
function movedOrder(base, key, target, after) {
  const keys = base.filter((k) => k !== key)
  let at = keys.indexOf(target)
  if (at < 0) at = keys.length
  else if (after) at += 1
  keys.splice(at, 0, key)
  return keys
}

/**
 * SidebarPortal — the sidebar cover: services on the left, the selected one in a
 * panel on the right (mockups/portal-sidebar-a.html).
 *
 * A service opens according to its manifest `open`:
 *   'panel'  — an iframe inside the panel. Same origin (the portal serves /p/
 *              itself), so the session cookie and the proxy's base-href
 *              injection work exactly as in a tab.
 *   'window' — its own tab. Multi-project services default to this: they bring
 *              their own top bar, command bar and drawer, which read as a second
 *              set of chrome once framed. It describes the SERVICE, so it holds
 *              for its projects too.
 *
 * Groups are the portal's EXISTING ones (data/_portal/service_groups.json, made in
 * manage mode) rather than a per-manifest field, so a band can hold builtins too
 * and keeps carrying the visibility and grants the admin screens apply.
 *
 * It is the only cover: the classic card grid and the switch between the two
 * were removed once everything the grid did had a place here.
 */
const MINI_KEY = 'portal-mini'
const ARCHIVE_KEY = '#archive'
const PIN_KEY = 'portal-pin'
const FLAT_KEY = 'portal-flat'
const SHUT_KEY = 'portal-groups-shut'
const WIDE = 900          // below this the bar collapses on its own
// Narrow enough that one open bar fills the screen: the bar still stands, it
// just starts folded and folds again whenever something opens beside it.
const PHONE = 640

const readSet = (key) => {
  try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return new Set(Array.isArray(a) ? a : []) }
  catch { return new Set() }
}
const writeSet = (key, set) => {
  try { localStorage.setItem(key, JSON.stringify([...set])) } catch { /* private mode */ }
}

/** Every tile is filled with its colour and carries a white glyph; the PICKED one
 *  is told apart by SHAPE — its plate rounds into a circle. A shape survives what
 *  the colour tricks did not: there is no outline to crop against the collapsed
 *  bar's clip edge, and it still reads when two services share a colour.
 *
 *  19px, not 17: inside a 30px plate a smaller glyph leaves so much margin that
 *  the icon reads as shrunken. */
/** Running / stopped, drawn the same way wherever it appears — the corner of a
 *  head of a project card. Running is a green play button;
 *  stopped is a tiny grey dot, which only has to say "nothing here is running".
 *  Sizes live in the stylesheet so the two can differ — the button needs room the
 *  dot does not. */
function RunDot({ on }) {
  return (
    <span className={`pl-run${on ? ' up' : ''}`}>
      {on && <Icon name="play" size={7} weight="fill" color="#fff" />}
    </span>
  )
}

function Tile({ icon, color, on }) {
  const c = color || 'var(--text-secondary)'
  return (
    <span className={`pl-av${on ? ' round' : ''}`} style={{ background: c }}>
      <Icon name={icon} size={19} weight="fill" color="#fff" />
    </span>
  )
}

/** Selection ⇄ URL. Without this the address bar never moves: a reload would land
 *  on the empty panel, Back would leave the portal, and a link to one project
 *  could not be sent to anyone. */
function readSel() {
  const q = new URLSearchParams(window.location.search)
  const s = q.get('s') || ''
  return s ? { svc: s, proj: q.get('p') || '' } : null
}
function writeSel(sel) {
  const q = new URLSearchParams(window.location.search)
  if (sel?.svc) { q.set('s', sel.svc); sel.proj ? q.set('p', sel.proj) : q.delete('p') }
  else { q.delete('s'); q.delete('p') }
  const qs = q.toString()
  window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
}

/** Slide a list open/closed for real (height + the cards travelling) instead of
 *  fading it. Keep rendering while the phase is 'leave'. */
function useSlide(open) {
  const ref = useRef(null)
  const [shown, setShown] = useState(open)
  const [phase, setPhase] = useState(null)
  useLayoutEffect(() => {
    if (open && !shown) { setShown(true); setPhase('enter') }
    else if (!open && shown) { setPhase('leave') }
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps
  // --h is the height to grow to. A project list is fetched, so the first open
  // measures the "…" placeholder and the box would stop short of the rows that
  // land a moment later, then snap. Re-measure whenever the content resizes and
  // the animation retargets instead of jumping.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !phase) return
    const measure = () => el.style.setProperty('--h', `${el.scrollHeight}px`)
    measure()
    if (phase === 'leave' || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    for (const kid of el.children) ro.observe(kid)
    return () => ro.disconnect()
  }, [phase, shown])
  // A BACKSTOP, because the open list's height must not depend on an event.
  // `.enter` holds max-height at the animation's first keyframe — 0 — and only
  // animationend takes the class off again. Any frame the browser does not
  // paint (a background tab, a hidden pane, a window that was never composited
  // since the click) leaves the animation at t=0 and the event never fires:
  // the card says open, the chevron turns, and the list sits at zero height.
  // The timer ends the phase whatever the compositor did.
  useEffect(() => {
    if (!phase) return
    const t = setTimeout(() => {
      if (phase === 'leave') setShown(false)
      setPhase(null)
    }, 400)
    return () => clearTimeout(t)
  }, [phase])
  const onAnimEnd = (e) => {
    // Children animate too and their animationend bubbles — only the container's
    // own end means the transition is over.
    if (e.target !== ref.current) return
    if (phase === 'leave') setShown(false)
    setPhase(null)
  }
  return { ref, shown, cls: phase || '', onAnimEnd }
}

/** A sliding list of small cards — used for a service's projects, a group's
 *  members and the modes rows, so all three open the same way. */
function Slider({ open, className = '', children }) {
  const slide = useSlide(open)
  if (!slide.shown) return null
  return (
    <div ref={slide.ref} className={`pl-projs ${className} ${slide.cls}`} onAnimationEnd={slide.onAnimEnd}>
      {children}
    </div>
  )
}

function ProjectList({ svc, color, sel, onPick, open }) {
  const { lang } = useLang()
  const [rows, setRows] = useState(null)

  useEffect(() => {
    if (!open || rows) return
    launcher.get(`/services/${svc}/projects`).then((r) => setRows(r.data)).catch(() => setRows([]))
  }, [open, svc])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Slider open={open} className="pl-plist">
      {rows === null && <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>…</div>}
      {rows?.length === 0 && (
        <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>{tr("p_no_projects")}</div>
      )}
      {(rows || []).map((p) => {
        const on = sel?.svc === svc && sel?.proj === p.name
        return (
          <button key={p.name} type="button" className={`pl-proj${on ? ' on' : ''}`}
            onClick={() => onPick(p.name)}>
            <RunDot on={!!p.running} />
            <span className="pl-txt">{p.name}</span>
            <span className="pl-out" role="button" tabIndex={-1} title={tr("p_new_tab")}
              onClick={(e) => { e.stopPropagation(); window.open(`/pp/${svc}/${p.name}/`, '_blank') }}>
              <Icon name="link" size={13} />
            </span>
          </button>
        )
      })}
    </Slider>
  )
}

export default function SidebarPortal({
  user, isManager, cards, groups, liveCards, links, iconFor, fullOrder,
  onLogout, onRefresh, onSaveOrder, onRegroup, onCreateGroup,
  settingsTab, onSettingsTab, authCard, info,
}) {
  // Signed out: the bar is a list of names and the panel is the login card.
  // Nothing opens, nothing is managed, and the foot has no account to show.
  const signedOut = !!authCard

  // Logging out takes the settings bar with it — it belongs to an account, and
  // the cover would otherwise keep showing yesterday's menu beside the sign-in
  // panel. Also un-collapses, since settings was what collapsed the bar.
  useEffect(() => {
    if (!signedOut) return
    setView('empty'); setManage(false); setMini(false)
    miniBefore.current = null; viewBefore.current = null
  }, [signedOut])
  const { lang } = useLang()

  const [mini, setMini] = useState(() => {
    // On a phone the bar is a drawer over the panel: arriving with a service
    // already chosen (a shared link, a reload) should show the service, not the
    // menu. Wider, the saved choice wins, and a first visit collapses only when
    // the window is too narrow to spare 260px.
    if (window.innerWidth < PHONE) return !!readSel()
    const saved = localStorage.getItem(MINI_KEY)
    return saved !== null ? saved === '1' : window.innerWidth < WIDE
  })
  // Command mode: the keyboard is talking to the BAR, not to the service that
  // has the focus. Esc turns it on, the cards say which key is theirs, Esc (or
  // any click) turns it off.
  const [cmd, setCmd] = useState(false)
  const [cmdKeys, setCmdKeys] = useState([])    // card keys, in the order shown
  // Pinned: the bar was opened ON PURPOSE, from the switch that names itself,
  // so nothing that folds it as a side effect may fold it — opening a service,
  // picking a project, a narrower window. Only the switch (or the logo, which
  // is the same switch) puts it back.
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem(PIN_KEY) === '1' } catch { return false }
  })
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  /** Fold, unless the bar is pinned open. Every automatic fold goes through it. */
  const fold = useCallback(() => { if (!pinnedRef.current) setMini(true) }, [])
  const [sel, setSel] = useState(readSel)        // { svc, proj } — mirrored in the URL
  const [view, setView] = useState(() => (readSel() ? 'service' : 'empty'))  // service|settings|live|empty
  // A record another service asked to open here ({ svc, proj, id }): a link in
  // one service's panel (a paper on an activity) lands on that record in its
  // own. Only the services the portal itself frames may ask.
  const [deep, setDeep] = useState(null)
  useEffect(() => {
    const on = (e) => {
      if (e.origin !== window.location.origin) return
      const m = e.data
      if (!m || m.type !== 'lilak:open' || !m.svc) return
      setSel({ svc: String(m.svc), proj: String(m.proj || '') })
      setView('service')
      setDeep({ svc: String(m.svc), proj: String(m.proj || ''), id: String(m.id || '') })
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  // A Set, not one name: opening a service must not close another. Several
  // project lists can stand open at once.
  const [openSvcs, setOpenSvcs] = useState(() => {
    // Only a restored PROJECT has a list to reopen. Seeding on the service
    // alone pinned that card lit for the rest of the session: projOpen() is
    // half of what draws a card's ring, and a card with no project list has
    // nothing that ever takes it back out of this set — so the card selected
    // at load stayed pressed however many others you opened after it.
    const s0 = readSel()
    return new Set(s0?.svc && s0.proj ? [s0.svc] : [])
  })
  const [flat, setFlat] = useState(() => localStorage.getItem(FLAT_KEY) === '1')
  const [shut, setShut] = useState(() => readSet(SHUT_KEY))
  // Manage mode: the bar becomes editable (drag to arrange, a button to make a
  // group) and picking a card shows its settings in the panel instead of running it.
  const [manage, setManage] = useState(false)
  // The archive: services whose data was deleted. Archiving happens from a
  // service's own manage panel, so restoring has to be reachable from manage
  // mode too — otherwise an archived service never comes back on this cover.
  const [archivedN, setArchivedN] = useState(0)
  const [archiveTick, setArchiveTick] = useState(0)
  const loadArchived = useCallback(() => {
    launcher.get('/admin/archived').then((r) => setArchivedN((r.data || []).length)).catch(() => setArchivedN(0))
    setArchiveTick((n) => n + 1)
  }, [])
  const [drag, setDrag] = useState(null)        // key being dragged
  const [dropAt, setDropAt] = useState(null)    // { key, after } | { gid } | { end: true }
  // Opening settings leaves the service bar as it is — the menu steps out beside
  // it, it does not take its room. Only a phone, where the menu is a drawer over
  // everything, still folds the bar; miniBefore is what it folded FROM.
  const miniBefore = useRef(null)
  const viewBefore = useRef(null)

  // ── peeking ──────────────────────────────────────────────────────────────
  // Resting the pointer on the folded rail for a second opens it; taking the
  // pointer away folds it again. It is a LOOK, not a decision: it is not
  // written down, so a reload still comes back folded, and the first press
  // inside makes it an ordinary open that stays.
  const peek = useRef(false)
  const peekT = useRef(null)
  const stopPeekTimer = () => { clearTimeout(peekT.current); peekT.current = null }
  function onSideEnter() {
    if (!mini || peek.current || manageRef.current) return
    if (window.innerWidth < PHONE) return          // a drawer, and there is no hover
    stopPeekTimer()
    peekT.current = setTimeout(() => { peek.current = true; setMini(false) }, 1000)
  }
  function onSideLeave() {
    stopPeekTimer()
    if (!peek.current || manageRef.current) return
    peek.current = false
    setMini(true)
  }
  // A press is a decision: whatever happens next, this is no longer a peek.
  const endPeek = () => { stopPeekTimer(); peek.current = false }
  useEffect(() => stopPeekTimer, [])

  useEffect(() => { localStorage.setItem(PIN_KEY, pinned ? '1' : '0') }, [pinned])
  useEffect(() => {
    if (peek.current) return                       // a look is not a preference
    localStorage.setItem(MINI_KEY, mini ? '1' : '0')
    // Collapsing hides the project lists; close them too, so expanding again does
    // not reveal a list the user last saw minutes ago.
    if (mini) setOpenSvcs(new Set())
  }, [mini])
  useEffect(() => { localStorage.setItem(FLAT_KEY, flat ? '1' : '0') }, [flat])
  useEffect(() => { writeSet(SHUT_KEY, shut) }, [shut])
  useEffect(() => { writeSel(view === 'service' ? sel : null) }, [sel, view])

  // What `fit` needs to know without becoming a reason for it to re-run.
  useEffect(() => { if (manage && isManager) loadArchived() }, [manage, isManager, loadArchived])
  const manageRef = useRef(false)
  manageRef.current = manage && isManager

  useEffect(() => {
    // The width rule only ever FOLDS. A window too narrow for 260px cannot show
    // the bar, so it closes — but it must not UNFOLD a bar the reader folded on
    // purpose, and it must not run on mount at all: doing both is what threw
    // the remembered choice away on every reload. The saved value is already
    // read by useState above, narrow first visits included.
    const fit = () => {
      const w = window.innerWidth
      if (w < PHONE) return                      // narrow: the user's choice stands
      // Managing needs the bar wide, whatever the window does: the grips, the
      // drop bands and the drag itself are not reachable at 64px. Read through
      // a ref, so this effect runs ONCE — with `manage` in its deps it re-ran
      // when the account finally loaded and re-collapsed a bar that a click
      // had just opened on purpose.
      if (manageRef.current) { setMini(false); return }
      if (w < WIDE) fold()
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fold])

  // One handler for the whole bar's keyboard. It also goes on the open service's
  // document: a service has the focus almost all the time, and the portal never
  // sees a key pressed in there.
  //
  //   `  (₩ on a Korean layout)  fold the bar / bring it back — the ONLY key
  //                              that does; command mode leaves the width alone
  //   Esc                        command mode on — and off again
  //   1..9 · 0                  while it is on: a card, or the account
  //
  // `\` is left alone: elog's drawer already has it.
  const foldKey = useRef(null)
  const sideRef = useRef(null)
  const enterCmd = useCallback(() => {
    const nodes = [...(navRef.current?.querySelectorAll('.pl-card[data-key]') || [])]
    setCmdKeys(nodes.map((n) => n.dataset.key))
    setCmd(true)
    // Take the focus back from the service, or the next key goes to it again.
    try { window.focus(); sideRef.current?.focus({ preventScroll: true }) } catch { /* no focus */ }
  }, [])
  foldKey.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const el = (e.target?.ownerDocument || document).activeElement
    const tag = (el?.tagName || '').toUpperCase()
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable
    if (e.key === 'Escape') {
      // Inside the service Esc is the service's own key first; it only reaches
      // the portal when nothing there took it.
      if (e.defaultPrevented) return
      // Escape out of a field is the whole point of Escape: the field lets go,
      // and the keys mean the bar again.
      if (typing) { try { el.blur() } catch { /* gone already */ } }
      if (cmd) { setCmd(false); return }
      enterCmd()
      return
    }
    if (typing) return
    if (e.key === '`' || e.key === '₩') {
      if (manageRef.current) return               // managing holds the bar open
      e.preventDefault()
      setMini((m) => !m)
      return
    }
    if (!cmd) return
    const press = (sel2) => {
      // The whole bar, not the card list: the account card sits outside it, and
      // looking only in .pl-nav found nothing and did nothing.
      const n = sideRef.current?.querySelector(sel2)
      if (!n) return
      e.preventDefault()
      setCmd(false)
      n.click()
    }
    if (e.key === '0') press('.pl-user .pl-row')
    else if (/^[1-9]$/.test(e.key)) {
      const key = cmdKeys[Number(e.key) - 1]
      if (key) press(`.pl-card[data-key="${CSS.escape(key)}"] .pl-row`)
    }
  }
  // ⌘R / Ctrl+R with the portal focused reloads the service in the panel,
  // not the portal. (Inside the panel the service does the same itself.)
  // ⇧⌘R is left to the browser.
  const frameRef = useRef(null)
  useEffect(() => {
    const on = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r' && frameRef.current) {
        e.preventDefault()
        try { frameRef.current.contentWindow.location.reload() } catch { frameRef.current.src = frameRef.current.src }
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  useEffect(() => {
    const on = (e) => foldKey.current(e)
    window.addEventListener('keydown', on)
    // A click is you pointing at what you want; the keys are not needed for it.
    const off = () => setCmd(false)
    window.addEventListener('mousedown', off)
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('mousedown', off) }
  }, [])

  const leaveSettings = useCallback(() => {
    // At phone width settings takes the screen and the bar was folded for it;
    // coming back restores what it was — but a pinned bar was not folded by a
    // decision of ours, so it comes back open.
    if (miniBefore.current !== null) {
      setMini(pinnedRef.current ? false : miniBefore.current)
      miniBefore.current = null
    }
    // Whatever was on screen before settings is no longer where we are going.
    viewBefore.current = null
  }, [])

  const openSettings = useCallback((tab) => {
    viewBefore.current = { view, sel }
    if (window.innerWidth < PHONE) {
      if (miniBefore.current === null) miniBefore.current = mini
      setMini(true)
    }
    // Settings and manage are two different jobs, and manage needs the bar wide:
    // leaving one for the other rather than stacking them keeps the bar readable.
    setManage(false)
    setSel(null)
    setView('settings')
    onSettingsTab?.(tab || 'me')
  }, [mini, view, sel, onSettingsTab])

  /** The account button opens the settings bar AND closes it — it is the thing
   *  the bar hangs off, so pressing it again should put it away rather than
   *  leaving the only way out at the far end of the menu. */
  const toggleSettings = useCallback(() => {
    if (view !== 'settings') { openSettings('me'); return }
    const was = viewBefore.current
    viewBefore.current = null
    leaveSettings()
    setSel(was?.view === 'service' ? was.sel : null)
    setView(was?.view === 'service' && was.sel ? 'service' : 'empty')
  }, [view, openSettings, leaveSettings])

  const openService = useCallback((s) => {
    if (signedOut) { setSel({ svc: cardKey(s), proj: '' }); return }
    leaveSettings()
    // A builtin is a portal tool, not a proxied URL: it opens in the panel as a
    // component. Everything else follows its manifest `open`.
    if (!s.builtin && s.open === 'window') { window.open(`/p/${s.name}/`, '_blank'); return }
    const key = cardKey(s)
    // Opening a service gives it the screen: the bar folds to the rail. Pressing
    // the one you are already on is how you get the bar back — and pressing it
    // again folds it away, so the rail is a handle for the bar as well as a
    // list of services.
    // Pressing what is already open folds the bar away — unless it is pinned,
    // which is the point of pinning.
    if (view === 'service' && sel?.svc === key) { if (!pinnedRef.current) setMini((m) => !m); return }
    setSel({ svc: key, proj: '' })
    setView('service')
    fold()
  }, [signedOut, leaveSettings, view, sel, fold])

  /** Manage mode: picking a card shows its settings in the panel, never runs it. */
  const openManage = useCallback((s) => {
    leaveSettings()
    setSel({ svc: cardKey(s), proj: '' })
    setView('manage')
    if (window.innerWidth < PHONE) fold()
  }, [fold])

  // `open` is a property of the SERVICE, so it governs its projects too: a service
  // whose chrome belongs in its own tab does not become panel-friendly just
  // because you reached it through a project.
  const pickProject = useCallback((s, proj) => {
    leaveSettings()
    if (s.open === 'window') { window.open(`/pp/${s.name}/${proj}/`, '_blank'); return }
    // Opening a project gives it the screen, exactly as opening a service does:
    // the bar folds to the rail, and pressing the project you are already in
    // brings the bar back — then folds it again.
    if (view === 'service' && sel?.svc === s.name && sel?.proj === proj) {
      if (!pinnedRef.current) setMini((m) => !m)
      return
    }
    setSel({ svc: s.name, proj })
    setView('service')
    fold()
  }, [view, sel, leaveSettings, fold])

  const projOpen = (name) => openSvcs.has(name)
  const toggleProj = (name) => setOpenSvcs((o) => {
    const n = new Set(o); n.has(name) ? n.delete(name) : n.add(name); return n
  })
  const groupOpen = (gid) => !shut.has(gid)
  const toggleGroup = (gid) => setShut((s) => {
    const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n
  })

  // Cards laid out as bands: each group in its order, then whatever belongs to no
  // group. `cards` arrives in the cover's saved order and holds BUILTINS too
  // (@links, @store, …), so the two covers show the same things in the same order.
  const bands = useMemo(() => {
    const list = (cards || []).filter((c) => !c.hidden || (manage && isManager))
    // Signed out there is one kind of thing in the bar and no groups to read it
    // by, so it is a plain list whatever the reader's group-mode setting says.
    if (flat || signedOut) return [{ g: null, items: list }]
    const byKey = new Map(list.map((c) => [cardKey(c), c]))
    const taken = new Set()
    const out = []
    // System first, and always: the portal's own tools are not filed by hand —
    // unless an admin drags a service in, at which point the band is a stored
    // group like any other and the loop below draws it.
    const stored = (groups || []).find((g) => g.name === SYSTEM_NAME)
    if (!stored) {
      const sys = SYSTEM_KEYS.map((k) => byKey.get(k)).filter(Boolean)
      sys.forEach((c) => taken.add(cardKey(c)))
      if (sys.length) out.push({ g: { id: SYSTEM_ID, name: tr("p_system"), fixed: true }, items: sys })
    }
    const gs = [...(groups || [])]
      .filter((g) => !g.hidden || (manage && isManager))
      .sort((a, b) => (a.name === SYSTEM_NAME ? -1 : b.name === SYSTEM_NAME ? 1 : (a.order ?? 1000) - (b.order ?? 1000)))
    const filed = new Set(gs.flatMap((g) => g.members || []))
    for (const g of gs) {
      const items = (g.members || []).map((k) => byKey.get(k)).filter((c) => c && !taken.has(cardKey(c)))
      // A builtin that did not exist when the System band was materialised is
      // still a system tool. Without this it lands in "No group", which no
      // admin asked for and which looks like a bug in the new tool.
      if (g.name === SYSTEM_NAME) {
        for (const k of SYSTEM_KEYS) {
          const c = !filed.has(k) && byKey.get(k)
          if (c && !taken.has(cardKey(c))) items.push(c)
        }
      }
      items.forEach((c) => taken.add(cardKey(c)))
      // An empty group still shows in manage mode — otherwise a group you just
      // made vanishes and there is nothing to drag onto.
      if (items.length || (manage && isManager)) out.push({ g, items })
    }
    // In group mode EVERY card is in a band, so the eye reads one kind of thing
    // down the bar instead of bands and then loose cards.
    const rest = list.filter((c) => !taken.has(cardKey(c)))
    out.push({ g: { id: NOGROUP_ID, name: tr("p_no_group"), loose: true }, items: rest })
    return out
  }, [cards, groups, flat, manage, isManager, signedOut, lang])

  // ── manage mode: drag to arrange ────────────────────────────────────────
  const gidOf = (key) => (groups || []).find((g) => (g.members || []).includes(key))?.id ?? null
  const onDrop = async () => {
    const key = drag
    const at = dropAt
    setDrag(null); setDropAt(null)
    if (!key || !at) return
    if (at.gid === SYSTEM_ID) {
      const present = SYSTEM_KEYS.filter((k) => (cards || []).some((c) => cardKey(c) === k))
      try { await onCreateGroup?.(SYSTEM_NAME, [...present, key]) } catch { await onRefresh?.() }
      return
    }
    let gid = null
    let keys = null
    if (at.gid !== undefined) {
      gid = at.gid
      // Dropped on a band rather than on one of its cards: go to its end.
      const g = (groups || []).find((x) => x.id === at.gid)
      const members = (fullOrder || []).filter((k) => (g?.members || []).includes(k) && k !== key)
      keys = members.length ? movedOrder(fullOrder, key, members[members.length - 1], true) : null
    } else if (at.key) {
      if (at.key === key) return
      gid = gidOf(at.key)
      keys = movedOrder(fullOrder, key, at.key, at.after)
    }
    try {
      if (gidOf(key) !== gid) await onRegroup?.(key, gid)
      if (keys) await onSaveOrder?.(keys)
      else await onRefresh?.()
    } catch { await onRefresh?.() }
  }
  const dragProps = (key) => (!manage || !isManager ? {} : {
    draggable: true,
    onDragStart: (e) => { setDrag(key); e.dataTransfer.effectAllowed = 'move' },
    onDragEnd: () => { setDrag(null); setDropAt(null) },
    onDragOver: (e) => {
      if (!drag || drag === key) return
      e.preventDefault(); e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      setDropAt({ key, after: e.clientY > r.top + r.height / 2 })
    },
    onDrop: (e) => { e.preventDefault(); e.stopPropagation(); onDrop() },
  })
  const bandProps = (gid) => (!manage || !isManager ? {} : {
    onDragOver: (e) => { if (!drag) return; e.preventDefault(); setDropAt({ gid }) },
    onDrop: (e) => { e.preventDefault(); onDrop() },
  })
  // Reordering moves the OTHER cards, and a card that teleports to its new row
  // is a card you have to find again. FLIP: remember where each one was, and
  // when the order changes put it back there for a frame and let it travel.
  // Only when the ORDER changed — a band opening or the grips appearing move
  // cards too, and those have animations of their own.
  const navRef = useRef(null)
  const posRef = useRef(new Map())
  const seqRef = useRef('')
  useLayoutEffect(() => {
    const nodes = [...(navRef.current?.querySelectorAll('.pl-card[data-key]') || [])]
    const next = new Map(nodes.map((n) => [n.dataset.key, n.getBoundingClientRect().top]))
    const seq = nodes.map((n) => n.dataset.key).join('|')
    const reordered = seq !== seqRef.current && seqRef.current !== ''
    seqRef.current = seq
    if (reordered && manage && isManager) {
      for (const n of nodes) {
        const was = posRef.current.get(n.dataset.key)
        const now = next.get(n.dataset.key)
        // The one under the cursor is already where the hand put it.
        if (was == null || was === now || n.dataset.key === drag) continue
        n.style.transition = 'none'
        n.style.transform = `translateY(${was - now}px)`
        requestAnimationFrame(() => {
          n.style.transition = 'transform .18s ease'
          n.style.transform = ''
        })
      }
    }
    posRef.current = next
  })

  /** Dropped on the manage bar's target: the card leaves the cover. Same call
   *  the Hide button makes, so a card hidden by dragging is hidden the same way
   *  and comes back the same way. */
  const hideDropped = async () => {
    const card = (cards || []).find((c) => cardKey(c) === drag)
    setDrag(null); setDropAt(null)
    if (!card) return
    try {
      if (card.builtin) await launcher.put('/admin/home-builtin', { key: card.builtin, hidden: true })
      else await launcher.put('/admin/home-service', { name: card.name, hidden: true })
    } finally { await onRefresh?.() }
  }

  /** Where a band's drop puts a card: a real group, or out of every group.
   *  The synthetic System band takes drops too — the first one turns it into a
   *  stored group holding the builtins plus what you dropped. */
  const bandDrop = (g) => bandProps(g.fixed ? SYSTEM_ID : g.loose ? null : g.id)
  /** The line drawn in the gap where a dragged card would land. */
  const dropLine = (key, after) =>
    (dropAt?.key === key && !!dropAt.after === after ? <div className="pl-dropline" /> : null)

  // One button, two jobs: while anything is open it closes everything; once
  // everything is shut it becomes the way back. (Opening deliberately only
  // reopens the BANDS — reopening every project list too buries the bar.)
  const bandIds = bands.map((b) => b.g?.id).filter(Boolean)
  const anyOpen = bandIds.some((id) => !shut.has(id)) || openSvcs.size > 0
  const foldAll = () => {
    if (anyOpen) { setShut(new Set(bandIds)); setOpenSvcs(new Set()) }
    else setShut(new Set())
  }

  /** Manage on/off. Leaving it drops back to the empty panel rather than framing
   *  whatever card you happened to be editing.
   *  Manage always runs in GROUP mode: a flat list has no bands, so there is
   *  nothing to drop a card into and nowhere for a new group to appear. The
   *  reader's own setting is put back on the way out. */
  const toggleManage = () => {
    leaveSettings()
    setManage((m) => {
      const next = !m
      setSel(null)
      setView(next ? 'manage' : 'empty')
      // Group mode is the reader's choice, not a condition of managing: it is
      // offered on the plinth below, the way the settings menu offers it.
      if (next) { setMini(false); setOpenSvcs(new Set()) }
      return next
    })
  }
  const openManageGroup = (g) => { setSel({ svc: `#g:${g.id}`, proj: '' }); setView('manage') }

  const enterLive = () => {
    leaveSettings()
    setView('live')
    fold()                                       // a wall wants the width
  }

  const selSvc = (cards || []).find((c) => cardKey(c) === sel?.svc)
  // A multi-project service has nothing to show on its own — the panel asks for a
  // project instead of framing the service root.
  const needProject = !!selSvc?.multi_project && !sel?.proj
  // A single service this user may see but not enter — no grant yet, or an
  // email verification that has lapsed. Framing it would only show the proxy's
  // refusal; the panel instead says which of the two it is and, when it can,
  // offers to ask for access. (A multi-project service does this per project,
  // in its own project panel.)
  const locked = !!selSvc && !signedOut && !selSvc.builtin && !selSvc.multi_project
    && (selSvc.can_enter === false || !!selSvc.view_only)
  const base = sel?.svc && !needProject && !locked && !selSvc?.builtin && !manage
    ? (sel.proj ? `/pp/${sel.svc}/${sel.proj}/` : `/p/${sel.svc}/`)
    : null
  // The record asked for rides along as #open=…, which the service reads.
  const src = base && deep?.id && deep.svc === sel.svc && deep.proj === (sel.proj || '')
    ? `${base}#open=${encodeURIComponent(deep.id)}` : base

  const serviceCard = (s) => {
    const key = cardKey(s)
    const hot = cmd ? cmdKeys.indexOf(key) : -1     // its key while command mode is on
    // Opening a service's projects counts as picking it: its tile fills, and the
    // card takes the selected border while the bar is expanded (collapsed, every
    // card's border is transparent, so the tile carries it alone).
    const on = ((view === 'service' || view === 'manage' || signedOut) && sel?.svc === key) || projOpen(key)
    // In manage mode a card is a thing to arrange and edit, never a thing to run:
    // even a multi-project service opens its settings instead of its project list.
    // A service that has nominated one project as its entrance is not a list
    // either: pressing it goes straight in, which is what the nomination means.
    const multi = s.multi_project && !s.entry_project && !manage && !signedOut
    // The project list is hidden at 64px (.pl-root.mini .pl-plist), so a card
    // marked open while the bar is folded is a card that says it is showing
    // something it is not. One condition drives the chevron AND the list.
    const listOpen = multi && projOpen(key) && !mini
    return (
      <div key={key} style={{ display: 'contents' }}>
        {dropLine(key, false)}
        <div className={`pl-card${on ? ' on' : ''}${listOpen ? ' open' : ''}`
            + `${manage ? ' mg' : ''}${drag === key ? ' dragging' : ''}`
            + `${s.hidden ? ' off' : ''}`}
          data-key={key}
          {...dragProps(key)}>
          <button type="button" className="pl-row"
            onClick={() => {
              if (manage && isManager) { openManage(s); return }
              // One project nominated: the card IS that project.
              if (!manage && !signedOut && s.multi_project && s.entry_project) {
                pickProject(s, s.entry_project); return
              }
              if (!multi) { openService(s); return }
              // A multi-project service has no page of its own. Picking it drops
              // its project list in the bar AND puts its projects in the panel —
              // the same panel manage mode uses, so making a project is where
              // looking at them already is. (Settings has to be left behind for
              // that; before, from settings, the click only expanded the bar and
              // the service looked like it had not opened at all.)
              const fromSettings = view === 'settings'
              if (fromSettings) leaveSettings()
              // Pressing the service already in the panel folds its list again.
              else if (sel?.svc === key && view === 'service' && projOpen(key)) { toggleProj(key); return }
              setSel({ svc: key, proj: '' })
              setView('service')
              // Collapsed, the project list is invisible — asking for it expands
              // the bar rather than doing nothing you can see.
              if (mini) setMini(false)
              setOpenSvcs((o) => new Set(o).add(key))
            }}>
            {/* Always rendered, opened by manage mode: mounting it moved every
                icon sideways in one jump, and a width that animates lets the
                row make room instead. */}
            {isManager && (
              <span className={`pl-grip${manage ? ' on' : ''}`} title={tr("p_drag_to_arrange")}>
                <Icon name="drag-handle" size={14} color="var(--text-muted)" />
              </span>
            )}
            <Tile icon={iconFor ? iconFor(s.name, s.icon) : (s.icon || 'circle')}
              color={s.color} on={on} />
            <span className="pl-txt">
              {s.label || s.name}
              {multi && s.projects_count != null && <small>({s.projects_count})</small>}
            </span>
            {hot >= 0 && hot < 9 && <kbd className="pl-key">{hot + 1}</kbd>}
            {multi && <span className="pl-chev"><Icon name="caret-right" size={13} color="var(--text-muted)" /></span>}
          </button>
        </div>
        {multi && (
          <ProjectList svc={s.name} color={s.color} sel={view === 'service' ? sel : null}
            open={listOpen} onPick={(p) => pickProject(s, p)} />
        )}
        {dropLine(key, true)}
      </div>
    )
  }

  /** Manage mode's right side: everything the classic cover shows inside an
   *  opened card, minus the card. A group selected in the bar shows the group's
   *  own management band instead. */
  // Look the band up in `bands`, not in `groups`: System and No group are the
  // portal's own bands and have no stored group behind them.
  const selBand = sel?.svc?.startsWith('#g:')
    ? bands.find((b) => b.g && `#g:${b.g.id}` === sel.svc) : null
  const selGroup = selBand && !selBand.g.fixed && !selBand.g.loose ? selBand.g : null
  const managePanel = (() => {
    if (!isManager) return null
    if (sel?.svc === ARCHIVE_KEY) {
      return <ArchivePanel always signal={archiveTick}
        onChanged={() => { loadArchived(); onRefresh?.() }} />
    }
    if (selGroup) {
      const mem = (selGroup.members || [])
        .map((k) => (cards || []).find((c) => cardKey(c) === k)).filter(Boolean)
      return (
        <>
          <h1 className="pl-mgtitle">{selGroup.name || tr("p_group")}</h1>
          <GroupManagePanel group={selGroup} members={mem} onChanged={onRefresh} />
        </>
      )
    }
    if (selBand) {
      return (
        <>
          <h1 className="pl-mgtitle">{selBand.g.name}</h1>
          <FixedGroupPanel band={selBand} onChanged={onRefresh} />
        </>
      )
    }
    if (!selSvc) {
      return (
        <div className="pl-empty">
          <div>
            <div className="big">{tr("p_manage_mode")}</div>
            <div>{tr("p_pick_a_service_or_a")}</div>
          </div>
        </div>
      )
    }
    const key = cardKey(selSvc)
    const i = (fullOrder || []).indexOf(key)
    return (
      <>
        <h1 className="pl-mgtitle">{selSvc.label || selSvc.name}</h1>
        <ServiceManagePanel service={selSvc} builtinKey={selSvc.builtin || null}
          initialIcon={iconFor ? iconFor(selSvc.name, selSvc.icon) : selSvc.icon}
          first={i <= 0} last={i >= (fullOrder || []).length - 1}
          onMove={(dir) => {
            const keys = [...(fullOrder || [])]
            const j = i + dir
            if (i < 0 || j < 0 || j >= keys.length) return
            ;[keys[i], keys[j]] = [keys[j], keys[i]]
            onSaveOrder?.(keys)
          }}
          onChanged={onRefresh} />
        {selSvc.builtin === 'links' && <LinksView links={links || []} manage onChanged={onRefresh} />}
        {!selSvc.builtin && selSvc.multi_project && <ServiceProjects service={selSvc} canManage manage onChanged={onRefresh} />}
        {!selSvc.builtin && !selSvc.multi_project && <ServiceSingle service={selSvc} canManage manage onChanged={onRefresh} />}
      </>
    )
  })()

  /** What the panel shows for a builtin card, which has no URL to frame. */
  const builtinView = (b) => (
    b === 'iconlab' ? <IconLabView />
      : b === 'links' ? <LinksView links={links || []} onChanged={onRefresh} />
        : b === 'store' ? <StoreView onChanged={onRefresh} />
          : b === 'newservice' ? <NewServiceView onCreated={onRefresh} />
          : b === 'rack' ? <RackView />
            : null
  )

  const modes = HOME_MODES.filter((m) => !m.admin || isManager)

  return (
    <div className={`pl-root${mini ? ' mini' : ''}${view === 'settings' ? ' settings' : ''}`
      + `${manage && isManager ? ' managing' : ''}${cmd ? ' cmd' : ''}`}>
      <aside className="pl-side" ref={sideRef} tabIndex={-1}
        onMouseEnter={onSideEnter} onMouseLeave={onSideLeave} onMouseDown={endPeek}>
        <div className="pl-brand">
          <button type="button" className="pl-logo" disabled={manage && isManager}
            onClick={() => { endPeek(); setPinned(mini); setMini((m) => !m) }}
            title={manage && isManager
              ? tr("p_not_while_managing")
              : tr("p_collapse_expand")}>
            <span className="pl-mark"><Icon name="lilak" size={26} /></span>
            {/* Where "portal" used to be: WHICH portal. With a main and its
                mirrors (sync), the brand alone does not say which server this
                window is on; the host and the build do. */}
            <b>lilak</b>
            <span className="sub" title={info ? `${info.host || '?'}${info.version ? ` · ${info.version}` : ''}` : ''}>
              {info ? <>{info.host || '?'}{info.version && <i>{info.version}</i>}</> : 'portal'}
            </span>
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="pl-fold"
            title={anyOpen ? tr("p_collapse_all") : tr("p_expand_all")}
            onClick={foldAll}>
            <Icon name={anyOpen ? 'caret-up' : 'caret-down'} size={14} color="var(--text-secondary)" />
          </button>
        </div>

        <div className="pl-nav" ref={navRef}>
          {bands.map(({ g, items }) => (g ? (
            /* A group is one tinted REGION spanning the bar's full width, with its
               cards inside it — a tinted title alone left the members looking like
               they had simply been indented under a heading. */
            <div key={g.id} className={`pl-group${g.fixed || g.loose ? ' auto' : ''}`
                + `${sel?.svc === `#g:${g.id}` && view === 'manage' ? ' on' : ''}`
                + `${dropAt?.gid === (g.fixed ? SYSTEM_ID : g.loose ? null : g.id) ? ' drop' : ''}`}
              {...bandDrop(g)}>
              <div className="pl-band">
                <button type="button" className="pl-grp"
                  onClick={() => (manage && isManager ? openManageGroup(g) : toggleGroup(g.id))}>
                  {/* Manage mode forces every band open (you cannot drop into a
                      band you cannot see), so the caret has to say so too. */}
                  <span className={`pl-gchev${groupOpen(g.id) || (manage && isManager) ? ' open' : ''}`}>
                    <Icon name="caret-right" size={14} weight="bold" color="var(--text-secondary)" />
                  </span>
                  <span className="pl-txt">{g.name || tr("p_group")}</span>
                  <span className="pl-gcount">{items.length}</span>
                </button>
              </div>
              {/* A shut group hides everything in it, the selected service
                  included — leaving that one behind made the band look broken. */}
              <Slider open={groupOpen(g.id) || (manage && isManager)} className="pl-gitems">
                {items.map(serviceCard)}
                {manage && isManager && items.length === 0 && (
                  <div className="pl-gempty" {...bandDrop(g)}>{tr("p_drop_things_here")}</div>
                )}
              </Slider>
            </div>
          ) : (
            <div key="ungrouped" style={{ display: 'contents' }}
              {...(manage && isManager ? bandProps(null) : {})}>
              {items.map(serviceCard)}
            </div>
          )))}
        </div>

        {/* The account alone at the foot now: the modes moved into the settings
            bar, which is where the rest of "things about this portal" live.
            Not in manage mode: the account card is not something you manage,
            and one more card on the plinth is one more thing to mis-drag. */}
        {!signedOut && !(manage && isManager) && (
        <div className="pl-user">
          <div className={`pl-card${view === 'settings' ? ' on' : ''}`}>
            <button type="button" className="pl-row"
              onClick={toggleSettings}>
              <span className="pl-av" style={{ background: 'transparent' }}>
                <Avatar icon={user?.profile_shape}
                  color={isManager ? MANAGER_COLOR : user?.profile_color}
                  seed={user?.username} size={30} />
              </span>
              <span className="pl-txt">{user?.username}</span>
              {/* INSIDE the row, like a service card's: folded, the key is
                  placed against the row it presses, and a kbd outside one has
                  no box to sit in — it ended up in the bar's own corner. */}
              {cmd && <kbd className="pl-key">0</kbd>}
            </button>
          </div>
        </div>
        )}
        {cmd && (
          <div className="pl-cmdhint">
            <b>1–9</b> {tr("p_service_2")} · <b>0</b> {tr("p_settings")}
            {' · '}<b>`</b> {tr("p_fold")} · <b>Esc</b> {tr("p_exit")}
          </div>
        )}
      </aside>

      {/* Live takes the whole right side — no panel inset, because a wall wants
          every pixel it can get. */}
      {/* Settings is a SECOND bar of the same shape one step in, not a page that
          replaces the first: the service bar stays, so there is always a way out
          and you can still see what is running. */}
      <StepOut open={(manage && isManager) || view === 'settings'}
        kind={manage && isManager ? 'manage' : 'settings'}>
        {manage && isManager ? (
          <>
          <div className="pl-b2head"><b>{tr("p_manage")}</b></div>
          <div className="pl-nav2">
            {/* What the cover DOES, then what you can do to it. Same items the
                settings menu carries, in the same class, so managing is one
                more bar beside the first rather than a mode that rearranges
                the one you had. */}
            <button type="button" className={`pl-c2${flat ? '' : ' on'}`}
              onClick={() => setFlat((f) => !f)}>
              <Icon name="tree" size={15} />
              <span className="pl-txt">{tr("p_group_mode")}</span>
            </button>
            <button type="button" className={`pl-c2${view === 'live' ? ' on' : ''}`}
              onClick={enterLive}>
              <Icon name="broadcast" size={15} />
              <span className="pl-txt">{tr("p_live_mode")}</span>
            </button>

            <div className="pl-sep" />
            <button type="button" className="pl-c2" onClick={() => onCreateGroup?.()}>
              <Icon name="folder-plus" size={15} />
              <span className="pl-txt">{tr("p_new_group")}</span>
            </button>
            {/* Only when there is something in it: an empty archive is not a
                place anyone needs to go. */}
            {archivedN > 0 && (
              <button type="button" className={`pl-c2${sel?.svc === ARCHIVE_KEY ? ' on' : ''}`}
                onClick={() => { setSel({ svc: ARCHIVE_KEY, proj: '' }); setView('manage') }}>
                <Icon name="archive" size={15} />
                <span className="pl-txt">{tr("p_archive", archivedN)}</span>
              </button>
            )}
            {/* The room the bar has left over IS the target, and it is here
                before you pick a card up — a place you have to discover while
                already holding something is a place you drop things wrong.
                Dropping here is the Hide button, reached by the hand that is
                already holding the card. */}
            <div className={`pl-b2drop${drag ? ' live' : ''}${dropAt?.hide ? ' over' : ''}`}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); setDropAt({ hide: true }) }}
              onDragLeave={() => setDropAt((d) => (d?.hide ? null : d))}
              onDrop={(e) => { e.preventDefault(); hideDropped() }}>
              <Icon name="eye-off" size={14} />
              <span>{tr("p_drop_a_card_here_to")}</span>
            </div>

            {/* Last of all, like Log out in the settings bar: leaving is not
                one of the things you do while you are here. */}
            <div className="pl-sep" />
            <button type="button" className="pl-c2 out" onClick={toggleManage}>
              <Icon name="close" size={15} />
              <span className="pl-txt">{tr("p_exit_manage_mode")}</span>
            </button>
          </div>
          </>
        ) : (
          <>
          <div className="pl-b2head"><b>{tr("p_settings_2")}</b></div>
          <div className="pl-nav2">
            {settingsMenu(isManager, lang).map(([key, , label], i, arr) => (
              <div key={key} style={{ display: 'contents' }}>
                {/* a rule where the personal half ends, instead of naming the halves */}
                {i > 0 && arr[i - 1][0] === 'feedback' && <div className="pl-sep" />}
                <button type="button" className={`pl-c2${settingsTab === key ? ' on' : ''}`}
                  onClick={() => onSettingsTab?.(key)}>
                  <span className="pl-txt">{label}</span>
                </button>
              </div>
            ))}
            <div className="pl-spring" />

            {/* The modes are not pages — they change what the whole cover does
                — so they sit past the spring, under the pages. */}
            <div className="pl-sep" />
            {/* The same thing the logo does, named: from in here the logo is two
                bars away, and this is where the other switches live. Unlike the
                modes below it, this one says what pressing it will DO — the
                caret points the way the bar is about to move. */}
            <button type="button" className={`pl-c2${mini ? ' on' : ''}`}
              onClick={() => {
                // Expanding from here PINS: you asked for the bar, not for a
                // glance at it. Collapsing from here hands it back to the
                // ordinary behaviour — folding on its own, peeking on hover.
                endPeek()
                setPinned(mini)
                setMini((m) => !m)
              }}>
              <Icon name={mini ? 'caret-right' : 'caret-left'} size={15} />
              <span className="pl-txt">
                {mini ? tr("p_expand_sidebar") : tr("p_collapse_sidebar")}
              </span>
            </button>
            {modes.map((m) => (
              <button key={m.id} type="button"
                className={`pl-c2${(m.id === 'live' ? view === 'live' : manage) ? ' on' : ''}`}
                title={lang === 'ko' ? m.ko_hint : m.en_hint}
                onClick={() => (m.id === 'live' ? enterLive() : toggleManage())}>
                <Icon name={m.icon} size={15} />
                <span className="pl-txt">{lang === 'ko' ? m.ko : m.en}</span>
              </button>
            ))}
            {/* Group mode reads like the other two: a fixed name that fills when
                it is on. (It only rearranges the sidebar and leaves the panel
                alone, but a switch that changed its own label made the reader
                work out which way it pointed.) */}
            <button type="button" className={`pl-c2${flat ? '' : ' on'}`}
              onClick={() => setFlat((f) => !f)}>
              <Icon name="tree" size={15} />
              <span className="pl-txt">{tr("p_group_mode")}</span>
            </button>

            {/* Last of all: leaving is not a page and not a mode. */}
            <div className="pl-sep" />
            <button type="button" className="pl-c2 out" onClick={onLogout}>
              <Icon name="logout" size={15} />
              <span className="pl-txt">{tr("p_log_out")}</span>
            </button>
          </div>
          </>
        )}
      </StepOut>

      <main className="pl-main">
        <div className="pl-panel">
          {signedOut ? (
            <div className="pl-scroll pl-authpage">{authCard}</div>
          ) : view === 'settings' ? (
            <>
              <div className="pl-scroll pl-setpage">
                <AccountView isManager={isManager} onChanged={onRefresh} onAccountGone={onLogout}
                  tab={settingsTab} onTab={onSettingsTab} hideMenu />
              </div>
              <SettingsStatus />
            </>
          ) : view === 'live' ? (
            // Framed, not fixed: the bar stays (collapsed), live fills the panel.
            <LiveWall framed cards={liveCards || []} iconFor={iconFor} onDone={() => setView('empty')} />
          ) : view === 'manage' ? (
            // The manage panels report through notify() like the settings pages,
            // so they need the same line at the foot to report INTO.
            <>
              {/* Keyed on the selection: every panel below seeds its form state
                  from props with useState, so without a remount React kept the
                  card you were editing a moment ago. The key goes HERE, on the
                  one container, rather than on the panels — they are siblings of
                  conditional ones, and a keyed child next to an unkeyed one is
                  where the old panels were surviving the switch. */}
              <div key={sel?.svc || '@none'} className="pl-scroll pl-mgpage">{managePanel}</div>
              <SettingsStatus />
            </>
          ) : view === 'service' && selSvc?.builtin ? (
            <>
              {/* A builtin is a third kind of page: not settings, not manage —
                  a tool the portal carries. It gets its own strip colour. */}
              <div key={selSvc.builtin} className="pl-scroll pl-mgpage pl-toolpage">
                <h1 className="pl-mgtitle">{selSvc.label || selSvc.name}</h1>
                {builtinView(selSvc.builtin)}
              </div>
              <SettingsStatus />
            </>
          ) : view === 'service' && needProject ? (
            // Not an empty page telling you to look left: the service's own
            // projects, managed here, with the same panel manage mode shows.
            <>
              <div key={sel.svc} className="pl-scroll pl-mgpage">
                <h1 className="pl-mgtitle">{selSvc.label || selSvc.name}</h1>
                <ServiceProjects service={selSvc} canManage={isManager} manage={isManager}
                  onChanged={onRefresh} />
              </div>
              <SettingsStatus />
            </>
          ) : view === 'service' && locked ? (
            <>
              <div key={sel.svc} className="pl-scroll pl-mgpage">
                <h1 className="pl-mgtitle">{selSvc.label || selSvc.name}</h1>
                <ServiceSingle service={selSvc} canManage={false}
                  onRequest={async () => {
                    await launcher.post('/access-requests', { service: selSvc.name })
                    onRefresh?.()
                  }}
                  onChanged={onRefresh} />
                {selSvc.view_only && (
                  // The grant is there; what is missing is this year's email
                  // check. Say so, and point at where it is done.
                  <div className="pl-lockhint">
                    <span>{tr("p_your_email_verification_is_over")}</span>
                    <button type="button" className="pl-lockbtn" onClick={() => openSettings('me')}>
                      {tr("p_re_verify_in_my_account")}
                    </button>
                  </div>
                )}
              </div>
              <SettingsStatus />
            </>
          ) : view === 'service' && src ? (
            <iframe key={src} ref={frameRef} src={src} title={sel.svc}
              allow="clipboard-read; clipboard-write; fullscreen"
              onLoad={(e) => {
                // Same origin for a proxied service; an external one throws and
                // simply does not get the shortcut.
                try { e.target.contentDocument.addEventListener('keydown', (ev) => foldKey.current(ev)) }
                catch { /* another origin */ }
              }} />
          ) : (
            <div className="pl-empty">
              <div>
                <div className="big">{tr("p_pick_a_service")}</div>
                <div>{tr("p_it_opens_here")}</div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
