import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import AccountView from './AccountView'
import './sidebar.css'

/**
 * SidebarPortal — the sidebar cover: services on the left, the selected one in a
 * panel on the right (mockups/portal-sidebar-a.html).
 *
 * Stage 1 of the redesign: services, the panel, the URL, collapsing, settings and
 * the user card. Modes, groups, search-aware expansion and keyboard navigation
 * come next; until then `portal_layout` keeps the classic card grid one click
 * away (AccountMenu), so this can be lived with before it is finished.
 *
 * A service opens according to its manifest `open`:
 *   'panel'  — an iframe inside the panel. Same origin (the portal serves /p/
 *              itself), so the session cookie and the proxy's base-href
 *              injection work exactly as in a tab.
 *   'window' — its own tab. Multi-project services default to this: they bring
 *              their own top bar, command bar and drawer, which read as a second
 *              set of chrome once framed.
 */
const MINI_KEY = 'portal-mini'
const WIDE = 900          // below this the bar collapses on its own
const PHONE = 640         // below this it becomes a drawer over the panel (CSS)

const letter = (s) => (s || '?').trim().charAt(0).toUpperCase()

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

/** Slide a list open/closed for real (height + the cards travelling), instead of
 *  fading it. Returns [phase, shown] — keep rendering while phase is 'leave'. */
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
    if (!el || !phase) return
    el.style.setProperty('--h', `${el.scrollHeight}px`)
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

function ProjectList({ svc, color, sel, onPick, open }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [rows, setRows] = useState(null)
  const slide = useSlide(open)

  useEffect(() => {
    if (!open || rows) return
    launcher.get(`/services/${svc}/projects`).then((r) => setRows(r.data)).catch(() => setRows([]))
  }, [open, svc])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!slide.shown) return null
  return (
    <div ref={slide.ref} className={`pl-projs ${slide.cls}`} onAnimationEnd={slide.onAnimEnd}>
      {rows === null && <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>…</div>}
      {rows?.length === 0 && (
        <div className="pl-proj" style={{ color: 'var(--text-muted)' }}>{L('프로젝트 없음', 'no projects')}</div>
      )}
      {(rows || []).map((p) => {
        const on = sel?.svc === svc && sel?.proj === p.name
        return (
          <button key={p.name} type="button" className={`pl-proj${on ? ' on' : ''}`}
            onClick={() => onPick(p.name)}>
            <span className="dot" style={{ background: on ? '#fff' : (color || 'var(--text-muted)') }} />
            <span className="pl-txt">{p.name}</span>
            <span className="pl-out" role="button" tabIndex={-1}
              title={L('새 창', 'new tab')}
              onClick={(e) => { e.stopPropagation(); window.open(`/pp/${svc}/${p.name}/`, '_blank') }}>
              <Icon name="external" size={13} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default function SidebarPortal({ user, isManager, services, onLogout, onRefresh, settingsTab, onSettingsTab }) {
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
  const [sel, setSel] = useState(readSel)          // { svc, proj } — mirrored in the URL
  const [view, setView] = useState(() => (readSel() ? 'service' : 'empty'))  // 'service' | 'settings' | 'empty'
  const [openSvc, setOpenSvc] = useState(() => readSel()?.svc || null)       // expanded project list
  const [q, setQ] = useState('')
  const searchRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(MINI_KEY, mini ? '1' : '0')
    // Collapsing hides the project lists; close them too, so expanding again does
    // not reveal a list the user last saw minutes ago.
    if (mini) setOpenSvc(null)
  }, [mini])
  useEffect(() => { writeSel(view === 'service' ? sel : null) }, [sel, view])

  // Collapse on its own between the phone drawer and a comfortable width — 260px
  // of chrome is a lot to give up when the panel is already narrow.
  useEffect(() => {
    const fit = () => {
      const w = window.innerWidth
      if (w < PHONE) return                        // drawer: the user's choice stands
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
    if (window.innerWidth < PHONE) setMini(true)   // drawer closes behind you
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

  const hit = (s) => {
    if (!q.trim()) return true
    const n = q.trim().toLowerCase()
    return (s.label || s.name).toLowerCase().includes(n) || s.name.toLowerCase().includes(n)
  }
  const list = (services || []).filter(hit)

  const selSvc = (services || []).find((s) => s.name === sel?.svc)
  // A multi-project service has nothing to show on its own — the panel asks for a
  // project instead of framing the service root.
  const needProject = !!selSvc?.multi_project && !sel?.proj
  const src = sel?.svc && !needProject
    ? (sel.proj ? `/pp/${sel.svc}/${sel.proj}/` : `/p/${sel.svc}/`)
    : null

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
          <button type="button" className="pl-chev" title={L('프로젝트 전부 접기', 'collapse all')}
            onClick={() => setOpenSvc(null)}>
            <Icon name="caret-up" size={14} color="var(--text-muted)" />
          </button>
        </div>

        <div className="pl-nav">
          <div className="pl-card pl-search" onClick={() => { setMini(false); searchRef.current?.focus() }}>
            <Icon name="search" size={16} color="var(--text-secondary)" style={{ flexShrink: 0, marginLeft: 7 }} />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={L('검색', 'Search')} />
          </div>

          <div className={`pl-card${view === 'settings' ? ' on' : ''}`}>
            <button type="button" className="pl-row"
              onClick={() => { setView('settings'); onSettingsTab?.('me'); if (window.innerWidth < PHONE) setMini(true) }}>
              <Icon name="settings" size={16} color="var(--text-secondary)" style={{ flexShrink: 0, marginLeft: 7 }} />
              <span className="pl-txt">{L('설정', 'Settings')}</span>
            </button>
          </div>

          {list.map((s) => {
            const on = view === 'service' && sel?.svc === s.name
            const multi = s.multi_project
            return (
              <div key={s.name} style={{ display: 'contents' }}>
                <div className={`pl-card${on ? ' on' : ''}${openSvc === s.name ? ' open' : ''}`}>
                  <button type="button" className="pl-row"
                    onClick={() => (multi
                      ? setOpenSvc((o) => (o === s.name ? null : s.name))
                      : openService(s))}>
                    <span className="pl-av" style={{ background: s.color || 'var(--text-secondary)' }}>
                      {letter(s.label || s.name)}
                      <i className={s.running ? 'up' : ''} />
                    </span>
                    <span className="pl-txt">
                      {s.label || s.name}
                      {multi && s.projects_count != null && <small>({s.projects_count})</small>}
                    </span>
                    {multi && <span className="pl-chev"><Icon name="caret-right" size={13} color="var(--text-muted)" /></span>}
                  </button>
                  {!multi && (
                    <span className="pl-out" role="button" tabIndex={0}
                      title={L('새 창', 'new tab')}
                      onClick={(e) => { e.stopPropagation(); window.open(`/p/${s.name}/`, '_blank') }}>
                      <Icon name="external" size={13} color="var(--text-muted)" />
                    </span>
                  )}
                </div>
                {multi && (
                  <ProjectList svc={s.name} color={s.color} sel={view === 'service' ? sel : null}
                    open={openSvc === s.name} onPick={(p) => pickProject(s, p)} />
                )}
              </div>
            )
          })}

          {list.length === 0 && (
            <div style={{ padding: '10px 9px', color: 'var(--text-muted)' }}>
              {q.trim() ? L('결과 없음', 'no matches') : L('서비스가 없습니다', 'no services')}
            </div>
          )}
        </div>

        <div className="pl-user">
          <div className={`pl-card${view === 'settings' && settingsTab === 'me' ? ' on' : ''}`}>
            <button type="button" className="pl-row"
              onClick={() => { setView('settings'); onSettingsTab?.('me'); if (window.innerWidth < PHONE) setMini(true) }}>
              <span className="pl-av sys">{letter(user?.username)}</span>
              <span className="pl-txt">{user?.username}</span>
            </button>
            <span className="pl-out" role="button" tabIndex={0} title={L('로그아웃', 'Log out')}
              onClick={(e) => { e.stopPropagation(); onLogout?.() }}>
              <Icon name="logout" size={14} color="var(--text-muted)" />
            </span>
          </div>
        </div>
      </aside>

      <main className="pl-main">
        <div className="pl-panel">
          {view === 'settings' ? (
            <div className="pl-scroll">
              <AccountView isManager={isManager} onChanged={onRefresh} onAccountGone={onLogout}
                tab={settingsTab} onTab={onSettingsTab} />
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
