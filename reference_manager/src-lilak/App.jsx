/**
 * reference manager — the same table author_manager is, about papers.
 *
 *   레퍼런스 ──────────────────────────── nameplate (the module's name)
 *   add to my list  clear      [search]  command line — acts on the selection
 *   total │ journals │ tags │ SpiRIT ×          tabs
 *   ☐ # type citeKey year jl title …    the head: sticky, draggable edges
 *   …rows…                              26px each
 *
 * A tab is either a list of REFERENCES (total, or one journal's or one tag's),
 * or a list of the JOURNALS / TAGS themselves. Picking one opens a tab of its
 * papers; tabs you opened carry an ×.
 *
 * The table, the tabs, the selection and the portal's document are the kit's
 * `racklist`, shared with author_manager. What is here is what makes this one
 * about PAPERS: the columns, the accessors behind them, and the listing tokens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs,
  useColumnWidths, useViewportWidth, useSelection, useFindKey, useNote, useViewState,
  bySome, fill as fillTpl, facetOf, passesFilter,
  PORTAL_PROJECT, projectKey, load, save, isManager, fetchDoc,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'

const WIDTH_KEY = projectKey('rm', 'cols')
const VIEW_KEY = projectKey('rm', 'view')
const IS_ADMIN = isManager()

// ─── The fields a row shows ─────────────────────────────────────────────────
// A paper is spelled in ONE place: the short reference, the first author and
// the journal's abbreviation are worked out from the parts, so they cannot
// drift from what is stored. (The spreadsheet kept all three in columns of
// their own, and they did.)
const AUTHOR_SPLIT = /\s+and\s+/i
const authorList = (r) => String(r.author || '').split(AUTHOR_SPLIT).map((s) => s.trim()).filter(Boolean)
const firstAuthor = (r) => authorList(r)[0] || ''
const etAl = (r) => {
  const list = authorList(r)
  return list.length > 1 ? `${list[0]} et al.` : (list[0] || '')
}
/** A journal is referenced by its record `name`; the table shows the short one. */
const journalRec = (doc, r) => (doc?.journals || []).find((j) => j.name === r.journal) || null
const jShort = (doc, r) => journalRec(doc, r)?.shortName || r.journal || ''
// A journal carries three names: what it is called, the short one a table can
// hold (ApJ) and the one a citation uses (Astrophys. J.).
const jAbbrev = (doc, r) => journalRec(doc, r)?.abbrev || journalRec(doc, r)?.name || r.journal || ''
const shortRef = (doc, r) => [
  etAl(r), [jAbbrev(doc, r), r.volume, r.pages].filter(Boolean).join(' '),
].filter(Boolean).join(', ') + (r.year ? ` (${r.year})` : '')

// A paper points at ONE journal and carries any number of tags. A topic set
// (tpc, 12c) and a collaboration (SpiRIT, LIGO_Virgo) were classes of their own
// at first, but nothing distinguished them from a tag: same many-to-many, no
// fields of their own, nothing to edit. They are tags.
const tagsOf = (r) => (r.tags || []).filter(Boolean)
const inTag = (r, t) => tagsOf(r).includes(t)
const inJrn = (r, name) => r.journal === name
/** Papers this one lists, and papers that list it — one is stored, the other
 *  is counted, because storing both is two places to disagree. */
const citesOf = (r) => (r.cites || []).filter((c) => c && (c.ref || c.raw))
const linkedCites = (r) => citesOf(r).filter((c) => c.ref)

const D = '·'   // a cell with nothing in it still shows its column

// ─── The columns ────────────────────────────────────────────────────────────
// `min` is as narrow as dragging may take it; `drop` is the width below which
// the column leaves rather than the table scrolling sideways.
const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'type', w: 56, min: 40, label: 'type', drop: 1180 },
  { k: 'citeKey', w: 186, min: 90, label: 'cite key' },
  { k: 'year', w: 46, min: 38, label: 'year', num: true },
  { k: 'jl', w: 64, min: 40, label: 'jl' },
  { k: 'title', w: 330, min: 120, label: 'title' },
  { k: 'a1', w: 134, min: 70, label: 'first author', drop: 1040 },
  { k: 'tags', w: 180, min: 60, label: 'tags', drop: 1320 },
  { k: 'cites', w: 44, min: 34, label: 'cites', num: true, drop: 860 },
  { k: 'by', w: 44, min: 34, label: 'cited by', num: true, drop: 860 },
]
const CLS_COLS = [
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'name', w: 200, min: 80, label: 'name' },
  { k: 'count', w: 70, min: 46, label: 'papers', num: true },
  { k: 'full', w: 320, min: 90, label: 'full name' },
]
/** Which columns are the record's own words (ink) and which are about it (dim). */
const TONE = { title: 'ink', type: 'dim', jl: 'dim', a1: 'dim', tags: 'dim' }

// ─── The listing rule ───────────────────────────────────────────────────────
// A preset fills in a TEMPLATE and the template makes the text, so a shape
// nobody thought of is an edit rather than a feature request. The tokens are
// the column names plus the parts a citation needs.
// BibTeX composes without help: the outer braces are literal and only the
// inner {token} is a token — `author = {{author}}` → `author = {J. Almeid …}`.
const TOKENS = (doc) => ({
  'cite key': (r) => r.citeKey || '',
  type: (r) => r.type || '',
  title: (r) => r.title || '',
  author: (r) => r.author || '',
  'first author': (r) => firstAuthor(r),
  'et al.': (r) => etAl(r),
  jl: (r) => jShort(doc, r),
  journal: (r) => jAbbrev(doc, r),
  volume: (r) => r.volume || '',
  pages: (r) => r.pages || '',
  year: (r) => r.year || '',
  doi: (r) => r.doi || '',
  url: (r) => r.url || '',
  'short ref': (r) => shortRef(doc, r),
  tags: (r) => tagsOf(r).join(' '),
})
const PRESETS = [
  ['short ref.', '{short ref}', ',⏎'],
  ['cite keys', '{cite key}', ', '],
  ['\\bibitem', '\\bibitem{{cite key}} {author}, {journal} {volume} {pages} ({year}).', '⏎'],
  ['BibTeX', '@article{{cite key},\n  author = {{author}},\n  title = {{title}},'
    + '\n  journal = {{journal}},\n  year = {{year}},\n  volume = {{volume}},'
    + '\n  pages = {{pages}},\n  doi = {{doi}},\n  url = {{url}},\n}', '⏎⏎'],
]

// What a column sorts by: the same accessors the cells use, so the order you
// get is the order you can see.
const SORTERS = (doc) => ({
  type: (r) => r.type || '',
  citeKey: (r) => r.citeKey || '',
  year: (r) => Number(r.year) || null,
  jl: (r) => jShort(doc, r),
  title: (r) => r.title || '',
  a1: (r) => firstAuthor(r),
  tags: (r) => tagsOf(r).join(' '),
  cites: (r) => citesOf(r).length || null,
})
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count, full: (r) => r.full }

// ─── Tabs ───────────────────────────────────────────────────────────────────
const FIXED = [
  { id: 'total', kind: 'refs', label: 'total' },
  { id: 'journals', kind: 'classes', label: 'journals', of: 'journal' },
  { id: 'tags', kind: 'classes', label: 'tags', of: 'tag' },
]
const CLS_OF = {
  journal: { key: 'journals', has: inJrn, open: (n) => ({ jrn: n }) },
  // Tags have no records behind them: the list is what the papers use.
  tag: { key: null, has: inTag, open: (n) => ({ tag: n }) },
}

export default function App() {
  const [VIEW, saveView] = useViewState(VIEW_KEY)
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useNote()
  const [tabs, setTabs] = useState(() => [...FIXED,
    ...(VIEW.tabs || []).filter((t) => t?.id && !FIXED.some((f) => f.id === t.id))])
  const [active, setActive] = useState(VIEW.active || 'total')
  const [query, setQuery] = useState('')
  const { drag, sized } = useColumnWidths(WIDTH_KEY, [...COLS, ...CLS_COLS])
  const vw = useViewportWidth()
  const [sort, setSort] = useState(VIEW.sort || null)
  const [clsSort, setClsSort] = useState(VIEW.clsSort || { k: 'name', dir: 1 })
  // Filtering has a MODE: in it the labels stop sorting and start choosing
  // which column's values you are picking from.
  const [fmode, setFmode] = useState(false)
  const [fcol, setFcol] = useState(null)
  const [fsel, setFsel] = useState(VIEW.fsel || {})
  const [fon, setFon] = useState(!!VIEW.fon)
  const [outOpen, setOutOpen] = useState(false)
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  useEffect(() => {
    saveView({ tabs: tabs.filter((t) => !FIXED.some((f) => f.id === t.id)),
               active, sort, clsSort, fsel, fon })
  }, [tabs, active, sort, clsSort, fsel, fon])
  // A tab for something the document no longer has cannot be shown — and
  // neither can one of a kind this service no longer has: collaborations and
  // topic groups were tabs of their own before they became tags, and a stored
  // one would otherwise sit there forever, next to the tag of the same name.
  useEffect(() => {
    if (!doc) return
    const alive = (t) => {
      if (FIXED.some((f) => f.id === t.id)) return true
      if (t.jrn) return (doc.journals || []).some((r) => r.name === t.jrn)
      if (t.tag) return (doc.references || []).some((r) => inTag(r, t.tag))
      return false
    }
    setTabs((ts) => (ts.every(alive) ? ts : ts.filter(alive)))
  }, [doc])
  useEffect(() => {
    if (!tabs.some((t) => t.id === active)) setActive('total')
  }, [tabs, active])

  const refs = doc?.references || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]
  const tokens = useMemo(() => TOKENS(doc), [doc])
  const sorters = useMemo(() => SORTERS(doc), [doc])

  const cols = useMemo(() => sized(COLS, vw), [sized, vw])
  const clsCols = useMemo(() => sized(CLS_COLS, vw, 'c:'), [sized, vw])

  /** How many papers in the list cite this one. Counted once for the whole
   *  document rather than per row, which would be 87² comparisons a render. */
  const citedBy = useMemo(() => {
    const n = new Map()
    for (const r of refs) for (const c of linkedCites(r)) n.set(c.ref, (n.get(c.ref) || 0) + 1)
    return n
  }, [refs])

  const byColumn = useCallback((k, dir) => bySome(sorters[k], dir), [sorters])

  const scopeOf = useCallback((t) => {
    if (t?.kind !== 'refs') return []
    let list = refs
    if (t.jrn) list = list.filter((r) => inJrn(r, t.jrn))
    if (t.tag) list = list.filter((r) => inTag(r, t.tag))
    return [...list].sort(byColumn(sort?.k || 'citeKey', sort?.dir ?? 1))
  }, [refs, sort, byColumn])
  const scope = useMemo(() => scopeOf(tab), [scopeOf, tab])

  const passes = useCallback((r) => passesFilter(r, fsel, sorters), [fsel, sorters])
  const rowsOf = useCallback((sc) => {
    const kept = fon ? sc.filter(passes) : sc
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((r) => [r.citeKey, r.title, r.author, r.journal, r.year, r.doi,
      ...tagsOf(r)].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [query, fon, passes])
  const rows = useMemo(() => rowsOf(scope), [rowsOf, scope])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)

  // Counted over the tab's own papers, not the filtered ones: a value that
  // would empty the list is still worth seeing.
  const facet = useMemo(() => facetOf(scope, sorters[fcol]), [fcol, scope, sorters])
  const picked_ = (k) => fsel[k] || []
  const facetTotal = Object.values(fsel).reduce((t, v) => t + v.length, 0)

  /** The classes themselves. Tags have no records, so their list is gathered
   *  from what the papers actually use. */
  const classesOf = useCallback((t) => {
    if (t?.kind !== 'classes') return []
    const spec = CLS_OF[t.of]
    const recs = spec.key ? (doc?.[spec.key] || [])
      : [...new Set(refs.flatMap(tagsOf))].sort().map((name) => ({ name }))
    return recs.map((r) => ({
      name: r.name,
      full: r.abbrev || r.fullName || '',
      count: refs.filter((x) => spec.has(x, r.name)).length,
    })).sort(bySome(CLS_SORTERS[clsSort.k] || CLS_SORTERS.name, clsSort.dir))
  }, [doc, refs, clsSort])
  const classes = useMemo(() => classesOf(tab), [classesOf, tab])

  function openTab(t) {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setActive(t.id)
  }
  function closeTab(id) {
    setTabs((ts) => ts.filter((t) => t.id !== id))
    if (active === id) setActive('total')
  }
  /** What the listing is about: the papers you ticked, or the tab itself when
   *  you have ticked nothing. */
  const chosen = useMemo(() => scope.filter((r) => picked.has(r.id)), [scope, picked])

  return (
    <div className="rl">
      <section className="rl-mod">
        <header className="rl-bar">
          <b>레퍼런스</b>
          <span className="rl-n">{doc ? `${refs.length}편` : ''}</span>
          <span className="rl-sp" />
          <span className="rl-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="rl-cmd">
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {picked.size > 0 && <span className="rl-n">{picked.size} 선택</span>}
          <span className="rl-gap" />
          {fmode ? (
            <>
              <button type="button" className="rl-btn rl-go"
                onClick={() => { setFmode(false); setFon(facetTotal > 0) }}>
                필터 적용{facetTotal ? ` (${facetTotal})` : ''}
              </button>
              <button type="button" className="rl-btn" onClick={() => setFmode(false)}>취소</button>
              <span className="rl-hint">레이블을 눌러 종류를 고르세요.</span>
            </>
          ) : fon ? (
            <>
              <button type="button" className="rl-btn rl-danger"
                onClick={() => { setFon(false); setFsel({}); setFcol(null) }}>필터 풀기</button>
              <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 고치기</button>
            </>
          ) : (
            <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 선택</button>
          )}
          <span className="rl-sp" />
          <input ref={findRef} type="search" className="rl-find" value={query}
            placeholder="제목 · 저자 · 저널 · 태그   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="rl-body">
          <div className="rl-pane">
            <RackTabs tabs={tabs} active={active} fixed={FIXED}
              onPick={setActive} onClose={closeTab} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !doc && <p className="rl-msg">읽는 중…</p>}

            {doc && tab?.kind === 'refs' && (
              <>
                <RackTable cols={cols} onDrag={drag('')}
                  facet={fmode ? { col: fcol, count: (k) => picked_(k).length, onPick: setFcol } : null}
                  sort={sort || { k: 'citeKey', dir: 1 }}
                  onSort={(k) => setSort((s2) => {
                    // The implicit order counts as the current one, so the first
                    // press on the column already sorted turns it over.
                    const now = s2 || { k: 'citeKey', dir: 1 }
                    return now?.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                  })}
                  head={fmode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                  {fmode && !fcol && <p className="rl-msg">위의 레이블을 눌러 어떤 종류로 걸를지 고르세요.</p>}
                  {fmode && fcol && facet.length === 0 && <p className="rl-msg">이 열에는 값이 없습니다.</p>}
                  {fmode && fcol && facet.map(({ v, count }) => {
                    const on = picked_(fcol).includes(v)
                    return (
                      <button key={v} type="button" className={`rl-frow${on ? ' on' : ''}`}
                        onClick={() => setFsel((s2) => {
                          const cur = s2[fcol] || []
                          const next = on ? cur.filter((x) => x !== v) : [...cur, v]
                          return { ...s2, [fcol]: next }
                        })}>
                        <span className="rl-fv">{v}</span>
                        <span className="rl-fn">{count}</span>
                      </button>
                    )
                  })}
                  {!fmode && rows.map((r, i) => {
                    const on = picked.has(r.id)
                    return (
                      <RackRow key={r.id || i} cols={cols} tone={TONE}
                        className={`rl-hit${on ? ' on' : ''}`}
                        onClick={(e) => hit(i, e.shiftKey)}
                        cell={{
                          chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                            aria-label={`${r.citeKey || r.title} 선택`} />,
                          num: i + 1,
                          type: r.type || D,
                          citeKey: r.citeKey || D,
                          year: r.year || D,
                          jl: jShort(doc, r) || D,
                          title: r.title || D,
                          a1: firstAuthor(r) || D,
                          tags: tagsOf(r).join(' ') || D,
                          cites: citesOf(r).length || D,
                          by: citedBy.get(r.id) || D,
                        }} />
                    )
                  })}
                  {!fmode && rows.length === 0 && <p className="rl-msg">해당하는 논문이 없습니다.</p>}
                </RackTable>
                <ListOut list={chosen.length ? chosen : scope} picked={chosen.length > 0}
                  tokens={tokens} say={setNote} open={outOpen} setOpen={setOutOpen} />
              </>
            )}

            {doc && tab?.kind === 'classes' && (
              <RackTable cols={clsCols} onDrag={drag('c:')} sort={clsSort}
                onSort={(k) => setClsSort((s2) => (s2.k === k ? { k, dir: -s2.dir } : { k, dir: 1 }))}>
                {classes.map((r, i) => (
                  <RackRow key={r.name} cols={clsCols} tone={TONE} className="rl-hit"
                    onClick={() => openTab({
                      id: `${tab.of}:${r.name}`, kind: 'refs', label: r.name,
                      ...CLS_OF[tab.of].open(r.name),
                    })}
                    cell={{ num: i + 1, name: r.name, count: r.count, full: r.full || D }} />
                ))}
                {classes.length === 0 && <p className="rl-msg">아직 없습니다.</p>}
              </RackTable>
            )}
          </div>
        </div>

        <footer className="rl-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위.'}</span>
          <span className="rl-sp" />
          <span className="rl-mono">{rows.length ? `${rows.length}줄` : ''}</span>
        </footer>
      </section>
    </div>
  )
}

// ─── The listing: the reason a chosen set exists ────────────────────────────
function ListOut({ list, picked, tokens, say, open, setOpen }) {
  const [sep, setSep] = useState(PRESETS[0][2])
  const [tpl, setTpl] = useState(PRESETS[0][1])
  // Derived, not stored: editing the rule changes the text under your hands.
  const out = list.map((r) => fillTpl(tpl, r, tokens)).filter(Boolean)
    .join(sep.replaceAll('⏎', '\n'))
  const none = list.length === 0

  async function copy() {
    if (!out) { say('나열할 것이 없습니다.'); return }
    try { await navigator.clipboard.writeText(out); say('복사했습니다.') }
    catch { say('복사 실패 — 직접 선택해 복사하세요.') }
  }

  return (
    <div className="rl-out">
      {/* Folded by default: the list is what you came for, the text it makes is
          what you leave with. */}
      <button type="button" className={`rl-outhead${open ? ' on' : ''}`} onClick={() => setOpen(!open)}
        aria-expanded={open}>
        <i className="rl-caret">{open ? '▾' : '▸'}</i>
        <span>나열</span>
        <span className="rl-hint">{picked ? `선택한 ${list.length}편` : `${list.length}편`}</span>
      </button>
      {open && (<>
        <div className="rl-outbar">
          {PRESETS.map(([label, t, s]) => (
            <button key={label} type="button" className={`rl-btn${tpl === t ? ' on' : ''}`}
              disabled={none} onClick={() => { setTpl(t); setSep(s) }}>{label}</button>
          ))}
          <span className="rl-sp" />
          <button type="button" className="rl-btn" disabled={!out} onClick={copy}>copy</button>
        </div>
        <div className="rl-rule-line">
          <span className="rl-hint">나열 규칙</span>
          <input className="rl-in rl-mono" style={{ flex: 1, minWidth: 180 }} value={tpl}
            onChange={(e) => setTpl(e.target.value)} />
          <span className="rl-hint">사이</span>
          <input className="rl-in rl-mono" style={{ width: 66 }} value={sep}
            onChange={(e) => setSep(e.target.value)} title="구분기호" />
          <button type="button" className="rl-btn" title="줄바꿈 추가"
            onClick={() => setSep((v) => `${v}⏎`)}>+⏎</button>
        </div>
        <div className="rl-tokens">
          {Object.keys(tokens).map((k) => (
            <button key={k} type="button" className="rl-tok"
              onClick={() => setTpl((v) => `${v}{${k}}`)}>{`{${k}}`}</button>
          ))}
        </div>
        <textarea className="rl-outbox" value={out} readOnly
          placeholder={none ? '이 탭에 논문이 없습니다.' : ''} />
      </>)}
    </div>
  )
}
