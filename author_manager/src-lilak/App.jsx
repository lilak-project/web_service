/**
 * author manager — the table, its tabs, the selection, and My List's output.
 *
 *   저자 ─────────────────────────────── nameplate (the module's name)
 *   add to my list  clear      [search]  command line — acts on the selection
 *   total │ my list │ affiliation │ groups │ CENS ×   tabs
 *   ☐ # affil. 이름 name │ nm. email …   the head: sticky, and draggable edges
 *   …rows…                               26px each
 *
 * A tab is either a list of AUTHORS (total, my list, or one affiliation/group),
 * a list of CLASSES (the affiliations or the groups themselves), or one record
 * being EDITED. Picking a class opens a tab of its authors; right-clicking any
 * row opens a tab that edits it. Tabs you opened carry an ×.
 *
 * Column widths live in one place (COLS + the `widths` state, remembered), and
 * both the head and every row read the same template — so a column is a column
 * all the way down, whatever the reader drags it to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './rack.css'

// ─── Portal integration (same contract as the rest of the services) ─────────
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''
const PORTAL_PARTS = PORTAL_BASE.split('/').filter(Boolean)
const PORTAL_PROJECT = PORTAL_PARTS.length ? PORTAL_PARTS[PORTAL_PARTS.length - 1] : ''
const MYLIST_KEY = `am.mylist.${PORTAL_PROJECT}`
const WIDTH_KEY = `am.cols.${PORTAL_PROJECT}`

const load = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

function portalToken() {
  try { return localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token') || '' }
  catch { return '' }
}
const authHeaders = () => (portalToken() ? { Authorization: `Bearer ${portalToken()}` } : {})

async function fetchDoc() {
  const r = await fetch(`${PORTAL_BASE}/api/data`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`GET /api/data → ${r.status}`)
  return r.json()
}
/** Whole-document save, version-guarded: 409 means someone else got there first. */
async function putDoc(baseVersion, body) {
  const r = await fetch(`${PORTAL_BASE}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ baseVersion, ...body }),
  })
  if (r.status === 409) return { conflict: true }
  if (!r.ok) throw new Error(`PUT /api/data → ${r.status}`)
  return { doc: await r.json() }
}

// ─── The fields a row shows ─────────────────────────────────────────────────
// A name is spelled in ONE place: nm./last/first/init are worked out from the
// English parts rather than stored, so they cannot drift from `name`.
const korName = (a) => `${a.korFamily || ''}${a.korGiven || ''}`.trim()
const engName = (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
const anyName = (a) => a.nick || korName(a) || engName(a) || '(이름 없음)'
const citeLast = (a) => a.engLast || ''
const citeFirst = (a) => [a.engFirst, a.engMiddle].filter(Boolean).join(' ')
const citeInit = (a) => [a.engFirst, a.engMiddle, a.engLast]
  .filter(Boolean).map((w) => w[0].toUpperCase()).join('')
const citeShort = (a) => {
  if (a.abvName) return a.abvName
  const given = [a.engFirst, a.engMiddle].filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ')
  return a.engLast ? [given, a.engLast].filter(Boolean).join(' ') : ''
}

/** Latest affiliation entry, by its `since` date: who someone is NOW. */
function currentAff(a) {
  const list = (a.affiliations || []).filter((x) => x.tag)
  if (!list.length) return null
  return [...list].sort((x, y) => String(x.since || '').localeCompare(String(y.since || ''))).at(-1)
}
const repEmail = (a) => a.repEmail || currentAff(a)?.email || (a.emails || [])[0] || ''
/** The smallest group `core`: where the author sits in a paper's author list. */
function coreOf(a) {
  const cores = (a.groups || []).map((g) => Number(g.core)).filter((n) => Number.isFinite(n) && n >= 1)
  return cores.length ? Math.min(...cores) : null
}
// An author's affiliation entry keys its affiliation as `tag`; its group entry
// keys the group as `group`. The class records carry `name` (and `shortName`).
const inAff = (a, tag) => (a.affiliations || []).some((x) => x.tag === tag)
const inGrp = (a, name) => (a.groups || []).some((g) => g.group === name)

const D = '·'   // a cell with nothing in it still shows its column

// ─── The columns ────────────────────────────────────────────────────────────
// One list, read by the head and by every row. `min` is as narrow as dragging
// may take it; `drop` is the width below which the column leaves rather than
// the table scrolling sideways.
const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 34, min: 26, fix: true, label: '#' },
  { k: 'affil', w: 96, min: 40, label: 'affiliation' },
  { k: 'kor', w: 86, min: 50, label: '이름' },
  { k: 'name', w: 196, min: 90, label: 'name' },
  { k: 'rule', w: 7, min: 7, fix: true },
  { k: 'nm', w: 112, min: 60, label: 'nm.', drop: 1040 },
  { k: 'email', w: 214, min: 90, label: 'email' },
  { k: 'pos', w: 176, min: 70, label: 'position', drop: 860 },
  { k: 'core', w: 44, min: 34, label: 'core', num: true },
  { k: 'last', w: 100, min: 50, label: 'last', cite: true, drop: 1280 },
  { k: 'first', w: 100, min: 50, label: 'first', cite: true, drop: 1280 },
  { k: 'init', w: 48, min: 34, label: 'init', cite: true, drop: 1280 },
]
const CLS_COLS = [
  { k: 'num', w: 34, min: 26, fix: true, label: '#' },
  { k: 'name', w: 200, min: 80, label: 'name' },
  { k: 'count', w: 70, min: 46, label: 'people', num: true },
  { k: 'full', w: 280, min: 90, label: 'full name' },
]

// ─── The listing rule ───────────────────────────────────────────────────────
// A "나열" button does not produce text: it fills in a TEMPLATE, and the
// template is what produces the text. So a preset is a starting point you can
// then edit — `"{이름}" <{email}>` is a rule, not a button somebody has to
// come and add. The tokens are the column names, which is what the reader
// already has in front of them.
const TOKENS = {
  affiliation: (a) => currentAff(a)?.tag || '',
  이름: (a) => korName(a),
  name: (a) => engName(a),
  'nm.': (a) => citeShort(a),
  email: (a) => repEmail(a),
  position: (a) => currentAff(a)?.position || '',
  core: (a) => coreOf(a) ?? '',
  last: (a) => citeLast(a),
  first: (a) => citeFirst(a),
  init: (a) => citeInit(a),
  nick: (a) => a.nick || '',
}
const fill = (tpl, a) => tpl.replace(/\{([^{}]+)\}/g, (m, k) => {
  const f = TOKENS[k.trim()]
  return f ? String(f(a) ?? '') : m
})
const PRESETS = [
  ['이름 나열', '{이름}'],
  ['full names', '{name}'],
  ['abv. names', '{nm.}'],
  ['email list', '"{이름}" <{email}>'],
]

// ─── Tabs ───────────────────────────────────────────────────────────────────
const FIXED = [
  { id: 'total', kind: 'authors', label: 'total' },
  { id: 'mylist', kind: 'authors', label: 'my list' },
  { id: 'affiliation', kind: 'classes', label: 'affiliation', of: 'affiliation' },
  { id: 'groups', kind: 'classes', label: 'groups', of: 'group' },
]

export default function App() {
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [tabs, setTabs] = useState(FIXED)
  const [active, setActive] = useState('total')
  const [picked, setPicked] = useState(() => new Set())     // selected author ids
  const [query, setQuery] = useState('')
  const [widths, setWidths] = useState(() => load(WIDTH_KEY, {}))
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth))
  const [myList, setMyList] = useState(() => load(MYLIST_KEY, []))
  const [groupForm, setGroupForm] = useState(null)   // the new-group form, when open
  const findRef = useRef(null)
  const lastHit = useRef(null)      // for shift-click: where the range starts

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  useEffect(() => { save(MYLIST_KEY, myList) }, [myList])
  useEffect(() => { save(WIDTH_KEY, widths) }, [widths])
  useEffect(() => {
    const on = () => setVw(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  // One line of status, and it clears itself.
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 4000)
    return () => clearTimeout(t)
  }, [note])
  // ⌘F / Ctrl+F belongs to the table's own search, not the browser's — the
  // browser would only find the rows already painted anyway.
  useEffect(() => {
    const on = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        findRef.current?.focus()
        findRef.current?.select()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const authors = doc?.authors || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

  const cols = useMemo(
    () => COLS.filter((c) => !(c.drop && vw < c.drop)).map((c) => ({ ...c, w: widths[c.k] ?? c.w })),
    [vw, widths])
  const clsCols = useMemo(() => CLS_COLS.map((c) => ({ ...c, w: widths[`c:${c.k}`] ?? c.w })), [widths])
  const drag = useCallback((prefix) => (key, startX, startW) => {
    const move = (e) => {
      const col = [...COLS, ...CLS_COLS].find((c) => c.k === key)
      const w = Math.max(col?.min ?? 34, Math.round(startW + (e.clientX - startX)))
      setWidths((s) => ({ ...s, [prefix + key]: w }))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('am-resizing')
    }
    document.body.classList.add('am-resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  // Which authors this tab is about, before the search narrows them.
  const scope = useMemo(() => {
    if (tab?.kind !== 'authors') return []
    if (tab.id === 'mylist') {
      const order = new Map(myList.map((id, i) => [id, i]))
      return authors.filter((a) => order.has(a.id)).sort((x, y) => order.get(x.id) - order.get(y.id))
    }
    let list = authors
    if (tab.aff) list = list.filter((a) => inAff(a, tab.aff))
    if (tab.grp) list = list.filter((a) => inGrp(a, tab.grp))
    return [...list].sort(byPaperOrder)
  }, [tab, authors, myList])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scope
    return scope.filter((a) => [korName(a), engName(a), a.nick, repEmail(a), currentAff(a)?.tag,
      currentAff(a)?.position, ...(a.groups || []).map((g) => g.group)]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [scope, query])

  const classes = useMemo(() => {
    if (tab?.kind !== 'classes') return []
    const recs = (tab.of === 'affiliation' ? doc?.affiliations : doc?.groups) || []
    return recs.map((r) => ({
      name: r.name,
      full: r.fullName || '',
      count: authors.filter((a) => (tab.of === 'affiliation' ? inAff(a, r.name) : inGrp(a, r.name))).length,
    })).sort((x, y) => x.name.localeCompare(y.name))
  }, [tab, doc, authors])

  // ── tabs ──
  function openTab(t) {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setActive(t.id)
  }
  function closeTab(id) {
    setTabs((ts) => ts.filter((t) => t.id !== id))
    if (active === id) setActive('total')
  }

  // ── the selection ──
  /** Click picks one; shift-click picks everything between it and the last. */
  function hit(i, shift) {
    const from = shift && lastHit.current != null ? lastHit.current : i
    const [lo, hi] = from <= i ? [from, i] : [i, from]
    const span = rows.slice(lo, hi + 1).map((a) => a.id)
    // The row you started from decides: shift-click extends a selection, and
    // a plain click on a picked row unpicks it.
    const turningOn = shift ? true : !picked.has(rows[i].id)
    setPicked((s) => {
      const n = new Set(s)
      span.forEach((id) => (turningOn ? n.add(id) : n.delete(id)))
      return n
    })
    if (!shift) lastHit.current = i
  }
  const allPicked = rows.length > 0 && rows.every((a) => picked.has(a.id))
  const somePicked = rows.some((a) => picked.has(a.id))
  function toggleAll() {
    setPicked((s) => {
      const n = new Set(s)
      if (allPicked) rows.forEach((a) => n.delete(a.id))
      else rows.forEach((a) => n.add(a.id))
      return n
    })
  }
  function addToMyList() {
    if (!picked.size) { setNote('선택된 저자가 없습니다.'); return }
    const fresh = [...picked].filter((id) => !myList.includes(id))
    setMyList((l) => [...l, ...fresh])
    setNote(fresh.length ? `My List에 ${fresh.length}명 담았습니다.` : '이미 다 담겨 있습니다.')
  }

  // ── saving one record ──
  async function commit(patch, said) {
    if (!doc) return
    try {
      const r = await putDoc(doc.version, {
        authors: patch.authors || doc.authors,
        affiliations: patch.affiliations || doc.affiliations,
        groups: patch.groups || doc.groups,
      })
      if (r.conflict) { setNote('다른 사람이 먼저 저장했습니다 — 새로 읽어주세요.'); return }
      setDoc(r.doc)
      setNote(said || '저장했습니다.')
    } catch (e) { setNote(String(e.message || e)) }
  }

  return (
    <div className="am">
      <section className="am-mod">
        <header className="am-bar">
          <b>저자</b>
          <span className="am-n">{doc ? `${authors.length}명` : ''}</span>
          <span className="am-sp" />
          <span className="am-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="am-cmd">
          <button type="button" className="am-btn" onClick={addToMyList}>add to my list</button>
          <button type="button" className="am-btn" disabled={!picked.size}
            onClick={() => { setPicked(new Set()); lastHit.current = null }}>clear</button>
          {picked.size > 0 && <span className="am-n">{picked.size} 선택</span>}
          {tab?.id === 'mylist' && <>
            <span className="am-gap" />
            <button type="button" className="am-btn" disabled={!scope.length}
              onClick={() => setGroupForm((g) => (g ? null : {}))}>make group</button>
            <button type="button" className="am-btn" disabled={!myList.length}
              onClick={() => { setMyList([]); setNote('My List를 비웠습니다.') }}>empty my list</button>
          </>}
          <span className="am-sp" />
          <input ref={findRef} type="search" className="am-find" value={query}
            placeholder="이름 · 이메일 · 소속 · 그룹   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="am-tabs">
          {tabs.map((t) => (
            <span key={t.id} className={`am-tab${t.id === active ? ' on' : ''}`}>
              <button type="button" className="am-tabname" onClick={() => setActive(t.id)}>{t.label}</button>
              {!FIXED.some((f) => f.id === t.id) && (
                <button type="button" className="am-x" title="닫기"
                  onClick={() => closeTab(t.id)} aria-label={`${t.label} 닫기`}>×</button>
              )}
            </span>
          ))}
        </div>

        {err && <p className="am-msg">{err}</p>}
        {!err && !doc && <p className="am-msg">읽는 중…</p>}

        {doc && tab?.kind === 'authors' && (
          <>
            <Table cols={cols} onDrag={drag('')}
              head={{ all: allPicked, some: somePicked, onAll: toggleAll }}>
              {rows.map((a, i) => {
                const cur = currentAff(a)
                const on = picked.has(a.id)
                return (
                  <Row key={a.id || i} cols={cols} className={`am-hit${on ? ' on' : ''}`}
                    onClick={(e) => hit(i, e.shiftKey)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openTab({ id: `edit:${a.id}`, kind: 'edit', label: anyName(a), who: a.id })
                    }}
                    cell={{
                      chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                        aria-label={`${anyName(a)} 선택`} />,
                      num: i + 1,
                      affil: cur?.tag || D,
                      kor: korName(a) || D,
                      name: engName(a) || a.nick || D,
                      nm: citeShort(a) || D,
                      email: repEmail(a) || D,
                      pos: cur?.position || D,
                      core: coreOf(a) ?? D,
                      last: citeLast(a) || D,
                      first: citeFirst(a) || D,
                      init: citeInit(a) || D,
                    }} />
                )
              })}
              {rows.length === 0 && <p className="am-msg">해당하는 저자가 없습니다.</p>}
            </Table>
            {tab.id === 'mylist' && (
              <MyListOut list={scope} doc={doc} say={setNote}
                onDrop={(id) => setMyList((l) => l.filter((x) => x !== id))}
                group={groupForm} setGroup={setGroupForm}
                onMakeGroup={(form) => {
                  const name = String(form.shortName || form.fullName || '').trim()
                  if (!name) { setNote('그룹 이름이 필요합니다.'); return false }
                  if ((doc.groups || []).some((g) => g.name === name)) { setNote('같은 이름의 그룹이 있습니다.'); return false }
                  const ids = new Set(scope.map((a) => a.id))
                  commit({
                    groups: [...(doc.groups || []), { ...form, name, shortName: name }],
                    authors: doc.authors.map((a) => (ids.has(a.id) && !inGrp(a, name)
                      ? { ...a, groups: [...(a.groups || []), { group: name, role: '', core: 10 }] }
                      : a)),
                  }, `'${name}' 그룹 생성 · ${ids.size}명 추가`)
                  return true
                }} />
            )}
          </>
        )}

        {doc && tab?.kind === 'classes' && (
          <Table cols={clsCols} onDrag={drag('c:')}>
            {classes.map((r, i) => (
              <Row key={r.name} cols={clsCols} className="am-hit"
                onClick={() => openTab({
                  id: `${tab.of}:${r.name}`, kind: 'authors', label: r.name,
                  ...(tab.of === 'affiliation' ? { aff: r.name } : { grp: r.name }),
                })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openTab({ id: `editcls:${tab.of}:${r.name}`, kind: 'editcls', label: r.name, of: tab.of, who: r.name })
                }}
                cell={{ num: i + 1, name: r.name, count: r.count, full: r.full || D }} />
            ))}
            {classes.length === 0 && <p className="am-msg">등록된 항목이 없습니다.</p>}
          </Table>
        )}

        {doc && tab?.kind === 'edit' && (
          <EditAuthor author={authors.find((a) => a.id === tab.who)} doc={doc} onSave={commit} />
        )}
        {doc && tab?.kind === 'editcls' && (
          <EditClass name={tab.who} of={tab.of} doc={doc} onSave={commit} />
        )}

        <footer className="am-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위, 오른쪽 클릭으로 편집.'}</span>
          <span className="am-sp" />
          <span className="am-mono">{rows.length ? `${rows.length}줄` : ''}</span>
        </footer>
      </section>
    </div>
  )
}

function byPaperOrder(a, b) {
  const c = (coreOf(a) ?? 99) - (coreOf(b) ?? 99)
  return c !== 0 ? c : (citeShort(a) || engName(a) || anyName(a))
    .localeCompare(citeShort(b) || engName(b) || anyName(b))
}

// ─── The table shell: one template, a sticky head, draggable edges ──────────
function Table({ cols, onDrag, head, children }) {
  const tmpl = `${cols.map((c) => `${c.w}px`).join(' ')} 1fr`
  return (
    <div className="am-tab-body">
      <div className="am-row am-head" style={{ gridTemplateColumns: tmpl }}>
        {cols.map((c) => (
          <span key={c.k}
            className={`${c.k === 'num' ? 'am-gut' : c.k === 'rule' ? 'am-rule' : 'am-c'}`
              + `${c.num ? ' am-num' : ''}${c.cite ? ' am-cite' : ''}${c.k === 'chk' ? ' am-chk' : ''}`}>
            {c.k === 'chk' && head ? (
              <input type="checkbox" checked={head.all}
                ref={(el) => { if (el) el.indeterminate = !head.all && head.some }}
                onChange={head.onAll} aria-label="전체 선택" />
            ) : c.label}
            {!c.fix && <i className="am-grip" onMouseDown={(e) => {
              e.preventDefault(); e.stopPropagation(); onDrag(c.k, e.clientX, c.w)
            }} />}
          </span>
        ))}
        <span className="am-c" />
      </div>
      {children}
    </div>
  )
}

function Row({ cols, cell, className, onClick, onContextMenu }) {
  const tmpl = `${cols.map((c) => `${c.w}px`).join(' ')} 1fr`
  return (
    <div className={`am-row ${className || ''}`} style={{ gridTemplateColumns: tmpl }}
      onClick={onClick} onContextMenu={onContextMenu}>
      {cols.map((c) => (c.k === 'rule'
        ? <i key={c.k} className="am-rule" />
        : (
          <span key={c.k}
            className={`${c.k === 'num' ? 'am-gut' : 'am-c'}`
              + `${c.k === 'chk' ? ' am-chk' : ''}${c.num ? ' am-num' : ''}`
              + `${c.cite ? ' am-cite' : ''}${c.k === 'name' ? ' am-ink' : ''}`
              + `${c.k === 'nm' || c.k === 'email' || c.k === 'init' ? ' am-mono' : ''}`
              + `${c.k === 'affil' || c.k === 'pos' || c.k === 'nm' ? ' am-dim' : ''}`}>
            {cell[c.k]}
          </span>
        )))}
      <span className="am-c" />
    </div>
  )
}

// ─── My List's output: the reason the list exists ───────────────────────────
function MyListOut({ list, doc, onDrop, onMakeGroup, group, setGroup, say }) {
  const [sep, setSep] = useState(', ')
  const [tpl, setTpl] = useState(PRESETS[0][1])
  const [paper, setPaper] = useState(false)   // the LaTeX block is not a template

  /** The LaTeX author block: core order, then a superscript per affiliation. */
  const paperOut = () => {
    const ordered = [...list].sort(byPaperOrder)
    const idx = new Map()
    for (const a of ordered) {
      const tag = currentAff(a)?.tag
      if (tag && !idx.has(tag)) idx.set(tag, idx.size + 1)
    }
    const line = (tag) => {
      const rec = (doc.affiliations || []).find((x) => x.name === tag)
      return rec ? [rec.fullName || rec.name, rec.address].filter(Boolean).join(', ') : tag
    }
    const names = ordered.map((a) => {
      const tag = currentAff(a)?.tag
      return `  ${citeShort(a) || engName(a) || anyName(a)}${tag ? `$^{${idx.get(tag)}}$` : ''}`
    })
    const affs = [...idx.entries()].map(([tag, i]) => `$^{${i}}$ ${line(tag)}\\\\`)
    return `\\author{%\n${names.join(',\n')}\n}\n\n% affiliations\n${affs.join('\n')}`
  }

  // Derived, not stored: editing the rule changes the text under your hands.
  const out = paper ? paperOut()
    : list.map((a) => fill(tpl, a)).filter(Boolean).join(sep.replaceAll('⏎', '\n'))

  async function copy() {
    if (!out) { say('나열할 것이 없습니다.'); return }
    try { await navigator.clipboard.writeText(out); say('복사했습니다.') }
    catch { say('복사 실패 — 직접 선택해 복사하세요.') }
  }

  const none = list.length === 0
  return (
    <div className="am-out">
      {group && (
        <div className="am-rec am-newgrp">
          <span className="am-fl">새 그룹</span>
          <div className="am-fv">
            <input className="am-in" style={{ width: 150 }} placeholder="short name *"
              value={group.shortName || ''} onChange={(e) => setGroup((g) => ({ ...g, shortName: e.target.value }))} />
            <input className="am-in" style={{ width: 240 }} placeholder="full name"
              value={group.fullName || ''} onChange={(e) => setGroup((g) => ({ ...g, fullName: e.target.value }))} />
            <button type="button" className="am-btn am-go"
              onClick={() => { if (onMakeGroup(group)) setGroup(null) }}>save</button>
            <button type="button" className="am-btn" onClick={() => setGroup(null)}>cancel</button>
            <span className="am-hint">My List의 {list.length}명이 이 그룹에 들어갑니다 (core 10).</span>
          </div>
        </div>
      )}

      <div className="am-outbar">
        {PRESETS.map(([label, t]) => (
          <button key={label} type="button" className={`am-btn${!paper && tpl === t ? ' on' : ''}`}
            disabled={none} onClick={() => { setPaper(false); setTpl(t) }}>{label}</button>
        ))}
        <button type="button" className={`am-btn am-go${paper ? ' on' : ''}`} disabled={none}
          onClick={() => setPaper(true)}>paper authors</button>
        <span className="am-sp" />
        <button type="button" className="am-btn" disabled={!out} onClick={copy}>copy</button>
      </div>

      {/* The rule itself, editable. The tokens are the column names. */}
      <div className="am-rule-line">
        <span className="am-hint">나열 규칙</span>
        <input className="am-in am-mono" style={{ flex: 1, minWidth: 180 }} value={tpl}
          disabled={paper} onChange={(e) => { setPaper(false); setTpl(e.target.value) }} />
        <span className="am-hint">사이</span>
        <input className="am-in am-mono" style={{ width: 66 }} value={sep} disabled={paper}
          onChange={(e) => setSep(e.target.value)} title="구분기호" />
        <button type="button" className="am-btn" title="줄바꿈 추가" disabled={paper}
          onClick={() => setSep((v) => `${v}⏎`)}>+⏎</button>
      </div>
      <div className="am-tokens">
        {Object.keys(TOKENS).map((k) => (
          <button key={k} type="button" className="am-tok" disabled={paper}
            onClick={() => { setPaper(false); setTpl((v) => `${v}{${k}}`) }}>{`{${k}}`}</button>
        ))}
      </div>

      <textarea className="am-outbox" value={out} readOnly
        placeholder={none ? 'My List가 비어 있습니다 — 표에서 고르고 add to my list.' : ''} />
      {!none && (
        <div className="am-outbar am-outfoot">
          <span className="am-hint">My List {list.length}명 — ×로 한 명씩 뺍니다.</span>
          <span className="am-sp" />
          {list.map((a) => (
            <span key={a.id} className="am-chip">
              {citeShort(a) || anyName(a)}
              <button type="button" className="am-x" title="빼기"
                onClick={() => onDrop(a.id)} aria-label={`${anyName(a)} 빼기`}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Fld({ label, children }) {
  return (<><span className="am-fl">{label}</span><div className="am-fv">{children}</div></>)
}

function EditAuthor({ author, doc, onSave }) {
  const [f, setF] = useState(author || {})
  useEffect(() => { setF(author || {}) }, [author])
  if (!author) return <p className="am-msg">그 저자를 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const cur = currentAff(f) || {}
  // The current affiliation is the last entry by date; editing it edits THAT
  // entry rather than adding a new one.
  const setAff = (k) => (e) => setF((s) => {
    const list = [...(s.affiliations || [])]
    if (!list.length) list.push({ tag: '', position: '', email: '', since: '' })
    const latest = [...list].sort((x, y) =>
      String(x.since || '').localeCompare(String(y.since || ''))).at(-1)
    const i = list.indexOf(latest)
    list[i] = { ...list[i], [k]: e.target.value }
    return { ...s, affiliations: list }
  })
  return (
    <div className="am-tab-body">
      <div className="am-rec">
        <Fld label="한글 이름">
          <input className="am-in" style={{ width: 90 }} value={f.korFamily || ''} onChange={set('korFamily')} placeholder="성" />
          <input className="am-in" style={{ width: 120 }} value={f.korGiven || ''} onChange={set('korGiven')} placeholder="이름" />
        </Fld>
        <Fld label="English">
          <input className="am-in" style={{ width: 130 }} value={f.engFirst || ''} onChange={set('engFirst')} placeholder="first" />
          <input className="am-in" style={{ width: 110 }} value={f.engMiddle || ''} onChange={set('engMiddle')} placeholder="middle" />
          <input className="am-in" style={{ width: 140 }} value={f.engLast || ''} onChange={set('engLast')} placeholder="last" />
        </Fld>
        <Fld label="별명">
          <input className="am-in" style={{ width: 200 }} value={f.nick || ''} onChange={set('nick')} />
        </Fld>
        <Fld label="줄임 이름">
          <input className="am-in am-mono" style={{ width: 160 }} value={f.abvName || ''} onChange={set('abvName')}
            placeholder={citeShort({ ...f, abvName: '' }) || 'J. W. Lee'} />
          <span className="am-hint">비우면 영문 이름에서 만듭니다.</span>
        </Fld>
        <Fld label="대표 email">
          <input className="am-in am-mono" style={{ width: 260 }} value={f.repEmail || ''} onChange={set('repEmail')}
            placeholder={repEmail(author) || 'name@ibs.re.kr'} />
        </Fld>
        <Fld label="현재 소속">
          <input className="am-in" style={{ width: 110 }} value={cur.tag || ''} onChange={setAff('tag')} placeholder="affil." />
          <input className="am-in" style={{ width: 200 }} value={cur.position || ''} onChange={setAff('position')} placeholder="position" />
          <input className="am-in am-mono" style={{ width: 90 }} value={cur.since || ''} onChange={setAff('since')} placeholder="2020-01" />
        </Fld>
        <Fld label="그룹">
          <span className="am-hint">
            {(f.groups || []).length
              ? (f.groups || []).map((g) => `${g.group}${g.core ? ` (core ${g.core})` : ''}`).join(' · ')
              : '없음'} — 아직 여기서 고칠 수 없습니다.
          </span>
        </Fld>
        <Fld label="">
          <button type="button" className="am-btn am-go"
            onClick={() => onSave({ authors: doc.authors.map((a) => (a.id === f.id ? f : a)) })}>save</button>
          <button type="button" className="am-btn" onClick={() => setF(author)}>revert</button>
        </Fld>
      </div>
    </div>
  )
}

function EditClass({ name, of, doc, onSave }) {
  const key = of === 'affiliation' ? 'affiliations' : 'groups'
  const rec = (doc[key] || []).find((r) => r.name === name)
  const [f, setF] = useState(rec || { name })
  useEffect(() => { setF(rec || { name }) }, [name, rec])
  if (!rec) return <p className="am-msg">그 {of === 'affiliation' ? '소속을' : '그룹을'} 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  return (
    <div className="am-tab-body">
      <div className="am-rec">
        <Fld label="이름">
          {/* name is what the authors point at, shortName is what the record
              shows: they are the same string, so they move together. */}
          <input className="am-in" style={{ width: 220 }} value={f.name || ''}
            onChange={(e) => setF((s) => ({ ...s, name: e.target.value, shortName: e.target.value }))} />
          <span className="am-hint">고치면 이 이름을 쓰는 저자들도 같이 고쳐집니다.</span>
        </Fld>
        <Fld label="full name">
          <input className="am-in" style={{ width: 360 }} value={f.fullName || ''} onChange={set('fullName')} />
        </Fld>
        {of === 'affiliation' ? (
          <Fld label="주소 · 전화">
            <input className="am-in" style={{ width: 360 }} value={f.address || ''} onChange={set('address')} placeholder="address" />
            <input className="am-in am-mono" style={{ width: 150 }} value={f.phone || ''} onChange={set('phone')} placeholder="phone" />
          </Fld>
        ) : (
          <Fld label="설명 · 기간">
            <input className="am-in" style={{ width: 300 }} value={f.description || ''} onChange={set('description')} placeholder="description" />
            <input className="am-in am-mono" style={{ width: 110 }} value={f.creationDate || ''} onChange={set('creationDate')} placeholder="2025-01-01" />
            <input className="am-in am-mono" style={{ width: 110 }} value={f.endDate || ''} onChange={set('endDate')} placeholder="end" />
          </Fld>
        )}
        <Fld label="">
          <button type="button" className="am-btn am-go" onClick={() => {
            const renamed = f.name !== rec.name
            const recs = (doc[key] || []).map((r) => (r.name === rec.name ? f : r))
            const authors = renamed
              ? doc.authors.map((a) => ({
                ...a,
                affiliations: of === 'affiliation'
                  ? (a.affiliations || []).map((x) => (x.tag === rec.name ? { ...x, tag: f.name } : x))
                  : a.affiliations,
                groups: of === 'group'
                  ? (a.groups || []).map((g) => (g.group === rec.name ? { ...g, group: f.name } : g))
                  : a.groups,
              }))
              : doc.authors
            onSave({ [key]: recs, authors })
          }}>save</button>
          <button type="button" className="am-btn" onClick={() => setF(rec)}>revert</button>
        </Fld>
      </div>
    </div>
  )
}
