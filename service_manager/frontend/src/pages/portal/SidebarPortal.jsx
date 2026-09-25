import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon, MANAGER_COLOR } from 'lilak-ui'
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
import './sidebar.css'

/** A card's stable key — the same one the cover and the saved order use, so a
 *  builtin ("@links") and a service ("elog") can share one list. */
const cardKey = (c) => (c.builtin ? '@' + c.builtin : c.name)

/** The portal's own tools always band together: they are things you do TO the
 *  portal, not services it runs, and an admin should not have to file them. */
const SYSTEM_KEYS = ['@iconlab', '@newservice', '@store']
const SYSTEM_ID = '@system'
const NOGROUP_ID = '@none'
// The name a materialised System band is stored under. Until something is
// dragged into it the band is synthetic — there is nothing to store, because
// its members are the same three builtins on every portal.
const SYSTEM_NAME = 'System'

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
 * `portal_layout` keeps the classic card grid one click away (AccountMenu).
 * Still to come: keyboard navigation and the redesigned login card.
 */
const MINI_KEY = 'portal-mini'
const FLAT_KEY = 'portal-flat'
const SHUT_KEY = 'portal-groups-shut'
const WIDE = 900          // below this the bar collapses on its own
const PHONE = 640         // below this it becomes a drawer over the panel (CSS)

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
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [rows, setRows] = useState(null)

  useEffect(() => {
    if (!open || rows) return
    launcher.get(`/services/${svc}/projects`).then((r) => setRows(r.data)).catch(() => setRows([]))
  }, [open, svc])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Slider open={open} className="pl-plist">
      {rows === null && <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>…</div>}
      {rows?.length === 0 && (
        <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>{L('프로젝트 없음', 'no projects')}</div>
      )}
      {(rows || []).map((p) => {
        const on = sel?.svc === svc && sel?.proj === p.name
        return (
          <button key={p.name} type="button" className={`pl-proj${on ? ' on' : ''}`}
            onClick={() => onPick(p.name)}>
            <RunDot on={!!p.running} />
            <span className="pl-txt">{p.name}</span>
            <span className="pl-out" role="button" tabIndex={-1} title={L('새 창', 'new tab')}
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
  settingsTab, onSettingsTab, authCard,
}) {
  // Signed out: the bar is a list of names and the panel is the login card.
  // Nothing opens, nothing is managed, and the foot has no account to show.
  const signedOut = !!authCard
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)

  const [mini, setMini] = useState(() => {
    // On a phone the bar is a drawer over the panel: arriving with a service
    // already chosen (a shared link, a reload) should show the service, not the
    // menu. Wider, the saved choice wins, and a first visit collapses only when
    // the window is too narrow to spare 260px.
    if (window.innerWidth < PHONE) return !!readSel()
    const saved = localStorage.getItem(MINI_KEY)
    return saved !== null ? saved === '1' : window.innerWidth < WIDE
  })
  const [sel, setSel] = useState(readSel)        // { svc, proj } — mirrored in the URL
  const [view, setView] = useState(() => (readSel() ? 'service' : 'empty'))  // service|settings|live|empty
  // A Set, not one name: opening a service must not close another. Several
  // project lists can stand open at once.
  const [openSvcs, setOpenSvcs] = useState(() => {
    const s0 = readSel()?.svc
    return new Set(s0 ? [s0] : [])
  })
  const [flat, setFlat] = useState(() => localStorage.getItem(FLAT_KEY) === '1')
  const [shut, setShut] = useState(() => readSet(SHUT_KEY))
  // Manage mode: the bar becomes editable (drag to arrange, a button to make a
  // group) and picking a card shows its settings in the panel instead of running it.
  const [manage, setManage] = useState(false)
  const [drag, setDrag] = useState(null)        // key being dragged
  const [dropAt, setDropAt] = useState(null)    // { key, after } | { gid } | { end: true }
  // Settings collapses the service bar to make room for its own; remember what the
  // bar was so leaving settings puts it back rather than stranding it at 64px.
  const miniBefore = useRef(null)
  const viewBefore = useRef(null)

  useEffect(() => {
    localStorage.setItem(MINI_KEY, mini ? '1' : '0')
    // Collapsing hides the project lists; close them too, so expanding again does
    // not reveal a list the user last saw minutes ago.
    if (mini) setOpenSvcs(new Set())
  }, [mini])
  useEffect(() => { localStorage.setItem(FLAT_KEY, flat ? '1' : '0') }, [flat])
  useEffect(() => { writeSet(SHUT_KEY, shut) }, [shut])
  useEffect(() => { writeSel(view === 'service' ? sel : null) }, [sel, view])

  useEffect(() => {
    const fit = () => {
      const w = window.innerWidth
      if (w < PHONE) return                      // drawer: the user's choice stands
      setMini(w < WIDE)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const leaveSettings = useCallback(() => {
    if (miniBefore.current !== null) { setMini(miniBefore.current); miniBefore.current = null }
  }, [])

  const openSettings = useCallback((tab) => {
    if (miniBefore.current === null) miniBefore.current = mini
    viewBefore.current = { view, sel }
    setMini(true)
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
    setSel({ svc: cardKey(s), proj: '' })
    setView('service')
    if (window.innerWidth < PHONE) setMini(true)
  }, [])

  /** Manage mode: picking a card shows its settings in the panel, never runs it. */
  const openManage = useCallback((s) => {
    leaveSettings()
    setSel({ svc: cardKey(s), proj: '' })
    setView('manage')
    if (window.innerWidth < PHONE) setMini(true)
  }, [])

  // `open` is a property of the SERVICE, so it governs its projects too: a service
  // whose chrome belongs in its own tab does not become panel-friendly just
  // because you reached it through a project.
  const pickProject = useCallback((s, proj) => {
    leaveSettings()
    if (s.open === 'window') { window.open(`/pp/${s.name}/${proj}/`, '_blank'); return }
    setSel({ svc: s.name, proj })
    setView('service')
    if (window.innerWidth < PHONE) setMini(true)
  }, [])

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
      if (sys.length) out.push({ g: { id: SYSTEM_ID, name: L('시스템', 'System'), fixed: true }, items: sys })
    }
    const gs = [...(groups || [])]
      .filter((g) => !g.hidden || (manage && isManager))
      .sort((a, b) => (a.name === SYSTEM_NAME ? -1 : b.name === SYSTEM_NAME ? 1 : (a.order ?? 1000) - (b.order ?? 1000)))
    for (const g of gs) {
      const items = (g.members || []).map((k) => byKey.get(k)).filter((c) => c && !taken.has(cardKey(c)))
      items.forEach((c) => taken.add(cardKey(c)))
      // An empty group still shows in manage mode — otherwise a group you just
      // made vanishes and there is nothing to drag onto.
      if (items.length || (manage && isManager)) out.push({ g, items })
    }
    // In group mode EVERY card is in a band, so the eye reads one kind of thing
    // down the bar instead of bands and then loose cards.
    const rest = list.filter((c) => !taken.has(cardKey(c)))
    out.push({ g: { id: NOGROUP_ID, name: L('그룹 없음', 'No group'), loose: true }, items: rest })
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
  const flatBefore = useRef(null)
  const toggleManage = () => {
    leaveSettings()
    setManage((m) => {
      const next = !m
      setSel(null)
      setView(next ? 'manage' : 'empty')
      if (next) {
        setMini(false); setOpenSvcs(new Set())
        flatBefore.current = flat
        setFlat(false)
      } else if (flatBefore.current !== null) {
        setFlat(flatBefore.current)
        flatBefore.current = null
      }
      return next
    })
  }
  const openManageGroup = (g) => { setSel({ svc: `#g:${g.id}`, proj: '' }); setView('manage') }

  const enterLive = () => {
    leaveSettings()
    setView('live')
    setMini(true)                                // a wall wants the width
  }

  const selSvc = (cards || []).find((c) => cardKey(c) === sel?.svc)
  // A multi-project service has nothing to show on its own — the panel asks for a
  // project instead of framing the service root.
  const needProject = !!selSvc?.multi_project && !sel?.proj
  const src = sel?.svc && !needProject && !selSvc?.builtin && !manage
    ? (sel.proj ? `/pp/${sel.svc}/${sel.proj}/` : `/p/${sel.svc}/`)
    : null

  const serviceCard = (s) => {
    const key = cardKey(s)
    // Opening a service's projects counts as picking it: its tile fills, and the
    // card takes the selected border while the bar is expanded (collapsed, every
    // card's border is transparent, so the tile carries it alone).
    const on = ((view === 'service' || view === 'manage' || signedOut) && sel?.svc === key) || projOpen(key)
    // In manage mode a card is a thing to arrange and edit, never a thing to run:
    // even a multi-project service opens its settings instead of its project list.
    const multi = s.multi_project && !manage && !signedOut
    return (
      <div key={key} style={{ display: 'contents' }}>
        {dropLine(key, false)}
        <div className={`pl-card${on ? ' on' : ''}${projOpen(key) ? ' open' : ''}`
            + `${manage ? ' mg' : ''}${drag === key ? ' dragging' : ''}`
            + `${s.hidden ? ' off' : ''}`}
          {...dragProps(key)}>
          <button type="button" className="pl-row"
            onClick={() => {
              if (manage && isManager) { openManage(s); return }
              if (!multi) { openService(s); return }
              // Collapsed, the project list is hidden — so asking for it expands
              // the bar rather than doing nothing visible.
              if (mini) { setMini(false); setOpenSvcs((o) => new Set(o).add(key)); return }
              toggleProj(key)
            }}>
            {manage && isManager && (
              <span className="pl-grip" title={L('끌어서 정렬', 'drag to arrange')}>
                <Icon name="drag-handle" size={14} color="var(--text-muted)" />
              </span>
            )}
            <Tile icon={iconFor ? iconFor(s.name, s.icon) : (s.icon || 'circle')}
              color={s.color} on={on} />
            <span className="pl-txt">
              {s.label || s.name}
              {multi && s.projects_count != null && <small>({s.projects_count})</small>}
            </span>
            {multi && <span className="pl-chev"><Icon name="caret-right" size={13} color="var(--text-muted)" /></span>}
          </button>
        </div>
        {multi && (
          <ProjectList svc={s.name} color={s.color} sel={view === 'service' ? sel : null}
            open={projOpen(key)} onPick={(p) => pickProject(s, p)} />
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
    if (selGroup) {
      const mem = (selGroup.members || [])
        .map((k) => (cards || []).find((c) => cardKey(c) === k)).filter(Boolean)
      return (
        <>
          <h1 className="pl-mgtitle">{selGroup.name || L('그룹', 'Group')}</h1>
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
            <div className="big">{L('관리 모드', 'Manage mode')}</div>
            <div>{L('왼쪽에서 서비스나 그룹을 고르면 설정이 여기에 열립니다.', 'Pick a service or a group on the left to edit it here.')}</div>
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
            : null
  )

  const modes = HOME_MODES.filter((m) => !m.admin || isManager)

  return (
    <div className={`pl-root${mini ? ' mini' : ''}${view === 'settings' ? ' settings' : ''}`
      + `${manage && isManager ? ' managing' : ''}`}>
      {/* the drawer's scrim — shown by CSS at phone width only, so it follows a
          resize instead of whatever innerWidth was at render time */}
      {!mini && <div className="pl-scrim" onClick={() => setMini(true)} />}

      {/* Phone only: the collapse toggle lives INSIDE the bar, which slides off
          screen with it — without this there is no way back to the menu. */}
      {mini && (
        <button type="button" className="pl-reopen" onClick={() => setMini(false)}
          title={L('메뉴', 'Menu')}>
          <Icon name="lilak" size={22} />
        </button>
      )}

      <aside className="pl-side">
        <div className="pl-brand">
          <button type="button" className="pl-logo" onClick={() => setMini((m) => !m)}
            title={L('사이드바 접기/펼치기', 'collapse / expand')}>
            <span className="pl-mark"><Icon name="lilak" size={26} /></span>
            <b>lilak</b><span className="sub">portal</span>
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="pl-fold"
            title={anyOpen ? L('전부 접기', 'Collapse all') : L('전부 펼치기', 'Expand all')}
            onClick={foldAll}>
            <Icon name={anyOpen ? 'caret-up' : 'caret-down'} size={14} color="var(--text-secondary)" />
          </button>
        </div>

        <div className="pl-nav">
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
                  <span className="pl-txt">{g.name || L('그룹', 'Group')}</span>
                  <span className="pl-gcount">{items.length}</span>
                </button>
              </div>
              {/* A shut group hides everything in it, the selected service
                  included — leaving that one behind made the band look broken. */}
              <Slider open={groupOpen(g.id) || (manage && isManager)} className="pl-gitems">
                {items.map(serviceCard)}
                {manage && isManager && items.length === 0 && (
                  <div className="pl-gempty" {...bandDrop(g)}>{L('여기로 끌어다 놓으세요', 'drop things here')}</div>
                )}
              </Slider>
            </div>
          ) : (
            <div key="ungrouped" style={{ display: 'contents' }}
              {...(manage && isManager ? bandProps(null) : {})}>
              {items.map(serviceCard)}
            </div>
          )))}

          {bands.every((b) => !b.items.length) && (
            <div style={{ padding: '10px 9px', color: 'var(--text-muted)' }}>
              {L('서비스가 없습니다', 'no services')}
            </div>
          )}
        </div>

        {/* Outside .pl-nav so it stays put while the list scrolls: these two act on
            the WHOLE bar, not on anything in the list — so they sit at its foot,
            on the plinth, where the other whole-portal controls already are. */}
        {manage && isManager && (
          <div className="pl-mgbar">
            {/* The action first, the way out last — at the foot of the bar the
                way out sits closest to where the eye ends up. */}
            <button type="button" className="pl-mgnew" onClick={onCreateGroup}>
              <Icon name="folder-plus" size={14} /> <span className="pl-txt">{L('그룹 생성', 'New group')}</span>
            </button>
            <button type="button" className="pl-mgout" onClick={toggleManage}>
              <Icon name="close" size={14} /> <span className="pl-txt">{L('관리 모드 끝내기', 'Exit manage mode')}</span>
            </button>
          </div>
        )}

        {/* The account alone at the foot now: the modes moved into the settings
            bar, which is where the rest of "things about this portal" live. */}
        {!signedOut && (
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
            </button>
          </div>
        </div>
        )}
      </aside>

      {/* Live takes the whole right side — no panel inset, because a wall wants
          every pixel it can get. */}
      {/* Settings is a SECOND bar of the same shape one step in, not a page that
          replaces the first: the service bar stays, so there is always a way out
          and you can still see what is running. */}
      {view === 'settings' && (
        <aside className="pl-bar2">
          <div className="pl-b2head"><b>{L('설정', 'Settings')}</b></div>
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

            {/* Signing out is not a settings page, so it sits under them all,
                past the spring. */}
            <div className="pl-sep" />
            <button type="button" className="pl-c2 out" onClick={onLogout}>
              <Icon name="logout" size={15} />
              <span className="pl-txt">{L('로그아웃', 'Log out')}</span>
            </button>

            {/* The modes are not pages either — they change what the whole cover
                does — and they are the last thing in the bar. */}
            <div className="pl-sep" />
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
              <span className="pl-txt">{L('그룹 모드', 'Group mode')}</span>
            </button>
          </div>
        </aside>
      )}

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
            <div className="pl-empty">
              <div>
                <div className="path">/pp/{sel.svc}/…</div>
                <div className="big">{L('프로젝트를 선택하세요', 'Pick a project')}</div>
                <div>{L('왼쪽에서 프로젝트를 고르세요.', 'Choose one on the left.')}</div>
              </div>
            </div>
          ) : view === 'service' && src ? (
            <iframe key={src} src={src} title={sel.svc}
              allow="clipboard-read; clipboard-write; fullscreen" />
          ) : (
            <div className="pl-empty">
              <div>
                <div className="big">{L('서비스를 선택하세요', 'Pick a service')}</div>
                <div>{L('왼쪽 목록에서 고르면 여기에 열립니다.', 'It opens here.')}</div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
