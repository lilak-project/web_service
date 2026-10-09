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
  RackTable, RackRow, RackTabs, RackActions,
  useColumnWidths, useViewportWidth, useSelection, usePaneSplit, useRackKeys, useFindKey, useNote, useViewState,
  bySome, fill as fillTpl, useFacetFilter, FilterBar, FacetRows,
  PORTAL_BASE, PORTAL_PROJECT, brandStyle, projectKey, load, save, isManager, newId,
  authHeaders, fetchDoc, putDoc,
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
// A paper's authors are ROWS, in order, each of which may point at an author
// record. BibTeX writes them as one string because a .bib field is one string;
// that string is these names joined, and is never stored — otherwise 'which
// papers is W. G. Lynch on' has two answers that can disagree.
const AUTHOR_SPLIT = /\s+and\s+/i
const splitAuthors = (text) => String(text || '')
  .split(AUTHOR_SPLIT).map((x) => x.trim().replace(/,$/, '')).filter(Boolean)
const authorRows = (r) => (r.authors || []).filter((a) => a && (a.name || a.ref))
/** A registered author is spelled by their record, so fixing a name fixes it
 *  on every paper at once. */
const autName = (doc, a) => (a?.ref
  ? ((doc?.authors || []).find((x) => x.id === a.ref)?.name || a.name || '')
  : (a?.name || ''))
const authorList = (doc, r) => authorRows(r).map((a) => autName(doc, a)).filter(Boolean)
const authorString = (doc, r) => authorList(doc, r).join(' and ')
const firstAuthor = (doc, r) => authorList(doc, r)[0] || ''
const etAl = (doc, r) => {
  const list = authorList(doc, r)
  return list.length > 1 ? `${list[0]} et al.` : (list[0] || '')
}
/** Where an author stands on a paper. Not exclusive: a first author can be the
 *  corresponding one, and both lists should say so. */
const autRoles = (r, id) => {
  const i = authorRows(r).findIndex((a) => a.ref === id)
  if (i < 0) return []
  const out = []
  if (i === 0) out.push('first')
  if (i === 1) out.push('second')
  if (authorRows(r)[i].corr) out.push('corr')
  if (i >= 2 && !authorRows(r)[i].corr) out.push('other')
  return out
}
const inRole = (r, id, role) => (role === 'all'
  ? authorRows(r).some((a) => a.ref === id) : autRoles(r, id).includes(role))
// An author carries three spellings of the same person, because a paper needs
// different ones in different places:
//   name      what a citation prints — W. G. Lynch
//   fullName  spelled out — William G Lynch
//   bibName   BibTeX's own order — Lynch, W. G.
// Only `name` is required; the other two are filled when they are known, and
// either can produce `name` mechanically.
/** given words and the family word, reading BibTeX's comma the right way. */
const nameParts = (name) => {
  const t = String(name || '').trim()
  if (t.includes(',')) {
    const [family, given] = [t.slice(0, t.indexOf(',')).trim(), t.slice(t.indexOf(',') + 1).trim()]
    return [given.replace(/[.]/g, ' ').split(/\s+/).filter(Boolean), family]
  }
  const w = t.replace(/[.]/g, ' ').split(/\s+/).filter(Boolean)
  return [w.slice(0, -1), w[w.length - 1] || '']
}
/** The citation form. A hyphenated given name keeps both initials — Ying-Xun →
 *  Y.-X. — which is how it is cited and the only thing that tells it from
 *  Y. Zhang. */
const abbrevName = (name) => {
  const [given, family] = nameParts(name)
  const ini = given.map((w) => w.split('-').filter((b) => /[A-Za-z]/.test(b))
    .map((b) => `${b.replace(/[^A-Za-z]/g, '')[0].toUpperCase()}.`).join('-'))
  return [...ini, family].filter(Boolean).join(' ')
}
/** BibTeX's order, out of a name written the usual way. */
const bibOrder = (name) => {
  const [given, family] = nameParts(name)
  if (!family) return String(name || '')
  return given.length ? `${family}, ${given.map((w) => (w.length <= 2 ? `${w}.` : w)).join(' ')}` : family
}
/** A handle for an author: initials and the family name, the way the
 *  spreadsheet's a1 column was written (J. Almeid → JAlmeid). */
const handleFor = (name) => {
  const [given, family] = nameParts(name)
  return `${given.map((w) => w.replace(/[^A-Za-z]/g, '')[0] || '').join('')}${family}`
    .replace(/[^\w-]/g, '') || 'author'
}
/** A journal is referenced by its record `name`; the table shows the short one. */
const journalRec = (doc, r) => (doc?.journals || []).find((j) => j.name === r.journal) || null
const jShort = (doc, r) => journalRec(doc, r)?.shortName || r.journal || ''
// A journal carries three names: what it is called, the short one a table can
// hold (ApJ) and the one a citation uses (Astrophys. J.).
const jAbbrev = (doc, r) => journalRec(doc, r)?.abbrev || journalRec(doc, r)?.name || r.journal || ''
const shortRef = (doc, r) => [
  etAl(doc, r), [jAbbrev(doc, r), r.volume, r.pages].filter(Boolean).join(' '),
].filter(Boolean).join(', ') + (r.year ? ` (${r.year})` : '')

// A paper points at ONE journal and carries any number of tags. A topic set
// (tpc, 12c) and a collaboration (SpiRIT, LIGO_Virgo) were classes of their own
// at first, but nothing distinguished them from a tag: same many-to-many, no
// fields of their own, nothing to edit. They are tags.
const tagsOf = (r) => (r.tags || []).filter(Boolean)
const inTag = (r, t) => tagsOf(r).includes(t)
const inJrn = (r, name) => r.journal === name
/** Is the paper itself on disk? `pdf` is {mode:'path'|'file', path} — the file
 *  the key is named after. */
const hasPdf = (r) => !!(r.pdf && (r.pdf.path || r.pdf.name))
/** The service reads the file for the browser: file:// cannot be opened from
 *  an http page, and the path is on the machine the backend runs on. */
const pdfSrc = (path, dl) => `${PORTAL_BASE}/api/file?path=${encodeURIComponent(path)}`
  + (dl ? '&download=1' : '')
/** Revealing a file opens the file manager of the machine the BACKEND is on.
 *  That is only useful when it is also the machine you are looking at. */
const onThisMachine = typeof location !== 'undefined'
  && ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname)
async function revealPdf(path, say) {
  try {
    const res = await fetch(`${PORTAL_BASE}/api/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ path }),
    })
    const got = await res.json().catch(() => ({}))
    say(res.ok ? `${got.where || '파일 관리자'}에서 열었습니다.` : (got.detail || '열 수 없습니다.'))
  } catch (e) { say(String(e.message || e)) }
}
/** Where the file IS, whole. The document keeps a path relative to a root, so
 *  the service is asked which root it was found under before it is copied —
 *  a file name on the clipboard is no use to anyone. */
async function copyPath(path, say) {
  let full = path
  try {
    const r = await fetch(`${PORTAL_BASE}/api/realpath?path=${encodeURIComponent(path)}`,
      { headers: authHeaders() })
    if (r.ok) full = (await r.json()).path || path
  } catch { /* the relative path is better than nothing */ }
  try { await navigator.clipboard.writeText(full); say(`복사했습니다 — ${full}`) }
  catch { say(full) }     // no clipboard: the status line IS the copy
}
/** A path dropped from Finder arrives as a file:// URL. */
const droppedPath = (e) => {
  const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || ''
  const one = uri.split(/\r?\n/).find((x) => x.startsWith('file://')) || uri.trim()
  try { return one.startsWith('file://') ? decodeURI(one.slice(7)) : one } catch { return one }
}
/** Papers this one lists, and papers that list it — one is stored, the other
 *  is counted, because storing both is two places to disagree. */
const citesOf = (r) => (r.cites || []).filter((c) => c && (c.ref || c.raw))
const linkedCites = (r) => citesOf(r).filter((c) => c.ref)

/** How a paper is named when it is not the row you are reading: its cite key,
 *  or the start of its title when it has none. */
const refLabel = (r) => (r?.citeKey || '').trim() || (r?.title || '').slice(0, 32) || '논문'

// ─── The cite key ───────────────────────────────────────────────────────────
// The key is also a file name — the PDFs on disk are named after it — so every
// part of it is squeezed to what a file name can hold. Punctuation becomes an
// underscore rather than vanishing, which is how the spreadsheet already spelled
// a reaction: 12C(p,p)12C → 12C_p_p_12C, X-ray burst → X-ray_burst.
const slug = (v) => String(v || '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/_+/g, '_')
  .replace(/^_|_$/g, '')
/** The tag this paper is filed under. One of its own, chosen; the first one
 *  when nobody has chosen. */
const mainTag = (r) => (tagsOf(r).includes(r.mainTag) ? r.mainTag : tagsOf(r)[0] || '')
const KEY_RULE = '{a1}_{jl}_{year}_{tag}'
/** The key a paper would be given. Parts nobody filled in leave no gap. */
const citeKeyFor = (doc, r, rule = KEY_RULE) => rule
  .replace(/\{([^{}]+)\}/g, (m, k) => {
    const v = { a1: handleFor(firstAuthor(doc, r)), jl: jShort(doc, r),
      year: r.year, tag: mainTag(r) }[k.trim()]
    return v === undefined ? m : slug(v)
  })
  .replace(/_+/g, '_').replace(/^_|_$/g, '')

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
  { k: 'jl', w: 86, min: 40, label: 'journal' },
  { k: 'title', w: 330, min: 120, label: 'title' },
  { k: 'a1', w: 134, min: 70, label: 'first author', drop: 1040 },
  { k: 'tags', w: 180, min: 60, label: 'tags', drop: 1320 },
  { k: 'pdf', w: 38, min: 30, label: 'pdf', num: true },
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
  author: (r) => authorString(doc, r),
  // What a .bib file wants: Family, Given — the record's own bibName when it
  // has one, and that order worked out from the name when it does not.
  'author (bib)': (r) => authorRows(r).map((a) => {
    const rec = a.ref ? (doc?.authors || []).find((x) => x.id === a.ref) : null
    return rec?.bibName || bibOrder(autName(doc, a))
  }).filter(Boolean).join(' and '),
  'first author': (r) => firstAuthor(doc, r),
  'et al.': (r) => etAl(doc, r),
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
  ['BibTeX', '@article{{cite key},\n  author = {{author (bib)}},\n  title = {{title}},'
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
  a1: (r) => firstAuthor(doc, r),
  tags: (r) => tagsOf(r).join(' '),
  cites: (r) => citesOf(r).length || null,
  pdf: (r) => (hasPdf(r) ? 'pdf' : ''),
})
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count, full: (r) => r.full }

// ─── Tabs ───────────────────────────────────────────────────────────────────
const FIXED = [
  // The id stays 'total' — it is in everyone's stored view state — but the
  // label says what the tab lists.
  { id: 'total', kind: 'refs', label: 'references' },
  { id: 'authors', kind: 'classes', label: 'authors', of: 'author' },
  { id: 'journals', kind: 'classes', label: 'journals', of: 'journal' },
  { id: 'tags', kind: 'classes', label: 'tags', of: 'tag' },
  ...(isManager() ? [{ id: 'settings', kind: 'settings', label: 'settings' }] : []),
]
const CLS_OF = {
  author: { key: 'authors', open: (id) => ({ aut: id, role: 'all' }) },
  journal: { key: 'journals', has: inJrn, open: (n) => ({ jrn: n }) },
  // Tags have no records behind them: the list is what the papers use.
  tag: { key: null, has: inTag, open: (n) => ({ tag: n }) },
}
/** The authors' own columns: where someone stands is the point of the row. */
const AUT_COLS = [
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'name', w: 200, min: 80, label: 'name' },
  { k: 'tag', w: 130, min: 60, label: 'handle' },
  { k: 'count', w: 70, min: 46, label: 'papers', num: true },
  { k: 'first', w: 58, min: 40, label: '1st', num: true },
  { k: 'second', w: 58, min: 40, label: '2nd', num: true },
  { k: 'corr', w: 58, min: 40, label: 'corr.', num: true },
  { k: 'other', w: 58, min: 40, label: '그 외', num: true },
]
const AUT_SORTERS = { name: (r) => r.name, tag: (r) => r.tag, count: (r) => r.count,
  first: (r) => r.first, second: (r) => r.second, corr: (r) => r.corr, other: (r) => r.other }
const ROLE_LABEL = { all: '', first: '1저자', second: '2저자', corr: 'corr.', other: '그 외' }

export default function App() {
  const [VIEW, saveView] = useViewState(VIEW_KEY)
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useNote()
  const [tabs, setTabs] = useState(() => [...FIXED,
    ...(VIEW.tabs || []).filter((t) => t?.id && !FIXED.some((f) => f.id === t.id))])
  const [active, setActive] = useState(VIEW.active || 'total')
  // The editor is its OWN pane with its OWN tabs: a record you are fixing is
  // not one of the lists, and closing one should not send you somewhere else.
  const [etabs, setEtabs] = useState([])
  const [eactive, setEactive] = useState(null)
  const [query, setQuery] = useState('')
  const { drag, sized } = useColumnWidths(WIDTH_KEY, [...COLS, ...CLS_COLS, ...AUT_COLS])
  const vw = useViewportWidth()
  const split = usePaneSplit(projectKey('rm', 'split'))
  const [sort, setSort] = useState(VIEW.sort || null)
  const [clsSort, setClsSort] = useState(VIEW.clsSort || { k: 'name', dir: 1 })
  const [outOpen, setOutOpen] = useState(false)
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
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
      // A citation tab belongs to a paper; without it there is nothing to list.
      if (t.cites || t.citedBy) return (doc.references || []).some((r) => r.id === (t.cites || t.citedBy))
      if (t.aut) return (doc.authors || []).some((a) => a.id === t.aut)
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
  const clsCols = useMemo(() => sized(tab?.of === 'author' ? AUT_COLS : CLS_COLS, vw, 'c:'),
    [sized, vw, tab])

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
    // Citation tabs: what this paper cites, and what cites it. The first keeps
    // the order the citation numbers give it — a reference list is numbered —
    // until a column is clicked.
    if (t.cites) {
      const me = refs.find((r) => r.id === t.cites)
      const byId = new Map(refs.map((r) => [r.id, r]))
      const list = linkedCites(me || {}).map((c) => ({ c, r: byId.get(c.ref) })).filter((x) => x.r)
      if (sort) return list.map((x) => x.r).sort(byColumn(sort.k, sort.dir))
      return list.sort((x, y) => (Number(x.c.n) || 999) - (Number(y.c.n) || 999)).map((x) => x.r)
    }
    if (t.citedBy) {
      const list = refs.filter((r) => linkedCites(r).some((c) => c.ref === t.citedBy))
      return [...list].sort(byColumn(sort?.k || 'citeKey', sort?.dir ?? 1))
    }
    // An author's papers, by where they stand on them.
    if (t.aut) {
      const list = refs.filter((r) => inRole(r, t.aut, t.role || 'all'))
      return [...list].sort(byColumn(sort?.k || 'year', sort?.dir ?? -1))
    }
    let list = refs
    if (t.jrn) list = list.filter((r) => inJrn(r, t.jrn))
    if (t.tag) list = list.filter((r) => inTag(r, t.tag))
    return [...list].sort(byColumn(sort?.k || 'citeKey', sort?.dir ?? 1))
  }, [refs, sort, byColumn])
  const scope = useMemo(() => scopeOf(tab), [scopeOf, tab])

  const filter = useFacetFilter(scope, sorters, { sel: VIEW.fsel, on: VIEW.fon })
  // Declared after the filter, because its deps read from it — a dependency
  // array is evaluated where it is written, and `filter` does not exist yet
  // further up.
  useEffect(() => {
    saveView({ tabs: tabs.filter((t) => !FIXED.some((x) => x.id === t.id)),
               active, sort, clsSort, fsel: filter.sel, fon: filter.on })
  }, [tabs, active, sort, clsSort, filter.sel, filter.on])   // eslint-disable-line react-hooks/exhaustive-deps
  const rowsOf = useCallback((sc) => {
    const kept = filter.on ? sc.filter(filter.passes) : sc
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((r) => [r.citeKey, r.title, r.journal, r.year, r.doi,
      ...authorList(doc, r), ...tagsOf(r)]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [query, filter.on, filter.passes, doc])
  const rows = useMemo(() => rowsOf(scope), [rowsOf, scope])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)


  /** The classes themselves. Tags have no records, so their list is gathered
   *  from what the papers actually use. */
  const classesOf = useCallback((t) => {
    if (t?.kind !== 'classes') return []
    // Authors count where they stand, not just how many: 1st, 2nd,
    // corresponding, and the rest.
    if (t.of === 'author') {
      return (doc?.authors || []).map((a) => {
        const mine = refs.filter((r) => authorRows(r).some((x) => x.ref === a.id))
        const n = (role) => mine.filter((r) => autRoles(r, a.id).includes(role)).length
        return { id: a.id, name: a.name, tag: a.tag, count: mine.length,
          first: n('first'), second: n('second'), corr: n('corr'), other: n('other'),
          // Every spelling this person is known by, so the search box finds
          // them by the full name or by #handle, not only by what the row shows.
          find: [a.name, a.fullName, a.bibName, a.tag, ...(a.aliases || [])]
            .filter(Boolean).join(' ').toLowerCase() }
      }).sort(bySome(AUT_SORTERS[clsSort.k] || AUT_SORTERS.name, clsSort.dir))
    }
    const spec = CLS_OF[t.of]
    const recs = spec.key ? (doc?.[spec.key] || [])
      : [...new Set(refs.flatMap(tagsOf))].sort().map((name) => ({ name }))
    return recs.map((r) => ({
      name: r.name,
      full: r.abbrev || r.fullName || '',
      count: refs.filter((x) => spec.has(x, r.name)).length,
      find: [r.name, r.shortName, r.abbrev].filter(Boolean).join(' ').toLowerCase(),
    })).sort(bySome(CLS_SORTERS[clsSort.k] || CLS_SORTERS.name, clsSort.dir))
  }, [doc, refs, clsSort])
  // The one search box searches whatever the tab lists: papers on a paper tab,
  // and the journals, authors or tags themselves on theirs.
  const classes = useMemo(() => {
    const all = classesOf(tab)
    const q = query.trim().toLowerCase()
    return q ? all.filter((r) => (r.find || r.name.toLowerCase()).includes(q)) : all
  }, [classesOf, tab, query])

  function openTab(t) {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setActive(t.id)
  }
  function closeTab(id) {
    setTabs((ts) => ts.filter((t) => t.id !== id))
    if (active === id) setActive('total')
  }
  function openEdit(t) {
    setEtabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setEactive(t.id)
  }
  // ⌘X closes the record you are in, ⌘N starts whatever this tab makes.
  useRackKeys({
    onClose: () => eactive && closeEdit(eactive),
    onNew: () => (tab?.kind === 'classes' && tab.of === 'author'
      ? openEdit({ id: 'newaut', kind: 'editaut', who: null, label: '새 저자' })
      : tab?.kind === 'classes' && tab.of === 'journal'
        ? openEdit({ id: 'newjrn', kind: 'editjrn', who: null, label: '새 저널' })
        : openEdit({ id: 'new', kind: 'edit', who: null, label: '새 논문' })),
  })

  function closeEdit(id) {
    setEtabs((ts) => {
      const left = ts.filter((t) => t.id !== id)
      if (id === eactive) setEactive(left.length ? left[left.length - 1].id : null)
      return left
    })
  }

  // ── saving one record ──
  async function commit(patch, said) {
    if (!doc) return false
    try {
      const r = await putDoc(doc.version, {
        references: patch.references || doc.references,
        journals: patch.journals || doc.journals,
        authors: patch.authors || doc.authors,
      })
      if (r.conflict) { setNote('다른 사람이 먼저 저장했습니다 — 새로 읽어주세요.'); return false }
      setDoc(r.doc)
      setNote(said || '저장했습니다.')
      return true
    } catch (e) { setNote(String(e.message || e)); return false }
  }
  /** What the listing is about: the papers you ticked, or the tab itself when
   *  you have ticked nothing. */
  const chosen = useMemo(() => scope.filter((r) => picked.has(r.id)), [scope, picked])

  // The editor takes the right half when there is room for both; below that it
  // has the width to itself while it is open.
  const etab = etabs.find((t) => t.id === eactive) || null
  const showEdit = !!etab
  const showList = !showEdit || vw >= 1180
  const allTags = useMemo(() => [...new Set(refs.flatMap(tagsOf))].sort(), [refs])

  return (
    <div className="rl" style={brandStyle()}>
      <section className="rl-mod">
        <header className="rl-bar">
          <b>레퍼런스</b>
          <span className="rl-n">{doc ? `${refs.length}편` : ''}</span>
          <span className="rl-sp" />
          <span className="rl-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="rl-cmd">
          {tab?.kind === 'classes' && tab.of === 'author' ? (
            <button type="button" className="rl-btn rl-tabonly"
              onClick={() => openEdit({ id: 'newaut', kind: 'editaut', who: null, label: '새 저자' })}>
              + 새 저자
            </button>
          ) : tab?.kind === 'classes' && tab.of === 'journal' ? (
            /* Mustard: it is only here while a journal tab is, and the colour is
               what says so. */
            <button type="button" className="rl-btn rl-tabonly"
              onClick={() => openEdit({ id: 'newjrn', kind: 'editjrn', who: null, label: '새 저널' })}>
              + 새 저널
            </button>
          ) : (
            <button type="button" className="rl-btn rl-go"
              onClick={() => openEdit({ id: 'new', kind: 'edit', who: null, label: '새 논문' })}>
              + 새 논문
            </button>
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {picked.size > 0 && <span className="rl-n">{picked.size} 선택</span>}
          <span className="rl-gap" />
          {tabs.length > FIXED.length && (
            <button type="button" className="rl-btn" title="열어둔 탭을 모두 닫습니다"
              onClick={() => { setTabs(FIXED); setActive('total') }}>
              탭 닫기 ({tabs.length - FIXED.length})
            </button>
          )}
          {etabs.length > 0 && (
            <button type="button" className="rl-btn" title="편집 패널의 탭을 모두 닫습니다"
              onClick={() => { setEtabs([]); setEactive(null) }}>
              편집 닫기 ({etabs.length})
            </button>
          )}
          <FilterBar f={filter} />
          <span className="rl-sp" />
          {/* One box, and it searches whatever is on screen: the papers, the
              classes, or — while the filter is choosing — the values on offer,
              because a column with two thousand of them is not a list you
              scroll. */}
          <input ref={findRef} type="search" className="rl-find"
            value={filter.mode ? filter.find : query}
            placeholder={filter.mode ? '고를 값 찾기   (⌘F)'
              : tab?.kind === 'classes' ? '이 목록에서 찾기   (⌘F)'
                : '제목 · 저자 · 저널 · 태그   (⌘F)'}
            onChange={(e) => (filter.mode ? filter.setFind : setQuery)(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane" style={showEdit ? split.leftStyle : undefined}>
            <RackTabs tabs={tabs} active={active} fixed={FIXED}
              onPick={setActive} onClose={closeTab} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !doc && <p className="rl-msg">읽는 중…</p>}

            {doc && tab?.kind === 'refs' && (
              <>
                <RackTable cols={cols} onDrag={drag('')}
                  facet={filter.tableFacet}
                  sort={sort || { k: 'citeKey', dir: 1 }}
                  onSort={(k) => setSort((s2) => {
                    // The implicit order counts as the current one, so the first
                    // press on the column already sorted turns it over.
                    const now = s2 || { k: 'citeKey', dir: 1 }
                    return now?.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                  })}
                  head={filter.mode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                  <FacetRows f={filter} labels={{ empty: '이 열에는 값이 없습니다.' }} />
                  {!filter.mode && rows.map((r, i) => {
                    const on = picked.has(r.id)
                    const edited = etabs.some((t) => t.who === r.id)
                    return (
                      <RackRow key={r.id || i} cols={cols} tone={TONE}
                        className={`rl-hit${on ? ' on' : ''}${edited ? ' rl-edited' : ''}`}
                        onClick={(e) => hit(i, e.shiftKey)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          openEdit({ id: `edit:${r.id}`, kind: 'edit', who: r.id,
                            label: r.citeKey || r.title?.slice(0, 24) || '논문' })
                        }}
                        cell={{
                          chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                            aria-label={`${r.citeKey || r.title} 선택`} />,
                          num: i + 1,
                          type: r.type || D,
                          citeKey: r.citeKey || D,
                          year: r.year || D,
                          jl: jShort(doc, r) || D,
                          title: r.title || D,
                          a1: firstAuthor(doc, r) || D,
                          tags: tagsOf(r).join(' ') || D,
                          // A count you can press: the number is also the way
                          // to the papers it counts.
                          // ✓ when the file is there, nothing when it is not —
                          // a column you can sort and filter on.
                          pdf: hasPdf(r) ? (
                            <button type="button" className="rl-ok rl-lnk" title={r.pdf.path}
                              onClick={(e) => {
                                e.stopPropagation()
                                openEdit({ id: `pdf:${r.id}`, kind: 'pdf', who: r.id,
                                  label: `📄 ${refLabel(r)}` })
                              }}>✓</button>
                          ) : D,
                          cites: linkedCites(r).length ? (
                            <button type="button" className="rl-lnk" title="이 논문이 인용한 것"
                              onClick={(e) => {
                                e.stopPropagation()
                                openTab({ id: `cites:${r.id}`, kind: 'refs', cites: r.id,
                                  label: `${refLabel(r)} →` })
                              }}>{linkedCites(r).length}</button>
                          ) : (citesOf(r).length || D),
                          by: citedBy.get(r.id) ? (
                            <button type="button" className="rl-lnk" title="이 논문을 인용한 것"
                              onClick={(e) => {
                                e.stopPropagation()
                                openTab({ id: `by:${r.id}`, kind: 'refs', citedBy: r.id,
                                  label: `→ ${refLabel(r)}` })
                              }}>{citedBy.get(r.id)}</button>
                          ) : D,
                        }} />
                    )
                  })}
                  {!filter.mode && rows.length === 0 && <p className="rl-msg">해당하는 논문이 없습니다.</p>}
                </RackTable>
                <ListOut list={chosen.length ? chosen : scope} picked={chosen.length > 0}
                  tokens={tokens} say={setNote} open={outOpen} setOpen={setOutOpen} />
              </>
            )}

            {doc && tab?.kind === 'settings' && (
              <Settings doc={doc} onSave={commit} say={setNote} />
            )}

            {doc && tab?.kind === 'classes' && (
              <RackTable cols={clsCols} onDrag={drag('c:')} sort={clsSort}
                onSort={(k) => setClsSort((s2) => (s2.k === k ? { k, dir: -s2.dir } : { k, dir: 1 }))}>
                {classes.map((r, i) => {
                  const key = tab.of === 'author' ? r.id : r.name
                  // On an author's row every count is a way in: press 1st and
                  // you get the papers they lead, not all of them.
                  const roleCell = (role, n) => (n ? (
                    <button type="button" className="rl-lnk" title={`${r.name} · ${ROLE_LABEL[role]}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openTab({ id: `aut:${r.id}:${role}`, kind: 'refs', aut: r.id, role,
                          label: `${r.tag || r.name} ${ROLE_LABEL[role]}` })
                      }}>{n}</button>
                  ) : D)
                  return (
                    <RackRow key={key} cols={clsCols} tone={TONE} className="rl-hit"
                      onClick={() => openTab({
                        id: `${tab.of}:${key}`, kind: 'refs', label: r.tag || r.name,
                        ...CLS_OF[tab.of].open(key),
                      })}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openEdit(tab.of === 'author'
                          ? { id: `editaut:${r.id}`, kind: 'editaut', who: r.id, label: r.tag || r.name }
                          : tab.of === 'journal'
                            ? { id: `editjrn:${r.name}`, kind: 'editjrn', who: r.name, label: r.name }
                            : { id: `edittag:${r.name}`, kind: 'edittag', who: r.name, label: r.name })
                      }}
                      cell={tab.of === 'author' ? {
                        num: i + 1, name: r.name, tag: r.tag || D, count: r.count,
                        first: roleCell('first', r.first), second: roleCell('second', r.second),
                        corr: roleCell('corr', r.corr), other: roleCell('other', r.other),
                      } : { num: i + 1, name: r.name, count: r.count, full: r.full || D }} />
                  )
                })}
                {classes.length === 0 && <p className="rl-msg">아직 없습니다.</p>}
              </RackTable>
            )}
          </div>)}

          {showList && showEdit && <div {...split.handleProps} />}
          {showEdit && (<div className="rl-pane rl-epane" style={showList ? split.rightStyle : undefined}>
            <RackTabs tabs={etabs} active={eactive} opened
              onPick={setEactive} onClose={closeEdit} />
            {etab.kind === 'pdf' ? (() => {
              const r = refs.find((x) => x.id === etab.who)
              if (!r || !hasPdf(r)) return <p className="rl-msg">파일이 연결되어 있지 않습니다.</p>
              return (
                <div className="rl-pdf">
                  <div className="rl-pdfbar">
                    <button type="button" className="rl-path rl-mono" title="경로 복사"
                      onClick={() => copyPath(r.pdf.path, setNote)}>{r.pdf.path}</button>
                    <div className="rl-pdfacts">
                      {onThisMachine && (
                        <button type="button" className="rl-btn"
                          onClick={() => revealPdf(r.pdf.path, setNote)}>폴더에서 보기</button>
                      )}
                      <a className="rl-btn" href={pdfSrc(r.pdf.path)} target="_blank" rel="noreferrer">새 창</a>
                      <a className="rl-btn" href={pdfSrc(r.pdf.path, true)} download>내려받기</a>
                      <span className="rl-sp" />
                      <button type="button" className="rl-btn"
                        onClick={() => copyPath(r.pdf.path, setNote)}>경로 복사</button>
                    </div>
                  </div>
                  <iframe className="rl-pdfview" src={pdfSrc(r.pdf.path)} title={r.pdf.path} />
                </div>
              )
            })() : etab.kind === 'edit' ? (
              <EditRef ref_={etab.who ? refs.find((r) => r.id === etab.who) : null}
                doc={doc} tags={allTags} onSave={commit} isAdmin={IS_ADMIN} say={setNote}
                onOpen={(id) => {
                  const r = refs.find((x) => x.id === id)
                  if (r) openEdit({ id: `edit:${id}`, kind: 'edit', who: id, label: refLabel(r) })
                }}
                onCreated={(id, label) => { closeEdit('new'); openEdit({ id: `edit:${id}`, kind: 'edit', who: id, label }) }}
                onDone={(id) => closeEdit(`edit:${id}`)}
                onCancel={() => closeEdit(etab.id)}
                onDeleted={(id) => {
                  closeEdit(`edit:${id}`)
                  setPicked((s2) => { const n = new Set(s2); n.delete(id); return n })
                }} />
            ) : etab.kind === 'editaut' ? (
              <EditAuthorRec id={etab.who} doc={doc} onSave={commit} isAdmin={IS_ADMIN}
                onCreated={(a) => { closeEdit('newaut'); openEdit({ id: `editaut:${a.id}`, kind: 'editaut', who: a.id, label: a.tag || a.name }) }}
                onDone={(id) => closeEdit(`editaut:${id}`)}
                onCancel={() => closeEdit(etab.id)}
                onOpenRef={(id) => {
                  const r = refs.find((x) => x.id === id)
                  if (r) openEdit({ id: `edit:${id}`, kind: 'edit', who: id, label: refLabel(r) })
                }}
                onOpenRole={(a, role) => openTab({ id: `aut:${a.id}:${role}`, kind: 'refs',
                  aut: a.id, role, label: `${a.tag || a.name} ${ROLE_LABEL[role]}` })} />
            ) : etab.kind === 'editjrn' ? (
              <EditJournal name={etab.who} doc={doc} onSave={commit} isAdmin={IS_ADMIN}
                onCreated={(name) => { closeEdit('newjrn'); openEdit({ id: `editjrn:${name}`, kind: 'editjrn', who: name, label: name }) }}
                onDone={(name) => closeEdit(`editjrn:${name}`)}
                onCancel={() => closeEdit(etab.id)} />
            ) : (
              <EditTag name={etab.who} doc={doc} tags={allTags} onSave={commit} isAdmin={IS_ADMIN}
                onDone={(name) => closeEdit(`edittag:${name}`)}
                onCancel={() => closeEdit(etab.id)} />
            )}
          </div>)}
        </div>

        <footer className="rl-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위, 오른쪽 클릭으로 편집.'}</span>
          <span className="rl-sp" />
          <span className="rl-mono">
            {tab?.kind === 'classes' ? (classes.length ? `${classes.length}줄` : '')
              : (rows.length ? `${rows.length}줄` : '')}
          </span>
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

// ─── Settings ───────────────────────────────────────────────────────────────
/** What the service may read from disk, and one pass that links every paper
 *  whose file is named after its key. Manager only — it is the one setting that
 *  decides what the backend will open. */
function Settings({ doc, onSave, say }) {
  const roots = (doc.settings || {}).pdfRoots || []
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState(null)

  const setRoots = (v) => onSave({ settings: { ...(doc.settings || {}), pdfRoots: v } },
    '허용 루트를 저장했습니다.')

  async function linkAll() {
    setBusy(true)
    try {
      const r = await fetch(`${PORTAL_BASE}/api/scan`, { headers: authHeaders() })
      const got = await r.json()
      const files = got.files || {}
      let linked = 0, already = 0
      const refs = doc.references.map((x) => {
        const hits = files[x.citeKey]
        if (!hits || !hits.length) return x
        if (x.pdf?.path) { already += 1; return x }
        const sorted = [...hits].sort((a, b) => a.split('/').length - b.split('/').length)
        linked += 1
        return { ...x, pdf: { mode: 'path', path: sorted[0],
          ...(sorted.length > 1 ? { copies: sorted.slice(1) } : {}) } }
      })
      setFound({ files: Object.keys(files).length, linked, already })
      if (linked) await onSave({ references: refs }, `${linked}편에 파일을 연결했습니다.`)
      else say('새로 연결할 것이 없습니다.')
    } catch (e) { say(String(e.message || e)) } finally { setBusy(false) }
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        <Fld label="PDF 허용 루트">
          <TextRows value={roots} add="+ 루트" placeholder="/Users/…/Papers"
            onChange={setRoots} />
          <span className="rl-hint">
            이 폴더들 안의 파일만 서비스가 읽습니다. 심볼릭 링크를 풀어 확인하므로
            루트 밖을 가리키는 링크는 거부됩니다.
          </span>
        </Fld>
        <Fld label="전부 자동 연결">
          <div className="rl-rows">
            <div className="rl-rrow">
              <button type="button" className="rl-btn rl-go" disabled={busy || !roots.length}
                onClick={linkAll}>{busy ? '훑는 중…' : '루트를 훑어 연결'}</button>
              <span className="rl-hint">파일 이름이 cite key와 같으면 연결합니다.</span>
            </div>
            {found && (
              <span className="rl-hint">
                파일 {found.files}개 · 새로 연결 {found.linked} · 이미 있던 것 {found.already}
              </span>
            )}
          </div>
        </Fld>
        <Fld label="문서">
          <span className="rl-hint rl-mono">
            논문 {doc.references.length} · 저널 {(doc.journals || []).length}
            {' · '}저자 {(doc.authors || []).length}
            {' · '}파일 연결 {doc.references.filter((r) => r.pdf?.path).length}
            {' · '}version {doc.version}
          </span>
        </Fld>
      </div>
    </div>
  )
}

// ─── Authors ────────────────────────────────────────────────────────────────
/** A paper's authors, in order. A row is a name; if it is someone the list
 *  knows, it is their handle instead, and the name comes from their record.
 *  Type a name or a #handle to link one, press 등록 to make a record out of a
 *  name nobody has registered yet. */
const SHOWN = 3   // an author list is long; the first three say whose paper it is

function AuthorRows({ value = [], doc, onChange, onRegister }) {
  // 291 authors is a real paper (LIGO), and a form that shows all of them is a
  // form you cannot read past. The rest are one press away.
  const [open, setOpen] = useState(false)
  const recs = doc.authors || []
  const byKey = useMemo(() => {
    const m = new Map()
    for (const a of recs) {
      for (const k of [a.name, a.fullName, a.bibName, a.tag, `#${a.tag}`, ...(a.aliases || [])]) {
        if (k) m.set(String(k).toLowerCase(), a.id)
      }
    }
    return m
  }, [recs])
  const options = useMemo(() => recs.flatMap((a) => [`#${a.tag}`, a.name,
    ...(a.fullName ? [a.fullName] : [])]), [recs])
  const row = (i, patch) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const move = (i, d) => {
    const next = [...value]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const linked = value.filter((a) => a.ref).length

  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {(open ? value : value.slice(0, SHOWN)).map((a, i) => {
        const rec = a.ref ? recs.find((x) => x.id === a.ref) : null
        return (
          <div key={i} className="rl-rrow">
            <span className="rl-hint rl-mono" style={{ width: 22, textAlign: 'right' }}>{i + 1}</span>
            {rec ? (
              <span className="rl-tag">
                #{rec.tag}
                <button type="button" className="rl-x" title="연결 끊기"
                  onClick={() => row(i, { ref: '', name: rec.name })}>×</button>
              </span>
            ) : (
              <>
                <input className="rl-in" style={{ width: 210 }} list="rl-auts" value={a.name || ''}
                  placeholder="이름 또는 #handle"
                  onChange={(e) => {
                    const v = e.target.value
                    const id = byKey.get(v.trim().toLowerCase())
                    row(i, id ? { ref: id, name: '' } : { name: v })
                  }} />
                <button type="button" className="rl-btn" disabled={!String(a.name || '').trim()}
                  title="이 이름으로 저자를 등록하고 같은 이름의 줄을 모두 연결합니다"
                  onClick={() => onRegister?.(a.name)}>등록</button>
              </>
            )}
            <span className="rl-hint">{rec ? rec.name : ''}</span>
            <label className="rl-hint" title="corresponding author">
              <input type="checkbox" checked={!!a.corr}
                onChange={(e) => row(i, { corr: e.target.checked })} /> corr.
            </label>
            <button type="button" className="rl-x" title="위로" onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="rl-x" title="아래로" onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="rl-x" title="이 줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
          </div>
        )
      })}
      <datalist id="rl-auts">{options.map((o) => <option key={o} value={o} />)}</datalist>
      <div className="rl-rrow">
        {value.length > SHOWN && (
          <button type="button" className="rl-btn" onClick={() => setOpen(!open)}>
            {open ? '접기' : `열기 (${value.length - SHOWN}명 더)`}
          </button>
        )}
        <button type="button" className="rl-btn"
          onClick={() => { setOpen(true); onChange([...value, { name: '', ref: '', corr: false }]) }}>
          + 저자
        </button>
        <span className="rl-hint">{value.length}명 · {linked}명 연결</span>
      </div>
    </div>
  )
}

/** An author record. The counts are the point: where this person stands on the
 *  papers they are on, and each of them is a way to that list. */
function EditAuthorRec({ id, doc, onSave, isAdmin, onCreated, onDone, onCancel, onOpenRef, onOpenRole }) {
  const draft = !id
  const rec = draft ? null : (doc.authors || []).find((a) => a.id === id)
  const blank = { id: null, tag: '', name: '', fullName: '', bibName: '',
    aliases: [], email: '', orcid: '', note: '' }
  const [f, setF] = useState(rec || blank)
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => (draft ? create() : update(true)) })
  useEffect(() => { setF(rec || blank) }, [id, rec])  // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft && !rec) return <p className="rl-msg">그 저자를 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const named = String(f.name || '').trim()
  const tag = String(f.tag || '').trim() || handleFor(named)
  const taken = (doc.authors || []).some((a) => a.tag === tag && a.id !== rec?.id)

  const mine = (doc.references || []).filter((r) => (r.authors || []).some((a) => a.ref === id))
  const of = (role) => mine.filter((r) => autRoles(r, id).includes(role))
  const ROLES = [['first', '1저자'], ['second', '2저자'], ['corr', 'corresponding'], ['other', '그 외']]

  async function create() {
    if (!named || taken) return
    const a = { ...f, id: newId(), tag, name: named }
    // A record made here still links the rows that spell the name this way.
    const link = (rows) => (rows || []).map((x) => (!x.ref && x.name === named ? { ...x, ref: a.id } : x))
    const hits = (doc.references || []).reduce((n, r) => n + (r.authors || [])
      .filter((x) => !x.ref && x.name === named).length, 0)
    if (await onSave({
      authors: [...(doc.authors || []), a],
      references: (doc.references || []).map((r) => ({ ...r, authors: link(r.authors) })),
    }, `${a.tag} 등록 · ${hits}줄 연결`)) onCreated?.(a)
  }
  async function update(keep) {
    const a = { ...f, tag, name: named, aliases: (f.aliases || []).map((x) => String(x).trim()).filter(Boolean) }
    // Every spelling this record holds links the rows that use it: the other
    // two names are spellings too, not decoration.
    const spellings = [named, a.fullName, a.bibName, ...(a.aliases || [])]
      .map((x) => String(x || '').trim()).filter(Boolean)
    const link = (rows) => (rows || []).map((x) => (!x.ref && spellings.includes(x.name)
      ? { ...x, ref: a.id } : x))
    const hits = (doc.references || []).reduce((n, r) => n + (r.authors || [])
      .filter((x) => !x.ref && spellings.includes(x.name)).length, 0)
    const ok = await onSave({
      authors: (doc.authors || []).map((x) => (x.id === rec.id ? a : x)),
      references: (doc.references || []).map((r) => ({ ...r, authors: link(r.authors) })),
    }, hits ? `저장 · ${hits}줄 새로 연결` : '저장했습니다.')
    if (ok && !keep) onDone?.(rec.id)
  }
  async function remove() {
    // The papers keep the name as text: what goes is the record, not the fact
    // that this person wrote them.
    const refs = (doc.references || []).map((r) => ({
      ...r,
      authors: (r.authors || []).map((x) => (x.ref === rec.id
        ? { ...x, ref: '', name: x.name || rec.name } : x)),
    }))
    if (await onSave({ authors: (doc.authors || []).filter((a) => a.id !== rec.id), references: refs },
      `${rec.tag} 삭제 · 이름은 ${mine.length}편에 글자로 남습니다`)) onDone?.(rec.id)
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        <Fld label="줄임이름">
          <input className="rl-in" style={{ width: 240 }} value={f.name || ''} onChange={set('name')}
            placeholder="W. G. Lynch" />
          <span className="rl-hint">표와 인용에 쓰입니다. 하나는 있어야 합니다.</span>
        </Fld>
        <Fld label="풀네임">
          <input className="rl-in" style={{ width: 280 }} value={f.fullName || ''} onChange={set('fullName')}
            placeholder="William G Lynch" />
          <button type="button" className="rl-btn" disabled={!String(f.fullName || '').trim()}
            title="풀네임에서 줄임이름을 만듭니다"
            onClick={() => setF((s2) => ({ ...s2, name: abbrevName(s2.fullName) }))}>줄임이름으로</button>
        </Fld>
        <Fld label="BibTeX 표기">
          <input className="rl-in rl-mono" style={{ width: 280 }} value={f.bibName || ''}
            onChange={set('bibName')} placeholder="Lynch, W. G." />
          <button type="button" className="rl-btn" disabled={!String(f.bibName || '').trim()}
            title="BibTeX 표기에서 줄임이름을 만듭니다"
            onClick={() => setF((s2) => ({ ...s2, name: abbrevName(s2.bibName) }))}>줄임이름으로</button>
          <button type="button" className="rl-btn" disabled={!String(f.name || f.fullName || '').trim()}
            title="이름에서 BibTeX 순서를 만듭니다"
            onClick={() => setF((s2) => ({ ...s2, bibName: bibOrder(s2.fullName || s2.name) }))}>← 이름에서</button>
          <span className="rl-hint">성이 먼저인 형태. BibTeX 출력이 이 표기를 씁니다.</span>
        </Fld>
        <Fld label="handle">
          <span className="rl-tag">#{tag}</span>
          <input className="rl-in rl-mono" style={{ width: 150 }} value={f.tag || ''} onChange={set('tag')}
            placeholder={handleFor(named)} />
          {taken && <span className="rl-warn">이미 쓰는 handle입니다.</span>}
          <span className="rl-hint">논문의 저자 칸에 #{tag} 로 붙입니다.</span>
        </Fld>
        <Fld label="다른 표기">
          <TextRows value={f.aliases || []} add="+ 표기" placeholder="W.G. Lynch"
            onChange={(v) => setF((s) => ({ ...s, aliases: v }))} />
          <span className="rl-hint">저장하면 이렇게 적힌 줄도 연결됩니다.</span>
        </Fld>
        <Fld label="email">
          <input className="rl-in" style={{ width: 240 }} value={f.email || ''} onChange={set('email')} />
        </Fld>
        <Fld label="orcid">
          <input className="rl-in rl-mono" style={{ width: 200 }} value={f.orcid || ''} onChange={set('orcid')} />
        </Fld>
        <Fld label="메모">
          <textarea className="rl-in" rows={2} style={{ width: '100%', minWidth: 260 }}
            value={f.note || ''} onChange={set('note')} />
        </Fld>
        {!draft && (
          <Fld label="논문">
            <div className="rl-rows">
              <div className="rl-rrow">
                {ROLES.map(([role, label]) => {
                  const n = of(role).length
                  return (
                    <span key={role} className="rl-hint">
                      {label}{' '}
                      {n ? (
                        <button type="button" className="rl-lnk"
                          onClick={() => onOpenRole?.(rec, role)}>{n}</button>
                      ) : '0'}
                    </span>
                  )
                })}
                <span className="rl-hint">· 모두 {mine.length}편</span>
              </div>
              {mine.slice(0, 14).map((r) => (
                <div key={r.id} className="rl-rrow">
                  <button type="button" className="rl-lnk" onClick={() => onOpenRef?.(r.id)}>
                    {refLabel(r)}
                  </button>
                  <span className="rl-hint">
                    {autRoles(r, id).map((x) => ROLE_LABEL[x]).filter(Boolean).join(' · ')}
                  </span>
                </div>
              ))}
              {mine.length > 14 && <span className="rl-hint">… 모두 {mine.length}편</span>}
            </div>
          </Fld>
        )}
      </div>
      <RackActions key={id || 'new'} draft={draft}
        onCreate={create} createDisabled={!named || taken}
        hint={draft && !named ? '이름이 있어야 합니다.' : ''}
        onSave={update} saveDisabled={!named || taken} onCancel={onCancel}
        onRevert={() => setF(rec)} onDelete={isAdmin ? remove : null}
        deleteWarn={`이름은 논문 ${mine.length}편에 글자로 남습니다. 되돌릴 수 없습니다.`} />
    </div>
  )
}

/** A paper's file: where it is, and the three ways to say where.
 *
 *  A file picker cannot tell a web page a PATH — only its contents — so the
 *  path arrives by being dropped from Finder (a file:// URL), pasted (⌥⌘C
 *  copies one), or found: the file is named after the cite key, so the service
 *  looks for that name under the roots the project allows.
 */
function PdfRow({ value, citeKey, onChange, say }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const path = value?.path || ''
  const set = (p) => onChange(p ? { ...(value || {}), mode: 'path', path: p } : null)

  async function look() {
    const key = String(citeKey || '').trim()
    if (!key) { say('cite key가 있어야 찾을 수 있습니다.'); return }
    setBusy(true)
    try {
      const r = await fetch(`${PORTAL_BASE}/api/scan`, { headers: authHeaders() })
      const got = await r.json()
      const hits = got.files?.[key] || []
      if (!hits.length) { say(`허용 루트에 ${key}.pdf 가 없습니다.`); return }
      const sorted = [...hits].sort((a, b) => a.split('/').length - b.split('/').length)
      onChange({ mode: 'path', path: sorted[0], ...(sorted.length > 1 ? { copies: sorted.slice(1) } : {}) })
      say(hits.length > 1 ? `${hits.length}개 찾음 — 가장 바깥 것을 연결했습니다.` : '연결했습니다.')
    } catch (e) { say(String(e.message || e)) } finally { setBusy(false) }
  }

  return (
    <div className={`rl-rows${over ? ' rl-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false)
        const p = droppedPath(e)
        if (p) { set(p); say('경로를 받았습니다 — 허용 루트 안이어야 열립니다.') }
      }}>
      <div className="rl-rrow">
        <input className="rl-in rl-mono" style={{ width: 360 }} value={path}
          placeholder="Finder에서 끌어다 놓거나 경로를 붙여넣으세요"
          onChange={(e) => set(e.target.value)} />
        {path && (
          <>
            <a className="rl-btn" href={pdfSrc(path)} target="_blank" rel="noreferrer">열기</a>
            <a className="rl-btn" href={pdfSrc(path, true)} download>내려받기</a>
            {onThisMachine && (
              <button type="button" className="rl-btn"
                onClick={() => revealPdf(path, say)}>폴더에서 보기</button>
            )}
            <button type="button" className="rl-btn"
              onClick={() => copyPath(path, say)}>경로 복사</button>
            <button type="button" className="rl-x" title="연결 끊기" onClick={() => set('')}>×</button>
          </>
        )}
        {!path && (
          <button type="button" className="rl-btn rl-go" disabled={busy} onClick={look}>
            {busy ? '찾는 중…' : '찾기'}
          </button>
        )}
      </div>
      {(value?.copies || []).length > 0 && (
        <span className="rl-hint">사본 {value.copies.length}개: {value.copies.join(' · ')}</span>
      )}
    </div>
  )
}

// ─── Citations ──────────────────────────────────────────────────────────────
/** A paper's reference list. Entry 5 is either a paper in this list — press its
 *  number and you are reading it — or a line of text for one that is not here
 *  yet. Both are kept: a citation you cannot link is still a citation. */
function CiteRows({ value = [], refs, mine, onChange, onOpen }) {
  // citeKey → id, so the picker can be typed into and pasted into.
  const byLabel = useMemo(() => {
    const m = new Map()
    for (const r of refs) if (r.id !== mine) m.set(refLabel(r), r.id)
    return m
  }, [refs, mine])
  const labels = useMemo(() => [...byLabel.keys()].sort(), [byLabel])
  const labelOf = (id) => refLabel(refs.find((r) => r.id === id))
  const row = (i, patch) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((c, i) => {
        const linked = c.ref && refs.some((r) => r.id === c.ref)
        return (
          <div key={i} className="rl-rrow">
            <input className="rl-in rl-mono" style={{ width: 44 }} value={c.n ?? ''} placeholder="#"
              onChange={(e) => row(i, { n: e.target.value })} title="이 논문에서의 인용 번호" />
            <input className="rl-in" style={{ width: 240 }} list="rl-refs"
              value={linked ? labelOf(c.ref) : ''} placeholder="목록에서 찾기"
              onChange={(e) => {
                const id = byLabel.get(e.target.value.trim())
                // Typing over a link clears it; a name that matches makes one.
                row(i, id ? { ref: id, raw: '' } : { ref: '' })
              }} />
            {linked ? (
              <button type="button" className="rl-btn" onClick={() => onOpen?.(c.ref)}>열기</button>
            ) : (
              <input className="rl-in" style={{ width: 300 }} value={c.raw || ''}
                placeholder="J. Doe et al., PRC 99 (2019) 014601"
                onChange={(e) => row(i, { raw: e.target.value })} />
            )}
            <button type="button" className="rl-x" title="이 줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
          </div>
        )
      })}
      <datalist id="rl-refs">{labels.map((l) => <option key={l} value={l} />)}</datalist>
      <div className="rl-rrow">
        <button type="button" className="rl-btn"
          onClick={() => onChange([...value, { n: String(value.length + 1), ref: '', raw: '' }])}>
          + 참고문헌
        </button>
        <span className="rl-hint">
          {value.filter((c) => c.ref).length}개 연결 · {value.filter((c) => !c.ref && c.raw).length}개 글자만
        </span>
      </div>
    </div>
  )
}

/** Which papers cite this one. Counted, never stored: one fact in one place. */
function CitedBy({ refs, mine, onOpen }) {
  const users = refs.filter((r) => (r.cites || []).some((c) => c.ref === mine))
  if (!users.length) return <span className="rl-hint">없음</span>
  return (
    <div className="rl-rows">
      {users.map((r) => {
        const n = (r.cites || []).find((c) => c.ref === mine)?.n
        return (
          <div key={r.id} className="rl-rrow">
            <button type="button" className="rl-lnk" onClick={() => onOpen?.(r.id)}>{refLabel(r)}</button>
            {n ? <span className="rl-hint">[{n}]</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Fld({ label, children }) {
  return (<><span className="rl-fl">{label}</span><div className="rl-fv">{children}</div></>)
}

/** A list of plain strings — links — one line each. */
function TextRows({ value = [], onChange, add, placeholder, link }) {
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((v, i) => (
        <div key={i} className="rl-rrow">
          <input className="rl-in" style={{ width: 320 }} placeholder={placeholder} value={v}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          {link && /^https?:\/\//.test(v) && (
            <a href={v} target="_blank" rel="noreferrer" className="rl-hint">열기</a>
          )}
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="rl-btn" onClick={() => onChange([...value, ''])}>{add}</button>
    </div>
  )
}

/** Tags: the ones already in use are offered, a new one is just typed. A tag
 *  is a word, so the list of them is the list of words in use — there is
 *  nothing to create first. */
function TagRows({ value = [], onChange, options, main, onMain }) {
  const [add, setAdd] = useState('')
  const put = () => {
    const t = add.trim()
    if (!t) return
    if (!value.includes(t)) onChange([...value, t])
    setAdd('')
  }
  return (
    <div className="rl-rows">
      <div className="rl-rrow">
        {value.map((t) => (
          /* One tag is the MAIN one: it is what the cite key is filed under, so
             which it is has to be visible and choosable, not just first. */
          <span key={t} className={`rl-tag${onMain && t === main ? ' rl-main' : ''}`}>
            {onMain ? (
              <button type="button" className="rl-tagpick"
                title={t === main ? '메인 태그' : '메인 태그로'}
                onClick={() => onMain(t)}>{t}</button>
            ) : t}
            <button type="button" className="rl-x" title="이 태그 떼기"
              onClick={() => onChange(value.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        {value.length === 0 && <span className="rl-hint">없음</span>}
      </div>
      <div className="rl-rrow">
        <input className="rl-in" style={{ width: 220 }} list="rl-tags" value={add}
          placeholder="태그" onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); put() } }} />
        <datalist id="rl-tags">{options.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="button" className="rl-btn" onClick={put} disabled={!add.trim()}>+ 태그</button>
      </div>
    </div>
  )
}

// ─── Pasting a citation ─────────────────────────────────────────────────────
/** What a publisher's site hands you is a BibTeX entry or a RIS block, so
 *  typing the fields again is work a parser can do. Anything it cannot read is
 *  left for the fields you already filled — a partial read beats a refusal. */
function parseCitation(text) {
  const t = String(text || '').trim()
  if (!t) return null
  return /^TY\s{2}-|\nTY\s{2}-/.test(t) ? parseRis(t) : parseBib(t)
}
/** The value of one BibTeX field, brace-balanced: a title with {$^{12}$C} in it
 *  ends at ITS closing brace, not at the first one. */
function bibField(src, key) {
  const m = new RegExp(`[,{]\\s*${key}\\s*=\\s*`, 'i').exec(src)
  if (!m) return ''
  let i = m.index + m[0].length
  const open = src[i]
  if (open === '{' || open === '"') {
    const close = open === '{' ? '}' : '"'
    let depth = 0, out = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{' || (c === '"' && open === '"' && depth === 0)) { depth++; if (depth === 1) continue }
      if (c === close) { depth--; if (depth === 0) break }
      out += c
    }
    return out.replace(/\s+/g, ' ').trim()
  }
  return (src.slice(i).match(/^[^,}\n]+/) || [''])[0].trim()
}
function parseBib(src) {
  const head = /@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(src)
  const got = {
    type: head && /thesis/i.test(head[1]) ? 'thesis' : 'paper',
    citeKey: head ? head[2] : '',
    title: bibField(src, 'title'),
    author: bibField(src, 'author'),
    journal: bibField(src, 'journal') || bibField(src, 'journaltitle') || bibField(src, 'booktitle'),
    volume: bibField(src, 'volume'),
    pages: bibField(src, 'pages'),
    year: bibField(src, 'year') || (bibField(src, 'date').match(/\d{4}/) || [''])[0],
    doi: bibField(src, 'doi'),
    url: bibField(src, 'url'),
  }
  const eprint = bibField(src, 'eprint')
  if (eprint && !got.journal) { got.journal = 'arXiv'; got.volume = got.volume || eprint }
  return got
}
const RIS = { TI: 'title', T1: 'title', JO: 'journal', JF: 'journal', T2: 'journal',
  VL: 'volume', PY: 'year', Y1: 'year', DO: 'doi', UR: 'url', SP: 'pages', EP: 'end' }
function parseRis(src) {
  const got = { type: 'paper', citeKey: '', author: '', title: '', journal: '',
    volume: '', pages: '', year: '', doi: '', url: '' }
  const authors = []
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{2}-\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const [, tag, val] = m
    if (tag === 'AU' || tag === 'A1') { if (val) authors.push(val) }
    else if (RIS[tag] && val) {
      if (RIS[tag] === 'year') got.year = (val.match(/\d{4}/) || [val])[0]
      else if (RIS[tag] === 'end') got.pages = got.pages ? `${got.pages}-${val}` : val
      else if (!got[RIS[tag]]) got[RIS[tag]] = val
    } else if (tag === 'TY' && /THES/i.test(val)) got.type = 'thesis'
  }
  got.author = authors.join(' and ')
  return got
}

/** Paste a citation, see what it read, take it or leave it. */
function PasteBox({ onTake, say }) {
  const [text, setText] = useState('')
  const got = useMemo(() => parseCitation(text), [text])
  const found = got ? Object.entries(got).filter(([, v]) => v) : []
  return (
    <div className="rl-rows">
      <textarea className="rl-in rl-mono" rows={4} style={{ width: '100%', minWidth: 260 }}
        placeholder="BibTeX 또는 RIS를 붙여넣으세요" value={text}
        onChange={(e) => setText(e.target.value)} />
      <div className="rl-rrow">
        <button type="button" className="rl-btn rl-go" disabled={found.length < 2}
          onClick={() => {
            onTake(got)
            say(`${found.length}개 항목을 읽었습니다.`)
            setText('')
          }}>읽어서 채우기</button>
        <button type="button" className="rl-btn" disabled={!text} onClick={() => setText('')}>지우기</button>
        <span className="rl-hint">
          {text ? (found.length ? found.map(([k]) => k).join(' · ') : '읽을 수 있는 항목이 없습니다.') : ''}
        </span>
      </div>
    </div>
  )
}

const TYPES = ['paper', 'thesis', 'report', 'writing']

function EditRef({ ref_, doc, tags, onSave, isAdmin, onCreated, onDeleted, onDone, onCancel, onOpen, say }) {
  /** Registering the author on this row registers them everywhere: the record
   *  is created and every row in every paper that spells the name this way
   *  points at it. That is the whole convenience — 44 rows saying
   *  'W. G. Lynch' become 44 links in one press. */
  async function registerAuthor(name) {
    const clean = String(name || '').trim()
    if (!clean) return
    const existing = (doc.authors || []).find((a) => a.name === clean
      || (a.aliases || []).includes(clean))
    const rec = existing || (() => {
      const taken = new Set((doc.authors || []).map((a) => a.tag))
      let tag = handleFor(clean), n = 2
      while (taken.has(tag)) tag = `${handleFor(clean)}${n++}`
      return { id: newId(), tag, name: clean, aliases: [], email: '', orcid: '', note: '' }
    })()
    const link = (rows) => (rows || []).map((a) => (!a.ref && (a.name === clean
      || (rec.aliases || []).includes(a.name)) ? { ...a, ref: rec.id } : a))
    const patch = {
      authors: existing ? doc.authors : [...(doc.authors || []), rec],
      references: doc.references.map((r) => ({ ...r, authors: link(r.authors) })),
    }
    // The form's own rows are linked straight away, so the field does not wait
    // for the document to come back.
    setF((s) => ({ ...s, authors: link(s.authors) }))
    const hits = doc.references.reduce((n, r) => n + (r.authors || [])
      .filter((a) => !a.ref && a.name === clean).length, 0)
    await onSave(patch, existing
      ? `${rec.tag} 로 연결 · ${hits}줄`
      : `${rec.tag} 등록 · ${hits}줄 연결`)
  }

  // No record means a DRAFT: the same form, and saving puts it in the document
  // rather than over one.
  const draft = !ref_
  const blank = { id: null, type: 'paper', citeKey: '', title: '', author: '', journal: '',
    volume: '', pages: '', year: '', doi: '', url: '', tags: [], mainTag: '',
    cites: [], links: [], note: '', pdf: null }
  const [f, setF] = useState(ref_ || blank)
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => (draft ? create() : update(true)) })
  useEffect(() => { setF(ref_ || blank) }, [ref_])  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const named = () => (f.citeKey || '').trim() || (f.title || '').trim()
  const jrnNames = (doc.journals || []).map((j) => j.name)

  // The key a paper would be given by the rule, and whether somebody already
  // has it. A key that exists is not refused — two papers really can be the
  // same author, journal and year — but it is said out loud.
  const suggested = citeKeyFor(doc, f)
  const taken = (f.citeKey || '').trim()
    && (doc.references || []).some((r) => r.citeKey === f.citeKey.trim() && r.id !== f.id)
  // A key you typed is yours. One you never touched, on a NEW paper, writes
  // itself as the fields that make it arrive — the papers already in the list
  // keep the names their files are under.
  const keyTyped = useRef(false)
  useEffect(() => { keyTyped.current = false }, [ref_])
  useEffect(() => {
    if (draft && !keyTyped.current && suggested && f.citeKey !== suggested) {
      setF((s2) => ({ ...s2, citeKey: suggested }))
    }
  }, [draft, suggested])   // eslint-disable-line react-hooks/exhaustive-deps

  // A half-typed line is not data: blank strings are dropped on the way out.
  const tidy = (r) => ({
    ...r,
    citeKey: String(r.citeKey || '').trim(),
    tags: (r.tags || []).map((x) => String(x).trim()).filter(Boolean),
    mainTag: tagsOf(r).includes(r.mainTag) ? r.mainTag : '',
    links: (r.links || []).map((x) => String(x).trim()).filter(Boolean),
  })
  const label = (r) => r.citeKey || (r.title || '').slice(0, 24) || '논문'

  async function create() {
    if (!named()) return
    const now = new Date().toISOString()
    const r = { ...tidy(f), id: newId(), createdAt: now, updatedAt: now }
    if (await onSave({ references: [r, ...doc.references] }, `${label(r)} 등록됨`)) onCreated?.(r.id, label(r))
  }
  async function update(keep) {
    const ok = await onSave({
      references: doc.references.map((r) => (r.id === f.id
        ? { ...tidy(f), updatedAt: new Date().toISOString() } : r)),
    })
    // The record was an errand, not a destination: a save that landed closes
    // the tab it came from.
    if (ok && !keep) onDone?.(f.id)
  }
  async function remove() {
    // A paper other papers cite is removed from their citation lists too, or
    // they would point at nothing.
    const refs = doc.references.filter((r) => r.id !== f.id).map((r) => (
      (r.cites || []).some((c) => c.ref === f.id)
        ? { ...r, cites: r.cites.map((c) => (c.ref === f.id ? { ...c, ref: '' } : c)) } : r))
    if (await onSave({ references: refs }, `${label(f)} 삭제됨`)) onDeleted?.(f.id)
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        {draft && (
          <Fld label="붙여넣기">
            <PasteBox say={say} onTake={(got) => setF((s) => {
              const { author, ...rest } = got
              return { ...s, ...rest,
                // The parser reads ONE string; this form keeps rows.
                authors: splitAuthors(author).map((n) => ({ name: n, ref: '', corr: false })),
                // A journal we already know keeps its record's spelling.
                journal: jrnNames.find((n) => n.toLowerCase() === (got.journal || '').toLowerCase())
                  || got.journal || s.journal }
            })} />
          </Fld>
        )}
        <Fld label="종류">
          <select className="rl-in" value={f.type || 'paper'} onChange={set('type')}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Fld>
        <Fld label="cite key">
          <input className="rl-in rl-mono" style={{ width: 300 }} value={f.citeKey || ''}
            onChange={(e) => { keyTyped.current = true; set('citeKey')(e) }}
            placeholder={suggested || 'JAlmeid_ApJ_1983'} />
          <button type="button" className="rl-btn" disabled={!suggested || f.citeKey === suggested}
            title={`${KEY_RULE} → ${suggested || ''}`}
            onClick={() => { keyTyped.current = true; setF((s2) => ({ ...s2, citeKey: suggested })) }}>
            자동
          </button>
          <span className="rl-hint rl-mono">{KEY_RULE}</span>
          {taken && <span className="rl-warn">같은 키의 논문이 있습니다.</span>}
        </Fld>
        <Fld label="제목">
          <textarea className="rl-in" rows={2} style={{ width: '100%', minWidth: 260 }}
            value={f.title || ''} onChange={set('title')} />
        </Fld>
        <Fld label="저자">
          <AuthorRows value={f.authors || []} doc={doc} onRegister={registerAuthor}
            onChange={(v) => setF((s) => ({ ...s, authors: v }))} />
        </Fld>
        <Fld label="저널">
          <input className="rl-in" style={{ width: 300 }} list="rl-jrns" value={f.journal || ''}
            onChange={set('journal')} />
          <datalist id="rl-jrns">{jrnNames.map((n) => <option key={n} value={n} />)}</datalist>
          {f.journal && !jrnNames.includes(f.journal) && (
            <span className="rl-hint">목록에 없는 저널입니다 — journals 탭에서 등록하면 약어가 붙습니다.</span>
          )}
        </Fld>
        <Fld label="권 · 면 · 해">
          <input className="rl-in" style={{ width: 80 }} value={f.volume || ''} onChange={set('volume')} placeholder="volume" />
          <input className="rl-in" style={{ width: 110 }} value={f.pages || ''} onChange={set('pages')} placeholder="pages" />
          <input className="rl-in" style={{ width: 70 }} value={f.year || ''} onChange={set('year')} placeholder="year" />
        </Fld>
        <Fld label="doi">
          <input className="rl-in rl-mono" style={{ width: 300 }} value={f.doi || ''} onChange={set('doi')} />
          {f.doi && <a className="rl-hint" href={`https://doi.org/${f.doi}`} target="_blank" rel="noreferrer">열기</a>}
        </Fld>
        <Fld label="url">
          <input className="rl-in" style={{ width: 320 }} value={f.url || ''} onChange={set('url')} />
          {/^https?:\/\//.test(f.url || '') && (
            <a className="rl-hint" href={f.url} target="_blank" rel="noreferrer">열기</a>
          )}
        </Fld>
        <Fld label="태그">
          <TagRows value={f.tags || []} options={tags} main={mainTag(f)}
            onMain={(t) => setF((s) => ({ ...s, mainTag: t }))}
            onChange={(v) => setF((s) => ({ ...s, tags: v }))} />
          <span className="rl-hint">태그를 누르면 메인 태그 — cite key의 {'{tag}'} 자리입니다.</span>
        </Fld>
        {!draft && (
          <Fld label="참고문헌">
            <CiteRows value={f.cites || []} refs={doc.references} mine={f.id} onOpen={onOpen}
              onChange={(v) => setF((s) => ({ ...s, cites: v }))} />
          </Fld>
        )}
        {!draft && (
          <Fld label="인용한 논문">
            <CitedBy refs={doc.references} mine={f.id} onOpen={onOpen} />
          </Fld>
        )}
        <Fld label="pdf">
          <PdfRow value={f.pdf} citeKey={f.citeKey} say={say}
            onChange={(v) => setF((s) => ({ ...s, pdf: v }))} />
        </Fld>
        <Fld label="링크">
          <TextRows value={f.links || []} add="+ 링크" placeholder="https://…" link
            onChange={(v) => setF((s) => ({ ...s, links: v }))} />
        </Fld>
        <Fld label="메모">
          <textarea className="rl-in" rows={2} style={{ width: '100%', minWidth: 260 }}
            value={f.note || ''} onChange={set('note')} />
        </Fld>
      </div>
      <RackActions key={ref_?.id || 'new'} draft={draft}
        onCreate={create} createDisabled={!named()}
        hint={draft && !named() ? 'cite key나 제목 하나는 있어야 합니다.' : ''}
        onSave={update} onCancel={onCancel} onRevert={() => setF(ref_)}
        onDelete={isAdmin ? remove : null} />
    </div>
  )
}

function EditJournal({ name, doc, onSave, isAdmin, onCreated, onDone, onCancel }) {
  const draft = !name
  const rec = draft ? null : (doc.journals || []).find((j) => j.name === name)
  const blank = { name: '', shortName: '', abbrev: '', publisher: '', issn: '', url: '' }
  const [f, setF] = useState(rec || blank)
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => (draft ? create() : update(true)) })
  useEffect(() => { setF(rec || blank) }, [name, rec])  // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft && !rec) return <p className="rl-msg">그 저널을 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const named = String(f.name || '').trim()
  const taken = (doc.journals || []).some((j) => j.name === named && j.name !== rec?.name)
  // How many papers point at this name: the number that decides whether a
  // rename is a tidy-up or an edit to two dozen records.
  const users = (doc.references || []).filter((r) => r.journal === name).length

  function create() {
    if (!named || taken) return
    const j = { ...f, name: named, shortName: (f.shortName || named).trim() }
    if (onSave({ journals: [...(doc.journals || []), j] }, `저널 '${named}' 등록됨`)) onCreated?.(named)
  }
  async function update(keep) {
    const j = { ...f, name: named, shortName: (f.shortName || named).trim() }
    // A journal is referenced by its name, so a rename has to travel to every
    // paper that names it — otherwise they point at a journal that is gone.
    const ok = await onSave({
      journals: (doc.journals || []).map((x) => (x.name === rec.name ? j : x)),
      references: named === rec.name ? doc.references
        : doc.references.map((r) => (r.journal === rec.name ? { ...r, journal: named } : r)),
    }, named === rec.name ? '저장했습니다.' : `'${rec.name}' → '${named}' · 논문 ${users}편도 함께`)
    if (ok && !keep) onDone?.(named)
  }
  async function remove() {
    // The papers keep their journal text: deleting the record loses the
    // abbreviation, not the fact of where it was published.
    if (await onSave({ journals: (doc.journals || []).filter((x) => x.name !== rec.name) },
      `저널 '${rec.name}' 삭제됨`)) onDone?.(rec.name)
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        <Fld label="이름">
          <input className="rl-in" style={{ width: 320 }} value={f.name || ''} onChange={set('name')}
            placeholder="The Astrophysical Journal" />
          {taken && <span className="rl-warn">같은 이름의 저널이 있습니다.</span>}
        </Fld>
        <Fld label="짧은 이름">
          <input className="rl-in" style={{ width: 120 }} value={f.shortName || ''} onChange={set('shortName')}
            placeholder="ApJ" />
          <span className="rl-hint">표의 jl 열에 나옵니다.</span>
        </Fld>
        <Fld label="축약 이름">
          <input className="rl-in" style={{ width: 240 }} value={f.abbrev || ''} onChange={set('abbrev')}
            placeholder="Astrophys. J." />
          <span className="rl-hint">인용에 쓰입니다.</span>
        </Fld>
        <Fld label="발행처">
          <input className="rl-in" style={{ width: 240 }} value={f.publisher || ''} onChange={set('publisher')} />
        </Fld>
        <Fld label="issn">
          <input className="rl-in rl-mono" style={{ width: 140 }} value={f.issn || ''} onChange={set('issn')} />
        </Fld>
        <Fld label="url">
          <input className="rl-in" style={{ width: 320 }} value={f.url || ''} onChange={set('url')} />
        </Fld>
      </div>
      <RackActions key={name || 'new'} draft={draft}
        onCreate={create} createDisabled={!named || taken}
        hint={draft ? (named ? '' : '이름이 있어야 합니다.') : `${users}편이 이 저널입니다.`}
        onSave={update} saveDisabled={!named || taken} onCancel={onCancel}
        onRevert={() => setF(rec)} onDelete={isAdmin ? remove : null}
        deleteWarn="논문의 저널 이름은 글자로 남습니다. 되돌릴 수 없습니다." />
    </div>
  )
}

/** A tag has no record: it is a word on some papers. So editing one is
 *  renaming it everywhere, merging it into another, or taking it off. */
function EditTag({ name, doc, tags, onSave, isAdmin, onDone, onCancel }) {
  const [to, setTo] = useState(name)
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => rename(true) })
  useEffect(() => { setTo(name) }, [name])
  const users = (doc.references || []).filter((r) => (r.tags || []).includes(name))
  const named = String(to || '').trim()
  const merging = named && tags.includes(named) && named !== name

  async function rename(keep) {
    if (!named || named === name) return
    const refs = doc.references.map((r) => {
      if (!(r.tags || []).includes(name)) return r
      const next = []
      for (const t of r.tags) {
        const v = t === name ? named : t
        if (!next.includes(v)) next.push(v)     // merging into a tag it already has
      }
      return { ...r, tags: next }
    })
    const said = merging
      ? `'${name}' → '${named}'에 합쳤습니다 · 논문 ${users.length}편`
      : `'${name}' → '${named}' · 논문 ${users.length}편`
    if (await onSave({ references: refs }, said) && !keep) onDone?.(name)
  }
  async function remove() {
    const refs = doc.references.map((r) => ((r.tags || []).includes(name)
      ? { ...r, tags: r.tags.filter((t) => t !== name) } : r))
    if (await onSave({ references: refs }, `'${name}' 태그를 ${users.length}편에서 뗐습니다.`)) onDone?.(name)
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        <Fld label="태그">
          <input className="rl-in" style={{ width: 260 }} list="rl-tags-all" value={to || ''}
            onChange={(e) => setTo(e.target.value)} />
          <datalist id="rl-tags-all">{tags.map((t) => <option key={t} value={t} />)}</datalist>
          {merging && <span className="rl-hint">이미 있는 태그입니다 — 합쳐집니다.</span>}
        </Fld>
        <Fld label="쓰는 논문">
          <div className="rl-rows">
            {users.length === 0 && <span className="rl-hint">없음</span>}
            {users.slice(0, 12).map((r) => (
              <span key={r.id} className="rl-hint">{r.citeKey || (r.title || '').slice(0, 40)}</span>
            ))}
            {users.length > 12 && <span className="rl-hint">… 모두 {users.length}편</span>}
          </div>
        </Fld>
      </div>
      <RackActions key={name}
        saveLabel={merging ? '합치고 나가기' : 'save and exit'}
        onSave={rename} saveDisabled={!named || named === name}
        onCancel={onCancel} onRevert={() => setTo(name)}
        onDelete={isAdmin ? remove : null}
        deleteWarn={`논문 ${users.length}편에서 이 태그를 뗍니다. 되돌릴 수 없습니다.`} />
    </div>
  )
}
