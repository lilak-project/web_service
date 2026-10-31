import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { Panel, Row, Pill } from './Field'
import StoreView from './StoreView'

const cardKey = (c) => (c.builtin ? '@' + c.builtin : c.name)

/**
 * HomeView — what the panel shows when nothing is open: a search first, the
 * last things this account opened, then every app and project in one table.
 * One press anywhere here opens the thing, no list in the bar to go through.
 *
 * Rows follow the bar's order (cards arrive in it). Projects come from each
 * multi-project service's own list, so the per-project grants are the ones
 * the bar already uses.
 */
export default function HomeView({ cards, groups, recent, onOpen, isManager, storeOpen, onRefresh }) {
  const [store, setStore] = useState(!!storeOpen)
  const apps = useMemo(() => (cards || []).filter((c) => !c.builtin && !c.hidden), [cards])
  const groupOf = useMemo(() => {
    const m = {}
    for (const g of groups || []) for (const k of g.members || []) m[k] = g
    return m
  }, [groups])
  const shown = apps.filter((c) => !groupOf[cardKey(c)]?.hidden)

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
    const base = { svc: c, app: c.label || c.name, group: groupOf[cardKey(c)]?.name || '' }
    if (!c.multi_project) rows.push({ ...base, key: c.name, proj: '', running: !!c.running, enter: c.can_enter !== false })
    else for (const p of projs[c.name] || []) {
      rows.push({ ...base, key: `${c.name}/${p.name}`, proj: p.name, label: p.label, running: !!p.running, enter: !!p.can_enter })
    }
  }

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

  const byKey = new Map(rows.map((r) => [r.key, r]))
  const recents = (recent || []).map((k) => byKey.get(k)).filter(Boolean)

  const open = (r) => onOpen(r.svc, r.proj)
  const inputRef = useRef(null)
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
  const swatch = (c) => <span className="pl-hsw" style={{ background: c.color || 'var(--text-secondary)' }} />

  return (
    <div className="pl-scroll pl-mgpage pl-home">
      <div className="pl-hsearch">
        <label>
          <Icon name="search" size={18} color="var(--text-secondary)" />
          <input ref={inputRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            aria-label={tr('p_home_search')} placeholder={tr('p_home_search')} />
        </label>
        <span className="hint">{tr('p_home_keys')}</span>
      </div>

      {!words.length && recents.length > 0 && (
        <section className="pl-hrecent">
          <h2>{tr('p_home_recent')}</h2>
          <div className="grid">
            {recents.map((r) => (
              <button key={r.key} type="button" className="pl-hrc" onClick={() => open(r)}>
                <span className="strip" style={{ background: r.svc.color || 'var(--text-secondary)' }} />
                <span className="name">{r.proj || r.app}</span>
                <span className="app">{r.proj ? r.app : r.group}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <Panel title={words.length ? tr('p_home_found', hits.length) : tr('p_home_all')}
        hint={words.length ? null : tr('p_home_count', rows.length)} bare>
        <Row className="cols pl-hrow head">
          <span>{tr('p_home_app')}</span><span>{tr('p_home_proj')}</span>
          <span>{tr('p_home_group')}</span><span>{tr('p_home_state')}</span><span />
        </Row>
        {hits.map((r, i) => (
          <Row key={r.key} className={`cols pl-hrow${words.length && i === at ? ' at' : ''}`}>
            <span className="app">{swatch(r.svc)}{r.app}</span>
            <span className="mono">{r.proj || '—'}{r.label && <span className="sub"> {r.label}</span>}</span>
            <span className="sub">{r.group || '—'}</span>
            <span>{state(r)}</span>
            <button type="button" onClick={() => open(r)}>{tr('p_home_open')}</button>
          </Row>
        ))}
        {!hits.length && <Row className="empty">{tr('p_home_none')}</Row>}
      </Panel>

      {/* What used to be the Service Manager card: installing is occasional,
          so it waits folded at the foot of a manager's home. */}
      {isManager && (
        <section className="pl-hmanage">
          <button type="button" className={`pl-hfold${store ? ' open' : ''}`} aria-expanded={store}
            onClick={() => setStore((o) => !o)}>
            <Icon name="caret-right" size={12} />
            {tr('p_home_store')}
          </button>
          {store && <StoreView onChanged={onRefresh} />}
        </section>
      )}
    </div>
  )
}
