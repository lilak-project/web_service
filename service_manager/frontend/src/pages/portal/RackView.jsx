import { useEffect, useRef, useState } from 'react'
import { tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Row, Pill } from './Field'
import AdminEditor from './AdminEditor'
import ServiceManagePanel from './ServiceManagePanel'
import ServiceProjects from './ServiceProjects'
import ServiceSingle from './ServiceSingle'

/**
 * RackView — the rack services (the ones built on racklist): which band each
 * sits in with the projects inside it, or their share sets (`tab`: 'map' | 'sets').
 * Two tabs of Home.
 *
 * A share set is {service: project}: those projects read each other's tags and
 * link each other's records. A project is in one set at most. Stored by the
 * portal (`/api/share-sets`, registry.share_sets); until a manager saves, the
 * sets come from the manifests' tag groups through the main projects. The
 * portal hands each page its set as `__PORTAL_SERVICE__.share` (racklist).
 */

// Only the services drawn with racklist — elog, nptoy … are other code and
// share nothing with these. Same rule as registry.link_project.

const SLOT_TONE = { ok: 'var(--dock-success-text)', warn: 'var(--dock-warning-text)', bad: 'var(--dock-danger-text)', hint: 'var(--dock-text-secondary)' }

const keyOf = (c) => (c.project_card ? `${c.name}/${c.project_card}` : c.name)
const isRack = (c) => !c.builtin && (c.kind === 'rack' || c.tags)
// Which of the account menu's three lists a service is in: NEON says so in its
// manifest (`look`), rack is the racklist services, everything else is DOCK.
export const lookOf = (c) => (c.look === 'neon' ? 'neon' : isRack(c) ? 'rack' : 'dock')
const LOOK_TITLE = { rack: 'rack_title', dock: 'p_home_tab_dock', neon: 'p_home_tab_neon' }

function Swatch({ color }) {
  return <span style={{ width: 10, height: 10, flex: 'none', background: color || 'var(--dock-border-strong)' }} />
}

export default function RackView({ tab, look = 'rack', cards: allCards, bands = [], onGo, onManage, onChanged, onHideCards, readOnly = false }) {
  // A service's settings open as their own page (the manage panel) when the host can show it; else inline.
  const openSvc = (name) => (onManage ? onManage(name) : flip(name))
  // readOnly: a project admin sees the sets and makes new ones from a template; only a manager rearranges them.
  const { lang } = useLang()

  const groups = bands
    .map((b) => ({ g: b.g, items: b.items.filter(isRack) }))
    .filter((b) => b.items.length)
  // A service split into project cards is still one service here. The list tabs take
  // every card (hidden ones too — this is where a manager finds them); the sets, the rack ones in the bar.
  const all = tab === 'map' && allCards ? allCards.filter((c) => !c.builtin && lookOf(c) === look) : groups.flatMap((b) => b.items)
  const services = [...new Map(all.map((s) => [s.name, s])).values()]
  // What is unfolded: a service (`svc`) shows what Manage sidebar shows for it and its admins.
  const [open, setOpen] = useState(() => new Set())
  const flip = (k) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const byName = Object.fromEntries(services.map((s) => [s.name, s]))
  const cardOf = (svc, proj) => all.find((c) => c.name === svc && c.project_card === proj)
  // A card that opens one project is named after it; the service's own name is then service_label (or none).
  const label = (svc) => { const s = byName[svc]; return !s ? svc : 'service_label' in s ? (s.service_label || s.name) : (s.labels?.[lang] || s.label || s.name) }

  // svc -> [project] | null (failed)
  const [projects, setProjects] = useState({})
  const multi = services.filter((s) => s.multi_project).map((s) => s.name).join(',')
  const loadProjects = (svc) => launcher.get(`/services/${svc}/projects`)
    .then((r) => setProjects((p) => ({ ...p, [svc]: r.data || [] })))
    .catch(() => setProjects((p) => ({ ...p, [svc]: null })))
  useEffect(() => { for (const svc of multi ? multi.split(',') : []) loadProjects(svc) }, [multi])  // eslint-disable-line react-hooks/exhaustive-deps

  // New project, from the overview: one service's input open at a time.
  const [adding, setAdding] = useState(null)   // { svc, at (card), name, busy, err }
  const create = () => {
    const name = adding.name.trim()
    if (!name) return
    setAdding((a) => ({ ...a, busy: true, err: null }))
    launcher.post(`/services/${adding.svc}/projects`, { name })
      .then(() => { loadProjects(adding.svc); setAdding(null) })
      .catch((e) => setAdding((a) => ({ ...a, busy: false, err: errText(e) })))
  }

  const [sets, setSets] = useState(null)
  const [stored, setStored] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState(null)        // { tone, text }
  const take = (d) => { setSets(d.sets || []); setStored(!!d.stored); setDirty(false) }
  useEffect(() => {
    launcher.get('/share-sets').then((r) => take(r.data)).catch((e) => setMsg({ tone: 'bad', text: errText(e) }))
  }, [])

  // A set made from a template in one go: the projects it lacks are made, then joined.
  const [tpls, setTpls] = useState([])
  const [mk, setMk] = useState({ tpl: 0, name: '', project: '', hide: null })   // hide: services ticked, null = default
  // Ticked to start hidden: a service whose cards this account already hides, all of them (the inbox, say).
  const hideDefault = (svcs) => new Set(svcs.filter((v) => {
    const own = (allCards || []).filter((c) => c.name === v)
    return own.length > 0 && own.every((c) => c.hidden)
  }))
  const hideSet = mk.hide ?? hideDefault(tpls[mk.tpl]?.services || [])
  useEffect(() => {
    launcher.get('/share-sets/templates').then((r) => setTpls(r.data || [])).catch(() => {})
  }, [sets])
  const make = async () => {
    const t = tpls[mk.tpl]
    // An empty name is the template's; the project defaults to the name, spaces made _.
    const name = mk.name.trim() || t.name
    try {
      const project = mk.project.trim() || name.replace(/\s+/g, '_')
      const r = await launcher.post('/share-sets/make', { name, project, services: t.services })
      take(r.data)
      // The new project cards start hidden in this account's own bar where ticked.
      const hide = t.services.filter((v) => hideSet.has(v)).map((v) => `${v}/${project}`)
      if (hide.length) onHideCards?.(hide)
      setMsg({ tone: 'ok', text: tr('p_share_made', name, r.data.made.length, r.data.joined.length) })
      setMk({ ...mk, name: '', project: '', hide: null })
      onChanged?.()
    } catch (e) { setMsg({ tone: 'bad', text: errText(e) }) }
  }

  // An MCP token bound to one set: an agent given it reads and writes that set's projects only.
  // Shown once, with the line that registers it in Claude Code. For whoever administers every project of
  // the set (a manager, or a project admin holding the whole set): the server says, by answering the list.
  const [tok, setTok] = useState(null)        // { i, write, made? }
  // The tokens bound to each set, by set id or name; a set missing here is not the viewer's to issue for.
  const [tokens, setTokens] = useState({})
  const setKeys = (sets || []).map((st) => st.id || st.name).join('|')
  const loadTokens = () => {
    Promise.all((sets || []).map((st) => launcher.get('/share-sets/mcp-tokens', { params: { set: st.id || st.name } })
      .then((r) => [st.id || st.name, r.data || []], () => null)))
      .then((rows) => setTokens(Object.fromEntries(rows.filter(Boolean))))
  }
  useEffect(loadTokens, [setKeys])  // eslint-disable-line react-hooks/exhaustive-deps
  const mayIssue = (st) => !!tokens[st.id || st.name]
  const boundTo = (st) => (tokens[st.id || st.name] || []).filter((t) => !t.revoked && !t.expired)
  const issueTok = async (st) => {
    try {
      const r = await launcher.post('/share-sets/mcp-tokens', { set: st.id || st.name, can_write: !!tok.write, days: 180 })
      setTok({ ...tok, made: r.data.token })
      loadTokens()
      // The sets may have been given their ids just now: take them, so the next save keeps them.
      launcher.get('/share-sets').then((x) => take(x.data)).catch(() => {})
    } catch (e) { setMsg({ tone: 'bad', text: errText(e) }) }
  }
  const mcpLine = (st, token) => `claude mcp add --transport http --scope user lilak-${st.name} ${window.location.origin}/mcp --header "Authorization: Bearer ${token}"`

  const edit = (fn) => { if (readOnly) return; setSets((old) => fn(structuredClone(old))); setDirty(true); setMsg(null) }
  const setOf = (svc, proj) => (sets || []).findIndex((s) => s.members?.[svc] === proj)

  // Every project of every rack service, as a card to click. A click picks it;
  // "move here" puts the picked ones in a set, "take out" leaves them in none.
  const cards = services.filter((s) => s.multi_project).flatMap((s) => (projects[s.name] || [])
    .map((p) => ({ key: `${s.name}/${p.name}`, svc: s.name, proj: p.name, name: p.label || p.name, color: s.color })))
  const outside = cards.filter((c) => setOf(c.svc, c.proj) < 0)
  const [picked, setPicked] = useState(() => new Set())
  const pickedCards = cards.filter((c) => picked.has(c.key))
  // A set holds one project per service: a link to that service needs one place.
  const twoOfOne = new Set(pickedCards.map((c) => c.svc)).size < pickedCards.length
  const pickedInSet = pickedCards.some((c) => setOf(c.svc, c.proj) >= 0)
  const toggle = (k) => { if (readOnly) return; setMsg(null); setPicked((old) => { const n = new Set(old); if (n.has(k)) n.delete(k); else n.add(k); return n }) }
  const leave = (s, c) => { for (const t of s) if (t.members?.[c.svc] === c.proj) delete t.members[c.svc] }
  // Moving in a project of a service the set already holds pushes the old one out.
  const moveHere = (i, list = pickedCards) => {
    edit((s) => { for (const c of list) { leave(s, c); s[i].members = { ...s[i].members, [c.svc]: c.proj } } return s })
    setPicked(new Set())
  }
  const takeOut = (list = pickedCards) => { edit((s) => { for (const c of list) leave(s, c); return s }); setPicked(new Set()) }
  // Dragging carries the card under the mouse, and the other picked ones if it is
  // picked too. `at` is a set's index, or 'out' for the no-set panel.
  const dragged = useRef([])
  const [over, setOver] = useState(null)
  const drop = (at) => {
    const list = dragged.current
    dragged.current = []
    setOver(null)
    if (!list.some((c) => setOf(c.svc, c.proj) !== (at === 'out' ? -1 : at))) return
    if (at === 'out') { takeOut(list); return }
    if (new Set(list.map((c) => c.svc)).size < list.length) { setMsg({ tone: 'warn', text: tr('p_share_two_of_one') }); return }
    moveHere(at, list)
  }
  const zone = (at, panel) => (
    <div key={at} style={{ display: 'contents' }}
      onDragOver={(e) => { if (!dragged.current.length) return; e.preventDefault(); setOver(at) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) }}
      onDrop={(e) => { e.preventDefault(); if (!readOnly) drop(at) }}>
      {panel}
    </div>
  )
  const zoneStyle = (at) => (over === at ? { outline: '2px solid var(--dock-info-text)', outlineOffset: -1 } : undefined)
  const card = (c) => {
    const on = picked.has(c.key)
    return (
      // Not a <button>: Firefox will not drag one.
      <div key={c.key} role="button" tabIndex={0} aria-pressed={on} draggable onClick={() => toggle(c.key)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(c.key) } }}
        onDragStart={(e) => {
          dragged.current = on ? pickedCards : [c]
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', c.name)
        }}
        onDragEnd={() => { dragged.current = []; setOver(null) }}
        style={{ display: 'flex', alignItems: 'stretch', textAlign: 'left', padding: 0, minWidth: 130, cursor: 'grab',
          font: 'inherit', color: 'var(--dock-text-primary)',
          border: `1px solid ${on ? 'var(--dock-info-text)' : 'var(--dock-border-default)'}`,
          boxShadow: on ? 'inset 0 0 0 1px var(--dock-info-text)' : 'none',
          background: on ? 'var(--dock-info-bg)' : 'var(--dock-surface)' }}>
        <span style={{ width: 5, flex: 'none', background: c.color || 'var(--dock-border-strong)' }} />
        <span style={{ display: 'flex', flexDirection: 'column', padding: '4px 10px', lineHeight: 1.35 }}>
          <span style={{ color: 'var(--dock-text-secondary)', fontSize: 'var(--fs-small)' }}>{label(c.svc)}</span>
          <span>{c.name}</span>
        </span>
      </div>
    )
  }

  // Every change saves itself, a moment after the last one (the name box types).
  // The answer does not replace `sets`: you may have typed on since it left.
  const latest = useRef(sets)
  latest.current = sets
  useEffect(() => {
    if (!dirty) return
    const sent = sets
    const t = setTimeout(() => launcher.put('/share-sets', { sets: sent })
      .then(() => { setStored(true); if (latest.current === sent) setDirty(false); setMsg({ tone: 'ok', text: tr('p_share_saved') }); onChanged?.() })
      .catch((e) => setMsg({ tone: 'bad', text: errText(e) })), 600)
    return () => clearTimeout(t)
  }, [sets, dirty])
  // Leaving the tab inside that moment must not lose the last move.
  const unsaved = useRef(false)
  unsaved.current = dirty
  useEffect(() => () => {
    if (unsaved.current) launcher.put('/share-sets', { sets: latest.current }).catch(() => {})
  }, [])

  const reset = () => launcher.delete('/share-sets')
    .then((r) => { take(r.data); setMsg({ tone: 'ok', text: tr('p_share_reset_done') }) })
    .catch((e) => setMsg({ tone: 'bad', text: errText(e) }))

  const slot = twoOfOne ? { tone: 'warn', text: tr('p_share_two_of_one') }
    : msg || (picked.size ? { text: tr('p_share_picked', picked.size) } : { tone: 'hint', text: tr('p_share_pick_hint') })
  const TWO = { gridTemplateColumns: 'minmax(140px, 200px) 1fr' }
  // The state column is as wide as its button ("● 실행 중 →"), so it never runs into the set's name.
  const MAP_COLS = { gridTemplateColumns: 'minmax(120px, 1.2fr) minmax(100px, 1fr) 56px max-content minmax(90px, 1fr)', columnGap: 12 }

  return (
    <>
      {/* Service by service, not by sidebar group: one list, each service with all
          its projects. A service split into project cards is listed whole. */}
      {tab === 'map' && [{ g: null, items: services.map((s) => (s.project_card ? { ...s, project_card: null } : s)) }].map(({ g, items }) => {
        const nproj = items.reduce((n, s) => n + (s.multi_project && !s.project_card ? (s.projects_count || 0) : 1), 0)
        return (
          <Panel key={g?.id || '@all'} title={g?.name || tr(LOOK_TITLE[look])}
            hint={tr('p_map_band_hint', new Set(items.map((s) => s.name)).size, nproj)} bare>
            <Row className="cols head" style={MAP_COLS}>
              <span>{tr('p_map_col_service')}</span><span>{tr('p_map_col_project')}</span>
              <span>{tr('p_map_col_main')}</span><span>{tr('p_map_col_state')}</span><span>{tr('p_map_col_set')}</span>
            </Row>
            {items.flatMap((s) => {
              const all = projects[s.name]
              const list = s.project_card && all ? all.filter((p) => p.name === s.project_card) : all
              const at = keyOf(s)
              const head = (
                <span style={{ display: 'flex', alignItems: 'stretch', gap: 7, minWidth: 0, alignSelf: 'stretch' }}>
                  {/* The whole cell up to "+" is the way into the service's settings. */}
                  <span className={readOnly ? undefined : 'pl-rsvc'} role={readOnly ? undefined : 'button'} tabIndex={readOnly ? undefined : 0}
                    style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}
                    onClick={readOnly ? undefined : () => openSvc(s.name)}
                    onKeyDown={readOnly ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSvc(s.name) } }}>
                    <Swatch color={s.color} />
                    <span style={{ overflowWrap: 'anywhere' }}>{label(s.name)}</span>
                    {s.hidden && <Pill>{tr('p_map_hidden')}</Pill>}
                  </span>
                  {s.multi_project && (
                    <button type="button" className="set-plain" title={tr('p_map_new_project')}
                      onClick={() => setAdding(adding?.at === at ? null : { svc: s.name, at, name: '' })}
                      style={{ alignSelf: 'center', flex: 'none', padding: '0 6px', font: 'inherit', cursor: 'pointer', lineHeight: 1.4,
                        border: '1px solid var(--dock-border-default)', background: adding?.at === at ? 'var(--dock-info-bg)' : 'var(--dock-surface)',
                        color: 'var(--dock-text-secondary)' }}>+</button>
                  )}
                </span>
              )
              const addRow = adding?.at === at && (
                <Row key={`${at}/+`} className="cols" style={MAP_COLS}>
                  <span />
                  <span style={{ gridColumn: '2 / -1', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input autoFocus value={adding.name} placeholder={tr('p_map_new_project_name')}
                      onChange={(e) => { const v = e.target.value; setAdding((a) => ({ ...a, name: v })) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setAdding(null) }} />
                    <button type="button" disabled={!adding.name.trim() || adding.busy} onClick={create}>{tr('portal_proj_create')}</button>
                    <button type="button" onClick={() => setAdding(null)}>{tr('p_cancel')}</button>
                    {adding.err && <Pill tone="bad">{adding.err}</Pill>}
                  </span>
                </Row>
              )
              const unfolded = open.has(s.name) && (
                // Not a table row (.cols is one fixed height): the open panel grows with what it holds.
                <Row key={`${at}/@`} style={{ display: 'block', height: 'auto', padding: '8px 12px 12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <AdminEditor scopes={[{ svc: s.name, proj: '' }]} />
                    <ServiceManagePanel service={'service_label' in s ? { ...s, label: s.service_label, labels: s.service_labels } : s}
                      onChanged={onChanged} />
                    {s.multi_project ? <ServiceProjects service={s} canManage manage onChanged={() => { loadProjects(s.name); onChanged?.() }} />
                      : <ServiceSingle service={s} canManage manage onChanged={onChanged} />}
                  </div>
                </Row>
              )
              const note = !s.multi_project ? tr('p_map_single') : list === undefined ? '…'
                : list === null ? tr('p_map_load_failed') : list.length === 0 ? tr('p_map_no_projects') : null
              if (note) {
                return [(
                  <Row key={at} className="cols" style={MAP_COLS}>
                    {head}<span className="sub">{note}</span><span /><span /><span />
                  </Row>
                ), unfolded, addRow]
              }
              return [...list.map((p, n) => {
                const k = setOf(s.name, p.name)
                const pk = `${s.name}/${p.name}`
                return [(
                  <Row key={pk} className="cols" style={MAP_COLS}>
                    {n === 0 ? head : <span />}
                    {/* a project's admins are set in the whole Manage view now, not unfolded here */}
                    <span style={{ overflowWrap: 'anywhere', display: 'flex', alignItems: 'center', gap: 5 }}>{p.label || p.name}</span>
                    <span>{p.name === s.link_project ? tr('p_map_main') : ''}</span>
                    {/* The state doubles as the way in: it opens this project of this service. */}
                    <button type="button" className="set-plain" disabled={!onGo} title={tr('p_map_go')}
                      onClick={() => onGo?.(cardOf(s.name, p.name) || s, p.name)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, justifySelf: 'start', padding: '1px 7px', font: 'inherit',
                        cursor: onGo ? 'pointer' : 'default', border: '1px solid var(--dock-border-default)', background: 'var(--dock-surface)' }}>
                      <span style={{ width: 6, height: 6, borderRadius: 3, flex: 'none',
                        background: p.running ? 'var(--dock-success-text, #15803d)' : 'var(--dock-border-strong)' }} />
                      <span className="sub">{p.running ? tr('p_map_on') : tr('p_map_off')}</span>
                      <span className="sub">→</span>
                    </button>
                    <span>{k >= 0 ? <Pill tone="ok">{sets[k].name}</Pill> : <span className="sub">—</span>}</span>
                  </Row>
                ), n === 0 && unfolded]
              }), addRow]
            })}
          </Panel>
        )
      })}

      {tab === 'sets' && <>
      <Panel title={tr('p_share_sets')} hint={stored ? tr('p_share_stored') : tr('p_share_default')} bare
        right={(
          !readOnly && <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => edit((s) => [...s, { name: tr('p_share_new_name', s.length + 1), members: {} }])}>
              {tr('p_share_add_set')}
            </button>
            {stored && <button type="button" onClick={reset}>{tr('p_share_reset')}</button>}
          </span>
        )}>
        <Row className="sub">{tr('p_share_explain')}</Row>
        <Row style={{ flexWrap: 'nowrap' }}>
          {/* One slot for what is being said here, two lines tall from the start, so a
              message arriving never moves the panels below. A click on a card clears it. */}
          <span style={{ flex: 1, minWidth: 0, height: '2.8em', lineHeight: 1.4, display: 'flex', alignItems: 'center', color: SLOT_TONE[slot.tone] }}>
            <span title={slot.text} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{slot.text}</span>
          </span>
          {!readOnly && <>
            <button type="button" disabled={!pickedInSet} onClick={() => takeOut()}>{tr('p_share_take_out')}</button>
            <button type="button" disabled={!picked.size} onClick={() => setPicked(new Set())}>{tr('p_share_clear')}</button>
          </>}
        </Row>
      </Panel>

      <Panel title={tr('p_share_tpl')} bare>
        <Row className="sub">{tr('p_share_tpl_explain')}</Row>
        <Row style={{ gap: 6, flexWrap: 'wrap' }}>
          {/* Buttons, not a <select>: in the portal frame a native menu swallowed the next click. */}
          {tpls.map((t, k) => (
            <button key={k} type="button" aria-pressed={mk.tpl === k} onClick={() => setMk({ ...mk, tpl: k })}
              style={mk.tpl === k ? { fontWeight: 600, borderColor: 'var(--dock-border-focus)' } : undefined}>
              {t.name}
            </button>
          ))}
          <input placeholder={tpls[mk.tpl]?.name || tr('p_share_tpl_name')} aria-label={tr('p_share_tpl_name')} value={mk.name}
            onChange={(e) => setMk({ ...mk, name: e.target.value })} />
          <input placeholder={tr('p_share_tpl_project')} aria-label={tr('p_share_tpl_project')} value={mk.project}
            onChange={(e) => setMk({ ...mk, project: e.target.value })} />
          <button type="button" disabled={!tpls[mk.tpl] || dirty} title={dirty ? tr('p_share_tpl_save_first') : undefined} onClick={make}>{tr('p_share_tpl_make')}</button>
        </Row>
        {tpls[mk.tpl] && (
          <Row className="sub" style={{ flexWrap: 'wrap', gap: 6, height: 'auto', paddingTop: 6, paddingBottom: 6 }}>
            {tpls[mk.tpl].services.map((v) => (
              <label key={v} title={tr('p_share_tpl_hide_hint')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px',
                border: '1px solid var(--dock-border-default)', background: hideSet.has(v) ? 'var(--dock-surface-sunken, transparent)' : 'var(--dock-surface)',
                color: hideSet.has(v) ? 'var(--dock-text-tertiary, var(--dock-text-secondary))' : 'var(--dock-text-primary)', cursor: onHideCards ? 'pointer' : 'default' }}>
                {onHideCards && <input type="checkbox" checked={hideSet.has(v)}
                  onChange={() => setMk((m) => { const n = new Set(m.hide ?? hideSet); if (n.has(v)) n.delete(v); else n.add(v); return { ...m, hide: n } })} />}
                {label(v)}{hideSet.has(v) && onHideCards ? ` · ${tr('p_share_tpl_hidden')}` : ''}
              </label>
            ))}
          </Row>
        )}
      </Panel>

      {(sets || []).map((st, i) => {
        const inSet = cards.filter((c) => st.members?.[c.svc] === c.proj)
        return (
          zone(i, <Panel title={st.name} hint={tr('p_share_n', inSet.length)} bare style={zoneStyle(i)}
            right={(
              <span style={{ display: 'flex', gap: 6 }}>
                {/* The set's sidebar group follows it on its own (service_groups.sync_set_groups). */}
                {!readOnly && <>
                  <button type="button" disabled={!picked.size || twoOfOne} onClick={() => moveHere(i)}>{tr('p_share_move_here')}</button>
                  <button type="button" onClick={() => edit((s) => s.filter((_, k) => k !== i))}>{tr('p_share_delete_set')}</button>
                </>}
                {mayIssue(st) && <button type="button" disabled={dirty} title={dirty ? tr('p_share_tok_save_first') : undefined}
                  onClick={() => setTok(tok?.i === i ? null : { i, write: true })}>{tr('p_share_tok')}</button>}
              </span>
            )}>
            {mayIssue(st) && (
              <Row className="sub" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span>{tr('p_share_tok_bound')}</span>
                {boundTo(st).length ? boundTo(st).map((t) => (
                  <span key={t.id}><b>{t.name}</b> · {t.can_write ? tr('p_mcp_write') : tr('p_mcp_read')} · {tr('p_mcp_used')} {t.last_used_at
                    ? new Date(`${t.last_used_at}Z`).toLocaleString('sv').slice(0, 16) : tr('p_mcp_never')}</span>
                )) : <span>{tr('p_share_tok_none')}</span>}
              </Row>
            )}
            {tok?.i === i && (
              <Row style={{ background: 'var(--dock-info-bg)', flexWrap: 'wrap', gap: 6 }}>
                {tok.made ? <>
                  <span style={{ flex: '1 1 100%' }}>{tr('p_share_tok_once')}</span>
                  <input readOnly value={mcpLine(st, tok.made)} onFocus={(e) => e.target.select()} aria-label={tr('p_share_tok')}
                    style={{ flex: '1 1 320px', fontFamily: 'var(--font-mono)' }} />
                  <button type="button" onClick={() => navigator.clipboard?.writeText(mcpLine(st, tok.made))
                    .then(() => setMsg({ tone: 'ok', text: tr('p_mcp_copied') }), () => setMsg({ tone: 'bad', text: tr('p_mcp_copy_failed') }))}>
                    {tr('p_mcp_copy')}</button>
                  <button type="button" onClick={() => setTok(null)}>{tr('p_mcp_done')}</button>
                </> : <>
                  <span style={{ flex: '1 1 260px' }}>{tr('p_share_tok_explain', st.name)}</span>
                  <label><input type="checkbox" checked={tok.write} onChange={(e) => setTok({ ...tok, write: e.target.checked })} /> {tr('p_mcp_write')}</label>
                  <button type="button" onClick={() => issueTok(st)}>{tr('p_mcp_issue')}</button>
                  <button type="button" onClick={() => setTok(null)}>{tr('p_cancel')}</button>
                </>}
              </Row>
            )}
            <Row className="cols" style={TWO}>
              <span className="sub">{tr('p_share_name')}</span>
              <input value={st.name} onChange={(e) => { const v = e.target.value; edit((s) => { s[i].name = v; return s }) }} />
            </Row>
            <Row>{inSet.length ? inSet.map(card) : <span className="sub">{tr('p_share_empty')}</span>}</Row>
            {!readOnly && inSet.length > 0 && (
              <SetNames set={st} cards={inSet} label={label} two={TWO}
                onSaved={(svcs) => { for (const v of svcs) loadProjects(v); onChanged?.() }} />
            )}
            {/* Admins of every project in the set at once (one per row of a set: n/all). */}
            {/* A project admin sees this on the sets that are wholly theirs (the API decides). */}
            {st.id && Object.keys(st.members || {}).length > 0 && (
              <AdminEditor key={`${st.id}:${JSON.stringify(st.members)}`} setKey={st.id}
                scopes={Object.entries(st.members).map(([svc, proj]) => ({ svc, proj }))} />
            )}
          </Panel>)
        )
      })}

      {zone('out', <Panel title={tr('p_share_outside')} hint={tr('p_share_n', outside.length)} bare style={zoneStyle('out')}>
        <Row>{outside.length ? outside.map(card) : <span className="sub">{tr('p_share_empty')}</span>}</Row>
      </Panel>)}
      </>}
    </>
  )
}

/** The display names of a set's projects (the folder id stays): one by one, or all as
 *  "<service> (<set>)" at once. Saved on Enter or leaving the field. */
function SetNames({ set, cards, label, two, onSaved }) {
  const [draft, setDraft] = useState({})
  const [err, setErr] = useState('')
  const val = (c) => draft[c.key] ?? c.name
  const save = async (list) => {
    const todo = list.filter(([c, v]) => v.trim() && v.trim() !== c.name)
    if (!todo.length) return
    try {
      for (const [c, v] of todo) await launcher.put(`/services/${c.svc}/projects/${c.proj}/name`, { name: v.trim() })
      setErr(''); setDraft({}); onSaved([...new Set(todo.map(([c]) => c.svc))])
    } catch (e) { setErr(e?.response?.data?.detail || tr('p_failed')) }
  }
  const suffix = (set.name || '').trim()
  return (
    <Row className="cols" style={{ ...two, height: 'auto', alignItems: 'start', paddingTop: 6, paddingBottom: 6 }}>
      <span className="sub">{tr('p_share_card_names')}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {cards.map((c) => (
          <input key={c.key} value={val(c)} aria-label={label(c.svc)} title={label(c.svc)} style={{ width: 150 }}
            onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, [c.key]: v })) }}
            onKeyDown={(e) => { if (e.key === 'Enter') save([[c, val(c)]]); if (e.key === 'Escape') setDraft((d) => { const n = { ...d }; delete n[c.key]; return n }) }}
            onBlur={() => save([[c, val(c)]])} />
        ))}
        <button type="button" disabled={!suffix} onClick={() => save(cards.map((c) => [c, `${label(c.svc)} (${suffix})`]))}>
          {tr('p_share_name_all', suffix || '…')}</button>
        {err && <Pill tone="bad">{err}</Pill>}
      </span>
    </Row>
  )
}
