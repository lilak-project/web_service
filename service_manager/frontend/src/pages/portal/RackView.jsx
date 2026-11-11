import { useEffect, useRef, useState } from 'react'
import { tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Row, Pill } from './Field'

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

function Swatch({ color }) {
  return <span style={{ width: 10, height: 10, flex: 'none', background: color || 'var(--dock-border-strong)' }} />
}

export default function RackView({ tab, bands = [], onGo, onChanged }) {
  const { lang } = useLang()

  const groups = bands
    .map((b) => ({ g: b.g, items: b.items.filter(isRack) }))
    .filter((b) => b.items.length)
  // A service split into project cards is still one service here.
  const services = [...new Map(groups.flatMap((b) => b.items).map((s) => [s.name, s])).values()]
  const byName = Object.fromEntries(services.map((s) => [s.name, s]))
  const cardOf = (svc, proj) => groups.flatMap((b) => b.items).find((c) => c.name === svc && c.project_card === proj)
  const label = (svc) => { const s = byName[svc]; return s ? (s.service_label || s.labels?.[lang] || s.label || s.name) : svc }

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

  const edit = (fn) => { setSets((old) => fn(structuredClone(old))); setDirty(true); setMsg(null) }
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
  const toggle = (k) => { setMsg(null); setPicked((old) => { const n = new Set(old); if (n.has(k)) n.delete(k); else n.add(k); return n }) }
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
      onDrop={(e) => { e.preventDefault(); drop(at) }}>
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
      .then(() => { setStored(true); if (latest.current === sent) setDirty(false); setMsg({ tone: 'ok', text: tr('p_share_saved') }) })
      .catch((e) => setMsg({ tone: 'bad', text: errText(e) })), 600)
    return () => clearTimeout(t)
  }, [sets, dirty])
  // Leaving the tab inside that moment must not lose the last move.
  const unsaved = useRef(false)
  unsaved.current = dirty
  useEffect(() => () => {
    if (unsaved.current) launcher.put('/share-sets', { sets: latest.current }).catch(() => {})
  }, [])

  // A set's projects as a sidebar group: the group already holding most of them
  // gets the rest; with none, a new group named after the set. A card sits in one
  // group, so a service whose one card another group holds is `taken`: only
  // splitting it into project cards can bring this set's project over.
  const groupFor = (st) => {
    const names = Object.entries(st.members || {}).map(([svc, proj]) => (byName[svc]?.project_card ? `${svc}/${proj}` : svc))
    const own = bands.filter((b) => b.g && !b.g.fixed && !b.g.loose)
      .map((b) => ({ g: b.g, mem: b.g.members || b.items.map(keyOf) }))
    let best = null, n = 0
    for (const o of own) {
      const k = names.filter((x) => o.mem.includes(x)).length
      if (k > n) { best = o; n = k }
    }
    const out = names.filter((x) => !best?.mem.includes(x))
    const taken = out.filter((x) => !x.includes('/') && own.some((o) => o !== best && o.mem.includes(x)))
    return { g: best?.g, mem: best?.mem || [], missing: out.filter((x) => !taken.includes(x)), taken }
  }
  const [asking, setAsking] = useState(null)   // index of the set whose "split them?" is open
  const toGroup = async (st, split) => {
    const { g, mem, missing, taken } = groupFor(st)
    setAsking(null)
    try {
      // One at a time: each rewrites the same two files.
      if (split) for (const svc of taken) await launcher.put('/admin/home-service', { name: svc, split: true })
      const add = [...missing, ...(split ? taken.map((svc) => `${svc}/${st.members[svc]}`) : [])]
      if (g) await launcher.put(`/admin/service-groups/${g.id}`, { members: [...mem, ...add] })
      else await launcher.post('/admin/service-groups', { name: st.name, members: add })
      setMsg({ tone: 'ok', text: g ? tr('p_share_group_updated', g.name) : tr('p_share_group_made', st.name) })
      onChanged?.()
    } catch (e) { setMsg({ tone: 'bad', text: errText(e) }) }
  }
  const reset = () => launcher.delete('/share-sets')
    .then((r) => { take(r.data); setMsg({ tone: 'ok', text: tr('p_share_reset_done') }) })
    .catch((e) => setMsg({ tone: 'bad', text: errText(e) }))

  const slot = twoOfOne ? { tone: 'warn', text: tr('p_share_two_of_one') }
    : msg || (picked.size ? { text: tr('p_share_picked', picked.size) } : { tone: 'hint', text: tr('p_share_pick_hint') })
  const TWO = { gridTemplateColumns: 'minmax(140px, 200px) 1fr' }
  const MAP_COLS = { gridTemplateColumns: 'minmax(120px, 1.2fr) minmax(100px, 1fr) 56px 72px minmax(90px, 1fr)' }

  return (
    <>
      {/* Service by service, not by sidebar group: one list, each service with all
          its projects. A service split into project cards is listed whole. */}
      {tab === 'map' && [{ g: null, items: services.map((s) => (s.project_card ? { ...s, project_card: null } : s)) }].map(({ g, items }) => {
        const nproj = items.reduce((n, s) => n + (s.multi_project && !s.project_card ? (s.projects_count || 0) : 1), 0)
        return (
          <Panel key={g?.id || '@all'} title={g?.name || tr('p_map_all')}
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
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <Swatch color={s.color} />
                  <span style={{ overflowWrap: 'anywhere' }}>{label(s.name)}</span>
                  {s.hidden && <Pill>{tr('p_map_hidden')}</Pill>}
                  {s.multi_project && (
                    <button type="button" className="set-plain" title={tr('p_map_new_project')}
                      onClick={() => setAdding(adding?.at === at ? null : { svc: s.name, at, name: '' })}
                      style={{ marginLeft: 'auto', flex: 'none', padding: '0 6px', font: 'inherit', cursor: 'pointer', lineHeight: 1.4,
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
              const note = !s.multi_project ? tr('p_map_single') : list === undefined ? '…'
                : list === null ? tr('p_map_load_failed') : list.length === 0 ? tr('p_map_no_projects') : null
              if (note) {
                return [(
                  <Row key={at} className="cols" style={MAP_COLS}>
                    {head}<span className="sub">{note}</span><span /><span /><span />
                  </Row>
                ), addRow]
              }
              return [...list.map((p, n) => {
                const k = setOf(s.name, p.name)
                return (
                  <Row key={`${s.name}/${p.name}`} className="cols" style={MAP_COLS}>
                    {n === 0 ? head : <span />}
                    <span style={{ overflowWrap: 'anywhere' }}>{p.label || p.name}</span>
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
                )
              }), addRow]
            })}
          </Panel>
        )
      })}

      {tab === 'sets' && <>
      <Panel title={tr('p_share_sets')} hint={stored ? tr('p_share_stored') : tr('p_share_default')} bare
        right={(
          <span style={{ display: 'flex', gap: 6 }}>
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
          <button type="button" disabled={!pickedInSet} onClick={() => takeOut()}>{tr('p_share_take_out')}</button>
          <button type="button" disabled={!picked.size} onClick={() => setPicked(new Set())}>{tr('p_share_clear')}</button>
        </Row>
      </Panel>

      {(sets || []).map((st, i) => {
        const inSet = cards.filter((c) => st.members?.[c.svc] === c.proj)
        return (
          zone(i, <Panel title={st.name} hint={tr('p_share_n', inSet.length)} bare style={zoneStyle(i)}
            right={(
              <span style={{ display: 'flex', gap: 6 }}>
                {(() => {
                  const { g, missing, taken } = groupFor(st)
                  return (
                    <button type="button" disabled={!missing.length && !taken.length}
                      title={g && !missing.length && !taken.length ? tr('p_share_group_same', g.name) : undefined}
                      onClick={() => { if (taken.length) setAsking(asking === i ? null : i); else toGroup(st, false) }}>
                      {g ? tr('p_share_group_update', g.name) : tr('p_share_group_make')}
                    </button>
                  )
                })()}
                <button type="button" disabled={!picked.size || twoOfOne} onClick={() => moveHere(i)}>{tr('p_share_move_here')}</button>
                <button type="button" onClick={() => edit((s) => s.filter((_, k) => k !== i))}>{tr('p_share_delete_set')}</button>
              </span>
            )}>
            {asking === i && (() => {
              const { missing, taken } = groupFor(st)
              return (
                <Row style={{ background: 'var(--dock-info-bg)' }}>
                  <span style={{ flex: '1 1 260px' }}>{tr('p_share_split_ask', taken.map(label).join(', '))}</span>
                  <button type="button" onClick={() => toGroup(st, true)}>{tr('p_share_split_yes')}</button>
                  {missing.length > 0 && <button type="button" onClick={() => toGroup(st, false)}>{tr('p_share_split_no')}</button>}
                  <button type="button" onClick={() => setAsking(null)}>{tr('p_cancel')}</button>
                </Row>
              )
            })()}
            <Row className="cols" style={TWO}>
              <span className="sub">{tr('p_share_name')}</span>
              <input value={st.name} onChange={(e) => { const v = e.target.value; edit((s) => { s[i].name = v; return s }) }} />
            </Row>
            <Row>{inSet.length ? inSet.map(card) : <span className="sub">{tr('p_share_empty')}</span>}</Row>
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
