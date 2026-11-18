import InboxView from './InboxView'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { Panel, Row, Pill } from './Field'
import StoreView from './StoreView'
import RackView from './RackView'
import NewServiceView from './NewServiceView'

const cardKey = (c) => (c.builtin ? '@' + c.builtin : c.project_card ? `${c.name}/${c.project_card}` : c.name)

/**
 * HomeView — what the panel shows when nothing is open: a search first, the
 * last things this account opened, then every app and project in one table.
 * One press anywhere here opens the thing, no list in the bar to go through.
 *
 * Rows follow the bar's order (cards arrive in it). Projects come from each
 * multi-project service's own list, so the per-project grants are the ones
 * the bar already uses.
 */
export default function HomeView({ cards, groups, recent, onOpen, onInboxAll, isManager, storeOpen, onRefresh, iconFor, bands, onRackGo, view, onView, onManage, onRegroup, onCreateGroup, onRenameGroup, onSetMembers, onDeleteGroup, onManageService, tab: tabProp, onTab, canSets = false }) {
  // The account menu picks the tab now (tab/onTab); without them Home keeps its own tab row.
  const [ownTab, setOwnTab] = useState(storeOpen ? 'store' : 'home')      // 'home' | 'map' | 'sets' | 'dock' | 'store'
  const tabWanted = tabProp ?? ownTab
  const setTab = onTab ?? setOwnTab
  // Only a manager has the other tabs; anyone else is always on Home, whatever was asked.
  const tab = isManager || (canSets && tabWanted === 'sets') ? tabWanted : 'home'
  const apps = useMemo(() => (cards || []).filter((c) => !c.builtin && !c.hidden)
    .filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i), [cards])     // one row source per service; project cards repeat it
  const groupOf = useMemo(() => {
    const m = {}
    for (const g of groups || []) for (const k of g.members || []) m[k] = g
    return m
  }, [groups])
  const shown = apps.filter((c) => c.project_card || !groupOf[cardKey(c)]?.hidden)

  // ponytail: one request per multi-project app; a GET /api/home when there are dozens.
  const [projs, setProjs] = useState({})
  const multiKey = shown.filter((c) => c.multi_project).map((c) => c.name).join(',')
  useEffect(() => {
    let alive = true
    for (const name of multiKey ? multiKey.split(',') : []) {
      launcher.get(`/services/${name}/projects`)
        .then((r) => alive && setProjs((p) => ({ ...p, [name]: r.data || [] })))
        .catch(() => alive && setProjs((p) => ({ ...p, [name]: [] })))
    }
    return () => { alive = false }
  }, [multiKey])

  const rows = []
  for (const c of shown) {
    const groupName = (g) => g?.label || g?.name || ''
    const g = groupOf[cardKey(c)]
    const base = { svc: c, app: c.service_label || c.label || c.name, group: groupName(g), gid: g?.id || '', ckey: cardKey(c) }
    if (!c.multi_project) rows.push({ ...base, key: c.name, proj: '', running: !!c.running, enter: c.can_enter !== false })
    else for (const p of projs[c.name] || []) {
      const own = c.project_card && groupOf[`${c.name}/${p.name}`]     // each project card has its own group
      if (own?.hidden) continue
      rows.push({ ...base, ...(c.project_card ? { group: groupName(own), gid: own?.id || '', ckey: `${c.name}/${p.name}` } : {}), key: `${c.name}/${p.name}`, proj: p.name, label: p.label,
        // The name the sidebar shows: the project card's (with this account's own name for it), else the project's.
        shown: (cards || []).find((x) => x.name === c.name && x.project_card === p.name)?.label || p.label || p.name, running: !!p.running, enter: !!p.can_enter })
    }
  }

  // System holds the portal's own tools, which Home does not list.
  const sortedGroups = [...(groups || [])].filter((g) => !g.hidden && g.name !== 'System').sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000))

  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length
    ? rows.filter((r) => {
      const hay = `${r.app} ${r.svc.name} ${r.proj} ${r.label || ''} ${r.group}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    : rows
  useEffect(() => setAt(0), [q])


  const open = (r) => onOpen(r.svc, r.proj)
  const inputRef = useRef(null)
  const thumbRef = useRef(null)
  // A mouse means a desk: the search takes the keys straight away. On a phone
  // that would throw the keyboard over the screen before anything was asked.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus({ preventScroll: true })
  }, [])
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && hits[at]) { e.preventDefault(); open(hits[at]) }
    // A query to clear comes first; an empty field lets Esc through to the bar.
    else if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') }
  }

  const state = (r) => (!r.enter ? <Pill tone="warn">{tr('p_home_locked')}</Pill>
    : r.running ? <Pill tone="ok">{tr('p_home_on')}</Pill> : <Pill>{tr('p_home_off')}</Pill>)
  const swatch = (c) => <Icon name={iconFor ? iconFor(c.name, c.icon) : (c.icon || 'circle')} size={18} weight="fill"
    color={c.color || 'var(--dock-text-primary)'} />

  // Group view lets you file cards without manage mode: move a row's card to
  // another group or to a place inside one, rename, add or delete a group.
  const [editing, setEditing] = useState(false)
  const edit = editing && view === 'group' && !words.length     // everyone arranges their own bar
  const dragged = useRef(null)                    // the row being dragged
  const [over, setOver] = useState(null)          // the band it is over
  const [overRow, setOverRow] = useState(null)    // the row it would land in front of
  const [deleting, setDeleting] = useState(null)  // the group whose delete waits for a second press
  const nogrp = view === 'group' && !words.length && !edit ? ' nogrp' : ''
  const [moving, setMoving] = useState(null)      // { key, style }: the row whose menu is open, and where
  const menuAt = (el) => {
    // Fixed, so the table's own clipping cannot cut it; above the button near the bottom.
    const b = el.getBoundingClientRect()
    return b.bottom + 220 > window.innerHeight ? { left: b.left, bottom: window.innerHeight - b.top } : { left: b.left, top: b.bottom }
  }
  const [renaming, setRenaming] = useState(null)  // { id, name }
  const [busy, setBusy] = useState(false)
  const run = async (fn) => { setBusy(true); try { await fn() } finally { setBusy(false); await onRefresh?.() } }
  const realGroups = sortedGroups.filter((g) => !g.loose)
  const moveTo = (r, gid) => { setMoving(null); if ((r.gid || '') !== gid) run(() => onRegroup(r.ckey, gid || null)) }
  const saveName = () => {
    const { id, name } = renaming || {}
    setRenaming(null)
    const g = realGroups.find((x) => x.id === id)
    if (g && name.trim() && name.trim() !== (g.label || g.name)) run(() => (onRenameGroup ? onRenameGroup(id, name.trim()) : launcher.put(`/admin/service-groups/${id}`, { name: name.trim() })))
  }
  const moveCell = (r) => (
    <span className="pl-hmove">
      <button type="button" className="set-plain" disabled={busy} aria-expanded={moving?.key === r.key}
        onClick={(e) => { const style = menuAt(e.currentTarget); setMoving((m) => (m?.key === r.key ? null : { key: r.key, style })) }}>
        {r.group || tr('p_no_group')} <Icon name="caret-down" size={10} />
      </button>
      {moving?.key === r.key && (
        <>
          <span className="pl-hmenu-back" onClick={() => setMoving(null)} />
          <span className="pl-hmenu" role="menu" style={moving.style}>
            {realGroups.map((g) => (
              <button key={g.id} type="button" role="menuitem" className={g.id === r.gid ? 'on' : ''}
                onClick={() => moveTo(r, g.id)}>{g.label || g.name}</button>
            ))}
            <button type="button" role="menuitem" className={!r.gid ? 'on' : ''} onClick={() => moveTo(r, '')}>{tr('p_no_group')}</button>
          </span>
        </>
      )}
    </span>
  )
  const bandTitle = (g, name) => {
    if (!edit || !g || g.loose) return name || tr('p_no_group')
    if (renaming?.id === g.id) {
      return <input autoFocus value={renaming.name} aria-label={tr('p_group_name')} className="pl-hrename"
        onChange={(e) => setRenaming({ id: g.id, name: e.target.value })} onBlur={saveName}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setRenaming(null) }} />
    }
    return <button type="button" className="set-plain pl-hrename-btn" title={tr('p_home_rename')}
      onClick={() => setRenaming({ id: g.id, name })}>{name} <Icon name="edit" size={11} /></button>
  }

  // In edit mode a band is a drop target: a row dropped on it moves its card there.
  const zone = (g) => (!edit || !g ? {} : {
    onDragOver: (e) => { if (dragged.current) { e.preventDefault(); setOver(g.id) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o === g.id ? null : o)) },
    onDrop: (e) => { e.preventDefault(); setOver(null); const r = dragged.current; dragged.current = null; if (r) moveTo(r, g.loose ? '' : g.id) },
    style: over === g.id ? { outline: '2px solid var(--dock-info-text)', outlineOffset: 2 } : undefined,
  })
  const drag = (r, g) => (!edit ? {} : {
    draggable: true,
    onDragStart: (e) => { dragged.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.key) },
    onDragEnd: () => { dragged.current = null; setOver(null); setOverRow(null) },
    // Dropped on a row: the card goes in front of that row's card, in that group —
    // the same group (a new order) or another (moved there, at that place).
    onDragOver: (e) => { if (dragged.current && g && !g.loose) { e.preventDefault(); e.stopPropagation(); setOver(g.id); setOverRow(r.key) } },
    onDrop: (e) => {
      if (!g || g.loose) return
      e.preventDefault(); e.stopPropagation()
      const d = dragged.current
      dragged.current = null; setOver(null); setOverRow(null)
      if (!d || d.ckey === r.ckey) return
      const rest = (g.members || []).filter((k) => k !== d.ckey)
      const at = rest.indexOf(r.ckey)
      const members = at < 0 ? [...rest, d.ckey] : [...rest.slice(0, at), d.ckey, ...rest.slice(at)]
      run(() => onSetMembers(g.id, members))
    },
  })
  const delBtn = (g) => (!edit || !g || g.loose || g.share_set || !onDeleteGroup ? null : deleting === g.id ? (
    <span style={{ display: 'flex', gap: 6 }}>
      <button type="button" className="pl-hbtn" disabled={busy}
        onClick={() => { setDeleting(null); run(() => onDeleteGroup(g.id)) }}>{tr('p_home_delete_yes')}</button>
      <button type="button" className="pl-hbtn" onClick={() => setDeleting(null)}>{tr('p_cancel')}</button>
    </span>
  ) : (
    <button type="button" className="pl-hbtn" title={tr('p_home_delete_hint')} onClick={() => setDeleting(g.id)}>
      <Icon name="trash" size={12} /> {tr('p_delete_group_2')}
    </button>
  ))

  const table = (title, hint, list, key, g) => (
    <div key={key} {...zone(g)}>
    <Panel title={title} hint={hint} right={delBtn(g)} bare>
      <Row className={`cols pl-hrow head${nogrp}`}>
        <span>{tr('p_home_app')}</span><span>{tr('p_home_proj')}</span>
        <span>{tr('p_home_group')}</span><span>{tr('p_home_state')}</span><span />
      </Row>
      {list.map((r, i) => (
        <Row key={r.key} className={`cols pl-hrow${nogrp}${edit ? ' drag' : ''}${words.length && i === at ? ' at' : ''}`} {...drag(r, g)}
          style={overRow === r.key ? { boxShadow: 'inset 0 2px 0 var(--dock-info-text)' } : undefined}>
          <span className="app">{edit && <Icon name="drag-handle" size={14} color="var(--dock-text-secondary)" />}{swatch(r.svc)}{r.app}</span>
          <span className="mono">{r.proj || '—'}{r.label && <span className="sub"> {r.label}</span>}</span>
          {edit ? moveCell(r) : <span className="sub">{r.group || '—'}</span>}
          <span>{state(r)}</span>
          <button type="button" onClick={() => open(r)}>{tr('p_home_open')}</button>
        </Row>
      ))}
      {!list.length && <Row className="empty">{tr(grouped ? 'p_home_group_empty' : 'p_home_none')}</Row>}
    </Panel>
    </div>
  )

  // In the bar's group order; the loose band holds the rows with no group.
  // Editing shows empty groups too, so a new one is there to move into.
  const grouped = view === 'group' && !words.length
  const bandsOf = [...sortedGroups, ...(sortedGroups.some((g) => g.loose) ? [] : [{ id: '@none', loose: true }])]
    // Inside a group, in its own member order (the order the bar shows).
    .map((g) => [g, rows.filter((r) => (g.loose ? !r.gid : r.gid === g.id))
      .map((r, n) => [r, g.loose ? n : ((g.members || []).indexOf(r.ckey) + 1 || 1e6) * 1e3 + n])
      .sort((a, b) => a[1] - b[1]).map(([r]) => r)])
    .filter(([g, list]) => list.length || (edit && !g.loose))

  // Rack services are a manager's: without them Home has one page and no tabs.
  const tabs = isManager && tabProp == null ? [['home', tr('p_home')], ['map', tr('rack_title')], ['dock', tr('p_home_tab_dock')], ['neon', tr('p_home_tab_neon')], ['sets', tr('p_rack_tab_sets')], ['store', tr('p_home_tab_store')]] : []

  return (
    <div className={`pl-mgpage pl-home${tabProp == null ? '' : ' nohead'}`}>
      {/* Opened from the account menu there is no search: the menu is the way round. */}
      {tabProp == null && (
        <div className="pl-hhead">
          <div className="pl-hsearch">
            <label>
              <Icon name="search" size={18} color="var(--dock-text-secondary)" />
              <input ref={inputRef} type="text" value={q} onChange={(e) => { setQ(e.target.value); setTab('home') }} onKeyDown={onKey}
                aria-label={tr('p_home_search')} placeholder={tr('p_home_search')} />
            </label>
          </div>
          {tabs.length > 0 && (
            <div className="pl-htabs" role="tablist">
              {tabs.map(([k, text]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''}
                  onClick={() => setTab(k)}>{text}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Our own scrollbar, shown while it scrolls and then faded: Safari does not
          repaint a styled native one when its class changes. */}
      <div className="pl-hbodywrap">
      <span className="pl-hthumb" ref={thumbRef} />
      <div className="pl-scroll pl-hbody" onScroll={(e) => {
        const el = e.currentTarget, th = thumbRef.current
        if (!th) return
        const h = el.clientHeight, sh = el.scrollHeight
        const len = Math.max(32, (h * h) / sh)
        th.style.height = `${len}px`
        th.style.transform = `translateY(${(el.scrollTop / Math.max(1, sh - h)) * (h - len)}px)`
        th.classList.add('on')
        clearTimeout(th._fade)
        th._fade = setTimeout(() => th.classList.remove('on'), 900)
      }}>
      {/* A search answers in one list, so the view switch and editing wait for it. */}
      {tab === 'home' && (
        <div className="pl-htool" style={words.length ? { visibility: 'hidden' } : undefined}>
          <div className="pl-hview">
            {[['list', tr('p_home_view_list')], ['group', tr('p_home_view_group')]].map(([k, text]) => (
              <button key={k} type="button" aria-pressed={view === k} className={view === k ? 'on' : ''}
                onClick={() => { onView(k); if (k === 'list') setEditing(false) }}>{text}</button>
            ))}
          </div>
          <button type="button" className={`pl-hbtn${edit ? ' on' : ''}`} aria-pressed={edit}
            onClick={() => { if (edit) setEditing(false); else { setEditing(true); onView('group') } }}>
            <Icon name="edit" size={12} /> {tr(edit ? 'p_home_edit_done' : 'p_home_edit')}
          </button>
          {edit && (
            <button type="button" className="pl-hbtn" disabled={busy} onClick={() => run(() => onCreateGroup())}>
              <Icon name="plus" size={12} /> {tr('p_new_group')}
            </button>
          )}
          <button type="button" className="pl-hbtn pl-hmanagebtn" onClick={onManage}>
            <Icon name="wrench" size={13} /> {tr('p_manage_mode')}
          </button>
        </div>
      )}
      {tab === 'home' && edit && <p className="pl-hedithint">{tr('p_home_edit_hint')}</p>}

      {tab === 'store' && <StoreView onChanged={onRefresh} />}
      {/* The three looks, one list each: a service unfolds into what Manage sidebar
          offers for it and its admins, a project into its admins. */}
      {(tab === 'map' || tab === 'dock' || tab === 'neon') && (
        <div className="pl-hrack">
          <RackView tab="map" look={{ map: 'rack', dock: 'dock', neon: 'neon' }[tab]} cards={cards}
            bands={bands} onChanged={onRefresh} onGo={onRackGo} onManage={onManageService} readOnly={!isManager} />
        </div>
      )}
      {tab === 'dock' && <NewServiceView onCreated={onRefresh} />}

      {tab === 'sets' && (
        <div className="pl-hrack">
          <RackView tab={tab} bands={bands} onChanged={onRefresh} onGo={onRackGo} onManage={onManageService} readOnly={!isManager} />
        </div>
      )}

      {/* What waits for the account's yes, five at most; the rest come up as these are done. */}
      {tab === 'home' && !words.length && <InboxView limit={5} onAll={onInboxAll} />}

      {tab === 'home' && (grouped
        ? bandsOf.map(([g, list]) => table(bandTitle(g, g.label || g.name || ''), tr('p_home_count', list.length), list, g.id, g))
        : table(words.length ? tr('p_home_found', hits.length) : tr('p_home_all'),
          words.length ? null : tr('p_home_count', rows.length), hits, 'all'))}
      </div>
      </div>
    </div>
  )
}
