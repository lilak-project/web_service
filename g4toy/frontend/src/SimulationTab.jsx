import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import Viewer from './Viewer.jsx'
import Session from './Session.jsx'
import { fetchJobScene, sessionScene } from './api.js'

const JOB_ID = new URLSearchParams(location.search).get('job')
const EMPTY_EVENT = { tracks: [], edep: [], meta: { n_events: 0, n_points: 0, energy_max: 0 } }
const swatch = (c) => (c ? `rgb(${c.map((v) => Math.round(v * 255)).join(',')})` : '#888')

export default function SimulationTab() {
  const [geometry, setGeometry] = useState([])
  const [event, setEvent] = useState(EMPTY_EVENT)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [show, setShow] = useState({ tracks: true, edep: true, axes: true, pointSize: 2.0 })
  const [hidden, setHidden] = useState(() => new Set())
  const [collapsed, setCollapsed] = useState(() => new Set())   // volume tree nodes
  const [cards, setCards] = useState({ session: false, volumes: false, display: false })
  const controlsRef = useRef(null)
  const geomSigRef = useRef('')

  function applyScene(s) {
    const sig = s.geometry.map((g) => g.id).join('|')
    if (sig !== geomSigRef.current) {
      geomSigRef.current = sig
      setHidden(new Set(s.geometry.filter((g) => g.visible === false).map((g) => g.id)))
      const cnt = {}
      for (const g of s.geometry) {
        if (g.group) cnt['g:' + g.group] = 1
        const nk = 'n:' + g.group + '/' + g.name
        cnt[nk] = (cnt[nk] || 0) + 1
      }
      setCollapsed(new Set(Object.entries(cnt)
        .filter(([k, c]) => k.startsWith('g:') || c > 1).map(([k]) => k)))
      setGeometry(s.geometry)
    }
    setEvent({ tracks: s.tracks, edep: s.edep, meta: s.meta })
    setLoaded(true)
  }

  useEffect(() => {
    if (JOB_ID) {
      fetchJobScene(JOB_ID).then(applyScene).catch((e) => setError(String(e.message || e)))
      return
    }
    let alive = true
    const tick = async () => {
      try { const s = await sessionScene(); if (alive) applyScene(s) }
      catch (e) { if (alive && e.status === 409 && !geomSigRef.current) setLoaded(false) }
    }
    tick()
    const t = setInterval(tick, 1200)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const groups = useMemo(() => {
    const m = new Map()
    for (const g of geometry) {
      if (!m.has(g.group)) m.set(g.group, new Map())
      const nm = m.get(g.group)
      if (!nm.has(g.name)) nm.set(g.name, [])
      nm.get(g.name).push({ id: g.id, copy: g.copy, color: g.color })
    }
    return m
  }, [geometry])

  const allIds = useMemo(() => geometry.map((g) => g.id), [geometry])
  const toggle = (k) => setShow((s) => ({ ...s, [k]: !s[k] }))
  const toggleIds = (ids) => setHidden((h) => {
    const n = new Set(h)
    const allHidden = ids.every((i) => n.has(i))
    ids.forEach((i) => (allHidden ? n.delete(i) : n.add(i)))
    return n
  })
  const soloIds = (ids) => setHidden(new Set(allIds.filter((i) => !ids.includes(i))))
  const showAll = () => setHidden(new Set())
  const allHidden = (ids) => ids.every((i) => hidden.has(i))
  const isCol = (k) => collapsed.has(k)
  const toggleCol = (k) =>
    setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n })
  const toggleCard = (k) => setCards((c) => ({ ...c, [k]: !c[k] }))

  function renderName(grp, name, items, indent) {
    const ids = items.map((x) => x.id)
    if (items.length === 1) {
      return <Row key={name} indent={indent} color={items[0].color} label={name}
        hidden={hidden.has(ids[0])} onToggle={() => toggleIds(ids)} onSolo={() => soloIds(ids)} />
    }
    const nk = 'n:' + grp + '/' + name
    return (
      <div className="vgroup" key={name}>
        <div className={`vghead ${indent ? 'indent' : ''}`}>
          <button className="caret" onClick={() => toggleCol(nk)}>{isCol(nk) ? '▸' : '▾'}</button>
          <button className={`tg ${allHidden(ids) ? '' : 'on'}`}
            onClick={() => toggleIds(ids)} title="show/hide all copies">
            <span className="box" style={{ '--c': swatch(items[0].color) }} />
            <span className="vname">{name}</span><span className="vtype">×{items.length}</span>
          </button>
        </div>
        {!isCol(nk) && items.map((it) => (
          <Row key={it.id} indent={(indent || 0) + 1} color={it.color} label={`#${it.copy}`}
            hidden={hidden.has(it.id)} onToggle={() => toggleIds([it.id])} onSolo={() => soloIds([it.id])} />
        ))}
      </div>
    )
  }

  const hasScene = loaded && (geometry.length > 0 || event.tracks.length > 0)

  return (
    <div className="stage">
      {hasScene ? (
        <Viewer geometry={geometry} event={event} show={show}
          hidden={hidden} controlsRef={controlsRef} />
      ) : (
        <div className="placeholder">
          {error ? `⚠ ${error}` : JOB_ID ? 'loading…'
            : 'session 카드에서 nptool 시뮬레이션을 실행하세요.'}
        </div>
      )}

      <div className="dock">
        <Card title="session" open={!cards.session} onToggle={() => toggleCard('session')}>
          <Session />
        </Card>

        {geometry.length > 0 && (
          <Card title={`volumes (${geometry.length})`} open={!cards.volumes}
            onToggle={() => toggleCard('volumes')}
            extra={<button className="mini" onClick={showAll}>all on</button>}>
            <div className="vollist">
              {[...groups.entries()].map(([grp, names]) =>
                grp === ''
                  ? [...names.entries()].map(([name, items]) => renderName('', name, items, 0))
                  : (() => {
                      const gk = 'g:' + grp
                      const gids = [...names.values()].flat().map((x) => x.id)
                      return (
                        <div className="vgroup" key={grp}>
                          <div className="vghead">
                            <button className="caret" onClick={() => toggleCol(gk)}>
                              {isCol(gk) ? '▸' : '▾'}</button>
                            <button className={`tg ${allHidden(gids) ? '' : 'on'}`}
                              onClick={() => toggleIds(gids)} title="show/hide group">
                              <span className="box" />
                              <span className="vname">{grp}</span>
                              <span className="vtype">{gids.length}</span>
                            </button>
                          </div>
                          {!isCol(gk) && [...names.entries()].map(([name, items]) =>
                            renderName(grp, name, items, 1))}
                        </div>
                      )
                    })(),
              )}
            </div>
          </Card>
        )}

        <Card title="display" open={!cards.display} onToggle={() => toggleCard('display')}>
          <Toggle on={show.tracks} onClick={() => toggle('tracks')}>tracks</Toggle>
          <Toggle on={show.edep} onClick={() => toggle('edep')}>energy pts</Toggle>
          <Toggle on={show.axes} onClick={() => toggle('axes')}>axes</Toggle>
          <label className="slider">point size
            <input type="range" min="0.5" max="5" step="0.5" value={show.pointSize}
              onChange={(e) => setShow((s) => ({ ...s, pointSize: +e.target.value }))} />
          </label>
          <div className="btns">
            <button className="reload" onClick={() => controlsRef.current?.reset()}>⌂ reset view</button>
            <button className="reload"
              onClick={() => (JOB_ID ? fetchJobScene(JOB_ID) : sessionScene()).then(applyScene).catch(() => {})}>
              reload</button>
          </div>
        </Card>
      </div>

      {hasScene && (
        <div className="hud">
          <span>{JOB_ID ? `job ${JOB_ID.slice(0, 8)}` : 'live'}</span>
          <span>{event.meta.n_events} ev</span>
          <span>{event.tracks.length} trk</span>
          <span>{event.meta.n_points.toLocaleString()} pts</span>
        </div>
      )}

      <div className="legend">
        <span>energy</span><i className="ramp" />
        <span className="lo">low</span><span className="hi">high</span>
      </div>
    </div>
  )
}

function Card({ title, extra, open, onToggle, children }) {
  return (
    <div className={`card ${open ? '' : 'closed'}`}>
      <div className="chead" onClick={onToggle}>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className="ctitle">{title}</span>
        <span className="cextra" onClick={(e) => e.stopPropagation()}>{extra}</span>
      </div>
      {open && <div className="cbody">{children}</div>}
    </div>
  )
}

function Toggle({ on, onClick, children }) {
  return (
    <button className={`tg ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="box" />{children}
    </button>
  )
}

function Row({ color, label, hidden, onToggle, onSolo, indent }) {
  return (
    <div className={`vol ${indent ? 'indent' + Math.min(indent, 2) : ''}`}>
      <button className={`tg ${hidden ? '' : 'on'}`} onClick={onToggle} title="show/hide">
        <span className="box" style={{ '--c': swatch(color) }} />
        <span className="vname">{label}</span>
      </button>
      <button className="solo" title="solo this volume" onClick={onSolo}>◎</button>
    </div>
  )
}
