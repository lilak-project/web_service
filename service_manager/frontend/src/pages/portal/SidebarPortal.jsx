import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon, MANAGER_COLOR } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { HOME_MODES } from './HomeModeMenu'
import AccountView from './AccountView'
import LiveWall from './LiveWall'
import './sidebar.css'

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
 *  service tile and the head of a project card. Running is a green play button;
 *  stopped is a tiny grey dot, which only has to say "nothing here is running".
 *  Sizes live in the stylesheet so the two can differ — the button needs room the
 *  dot does not. */
function RunDot({ on, ring }) {
  return (
    <span className={`pl-run${on ? ' up' : ''}${ring ? ' ring' : ''}`}>
      {on && <Icon name="play" size={7} weight="fill" color="#fff" />}
    </span>
  )
}

function Tile({ icon, color, on, dot }) {
  const c = color || 'var(--text-secondary)'
  return (
    <span className={`pl-av${on ? ' round' : ''}`} style={{ background: c }}>
      <Icon name={icon} size={19} weight="fill" color="#fff" />
      {dot !== undefined && <RunDot on={!!dot} ring />}
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
  useLayoutEffect(() => {
    const el = ref.current
    if (el && phase) el.style.setProperty('--h', `${el.scrollHeight}px`)
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
              <Icon name="external" size={13} />
            </span>
          </button>
        )
      })}
    </Slider>
  )
}

export default function SidebarPortal({
  user, isManager, services, groups, liveCards, iconFor,
  onLogout, onRefresh, onEnterManage, settingsTab, onSettingsTab,
}) {
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
  const [modesOpen, setModesOpen] = useState(false)

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

  const openService = useCallback((s) => {
    if (s.open === 'window') { window.open(`/p/${s.name}/`, '_blank'); return }
    setSel({ svc: s.name, proj: '' })
    setView('service')
    if (window.innerWidth < PHONE) setMini(true)
  }, [])

  // `open` is a property of the SERVICE, so it governs its projects too: a service
  // whose chrome belongs in its own tab does not become panel-friendly just
  // because you reached it through a project.
  const pickProject = useCallback((s, proj) => {
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

  // Services laid out as bands: each group in its order, then whatever belongs to
  // no group. Members are card keys, so a group may also list builtins (`@links`)
  // that this sidebar does not draw yet — those are simply skipped.
  const bands = useMemo(() => {
    const list = services || []
    if (flat) return [{ g: null, items: list }]
    const byName = new Map(list.map((s) => [s.name, s]))
    const taken = new Set()
    const out = []
    for (const g of [...(groups || [])].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000))) {
      const items = (g.members || []).map((k) => byName.get(k)).filter(Boolean)
      items.forEach((s) => taken.add(s.name))
      if (items.length) out.push({ g, items })
    }
    const rest = list.filter((s) => !taken.has(s.name))
    if (rest.length) out.push({ g: null, items: rest })
    return out
  }, [services, groups, flat])

  // Collapse all: every group and every project list. (Expand-all deliberately
  // only reopens the groups — reopening every project list buries the bar.)
  const allShut = () => { setShut(new Set((groups || []).map((g) => g.id))); setOpenSvcs(new Set()) }

  const enterLive = () => {
    setView('live')
    setModesOpen(false)
    setMini(true)                                // a wall wants the width
  }

  const selSvc = (services || []).find((s) => s.name === sel?.svc)
  // A multi-project service has nothing to show on its own — the panel asks for a
  // project instead of framing the service root.
  const needProject = !!selSvc?.multi_project && !sel?.proj
  const src = sel?.svc && !needProject
    ? (sel.proj ? `/pp/${sel.svc}/${sel.proj}/` : `/p/${sel.svc}/`)
    : null

  const serviceCard = (s) => {
    // Opening a service's projects counts as picking it: its tile fills, and the
    // card takes the selected border while the bar is expanded (collapsed, every
    // card's border is transparent, so the tile carries it alone).
    const on = (view === 'service' && sel?.svc === s.name) || projOpen(s.name)
    const multi = s.multi_project
    return (
      <div key={s.name} style={{ display: 'contents' }}>
        <div className={`pl-card${on ? ' on' : ''}${projOpen(s.name) ? ' open' : ''}`}>
          <button type="button" className="pl-row"
            onClick={() => {
              if (!multi) { openService(s); return }
              // Collapsed, the project list is hidden — so asking for it expands
              // the bar rather than doing nothing visible.
              if (mini) { setMini(false); setOpenSvcs((o) => new Set(o).add(s.name)); return }
              toggleProj(s.name)
            }}>
            <Tile icon={iconFor ? iconFor(s.name, s.icon) : (s.icon || 'circle')}
              color={s.color} on={on} dot={s.running} />
            <span className="pl-txt">
              {s.label || s.name}
              {multi && s.projects_count != null && <small>({s.projects_count})</small>}
            </span>
            {multi && <span className="pl-chev"><Icon name="caret-right" size={13} color="var(--text-muted)" /></span>}
          </button>
          {!multi && (
            <span className="pl-out" role="button" tabIndex={0} title={L('새 창', 'new tab')}
              onClick={(e) => { e.stopPropagation(); window.open(`/p/${s.name}/`, '_blank') }}>
              <Icon name="external" size={13} color="var(--text-muted)" />
            </span>
          )}
        </div>
        {multi && (
          <ProjectList svc={s.name} color={s.color} sel={view === 'service' ? sel : null}
            open={projOpen(s.name)} onPick={(p) => pickProject(s, p)} />
        )}
      </div>
    )
  }

  const modes = HOME_MODES.filter((m) => !m.admin || isManager)

  return (
    <div className={`pl-root${mini ? ' mini' : ''}`}>
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
          <button type="button" className="pl-chev" title={L('전부 접기', 'Collapse all')}
            onClick={allShut}>
            <Icon name="caret-up" size={14} color="var(--text-muted)" />
          </button>
        </div>

        <div className="pl-nav">
          {bands.map(({ g, items }) => (g ? (
            <div key={g.id} style={{ display: 'contents' }}>
              {/* The band spans the bar's full width, gutters included, so a group
                  reads as a strip rather than an indented box (a box widened the
                  collapsed bar). */}
              <div className="pl-band">
                <button type="button" className="pl-grp" onClick={() => toggleGroup(g.id)}>
                  <span className={`pl-gchev${groupOpen(g.id) ? ' open' : ''}`}>
                    <Icon name="caret-right" size={14} weight="bold" color="var(--text-secondary)" />
                  </span>
                  <span className="pl-txt">{g.name || L('그룹', 'Group')}</span>
                  <span className="pl-gcount">{items.length}</span>
                </button>
              </div>
              {/* A shut group hides everything in it, the selected service
                  included — leaving that one behind made the band look broken. */}
              <Slider open={groupOpen(g.id)} className="pl-gitems">{items.map(serviceCard)}</Slider>
            </div>
          ) : (
            <div key="ungrouped" style={{ display: 'contents' }}>{items.map(serviceCard)}</div>
          )))}

          {bands.every((b) => !b.items.length) && (
            <div style={{ padding: '10px 9px', color: 'var(--text-muted)' }}>
              {L('서비스가 없습니다', 'no services')}
            </div>
          )}
        </div>

        {/* Modes and the account sit together at the foot of the bar: both are
            about this portal rather than about a service. */}
        <div className="pl-user">
          <Slider open={modesOpen} className="pl-mlist up">
            {modes.map((m) => (
              <button key={m.id} type="button"
                className={`pl-proj${view === 'live' && m.id === 'live' ? ' on' : ''}`}
                title={lang === 'ko' ? m.ko_hint : m.en_hint}
                onClick={() => (m.id === 'live' ? enterLive() : onEnterManage?.())}>
                <Icon name={m.icon} size={14} />
                <span className="pl-txt">{lang === 'ko' ? m.ko : m.en}</span>
              </button>
            ))}
            {/* Group mode reads like the other two: a fixed name that fills when
                it is on. (It only rearranges the sidebar and leaves the panel
                alone, but a switch that changed its own label made the reader
                work out which way it pointed.) */}
            <button type="button" className={`pl-proj${flat ? '' : ' on'}`}
              onClick={() => setFlat((f) => !f)}>
              <Icon name="tree" size={14} />
              <span className="pl-txt">{L('그룹 모드', 'Group mode')}</span>
            </button>
          </Slider>
          <div className={`pl-card${modesOpen ? ' open' : ''}`}>
            <button type="button" className="pl-row"
              onClick={() => {
                // Collapsed, the list is hidden — so asking for it expands the bar
                // rather than doing nothing visible, same as a service does.
                if (mini) { setMini(false); setModesOpen(true); return }
                setModesOpen((o) => !o)
              }}>
              <Tile icon="squares-four" on={modesOpen} />
              <span className="pl-txt">{L('모드', 'Modes')}</span>
              <span className="pl-chev"><Icon name="caret-right" size={13} color="var(--text-muted)" /></span>
            </button>
          </div>
          <div className={`pl-card${view === 'settings' ? ' on' : ''}`}>
            <button type="button" className="pl-row"
              onClick={() => { setView('settings'); onSettingsTab?.('me'); if (window.innerWidth < PHONE) setMini(true) }}>
              <span className="pl-av" style={{ background: 'transparent' }}>
                <Avatar icon={user?.profile_shape}
                  color={isManager ? MANAGER_COLOR : user?.profile_color}
                  seed={user?.username} size={30} />
              </span>
              <span className="pl-txt">{user?.username}</span>
            </button>
            <span className="pl-out" role="button" tabIndex={0} title={L('로그아웃', 'Log out')}
              onClick={(e) => { e.stopPropagation(); onLogout?.() }}>
              <Icon name="logout" size={14} color="var(--text-muted)" />
            </span>
          </div>
        </div>
      </aside>

      {/* Live takes the whole right side — no panel inset, because a wall wants
          every pixel it can get. */}
      <main className={`pl-main${view === 'live' ? ' live' : ''}`}>
        <div className="pl-panel">
          {view === 'settings' ? (
            <div className="pl-scroll">
              <AccountView isManager={isManager} onChanged={onRefresh} onAccountGone={onLogout}
                tab={settingsTab} onTab={onSettingsTab} />
            </div>
          ) : view === 'live' ? (
            <div className="pl-scroll">
              <LiveWall cards={liveCards || []} iconFor={iconFor} onDone={() => setView('empty')} />
            </div>
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
