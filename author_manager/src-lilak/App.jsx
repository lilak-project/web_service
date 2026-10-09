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
 * The table itself, the tabs, the selection and the portal plumbing are the
 * kit's `racklist` — shared with reference_manager, which is the same shape of
 * service with different records. What stays here is what makes this one about
 * AUTHORS: the columns, the accessors behind them, the listing tokens and the
 * two editors.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs, RackActions,
  useColumnWidths, useViewportWidth, useSelection, usePaneSplit, useRackKeys, useFindKey, useToggleKey, useNote, useViewState,
  bySome, fill as fillTpl, useFacetFilter, FilterBar, FacetRows,
  PORTAL_PROJECT, brandStyle, projectKey, load, save, isManager, newId, fetchDoc, putDoc,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'

const WIDTH_KEY = projectKey('am', 'cols')
const VIEW_KEY = projectKey('am', 'view')
const IS_ADMIN = isManager()

// ─── The fields a row shows ─────────────────────────────────────────────────
// A name is spelled in ONE place: nm./last/first/init are worked out from the
// English parts rather than stored, so they cannot drift from `name`.
// 성 and 이름 are stored apart and written together, the way a Korean name is
// written: 한인식.
const korName = (a) => `${(a.korFamily || '').trim()}${(a.korGiven || '').trim()}`
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

// Where someone is NOW. A person can be in two places at once (곽민식 is at
// IRIS and at UST), so "current" is a FLAG on the entry, not the latest date —
// a date can only name one winner. An entry written before the flag existed is
// current: that is what it meant.
const isCurrent = (x) => x.current !== false
const currentAffs = (a) => (a.affiliations || []).filter((x) => x.tag && isCurrent(x))
/** The first of them, for the places that can only say one — a paper's
 *  superscript, the email a row falls back to. */
function currentAff(a) {
  return currentAffs(a)[0] || null
}
/** What the affiliation cell says. Two current places read as both; a person
 *  with a history but nothing current reads 모름, which is not the same as the
 *  blank of someone who never had one. */
const AFF_UNKNOWN = '모름'
function affilText(a) {
  const now = currentAffs(a)
  if (now.length) return now.map((x) => x.tag).join(', ')
  return (a.affiliations || []).some((x) => x.tag) ? AFF_UNKNOWN : ''
}
/** The email a row shows: the one typed as the representative, and nothing
 *  else. It used to fall back to the current affiliation's address, which meant
 *  changing where someone works silently changed the address on screen — a
 *  mail going somewhere nobody chose. A blank here means nobody has said. */
const repEmail = (a) => a.repEmail || ''
/** The smallest group `core`: where the author sits in a paper's author list
 *  when no one group is being looked at. */
function coreOf(a) {
  const cores = (a.groups || []).map((g) => Number(g.core)).filter((n) => Number.isFinite(n) && n >= 1)
  return cores.length ? Math.min(...cores) : null
}
/** That ONE group's core. A core is assigned per group: outside a group's tab
 *  there is no single number to show. */
function coreIn(a, group) {
  const n = Number((a.groups || []).find((g) => g.group === group)?.core)
  return Number.isFinite(n) && n >= 1 ? n : null
}
// An author's affiliation entry keys its affiliation as `tag`; its group entry
// keys the group as `group`. The class records carry `name` (and `shortName`).
const inAff = (a, tag) => (a.affiliations || []).some((x) => x.tag === tag)
const inGrp = (a, name) => (a.groups || []).some((g) => g.group === name)

/** Names in name order, Korean collation — the lists are in both scripts. */
const byName = (list) => [...list].sort((a, b) => String(a).localeCompare(String(b), 'ko'))

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
  { k: 'nm', w: 112, min: 60, label: 'abv-name', drop: 1040 },
  { k: 'email', w: 214, min: 90, label: 'email' },
  { k: 'pos', w: 176, min: 70, label: 'position', drop: 860 },
  // When the record was made, and when it last changed. The only two things
  // here the document knows and nobody typed — one asks who is new, the other
  // what has been seen to lately.
  { k: 'reg', w: 84, min: 62, label: '등록일', drop: 1180 },
  { k: 'upd', w: 84, min: 62, label: '수정일', drop: 1320 },
  { k: 'core', w: 44, min: 34, label: 'core', num: true },
]
const CLS_COLS = [
  { k: 'num', w: 34, min: 26, fix: true, label: '#' },
  { k: 'name', w: 200, min: 80, label: 'name' },
  { k: 'count', w: 70, min: 46, label: 'people', num: true },
  // Only a group has these: an affiliation is not of a kind, and does not run
  // from a date to a date.
  { k: 'type', w: 110, min: 70, label: 'type', group: true },
  { k: 'when', w: 160, min: 70, label: '기간', group: true },
  { k: 'full', w: 280, min: 90, label: 'full name' },
]

// ─── The listing rule ───────────────────────────────────────────────────────
// A "나열" button does not produce text: it fills in a TEMPLATE, and the
// template is what produces the text. So a preset is a starting point you can
// then edit — `"{이름}" <{email}>` is a rule, not a button somebody has to
// come and add. The tokens are the column names, which is what the reader
// already has in front of them.
const TOKENS = {
  affiliation: (a) => affilText(a),
  이름: (a) => korName(a),
  name: (a) => engName(a),
  'abv-name': (a) => citeShort(a),
  email: (a) => repEmail(a),
  position: (a) => currentAffs(a).map((x) => x.position).filter(Boolean).join(', '),
  core: (a) => coreOf(a) ?? '',
  last: (a) => citeLast(a),
  first: (a) => citeFirst(a),
  init: (a) => citeInit(a),
  nick: (a) => a.nick || '',
}
const fill = (tpl, a) => fillTpl(tpl, a, TOKENS)
// What a column sorts by. The same accessors the cells use, so the order you
// get is the order you can see.
const SORTERS = {
  affil: (a) => affilText(a),
  kor: (a) => korName(a),
  name: (a) => engName(a) || a.nick || '',
  nm: (a) => citeShort(a),
  email: (a) => repEmail(a),
  pos: (a) => currentAffs(a).map((x) => x.position).filter(Boolean).join(', '),
  reg: (a) => a.createdAt || '',
  upd: (a) => a.updatedAt || '',
  core: (a) => coreOf(a),
  last: (a) => citeLast(a),
  first: (a) => citeFirst(a),
  init: (a) => citeInit(a),
}
const byColumn = (k, dir, group) =>
  bySome(k === 'core' && group ? (a) => coreIn(a, group) : SORTERS[k], dir)
// The classes' own columns. Same machinery, three keys.
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count, full: (r) => r.full,
  // The first day is what a list of groups is ordered by; the end is a detail.
  when: (r) => r.start, type: (r) => r.type }
/** '2026-11-16 ~ 11-18' — the year is said once when both days share it. */
const spanOf = (from, to) => {
  const a = String(from || '').trim(), b = String(to || '').trim()
  if (!a && !b) return ''
  if (!b) return a
  if (!a) return `~ ${b}`
  return `${a} ~ ${b.slice(0, 4) === a.slice(0, 4) ? b.slice(5) : b}`
}
/** Which columns are the record's own words (ink) and which are about it (dim). */
const TONE = { name: 'ink', affil: 'dim', pos: 'dim', nm: 'dim', reg: 'dim', upd: 'dim', when: 'dim', type: 'dim' }
/** What a group IS. A paper's author list is assembled for different reasons,
 *  and a list of fifteen groups is unreadable without saying which is which. */
const GROUP_TYPES = [
  ['organization', '조직 · 팀 (CENS, IRIS 실험장치팀)'],
  ['experiment', '실험 (STARK, PKU, RAON, KO-25-20)'],
  ['presentation', '발표 · 포스터 (ICABU, INPC)'],
  ['project', '과제'],
  ['other', '그 밖'],
]

const PRESETS = [
  ['이름 나열', '{이름}'],
  ['full names', '{name}'],
  ['abv. names', '{abv-name}'],
  ['email list', '"{name}" <{email}>'],
]

// ─── Tabs ───────────────────────────────────────────────────────────────────
const FIXED = [
  // The id stays 'total' — it is in everyone's stored view state — but the
  // label says what the tab lists.
  { id: 'total', kind: 'authors', label: 'authors' },
  { id: 'groups', kind: 'classes', label: 'groups', of: 'group' },
  { id: 'affiliation', kind: 'classes', label: 'affiliation', of: 'affiliation' },
]

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
  const { drag, sized } = useColumnWidths(WIDTH_KEY, [...COLS, ...CLS_COLS])
  const vw = useViewportWidth()
  const split = usePaneSplit(projectKey('am', 'split'))
  const [groupForm, setGroupForm] = useState(null)   // the new-group form, when open
  // null = the tab's own order: 한글 이름, or My List's own sequence.
  const [sort, setSort] = useState(VIEW.sort || null)
  const [clsSort, setClsSort] = useState(VIEW.clsSort || { k: 'name', dir: 1 })
  const [outOpen, setOutOpen] = useState(false)   // the listing drawer
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  // The four fixed tabs are not worth storing; picking mode is not a state you
  // come back to, so only the applied filter is kept.
  // A tab for a group or an affiliation that is no longer in the document
  // cannot be shown; it goes, and takes you back to total if you were on it.
  // Nor can one of a kind that no longer exists (My List was a tab once), so an
  // opened tab has to name a scope this service still has.
  useEffect(() => {
    if (!doc) return
    const alive = (t) => {
      if (FIXED.some((f) => f.id === t.id)) return true
      if (t.grp) return (doc.groups || []).some((r) => r.name === t.grp)
      if (t.aff) return (doc.affiliations || []).some((r) => r.name === t.aff)
      return false
    }
    setTabs((ts) => (ts.every(alive) ? ts : ts.filter(alive)))
  }, [doc])
  useEffect(() => {
    if (!tabs.some((t) => t.id === active)) setActive('total')
  }, [tabs, active])

  const authors = doc?.authors || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

  // core belongs to ONE group, so it is only a column inside a group's tab.
  const cols = useMemo(() => sized(COLS.filter((c) => c.k !== 'core' || !!tab?.grp), vw),
    [sized, vw, tab])
  const clsCols = useMemo(
    () => sized(CLS_COLS.filter((c) => !c.group || tab?.of === 'group'), vw, 'c:'),
    [sized, vw, tab])

  // Which authors a tab is about, before the search narrows them. Takes the
  // tab, because an edit beside its list needs BOTH on screen.
  const scopeOf = useCallback((tab) => {
    if (tab?.kind !== 'authors') return []
    let list = authors
    if (tab.aff) list = list.filter((a) => inAff(a, tab.aff))
    if (tab.grp) list = list.filter((a) => inGrp(a, tab.grp))
    // No column clicked: the order an author list is written in — core first,
    // then by family name. On a group's tab that group's core is the one that
    // counts, which is the only core that means anything there.
    if (!sort) return [...list].sort(byPaperOrder(tab.grp ? (a) => coreIn(a, tab.grp) : coreOf))
    return [...list].sort(byColumn(sort.k, sort.dir, tab.grp))
  }, [authors, sort])
  const scope = useMemo(() => scopeOf(tab), [scopeOf, tab])

  const filter = useFacetFilter(scope, SORTERS, { sel: VIEW.fsel, on: VIEW.fon })
  // Declared after the filter, because its deps read from it — a dependency
  // array is evaluated where it is written.
  useEffect(() => {
    saveView({ tabs: tabs.filter((t) => !FIXED.some((x) => x.id === t.id)),
               active, sort, clsSort, fsel: filter.sel, fon: filter.on })
  }, [tabs, active, sort, clsSort, filter.sel, filter.on])   // eslint-disable-line react-hooks/exhaustive-deps

  const rowsOf = useCallback((sc) => {
    const kept = filter.on ? sc.filter(filter.passes) : sc
    const q = query.trim().toLowerCase()
    if (!q) return kept
    // The name with its spaces taken out is searched too: a transliterated
    // name is written 히로시 와타나베 and typed 히로시와타나베 as often as not.
    return kept.filter((a) => [korName(a), korName(a).replace(/\s+/g, ''), engName(a), a.nick, repEmail(a),
      ...(a.affiliations || []).flatMap((x) => [x.tag, x.position, x.dept]),
      ...(a.groups || []).map((g) => g.group)]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [query, filter.on, filter.passes])
  const rows = useMemo(() => rowsOf(scope), [rowsOf, scope])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)
  // ⌘Enter: whatever the search has left on screen, take it all — or put it
  // all back. The same thing the head checkbox does, without leaving the keys.
  useToggleKey(() => {
    if (!rows.length) return
    toggleAll()
    setNote(allPicked ? `${rows.length}명 선택 해제` : `${rows.length}명 선택`)
  })

  // The editor pane takes the right half when there is room for both; below
  // that it has the width to itself while it is open, and closing its last tab
  // gives the list back.
  const etab = etabs.find((t) => t.id === eactive) || null
  const wide = vw >= 1180
  const showEdit = !!etab
  const showList = !showEdit || wide

  // Counted over the tab's own authors, not the filtered ones: a value that
  // would empty the list is still worth seeing.

  const classesOf = useCallback((t) => {
    if (t?.kind !== 'classes') return []
    const recs = (t.of === 'affiliation' ? doc?.affiliations : doc?.groups) || []
    return recs.map((r) => ({
      name: r.name,
      full: r.fullName || '',
      start: r.creationDate || '',
      when: spanOf(r.creationDate, r.endDate),
      type: r.type || '',
      count: authors.filter((a) => (t.of === 'affiliation' ? inAff(a, r.name) : inGrp(a, r.name))).length,
    })).sort(bySome(CLS_SORTERS[clsSort.k] || CLS_SORTERS.name, clsSort.dir))
  }, [doc, authors, clsSort])
  const classes = useMemo(() => classesOf(tab), [classesOf, tab])

  // ── tabs ──
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
    onNew: () => (tab?.kind === 'classes'
      ? openEdit({ id: `newcls:${tab.of}`, kind: 'editcls', of: tab.of, who: null,
          label: tab.of === 'affiliation' ? '새 소속' : '새 그룹' })
      : openEdit({ id: 'new', kind: 'edit', label: '새 저자', who: null })),
  })

  function closeEdit(id) {
    setEtabs((ts) => {
      const left = ts.filter((t) => t.id !== id)
      if (id === eactive) setEactive(left.length ? left[left.length - 1].id : null)
      return left
    })
  }

  /** The menu reads in name order, not in the order groups were made: you are
   *  looking for one, and the document's order is not a thing anyone knows. */
  const groupNames = useMemo(() => byName((doc?.groups || []).map((g) => g.name)), [doc])

  /** The people the two group buttons act on: the ones you ticked. A tab is a
   *  question (who is in CENS?); the selection is an answer you assembled, and
   *  that is what goes into a group. */
  const chosen = useMemo(() => scope.filter((a) => picked.has(a.id)), [scope, picked])

  // Adding people to a group that already exists is the same edit make group
  // makes, minus inventing the group: pick it and the members go in.
  function addToGroup(name) {
    if (!name) return
    const fresh = chosen.filter((a) => !inGrp(a, name))
    if (!chosen.length) { setNote('선택된 저자가 없습니다.'); return }
    if (!fresh.length) { setNote(`이미 모두 '${name}'에 있습니다.`); return }
    const ids = new Set(fresh.map((a) => a.id))
    commit({
      authors: doc.authors.map((a) => (ids.has(a.id)
        ? { ...a, groups: [...(a.groups || []), { group: name, role: '', core: 10 }] }
        : a)),
    }, `'${name}'에 ${fresh.length}명 추가`)
  }

  /** Out of the group whose tab you are on. The button says how many, which is
   *  the whole confirmation it needs: putting them back is the menu next to it.
   *  Only this group's entry goes — the people and their other groups stay. */
  function removeFromGroup(name) {
    const out = chosen.filter((a) => inGrp(a, name))
    if (!out.length) { setNote('선택된 저자가 없습니다.'); return }
    const ids = new Set(out.map((a) => a.id))
    commit({
      authors: doc.authors.map((a) => (ids.has(a.id)
        ? { ...a, groups: (a.groups || []).filter((g) => g.group !== name) }
        : a)),
    }, `'${name}'에서 ${out.length}명 뺐습니다.`)
    setPicked((s2) => { const n = new Set(s2); ids.forEach((id) => n.delete(id)); return n })
  }

  /** A new group out of the ticked people. The form is a row under the command
   *  line, where the button that opened it is. */
  function makeGroup(form) {
    const name = String(form.shortName || form.fullName || '').trim()
    if (!name) { setNote('그룹 이름이 필요합니다.'); return false }
    if ((doc.groups || []).some((g) => g.name === name)) { setNote('같은 이름의 그룹이 있습니다.'); return false }
    if (!chosen.length) { setNote('선택된 저자가 없습니다.'); return false }
    const ids = new Set(chosen.map((a) => a.id))
    commit({
      groups: [...(doc.groups || []), { ...form, name, shortName: name }],
      authors: doc.authors.map((a) => (ids.has(a.id) && !inGrp(a, name)
        ? { ...a, groups: [...(a.groups || []), { group: name, role: '', core: 10 }] }
        : a)),
    }, `'${name}' 그룹 생성 · ${ids.size}명 추가`)
    return true
  }

  // ── saving one record ──
  async function commit(patch, said) {
    if (!doc) return false
    try {
      const r = await putDoc(doc.version, {
        authors: patch.authors || doc.authors,
        affiliations: patch.affiliations || doc.affiliations,
        groups: patch.groups || doc.groups,
      })
      if (r.conflict) { setNote('다른 사람이 먼저 저장했습니다 — 새로 읽어주세요.'); return false }
      setDoc(r.doc)
      setNote(said || '저장했습니다.')
      return true
    } catch (e) { setNote(String(e.message || e)); return false }
  }

  return (
    <div className="rl" style={brandStyle()}>
      <section className="rl-mod">
        <header className="rl-bar">
          <b>저자</b>
          <span className="rl-n">{doc ? `${authors.length}명` : ''}</span>
          <span className="rl-sp" />
          <span className="rl-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="rl-cmd">
          {tab?.kind === 'classes' ? (
            /* Mustard like the other two: it is only here while a class tab is,
               and the colour is what says so. */
            <button type="button" className="rl-btn rl-tabonly"
              onClick={() => openEdit({
                id: `newcls:${tab.of}`, kind: 'editcls', of: tab.of, who: null,
                label: tab.of === 'affiliation' ? '새 소속' : '새 그룹',
              })}>{tab.of === 'affiliation' ? '+ 새 소속' : '+ 새 그룹'}</button>
          ) : (
            <button type="button" className="rl-btn rl-go"
              onClick={() => openEdit({ id: 'new', kind: 'edit', label: '새 저자', who: null })}>+ 새 저자</button>
          )}
          {/* Both act on the ticked rows, so they are always here — a group is
              made of people you picked, whatever tab you picked them on. The
              group list IS the menu: a native select needs no popup of our own,
              and picking is the whole action. */}
          <select className="rl-btn rl-go rl-pick" value=""
            disabled={!picked.size || !(doc?.groups || []).length}
            onChange={(e) => addToGroup(e.target.value)}>
            <option value="">add to group</option>
            {groupNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button type="button" className="rl-btn rl-go" disabled={!picked.size}
            onClick={() => setGroupForm((g) => (g ? null : {}))}>make group</button>
          {/* Only while you are on a group's own tab: it is that group you would
              be taking them out of, and no other tab names one. */}
          {tab?.grp && (
            <button type="button" className="rl-btn rl-tabonly" disabled={!picked.size}
              onClick={() => removeFromGroup(tab.grp)}>
              remove from group{picked.size ? ` (${picked.size})` : ''}
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
          {/* One box: the list, or — while the filter is choosing — the values
              on offer. */}
          <input ref={findRef} type="search" className="rl-find"
            value={filter.mode ? filter.find : query}
            placeholder={filter.mode ? '고를 값 찾기   (⌘F)'
              : '이름 · 이메일 · 소속 · 그룹   (⌘F · ⌘⏎ 전체선택)'}
            onChange={(e) => (filter.mode ? filter.setFind : setQuery)(e.target.value)} />
        </div>

        {groupForm && (
          <div className="rl-rec rl-newgrp">
            <span className="rl-fl">새 그룹</span>
            <div className="rl-fv">
              <input className="rl-in" style={{ width: 150 }} placeholder="short name *"
                value={groupForm.shortName || ''} autoFocus
                onChange={(e) => setGroupForm((g) => ({ ...g, shortName: e.target.value }))} />
              <input className="rl-in" style={{ width: 240 }} placeholder="full name"
                value={groupForm.fullName || ''}
                onChange={(e) => setGroupForm((g) => ({ ...g, fullName: e.target.value }))} />
              <button type="button" className="rl-btn rl-go"
                onClick={() => { if (makeGroup(groupForm)) setGroupForm(null) }}>save</button>
              <button type="button" className="rl-btn" onClick={() => setGroupForm(null)}>cancel</button>
              <span className="rl-hint">선택한 {chosen.length}명이 이 그룹에 들어갑니다 (core 10).</span>
            </div>
          </div>
        )}

        <div className="rl-body">
        {showList && (<div className="rl-pane" style={showEdit ? split.leftStyle : undefined}>
        <RackTabs tabs={tabs} active={active} fixed={FIXED}
            onPick={setActive} onClose={closeTab} />

          {err && <p className="rl-msg">{err}</p>}
          {!err && !doc && <p className="rl-msg">읽는 중…</p>}

          {doc && tab?.kind === 'authors' && (
            <>
              <RackTable cols={cols} onDrag={drag('')}
                facet={filter.tableFacet}
                sort={sort || { k: 'core', dir: 1 }}
                onSort={(k) => setSort((s2) => {
                  // The implicit order counts as the current one, so the first
                  // press on the column already sorted turns it over instead of
                  // doing nothing you can see.
                  const now = s2 || { k: 'core', dir: 1 }
                  return now?.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={filter.mode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                <FacetRows f={filter} labels={{ empty: '이 열에는 값이 없습니다.' }} />
                {!filter.mode && rows.map((a, i) => {
                  const cur = currentAff(a)
                  const affs = affilText(a)
                  const on = picked.has(a.id)
                  // Open in the editor — on its own, or as one of many.
                  const edited = etabs.some((t) => t.who === a.id || t.ids?.includes(a.id))
                  return (
                    <RackRow key={a.id || i} cols={cols} tone={TONE}
                      className={`rl-hit${on ? ' on' : ''}${edited ? ' rl-edited' : ''}`}
                      onClick={(e) => hit(i, e.shiftKey)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        // Right-clicking INSIDE a selection means the selection:
                        // the row you hit is one of the many you picked, and
                        // editing it alone would ignore what you said.
                        if (picked.size > 1 && picked.has(a.id)) {
                          openEdit({ id: 'many', kind: 'many', label: `${picked.size}명 편집`,
                            ids: [...picked] })
                          return
                        }
                        openEdit({ id: `edit:${a.id}`, kind: 'edit', label: anyName(a), who: a.id })
                      }}
                      cell={{
                        chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                          aria-label={`${anyName(a)} 선택`} />,
                        num: i + 1,
                        affil: affs || D,
                        kor: korName(a) || D,
                        name: engName(a) || a.nick || D,
                        nm: citeShort(a) || D,
                        email: repEmail(a) || D,
                        pos: currentAffs(a).map((x) => x.position).filter(Boolean).join(', ') || D,
                        reg: (a.createdAt || '').slice(0, 10) || D,
                        upd: (a.updatedAt || '').slice(0, 10) || D,
                        core: (tab.grp ? coreIn(a, tab.grp) : coreOf(a)) ?? D,
                      }} />
                  )
                })}
                {!filter.mode && rows.length === 0 && <p className="rl-msg">해당하는 저자가 없습니다.</p>}
              </RackTable>
              {/* What you ticked is the set you assembled; with nothing ticked
                  the tab itself is the set. */}
              {/* On a group's tab the printed block is ordered by THAT group's
                  core — the number was assigned for this author list. */}
              <ListOut list={chosen.length ? chosen : scope} picked={chosen.length > 0}
                core={tab.grp ? (a) => coreIn(a, tab.grp) : coreOf}
                doc={doc} say={setNote} open={outOpen} setOpen={setOutOpen} />
            </>
          )}

          {doc && tab?.kind === 'classes' && (
            <RackTable cols={clsCols} onDrag={drag('c:')} sort={clsSort}
              onSort={(k) => setClsSort((s2) => (s2.k === k ? { k, dir: -s2.dir } : { k, dir: 1 }))}>
              {classes.map((r, i) => (
                <RackRow key={r.name} cols={clsCols} tone={TONE} className="rl-hit"
                  onClick={() => openTab({
                    id: `${tab.of}:${r.name}`, kind: 'authors', label: r.name,
                    ...(tab.of === 'affiliation' ? { aff: r.name } : { grp: r.name }),
                  })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openEdit({ id: `editcls:${tab.of}:${r.name}`, kind: 'editcls', label: r.name, of: tab.of, who: r.name })
                  }}
                  cell={{ num: i + 1, name: r.name, count: r.count,
                    type: r.type || D, when: r.when || D, full: r.full || D }} />
              ))}
              {classes.length === 0 && <p className="rl-msg">등록된 항목이 없습니다.</p>}
            </RackTable>
          )}

        </div>)}

        {showList && showEdit && <div {...split.handleProps} />}
        {showEdit && (<div className="rl-pane rl-epane" style={showList ? split.rightStyle : undefined}>
          <RackTabs tabs={etabs} active={eactive} opened
            onPick={setEactive} onClose={closeEdit} />
          {etab.kind === 'many' ? (
            <EditMany ids={etab.ids} doc={doc} onSave={commit} say={setNote}
              onDone={() => closeEdit('many')} onCancel={() => closeEdit('many')} />
          ) : etab.kind === 'edit' ? (
            <EditAuthor author={etab.who ? authors.find((a) => a.id === etab.who) : null}
              doc={doc} onSave={commit} isAdmin={IS_ADMIN} say={setNote}
              onCreated={(id, label) => {
                closeEdit('new')
                openEdit({ id: `edit:${id}`, kind: 'edit', label, who: id })
              }}
              onDone={(id) => closeEdit(`edit:${id}`)}
              onCancel={() => closeEdit(etab.id)}
              onDeleted={(id) => {
                closeEdit(`edit:${id}`)
                setPicked((s2) => { const n = new Set(s2); n.delete(id); return n })
              }} />
          ) : (
            <EditClass name={etab.who} of={etab.of} doc={doc} onSave={commit} isAdmin={IS_ADMIN}
              onCreated={(name) => {
                closeEdit(`newcls:${etab.of}`)
                openEdit({ id: `editcls:${etab.of}:${name}`, kind: 'editcls', label: name, of: etab.of, who: name })
              }}
              onDone={(name) => closeEdit(`editcls:${etab.of}:${name}`)}
              onCancel={() => closeEdit(etab.id)} />
          )}
        </div>)}
        </div>

        <footer className="rl-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위, 오른쪽 클릭으로 편집.'}</span>
          <span className="rl-sp" />
          <span className="rl-mono">{rows.length ? `${rows.length}줄` : ''}</span>
        </footer>
      </section>
    </div>
  )
}

/** Core first, then by FAMILY name — which is how an author list is ordered.
 *  Sorting the abbreviated name instead sorts by the first initial, and
 *  A. Chekhovska lands where S. Ahn belongs. */
const byPaperOrder = (core = coreOf) => (a, b) => {
  const c = (core(a) ?? 99) - (core(b) ?? 99)
  if (c !== 0) return c
  const last = (x) => (x.engLast || citeShort(x).split(' ').at(-1) || anyName(x)).toLowerCase()
  const l = last(a).localeCompare(last(b))
  return l !== 0 ? l : citeShort(a).localeCompare(citeShort(b))
}

// ─── My List's output: the reason the list exists ───────────────────────────
function ListOut({ list, picked, core = coreOf, doc, say, open, setOpen }) {
  const [sep, setSep] = useState(', ')
  const [tpl, setTpl] = useState(PRESETS[0][1])
  // Two printed forms are not templates: they number the affiliations, which a
  // per-name rule cannot do. '' means the rule above is what is running.
  const [mode, setMode] = useState('')
  // Printed with the citation name (S. Ahn) or the whole one (Sunghoon Ahn) —
  // an abstract wants one, a programme or a poster credit the other.
  const [nameAs, setNameAs] = useState('abv')

  /** The LaTeX author block: core order, then a superscript per affiliation. */
  /** The author block both printed forms are: core order, then the
   *  affiliations numbered in the order they first appear. Everyone's CURRENT
   *  affiliations count — somebody at two places carries two numbers, which is
   *  what the abstract prints. */
  const block = () => {
    const ordered = [...list].sort(byPaperOrder(core))
    const idx = new Map()
    for (const a of ordered) {
      for (const x of currentAffs(a)) if (!idx.has(x.tag)) idx.set(x.tag, idx.size + 1)
    }
    const line = (tag) => {
      const rec = (doc.affiliations || []).find((x) => x.name === tag)
      return rec ? [rec.fullName || rec.name, rec.address].filter(Boolean).join(', ') : tag
    }
    const nums = (a) => currentAffs(a).map((x) => idx.get(x.tag)).filter(Boolean)
    const name = (a) => (nameAs === 'full'
      ? engName(a) || citeShort(a) : citeShort(a) || engName(a)) || anyName(a)
    return { ordered, idx, line, nums, name }
  }
  const paperOut = () => {
    const { ordered, idx, line, nums, name } = block()
    const names = ordered.map((a) => {
      const n = nums(a)
      return `  ${name(a)}${n.length ? `$^{${n.join(',')}}$` : ''}`
    })
    const affs = [...idx.entries()].map(([tag, i]) => `$^{${i}}$ ${line(tag)}\\\\`)
    return `\\author{%\n${names.join(',\n')}\n}\n\n% affiliations\n${affs.join('\n')}`
  }
  /** The block as an abstract carries it: the name, a comma, and the plain
   *  numbers. Plain, because the superscripting is done where it is typeset —
   *  a superscript character pasted into a word processor is a character that
   *  does not match the font around it. */
  const abstractOut = (tex) => {
    const { ordered, idx, line, nums, name } = block()
    // The only difference between the two is how a number is raised: a word
    // processor does it to a plain digit, LaTeX does it to $^{…}$.
    const mark = (n) => (tex ? `$^{${n.join(',')}}$` : `,${n.join(',')}`)
    const one = (a) => {
      const n = nums(a)
      return `${name(a)}${n.length ? mark(n) : ''}`
    }
    // Plain: the comma is already in front of the numbers, so a space divides
    // people. LaTeX: the number is raised, so the comma has to divide them.
    const people = ordered.map(one)
    const sep2 = tex ? ', ' : ' '
    const joined = people.length > 1
      ? `${people.slice(0, -1).join(sep2)}${sep2}and ${people.at(-1)}`
      : people.join('')
    const affs = [...idx.entries()].map(([tag, i]) =>
      (tex ? `$^{${i}}$ ${line(tag)} \\\\` : `${i} ${line(tag)}`))
    return `${joined}\n\n${affs.join('\n')}`
  }

  // Derived, not stored: editing the rule changes the text under your hands.
  const out = mode === 'paper' ? paperOut()
    : mode === 'abstract' ? abstractOut(false)
      : mode === 'abstract-tex' ? abstractOut(true)
    : list.map((a) => fill(tpl, a)).filter(Boolean).join(sep.replaceAll('⏎', '\n'))

  async function copy() {
    if (!out) { say('나열할 것이 없습니다.'); return }
    try { await navigator.clipboard.writeText(out); say('복사했습니다.') }
    catch { say('복사 실패 — 직접 선택해 복사하세요.') }
  }

  const none = list.length === 0
  return (
    <div className="rl-out">
      {/* Folded by default: the list is what you came for, the text it makes is
          what you leave with. */}
      <button type="button" className={`rl-outhead${open ? ' on' : ''}`} onClick={() => setOpen(!open)}
        aria-expanded={open}>
        <i className="rl-caret">{open ? '▾' : '▸'}</i>
        <span>나열</span>
        <span className="rl-hint">{picked ? `선택한 ${list.length}명` : `${list.length}명`}</span>
      </button>
      {open && (<>
      <div className="rl-outbar">
        {PRESETS.map(([label, t]) => (
          <button key={label} type="button" className={`rl-btn${!mode && tpl === t ? ' on' : ''}`}
            disabled={none} onClick={() => { setMode(''); setTpl(t) }}>{label}</button>
        ))}
        <button type="button" className={`rl-btn rl-go${mode === 'abstract' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('abstract')}>abstract</button>
        <button type="button" className={`rl-btn rl-go${mode === 'abstract-tex' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('abstract-tex')}>abstract (LaTeX)</button>
        <button type="button" className={`rl-btn rl-go${mode === 'paper' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('paper')}>paper authors</button>
        {/* The three printed forms all name people; which name is a choice, not
            three more buttons. */}
        {mode && (<>
          <span className="rl-gap" />
          {[['abv', '{abv-name}'], ['full', '{name}']].map(([v, label]) => (
            <button key={v} type="button" className={`rl-btn${nameAs === v ? ' on' : ''}`}
              onClick={() => setNameAs(v)}>{label}</button>
          ))}
        </>)}
        <span className="rl-sp" />
        <button type="button" className="rl-btn" disabled={!out} onClick={copy}>copy</button>
      </div>

      {/* The rule itself, editable. The tokens are the column names. */}
      <div className="rl-rule-line">
        <span className="rl-hint">나열 규칙</span>
        <input className="rl-in rl-mono" style={{ flex: 1, minWidth: 180 }} value={tpl}
          disabled={!!mode} onChange={(e) => { setMode(''); setTpl(e.target.value) }} />
        <span className="rl-hint">사이</span>
        <input className="rl-in rl-mono" style={{ width: 66 }} value={sep} disabled={!!mode}
          onChange={(e) => setSep(e.target.value)} title="구분기호" />
        <button type="button" className="rl-btn" title="줄바꿈 추가" disabled={!!mode}
          onClick={() => setSep((v) => `${v}⏎`)}>+⏎</button>
      </div>
      <div className="rl-tokens">
        {Object.keys(TOKENS).map((k) => (
          <button key={k} type="button" className="rl-tok" disabled={!!mode}
            onClick={() => { setMode(''); setTpl((v) => `${v}{${k}}`) }}>{`{${k}}`}</button>
        ))}
      </div>

      <textarea className="rl-outbox" value={out} readOnly
        placeholder={none ? '이 탭에 사람이 없습니다.' : ''} />
      </>)}
    </div>
  )
}

/** Editing many records at once.
 *
 * Only what the records SHARE can be edited: a name or a phone number belongs
 * to one person, but "everyone in this group has core 3" is one fact said many
 * times. So the form holds the affiliations and the groups they all have.
 *
 * The rule in every field is the same: what is already there is what everyone
 * has, and an untouched field changes nothing. Where they differ the field is
 * empty and says (여러 값) — type into it and everyone gets what you typed.
 */
function EditMany({ ids, doc, onSave, onDone, onCancel, say }) {
  const people = useMemo(
    () => (doc.authors || []).filter((a) => ids.includes(a.id)), [doc, ids])
  /** The tags every one of them has, and the groups every one of them is in. */
  const common = useCallback((key, id) => {
    if (!people.length) return []
    const sets = people.map((a) => new Set((a[key] || []).map((x) => x[id]).filter(Boolean)))
    return byName([...sets[0]].filter((v) => sets.every((s) => s.has(v))))
  }, [people])
  const affTags = useMemo(() => common('affiliations', 'tag'), [common])
  const grpNames2 = useMemo(() => common('groups', 'group'), [common])

  /** One value if they all say the same thing, '' if they do not. */
  const shared = useCallback((key, id, name, field) => {
    const vals = people.map((a) => {
      const e = (a[key] || []).find((x) => x[id] === name)
      return e == null ? '' : String(e[field] ?? '')
    })
    return vals.every((v) => v === vals[0]) ? vals[0] : ''
  }, [people])
  const base = useMemo(() => {
    const out = { aff: {}, grp: {} }
    for (const t of affTags) {
      out.aff[t] = { dept: shared('affiliations', 'tag', t, 'dept'),
        position: shared('affiliations', 'tag', t, 'position'),
        since: shared('affiliations', 'tag', t, 'since') }
    }
    for (const g of grpNames2) {
      out.grp[g] = { role: shared('groups', 'group', g, 'role'),
        core: shared('groups', 'group', g, 'core') }
    }
    return out
  }, [affTags, grpNames2, shared])
  const mixed = useCallback((key, id, name, field) => {
    const vals = people.map((a) => {
      const e = (a[key] || []).find((x) => x[id] === name)
      return e == null ? '' : String(e[field] ?? '')
    })
    return !vals.every((v) => v === vals[0])
  }, [people])

  const [f, setF] = useState(base)
  const [drop, setDrop] = useState({ aff: [], grp: [] })
  const [add2, setAdd2] = useState({ aff: [], grp: [] })
  useEffect(() => { setF(base); setDrop({ aff: [], grp: [] }); setAdd2({ aff: [], grp: [] }) },
    [base, ids.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const put = (kind, name, field, v) =>
    setF((s) => ({ ...s, [kind]: { ...s[kind], [name]: { ...s[kind][name], [field]: v } } }))
  const toggleDrop = (kind, name) => setDrop((s) => ({ ...s,
    [kind]: s[kind].includes(name) ? s[kind].filter((x) => x !== name) : [...s[kind], name] }))

  const affLeft = byName((doc.affiliations || []).map((r) => r.name)
    .filter((n) => !affTags.includes(n) && !add2.aff.includes(n)))
  const grpLeft = byName((doc.groups || []).map((r) => r.name)
    .filter((n) => !grpNames2.includes(n) && !add2.grp.includes(n)))

  async function save() {
    const now = new Date().toISOString()
    const changed = (kind, name, field) => (f[kind][name]?.[field] ?? '') !== (base[kind][name]?.[field] ?? '')
    const authors = (doc.authors || []).map((a) => {
      if (!ids.includes(a.id)) return a
      let affiliations = (a.affiliations || [])
        .filter((x) => !drop.aff.includes(x.tag))
        .map((x) => {
          if (!base.aff[x.tag]) return x
          const out = { ...x }
          for (const k of ['dept', 'position', 'since']) {
            if (changed('aff', x.tag, k)) out[k] = f.aff[x.tag][k]
          }
          return out
        })
      for (const t of add2.aff) {
        if (!affiliations.some((x) => x.tag === t)) {
          affiliations = [...affiliations,
            { tag: t, dept: '', position: '', email: '', since: '', current: true }]
        }
      }
      let groups = (a.groups || [])
        .filter((x) => !drop.grp.includes(x.group))
        .map((x) => {
          if (!base.grp[x.group]) return x
          const out = { ...x }
          if (changed('grp', x.group, 'role')) out.role = f.grp[x.group].role
          if (changed('grp', x.group, 'core')) out.core = Number(f.grp[x.group].core) || f.grp[x.group].core
          return out
        })
      for (const g of add2.grp) {
        if (!groups.some((x) => x.group === g)) groups = [...groups, { group: g, role: '', core: 10 }]
      }
      return { ...a, affiliations, groups, updatedAt: now }
    })
    const n = ids.length
    if (await onSave({ authors }, `${n}명 한번에 저장했습니다.`)) onDone?.()
  }

  if (!people.length) return <p className="rl-msg">선택된 저자가 없습니다.</p>
  return (
    <div className="rl-tab-body">
      <div className="rl-rec">
        <Fld label="대상">
          <div className="rl-rows">
            <span className="rl-hint">{people.length}명</span>
            <div className="rl-rrow">
              {people.slice(0, 20).map((a) => <span key={a.id} className="rl-tag">{anyName(a)}</span>)}
              {people.length > 20 && <span className="rl-hint">… 외 {people.length - 20}명</span>}
            </div>
            <span className="rl-hint">
              이름 · 이메일 · 전화 · 링크 · 첨부는 한 사람의 것이라 여기서 고치지 않습니다.
            </span>
          </div>
        </Fld>

        <Fld label="소속 이력">
          <div className="rl-rows rl-grid">
            {affTags.length === 0 && <span className="rl-hint rl-full">모두가 함께 가진 소속이 없습니다.</span>}
            {affTags.map((t) => {
              const off = drop.aff.includes(t)
              return (
                <div key={t} className="rl-rrow" style={off ? { opacity: 0.45 } : null}>
                  <span className="rl-tag">{t}</span>
                  <input className="rl-in" style={{ width: 150 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'dept') ? '(여러 값)' : '부서'}
                    value={f.aff[t]?.dept ?? ''} onChange={(e) => put('aff', t, 'dept', e.target.value)} />
                  <input className="rl-in" style={{ width: 170 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'position') ? '(여러 값)' : 'position'}
                    value={f.aff[t]?.position ?? ''} onChange={(e) => put('aff', t, 'position', e.target.value)} />
                  <input className="rl-in" style={{ width: 90 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'since') ? '(여러 값)' : '2020-01'}
                    value={f.aff[t]?.since ?? ''} onChange={(e) => put('aff', t, 'since', e.target.value)} />
                  <button type="button" className="rl-x" title={off ? '되돌리기' : '모두에게서 빼기'}
                    onClick={() => toggleDrop('aff', t)}>{off ? '↺' : '×'}</button>
                </div>
              )
            })}
            {add2.aff.map((t) => (
              <div key={t} className="rl-rrow rl-full">
                <span className="rl-tag">{t}</span>
                <span className="rl-hint">모두에게 추가됩니다.</span>
                <button type="button" className="rl-x" title="취소"
                  onClick={() => setAdd2((s) => ({ ...s, aff: s.aff.filter((x) => x !== t) }))}>×</button>
              </div>
            ))}
            <div className="rl-rrow rl-full">
              <select className="rl-btn rl-pick" value="" disabled={!affLeft.length}
                onChange={(e) => setAdd2((s) => ({ ...s, aff: [...s.aff, e.target.value] }))}>
                <option value="">+ 소속 추가</option>
                {affLeft.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </Fld>

        <Fld label="그룹 소속">
          <div className="rl-rows rl-grid">
            {grpNames2.length === 0 && <span className="rl-hint rl-full">모두가 함께 속한 그룹이 없습니다.</span>}
            {grpNames2.map((g) => {
              const off = drop.grp.includes(g)
              return (
                <div key={g} className="rl-rrow" style={off ? { opacity: 0.45 } : null}>
                  <span className="rl-tag">{g}</span>
                  <input className="rl-in" style={{ width: 200 }} disabled={off}
                    placeholder={mixed('groups', 'group', g, 'role') ? '(여러 값)' : 'role'}
                    value={f.grp[g]?.role ?? ''} onChange={(e) => put('grp', g, 'role', e.target.value)} />
                  <input className="rl-in rl-mono" style={{ width: 70 }} disabled={off}
                    placeholder={mixed('groups', 'group', g, 'core') ? '(여러 값)' : 'core'}
                    value={f.grp[g]?.core ?? ''} onChange={(e) => put('grp', g, 'core', e.target.value)} />
                  <span className="rl-hint">저자 순서</span>
                  <button type="button" className="rl-x" title={off ? '되돌리기' : '모두에게서 빼기'}
                    onClick={() => toggleDrop('grp', g)}>{off ? '↺' : '×'}</button>
                </div>
              )
            })}
            {add2.grp.map((g) => (
              <div key={g} className="rl-rrow rl-full">
                <span className="rl-tag">{g}</span>
                <span className="rl-hint">모두에게 추가됩니다 (core 10).</span>
                <button type="button" className="rl-x" title="취소"
                  onClick={() => setAdd2((s) => ({ ...s, grp: s.grp.filter((x) => x !== g) }))}>×</button>
              </div>
            ))}
            <div className="rl-rrow rl-full">
              <select className="rl-btn rl-pick" value="" disabled={!grpLeft.length}
                onChange={(e) => setAdd2((s) => ({ ...s, grp: [...s.grp, e.target.value] }))}>
                <option value="">+ 그룹 추가</option>
                {grpLeft.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </Fld>
      </div>
      <RackActions onSave={save} onCancel={onCancel}
        onRevert={() => { setF(base); setDrop({ aff: [], grp: [] }); setAdd2({ aff: [], grp: [] }) }} />
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Fld({ label, children }) {
  return (<><span className="rl-fl">{label}</span><div className="rl-fv">{children}</div></>)
}

/** Every address, and which one is THE address. The list and the
 *  representative are one field because they are one question: a 대표 that is
 *  not in the list, or a list with no 대표, is a record disagreeing with
 *  itself. Marking a row moves the mark; editing the marked row moves it with
 *  the text. */
function EmailRows({ value = [], rep, onChange }) {
  const clean = (x) => String(x || '').trim()
  const put = (i, v) => {
    const next = value.map((x, j) => (j === i ? v : x))
    // The mark follows the address it was on, even while it is being typed.
    onChange(next, clean(value[i]) === clean(rep) ? v : rep)
  }
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((v, i) => (
        <div key={i} className="rl-rrow">
          <label className="rl-hint" title="대표 주소로">
            <input type="radio" checked={!!clean(v) && clean(v) === clean(rep)}
              onChange={() => onChange(value, v)} /> 대표
          </label>
          <input className="rl-in" style={{ width: 280 }} placeholder="name@lab.kr" value={v}
            onChange={(e) => put(i, e.target.value)} />
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i),
              clean(v) === clean(rep) ? '' : rep)}>×</button>
        </div>
      ))}
      <div className="rl-rrow">
        <button type="button" className="rl-btn"
          onClick={() => onChange([...value, ''], rep)}>+ 이메일</button>
        <span className="rl-hint">
          {clean(rep) ? `대표 ${clean(rep)}` : (value.some((x) => clean(x))
            ? '대표를 고르지 않으면 맨 위가 대표가 됩니다.' : '')}
        </span>
      </div>
    </div>
  )
}

/** A list of plain strings — links — one line each. */
function TextRows({ value = [], onChange, add, placeholder, link }) {
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((v, i) => (
        <div key={i} className="rl-rrow">
          <input className="rl-in" style={{ width: 300 }} placeholder={placeholder} value={v}
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

// The whole document is saved on every edit, so an attachment is carried in it
// as a data URL and counts against every future save. A couple of megabytes of
// PDF is a fair scan; ten is a document nobody can save any more.
const FILE_CAP = 2 * 1024 * 1024
const dataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = () => rej(new Error('읽지 못했습니다.'))
  r.readAsDataURL(file)
})
function download(data, name) {
  const a = document.createElement('a')
  a.href = data
  a.download = name || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

/** Attachments, kept in the document itself. */
function FileRows({ value = [], onChange, say }) {
  const pick = useRef(null)
  async function add(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    const added = []
    for (const f of files) {
      if (f.size > FILE_CAP) { say(`${f.name} 은 ${kb(FILE_CAP)}보다 큽니다 — 문서 전체가 매번 저장되므로 받지 않습니다.`); continue }
      added.push({ name: f.name, type: f.type, size: f.size, data: await dataUrl(f) })
    }
    if (added.length) onChange([...value, ...added])
  }
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((f, i) => (
        <div key={`${f.name}-${i}`} className="rl-rrow">
          <button type="button" className="rl-btn" onClick={() => download(f.data, f.name)}>{f.name}</button>
          <span className="rl-hint">{f.size ? kb(f.size) : ''}</span>
          <button type="button" className="rl-x" title="지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="rl-btn" onClick={() => pick.current?.click()}>+ 파일</button>
      <input ref={pick} type="file" multiple hidden onChange={add} />
      <span className="rl-hint">한 개 {kb(FILE_CAP)}까지.</span>
    </div>
  )
}

/** Which entry is the CURRENT affiliation: the last one by date. Marked rather
 *  than moved, so the order you typed them in survives. */
/** The affiliation history: every entry, in the order it is stored. */
function AffRows({ value = [], options, onChange }) {
  const put = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const nowCount = value.filter((x) => x.tag && isCurrent(x)).length
  // The order is not decoration: the list joins them in it (IRIS, UST), and the
  // first current one is the one a paper's superscript uses.
  const move = (i, d) => {
    const next = [...value]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((x, i) => (
        <div key={i} className="rl-rrow">
          <select className="rl-in" style={{ width: 120 }} value={x.tag || ''}
            onChange={(e) => put(i, 'tag', e.target.value)}>
            <option value="">(소속)</option>
            {/* An entry pointing at a class that is gone stays selectable, so
                saving does not quietly change who someone was. */}
            {[...new Set([...options, x.tag].filter(Boolean))].map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <input className="rl-in" style={{ width: 150 }} placeholder="부서"
            value={x.dept || ''} onChange={(e) => put(i, 'dept', e.target.value)} />
          <input className="rl-in" style={{ width: 170 }} placeholder="position"
            value={x.position || ''} onChange={(e) => put(i, 'position', e.target.value)} />
          <input className="rl-in" style={{ width: 190 }} placeholder="email"
            value={x.email || ''} onChange={(e) => put(i, 'email', e.target.value)} />
          <input className="rl-in" style={{ width: 84 }} placeholder="2020-01"
            value={x.since || ''} onChange={(e) => put(i, 'since', e.target.value)} />
          {/* A person can be in two places at once, so this is a box per entry,
              not a crown the latest date wears. */}
          <label className="rl-hint" title="지금도 이 소속입니다">
            <input type="checkbox" checked={isCurrent(x)}
              onChange={(e) => put(i, 'current', e.target.checked)} /> 현재
          </label>
          {value.length > 1 && (<>
            <button type="button" className="rl-x" title="위로" disabled={i === 0}
              onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="rl-x" title="아래로" disabled={i === value.length - 1}
              onClick={() => move(i, 1)}>↓</button>
          </>)}
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="rl-rrow">
        <button type="button" className="rl-btn" onClick={() =>
          onChange([...value, { tag: '', dept: '', position: '', email: '', since: '', current: true }])}>
          + 소속
        </button>
        {/* Moved away and we do not know where: the history stays, nothing is
            current, and the list says 모름 rather than going blank — a blank is
            what someone with no affiliation at all looks like. */}
        <button type="button" className="rl-btn" disabled={!nowCount}
          title="이전 소속은 남기고, 지금 소속은 모르는 상태로 둡니다"
          onClick={() => onChange(value.map((x) => ({ ...x, current: false })))}>
          지금은 모름
        </button>
        <span className="rl-hint">
          {nowCount ? `현재 ${nowCount}곳${nowCount > 1 ? ' · 위에 있는 것이 먼저 나옵니다' : ''}`
            : (value.some((x) => x.tag) ? '현재 소속 모름' : '')}
        </span>
      </div>
    </div>
  )
}

/** Group membership. `core` is this author's place in THAT group's author list. */
function GrpRows({ value = [], options, onChange }) {
  const put = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((x, i) => (
        <div key={i} className="rl-rrow">
          <select className="rl-in" style={{ width: 190 }} value={x.group || ''}
            onChange={(e) => put(i, 'group', e.target.value)}>
            <option value="">(그룹)</option>
            {[...new Set([...options, x.group].filter(Boolean))].map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <input className="rl-in" style={{ width: 150 }} placeholder="role"
            value={x.role || ''} onChange={(e) => put(i, 'role', e.target.value)} />
          <input className="rl-in" style={{ width: 66 }} type="number" min="1" placeholder="core"
            value={x.core ?? ''} onChange={(e) => put(i, 'core', e.target.value === '' ? '' : Number(e.target.value))} />
          <span className="rl-hint">저자 순서</span>
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="rl-btn" onClick={() =>
        onChange([...value, { group: '', role: '', core: 10 }])}>+ 그룹</button>
    </div>
  )
}

function EditAuthor({ author, doc, onSave, isAdmin, onCreated, onDeleted, onDone, onCancel, say }) {
  // No author means a DRAFT: the same form, and saving puts it in the document
  // rather than over one. One form, two jobs, so a field added here is added to
  // both at once.
  const draft = !author
  const blank = { id: null, korFamily: '', korGiven: '', engFirst: '', engMiddle: '', engLast: '' }
  const [f, setF] = useState(author || blank)
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => (draft ? create() : update(true)) })
  useEffect(() => { setF(author || blank) }, [author])  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  // Every list you pick a name from reads in name order: the order they were
  // made in is not an order anyone can look something up in.
  const affNames = byName((doc.affiliations || []).map((r) => r.name))
  const grpNames = byName((doc.groups || []).map((r) => r.name))

  const named = () => (f.nick || '').trim() || korName(f) || engName(f)

  // A half-typed line is not data. Blank strings and entries that point at no
  // affiliation or group are dropped on the way out, so the document does not
  // collect the rows somebody added and thought better of.
  const tidy = (r) => {
    const emails = (r.emails || []).map((x) => String(x).trim()).filter(Boolean)
    // A record cannot have a 대표 that is not one of its addresses, and a
    // record with addresses and no 대표 shows nothing in the list — so the
    // first one takes the job.
    const rep = emails.includes(String(r.repEmail || '').trim())
      ? String(r.repEmail).trim() : (emails[0] || '')
    return {
    ...r,
    emails,
    repEmail: rep,
    links: (r.links || []).map((x) => String(x).trim()).filter(Boolean),
    affiliations: (r.affiliations || []).filter((x) => String(x.tag || '').trim()),
    groups: (r.groups || []).filter((x) => String(x.group || '').trim()),
    }
  }

  async function create() {
    if (!named()) return   // the button is disabled, but a stray Enter is not
    const now = new Date().toISOString()
    const a = { ...tidy(f), id: newId(), createdAt: now, updatedAt: now }
    if (await onSave({ authors: [a, ...doc.authors] }, `${anyName(a)} 등록됨`)) onCreated?.(a.id, anyName(a))
  }
  async function update(keep) {
    const ok = await onSave({
      authors: doc.authors.map((a) => (a.id === f.id ? { ...tidy(f), updatedAt: new Date().toISOString() } : a)),
    })
    // The record was an errand, not a destination: a save that landed closes
    // the tab it came from. A save that lost the race keeps it, edits and all.
    if (ok && !keep) onDone?.(f.id)
  }
  async function remove() {
    if (await onSave({ authors: doc.authors.filter((a) => a.id !== f.id) }, `${anyName(f)} 삭제됨`)) onDeleted?.(f.id)
  }

  return (
    <div className="rl-tab-body">
      <div className="rl-rec">
        <Fld label="한글 이름">
          <input className="rl-in" style={{ width: 90 }} value={f.korFamily || ''} onChange={set('korFamily')} placeholder="성" />
          <input className="rl-in" style={{ width: 120 }} value={f.korGiven || ''} onChange={set('korGiven')} placeholder="이름" />
        </Fld>
        <Fld label="English">
          <input className="rl-in" style={{ width: 130 }} value={f.engFirst || ''} onChange={set('engFirst')} placeholder="first" />
          <input className="rl-in" style={{ width: 110 }} value={f.engMiddle || ''} onChange={set('engMiddle')} placeholder="middle" />
          <input className="rl-in" style={{ width: 140 }} value={f.engLast || ''} onChange={set('engLast')} placeholder="last" />
        </Fld>
        <Fld label="별명">
          <input className="rl-in" style={{ width: 200 }} value={f.nick || ''} onChange={set('nick')} />
        </Fld>
        <Fld label="줄임 이름">
          <input className="rl-in" style={{ width: 160 }} value={f.abvName || ''} onChange={set('abvName')}
            placeholder={citeShort({ ...f, abvName: '' }) || 'J. W. Lee'} />
          <span className="rl-hint">비우면 영문 이름에서 만듭니다.</span>
        </Fld>
        <Fld label="email">
          <EmailRows value={f.emails || []} rep={f.repEmail || ''}
            onChange={(emails, rep) => setF((s) => ({ ...s, emails, repEmail: rep }))} />
        </Fld>
        <Fld label="소속 이력">
          <AffRows value={f.affiliations || []} options={affNames}
            onChange={(v) => setF((s) => ({ ...s, affiliations: v }))} />
        </Fld>
        <Fld label="그룹 소속">
          <GrpRows value={f.groups || []} options={grpNames}
            onChange={(v) => setF((s) => ({ ...s, groups: v }))} />
        </Fld>
        <Fld label="전화">
          <input className="rl-in" style={{ width: 190 }} value={f.phone || ''} onChange={set('phone')} />
        </Fld>
        <Fld label="링크">
          <TextRows value={f.links || []} add="+ 링크" placeholder="https://…" link
            onChange={(v) => setF((s) => ({ ...s, links: v }))} />
        </Fld>
        <Fld label="첨부파일">
          <FileRows value={f.attachments || []} say={say}
            onChange={(v) => setF((s) => ({ ...s, attachments: v }))} />
        </Fld>
      </div>
      {/* Out of the field grid and stuck to the bottom: on a long record the way
          to save it was below the fold, and a form you have to scroll to leave
          is a form you leave by accident. */}
      <RackActions key={author?.id || 'new'} draft={draft}
        onCreate={create} createDisabled={!named()}
        hint={draft && !named() ? '별명이나 이름 하나는 있어야 합니다.' : ''}
        onSave={update} onCancel={onCancel} onRevert={() => setF(author)}
        onDelete={isAdmin ? remove : null} />
    </div>
  )
}

function EditClass({ name, of, doc, onSave, isAdmin, onCreated, onDone, onCancel }) {
  const key = of === 'affiliation' ? 'affiliations' : 'groups'
  const what = of === 'affiliation' ? '소속' : '그룹'
  const draft = !name
  const rec = draft ? null : (doc[key] || []).find((r) => r.name === name)
  const [f, setF] = useState(rec || { name: '', shortName: '', fullName: '' })
  // ⌘S saves and stays; closing is ⌘X's job.
  useRackKeys({ onSave: () => (draft ? create() : update(true)) })
  useEffect(() => { setF(rec || { name: '', shortName: '', fullName: '' }) }, [name, rec])
  if (!draft && !rec) return <p className="rl-msg">그 {what}을 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const named = String(f.name || '').trim()
  // A half-typed line is not data, here either.
  const tidy = (r) => ({ ...r, links: (r.links || []).map((x) => String(x).trim()).filter(Boolean) })

  // How many authors point at this name: the number that decides whether
  // deleting it is a tidy-up or an edit to two dozen records.
  const users = (doc.authors || []).filter((a) => (of === 'affiliation' ? inAff(a, name) : inGrp(a, name))).length
  const taken = (doc[key] || []).some((r) => r.name === named && r.name !== rec?.name)

  function create() {
    if (!named || taken) return
    onSave({ [key]: [...(doc[key] || []), { ...tidy(f), name: named, shortName: named }] },
      `'${named}' ${what} 등록됨`).then((ok) => { if (ok) onCreated?.(named) })
  }
  async function update(keep) {
    const renamed = named !== rec.name
    const recs = (doc[key] || []).map((r) => (r.name === rec.name ? { ...tidy(f), name: named, shortName: named } : r))
    // A rename has to travel: the authors point at this name by value.
    const authors = renamed
      ? doc.authors.map((a) => ({
        ...a,
        affiliations: of === 'affiliation'
          ? (a.affiliations || []).map((x) => (x.tag === rec.name ? { ...x, tag: named } : x))
          : a.affiliations,
        groups: of === 'group'
          ? (a.groups || []).map((g) => (g.group === rec.name ? { ...g, group: named } : g))
          : a.groups,
      }))
      : doc.authors
    const ok = await onSave({ [key]: recs, authors })
    if (ok && !keep) onDone?.(rec.name)
  }
  async function remove() {
    // Deleting the record without taking it off the authors would leave them
    // pointing at a name that is not there.
    const authors = doc.authors.map((a) => ({
      ...a,
      affiliations: of === 'affiliation' ? (a.affiliations || []).filter((x) => x.tag !== rec.name) : a.affiliations,
      groups: of === 'group' ? (a.groups || []).filter((g) => g.group !== rec.name) : a.groups,
    }))
    if (await onSave({ [key]: (doc[key] || []).filter((r) => r.name !== rec.name), authors },
      `'${rec.name}' ${what} 삭제됨`)) onDone?.(rec.name)
  }

  return (
    <div className="rl-tab-body">
      <div className="rl-rec">
        <Fld label="이름">
          {/* name is what the authors point at, shortName is what the record
              shows: they are the same string, so they move together. */}
          <input className="rl-in" style={{ width: 220 }} value={f.name || ''}
            onChange={(e) => setF((s) => ({ ...s, name: e.target.value, shortName: e.target.value }))} />
          {taken ? <span className="rl-warn">같은 이름이 이미 있습니다.</span>
            : draft ? <span className="rl-hint">저자들이 이 이름으로 가리킵니다.</span>
              : <span className="rl-hint">고치면 이 이름을 쓰는 저자 {users}명도 같이 고쳐집니다.</span>}
        </Fld>
        <Fld label="full name">
          <input className="rl-in" style={{ width: 360 }} value={f.fullName || ''} onChange={set('fullName')} />
          <span className="rl-hint">paper authors의 소속 줄에 이 이름이 나갑니다.</span>
        </Fld>
        {of === 'affiliation' ? (
          <Fld label="주소 · 전화">
            <input className="rl-in" style={{ width: 360 }} value={f.address || ''} onChange={set('address')} placeholder="address" />
            <input className="rl-in" style={{ width: 150 }} value={f.phone || ''} onChange={set('phone')} placeholder="phone" />
          </Fld>
        ) : (
          <>
            <Fld label="type">
              <select className="rl-in" style={{ width: 150 }} value={f.type || ''} onChange={set('type')}>
                <option value="">(없음)</option>
                {GROUP_TYPES.map(([v]) => <option key={v} value={v}>{v}</option>)}
              </select>
              <span className="rl-hint">
                {GROUP_TYPES.find(([v]) => v === f.type)?.[1] || '무엇으로 모인 사람들인지'}
              </span>
            </Fld>
            <Fld label="설명">
              <input className="rl-in" style={{ width: 360 }} value={f.description || ''} onChange={set('description')} placeholder="description" />
            </Fld>
            <Fld label="기간">
              <input className="rl-in rl-mono" style={{ width: 120 }} value={f.creationDate || ''}
                onChange={set('creationDate')} placeholder="2026-11-16" />
              <span className="rl-hint">~</span>
              <input className="rl-in rl-mono" style={{ width: 120 }} value={f.endDate || ''}
                onChange={set('endDate')} placeholder="2026-11-18" />
              <span className="rl-hint">없어도 됩니다. 목록은 시작일로 정렬합니다.</span>
            </Fld>
          </>
        )}
        <Fld label="링크">
          <TextRows value={f.links || []} add="+ 링크" placeholder="https://…" link
            onChange={(v) => setF((s) => ({ ...s, links: v }))} />
        </Fld>
      </div>
      <RackActions key={name || 'new'} draft={draft}
        onCreate={create} createDisabled={!named || taken}
        hint={draft && !named ? '이름이 있어야 합니다.' : ''}
        onSave={update} saveDisabled={!named || taken} onCancel={onCancel}
        onRevert={() => setF(rec)} onDelete={isAdmin ? remove : null}
        deleteWarn={`${users ? `저자 ${users}명의 목록에서도 빠집니다.` : '쓰는 저자가 없습니다.'} 되돌릴 수 없습니다.`} />
    </div>
  )
}
