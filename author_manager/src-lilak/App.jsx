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
  RackTable, RackRow, RackTabs,
  useColumnWidths, useViewportWidth, useSelection, useFindKey, useNote, useViewState,
  bySome, fill as fillTpl, facetOf, passesFilter,
  PORTAL_PROJECT, projectKey, load, save, isManager, newId, fetchDoc, putDoc,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'

const WIDTH_KEY = projectKey('am', 'cols')
const VIEW_KEY = projectKey('am', 'view')
const IS_ADMIN = isManager()

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
  { k: 'core', w: 44, min: 34, label: 'core', num: true },
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
  'abv-name': (a) => citeShort(a),
  email: (a) => repEmail(a),
  position: (a) => currentAff(a)?.position || '',
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
  affil: (a) => currentAff(a)?.tag || '',
  kor: (a) => korName(a),
  name: (a) => engName(a) || a.nick || '',
  nm: (a) => citeShort(a),
  email: (a) => repEmail(a),
  pos: (a) => currentAff(a)?.position || '',
  core: (a) => coreOf(a),
  last: (a) => citeLast(a),
  first: (a) => citeFirst(a),
  init: (a) => citeInit(a),
}
const byColumn = (k, dir, group) =>
  bySome(k === 'core' && group ? (a) => coreIn(a, group) : SORTERS[k], dir)
// The classes' own columns. Same machinery, three keys.
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count, full: (r) => r.full }
/** Which columns are the record's own words (ink) and which are about it (dim). */
const TONE = { name: 'ink', affil: 'dim', pos: 'dim', nm: 'dim' }

const PRESETS = [
  ['이름 나열', '{이름}'],
  ['full names', '{name}'],
  ['abv. names', '{abv-name}'],
  ['email list', '"{이름}" <{email}>'],
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
  const [groupForm, setGroupForm] = useState(null)   // the new-group form, when open
  // null = the tab's own order: 한글 이름, or My List's own sequence.
  const [sort, setSort] = useState(VIEW.sort || null)
  const [clsSort, setClsSort] = useState(VIEW.clsSort || { k: 'name', dir: 1 })
  // Filtering has a MODE. In it the labels stop sorting and start choosing
  // which column's values you are picking from; the picks pile up across
  // columns until they are applied.
  const [fmode, setFmode] = useState(false)
  const [fcol, setFcol] = useState(null)       // the column being picked from
  const [fsel, setFsel] = useState(VIEW.fsel || {})   // { column: [values] }
  const [fon, setFon] = useState(!!VIEW.fon)   // applied
  const [outOpen, setOutOpen] = useState(false)   // the listing drawer
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  // The four fixed tabs are not worth storing; picking mode is not a state you
  // come back to, so only the applied filter is kept.
  useEffect(() => {
    saveView({ tabs: tabs.filter((t) => !FIXED.some((f) => f.id === t.id)),
               active, sort, clsSort, fsel, fon })
  }, [tabs, active, sort, clsSort, fsel, fon])
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
  const clsCols = useMemo(() => sized(CLS_COLS, vw, 'c:'), [sized, vw])

  // Which authors a tab is about, before the search narrows them. Takes the
  // tab, because an edit beside its list needs BOTH on screen.
  const scopeOf = useCallback((tab) => {
    if (tab?.kind !== 'authors') return []
    let list = authors
    if (tab.aff) list = list.filter((a) => inAff(a, tab.aff))
    if (tab.grp) list = list.filter((a) => inGrp(a, tab.grp))
    return [...list].sort(byColumn(sort?.k || 'kor', sort?.dir ?? 1, tab.grp))
  }, [authors, sort])
  const scope = useMemo(() => scopeOf(tab), [scopeOf, tab])

  const passes = useCallback((a) => passesFilter(a, fsel, SORTERS), [fsel])

  const rowsOf = useCallback((sc) => {
    const kept = fon ? sc.filter(passes) : sc
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((a) => [korName(a), engName(a), a.nick, repEmail(a), currentAff(a)?.tag,
      currentAff(a)?.position, ...(a.groups || []).map((g) => g.group)]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [query, fon, passes])
  const rows = useMemo(() => rowsOf(scope), [rowsOf, scope])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)

  // The editor pane takes the right half when there is room for both; below
  // that it has the width to itself while it is open, and closing its last tab
  // gives the list back.
  const etab = etabs.find((t) => t.id === eactive) || null
  const wide = vw >= 1180
  const showEdit = !!etab
  const showList = !showEdit || wide

  // Counted over the tab's own authors, not the filtered ones: a value that
  // would empty the list is still worth seeing.
  const facet = useMemo(() => facetOf(scope, SORTERS[fcol]), [fcol, scope])
  const picked_ = (k) => fsel[k] || []
  const facetTotal = Object.values(fsel).reduce((t, v) => t + v.length, 0)

  const classesOf = useCallback((t) => {
    if (t?.kind !== 'classes') return []
    const recs = (t.of === 'affiliation' ? doc?.affiliations : doc?.groups) || []
    return recs.map((r) => ({
      name: r.name,
      full: r.fullName || '',
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
  function closeEdit(id) {
    setEtabs((ts) => {
      const left = ts.filter((t) => t.id !== id)
      if (id === eactive) setEactive(left.length ? left[left.length - 1].id : null)
      return left
    })
  }

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
    <div className="rl">
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
            {(doc?.groups || []).map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
          <button type="button" className="rl-btn rl-go" disabled={!picked.size}
            onClick={() => setGroupForm((g) => (g ? null : {}))}>make group</button>
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
          {fmode ? (
            <>
              <button type="button" className="rl-btn rl-go" onClick={() => { setFmode(false); setFon(facetTotal > 0) }}>
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
            placeholder="이름 · 이메일 · 소속 · 그룹   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
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
        {showList && (<div className="rl-pane">
        <RackTabs tabs={tabs} active={active} fixed={FIXED}
            onPick={setActive} onClose={closeTab} />

          {err && <p className="rl-msg">{err}</p>}
          {!err && !doc && <p className="rl-msg">읽는 중…</p>}

          {doc && tab?.kind === 'authors' && (
            <>
              <RackTable cols={cols} onDrag={drag('')}
                facet={fmode ? { col: fcol, count: (k) => picked_(k).length, onPick: setFcol } : null}
                sort={sort || { k: 'kor', dir: 1 }}
                onSort={(k) => setSort((s2) => {
                  // The implicit order counts as the current one, so the first
                  // press on the column already sorted turns it over instead of
                  // doing nothing you can see.
                  const now = s2 || { k: 'kor', dir: 1 }
                  return now?.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={fmode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                {fmode && !fcol && <p className="rl-msg">위의 레이블을 눌러 어떤 종류로 걸를지 고르세요.</p>}
                {fmode && fcol && facet.length === 0 && <p className="rl-msg">이 열에는 값이 없습니다.</p>}
                {fmode && fcol && facet.map(({ v, count }, i) => {
                  const on = picked_(fcol).includes(v)
                  return (
                    <div key={v} className={`rl-row rl-frow rl-hit${on ? ' on' : ''}`}
                      onClick={() => setFsel((s2) => {
                        const cur = s2[fcol] || []
                        return { ...s2, [fcol]: on ? cur.filter((x) => x !== v) : [...cur, v] }
                      })}>
                      <span className="rl-chk"><input type="checkbox" checked={on} tabIndex={-1} readOnly
                        aria-label={`${v} 고르기`} /></span>
                      <span className="rl-gut">{i + 1}</span>
                      <span className="rl-c rl-ink">{v}</span>
                      <span className="rl-c rl-num">{count}</span>
                    </div>
                  )
                })}
                {!fmode && rows.map((a, i) => {
                  const cur = currentAff(a)
                  const on = picked.has(a.id)
                  const edited = etabs.some((t) => t.who === a.id)
                  return (
                    <RackRow key={a.id || i} cols={cols} tone={TONE}
                      className={`rl-hit${on ? ' on' : ''}${edited ? ' rl-edited' : ''}`}
                      onClick={(e) => hit(i, e.shiftKey)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openEdit({ id: `edit:${a.id}`, kind: 'edit', label: anyName(a), who: a.id })
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
                        core: (tab.grp ? coreIn(a, tab.grp) : coreOf(a)) ?? D,
                      }} />
                  )
                })}
                {!fmode && rows.length === 0 && <p className="rl-msg">해당하는 저자가 없습니다.</p>}
              </RackTable>
              {/* What you ticked is the set you assembled; with nothing ticked
                  the tab itself is the set. */}
              <ListOut list={chosen.length ? chosen : scope} picked={chosen.length > 0}
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
                  cell={{ num: i + 1, name: r.name, count: r.count, full: r.full || D }} />
              ))}
              {classes.length === 0 && <p className="rl-msg">등록된 항목이 없습니다.</p>}
            </RackTable>
          )}

        </div>)}

        {showEdit && (<div className="rl-pane rl-epane">
          <RackTabs tabs={etabs} active={eactive} opened
            onPick={setEactive} onClose={closeEdit} />
          {etab.kind === 'edit' ? (
            <EditAuthor author={etab.who ? authors.find((a) => a.id === etab.who) : null}
              doc={doc} onSave={commit} isAdmin={IS_ADMIN} say={setNote}
              onCreated={(id, label) => {
                closeEdit('new')
                openEdit({ id: `edit:${id}`, kind: 'edit', label, who: id })
              }}
              onDone={(id) => closeEdit(`edit:${id}`)}
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
              onDone={(name) => closeEdit(`editcls:${etab.of}:${name}`)} />
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

const byPaperOrder = (core = coreOf) => (a, b) => {
  const c = (core(a) ?? 99) - (core(b) ?? 99)
  return c !== 0 ? c : (citeShort(a) || engName(a) || anyName(a))
    .localeCompare(citeShort(b) || engName(b) || anyName(b))
}

// ─── My List's output: the reason the list exists ───────────────────────────
function ListOut({ list, picked, doc, say, open, setOpen }) {
  const [sep, setSep] = useState(', ')
  const [tpl, setTpl] = useState(PRESETS[0][1])
  const [paper, setPaper] = useState(false)   // the LaTeX block is not a template

  /** The LaTeX author block: core order, then a superscript per affiliation. */
  const paperOut = () => {
    const ordered = [...list].sort(byPaperOrder())
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
          <button key={label} type="button" className={`rl-btn${!paper && tpl === t ? ' on' : ''}`}
            disabled={none} onClick={() => { setPaper(false); setTpl(t) }}>{label}</button>
        ))}
        <button type="button" className={`rl-btn rl-go${paper ? ' on' : ''}`} disabled={none}
          onClick={() => setPaper(true)}>paper authors</button>
        <span className="rl-sp" />
        <button type="button" className="rl-btn" disabled={!out} onClick={copy}>copy</button>
      </div>

      {/* The rule itself, editable. The tokens are the column names. */}
      <div className="rl-rule-line">
        <span className="rl-hint">나열 규칙</span>
        <input className="rl-in rl-mono" style={{ flex: 1, minWidth: 180 }} value={tpl}
          disabled={paper} onChange={(e) => { setPaper(false); setTpl(e.target.value) }} />
        <span className="rl-hint">사이</span>
        <input className="rl-in rl-mono" style={{ width: 66 }} value={sep} disabled={paper}
          onChange={(e) => setSep(e.target.value)} title="구분기호" />
        <button type="button" className="rl-btn" title="줄바꿈 추가" disabled={paper}
          onClick={() => setSep((v) => `${v}⏎`)}>+⏎</button>
      </div>
      <div className="rl-tokens">
        {Object.keys(TOKENS).map((k) => (
          <button key={k} type="button" className="rl-tok" disabled={paper}
            onClick={() => { setPaper(false); setTpl((v) => `${v}{${k}}`) }}>{`{${k}}`}</button>
        ))}
      </div>

      <textarea className="rl-outbox" value={out} readOnly
        placeholder={none ? '이 탭에 사람이 없습니다.' : ''} />
      </>)}
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Fld({ label, children }) {
  return (<><span className="rl-fl">{label}</span><div className="rl-fv">{children}</div></>)
}

/** A list of plain strings — emails, links — one line each. */
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
const latestIdx = (list) => {
  let best = -1
  list.forEach((x, i) => {
    if (best < 0 || String(x.since || '').localeCompare(String(list[best].since || '')) >= 0) best = i
  })
  return best
}

/** The affiliation history: every entry, in the order it is stored. */
function AffRows({ value = [], options, onChange }) {
  const cur = latestIdx(value)
  const put = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
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
          {i === cur && <span className="rl-tag">현재</span>}
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="rl-btn" onClick={() =>
        onChange([...value, { tag: '', dept: '', position: '', email: '', since: '' }])}>+ 소속</button>
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

function EditAuthor({ author, doc, onSave, isAdmin, onCreated, onDeleted, onDone, say }) {
  // No author means a DRAFT: the same form, and saving puts it in the document
  // rather than over one. One form, two jobs, so a field added here is added to
  // both at once.
  const draft = !author
  const blank = { id: null, korFamily: '', korGiven: '', engFirst: '', engMiddle: '', engLast: '' }
  const [f, setF] = useState(author || blank)
  const [sure, setSure] = useState(false)   // delete asks once, in place
  useEffect(() => { setF(author || blank); setSure(false) }, [author])  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const affNames = (doc.affiliations || []).map((r) => r.name)
  const grpNames = (doc.groups || []).map((r) => r.name)

  const named = () => (f.nick || '').trim() || korName(f) || engName(f)

  // A half-typed line is not data. Blank strings and entries that point at no
  // affiliation or group are dropped on the way out, so the document does not
  // collect the rows somebody added and thought better of.
  const tidy = (r) => ({
    ...r,
    emails: (r.emails || []).map((x) => String(x).trim()).filter(Boolean),
    links: (r.links || []).map((x) => String(x).trim()).filter(Boolean),
    affiliations: (r.affiliations || []).filter((x) => String(x.tag || '').trim()),
    groups: (r.groups || []).filter((x) => String(x.group || '').trim()),
  })

  async function create() {
    if (!named()) return   // the button is disabled, but a stray Enter is not
    const now = new Date().toISOString()
    const a = { ...tidy(f), id: newId(), createdAt: now, updatedAt: now }
    if (await onSave({ authors: [a, ...doc.authors] }, `${anyName(a)} 등록됨`)) onCreated?.(a.id, anyName(a))
  }
  async function update() {
    const ok = await onSave({
      authors: doc.authors.map((a) => (a.id === f.id ? { ...tidy(f), updatedAt: new Date().toISOString() } : a)),
    })
    // The record was an errand, not a destination: a save that landed closes
    // the tab it came from. A save that lost the race keeps it, edits and all.
    if (ok) onDone?.(f.id)
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
        <Fld label="대표 email">
          <input className="rl-in" style={{ width: 260 }} value={f.repEmail || ''} onChange={set('repEmail')}
            placeholder={(author && repEmail(author)) || 'name@ibs.re.kr'} />
          <span className="rl-hint">비우면 현재 소속의 이메일을 씁니다.</span>
        </Fld>
        <Fld label="소속 이력">
          <AffRows value={f.affiliations || []} options={affNames}
            onChange={(v) => setF((s) => ({ ...s, affiliations: v }))} />
        </Fld>
        <Fld label="그룹 소속">
          <GrpRows value={f.groups || []} options={grpNames}
            onChange={(v) => setF((s) => ({ ...s, groups: v }))} />
        </Fld>
        <Fld label="이메일">
          <TextRows value={f.emails || []} add="+ 이메일" placeholder="name@lab.kr"
            onChange={(v) => setF((s) => ({ ...s, emails: v }))} />
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
        <Fld label="">
          {draft ? (
            <>
              <button type="button" className="rl-btn rl-go" disabled={!named()} onClick={create}>등록</button>
              <span className="rl-hint">
                {named() ? '' : '별명이나 이름 하나는 있어야 합니다.'}
              </span>
            </>
          ) : (
            <>
              <button type="button" className="rl-btn rl-go" onClick={update}>save and exit</button>
              <button type="button" className="rl-btn" onClick={() => setF(author)}>revert</button>
              {isAdmin && (
                <>
                  <span className="rl-gap" />
                  {/* Asked in place: window.confirm never appears inside the
                      portal's frame, so a dialog would delete with no question
                      asked at all. */}
                  {sure ? (
                    <>
                      <span className="rl-hint">되돌릴 수 없습니다.</span>
                      <button type="button" className="rl-btn rl-danger" onClick={remove}>정말 삭제</button>
                      <button type="button" className="rl-btn" onClick={() => setSure(false)}>취소</button>
                    </>
                  ) : (
                    <button type="button" className="rl-btn rl-danger" onClick={() => setSure(true)}>delete</button>
                  )}
                </>
              )}
            </>
          )}
        </Fld>
      </div>
    </div>
  )
}

function EditClass({ name, of, doc, onSave, isAdmin, onCreated, onDone }) {
  const key = of === 'affiliation' ? 'affiliations' : 'groups'
  const what = of === 'affiliation' ? '소속' : '그룹'
  const draft = !name
  const rec = draft ? null : (doc[key] || []).find((r) => r.name === name)
  const [f, setF] = useState(rec || { name: '', shortName: '', fullName: '' })
  const [sure, setSure] = useState(false)
  useEffect(() => { setF(rec || { name: '', shortName: '', fullName: '' }); setSure(false) }, [name, rec])
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
  async function update() {
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
    if (await onSave({ [key]: recs, authors })) onDone?.(rec.name)
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
          <Fld label="설명 · 기간">
            <input className="rl-in" style={{ width: 300 }} value={f.description || ''} onChange={set('description')} placeholder="description" />
            <input className="rl-in" style={{ width: 110 }} value={f.creationDate || ''} onChange={set('creationDate')} placeholder="2025-01-01" />
            <input className="rl-in" style={{ width: 110 }} value={f.endDate || ''} onChange={set('endDate')} placeholder="end" />
          </Fld>
        )}
        <Fld label="링크">
          <TextRows value={f.links || []} add="+ 링크" placeholder="https://…" link
            onChange={(v) => setF((s) => ({ ...s, links: v }))} />
        </Fld>
        <Fld label="">
          {draft ? (
            <>
              <button type="button" className="rl-btn rl-go" disabled={!named || taken} onClick={create}>등록</button>
              {!named && <span className="rl-hint">이름이 있어야 합니다.</span>}
            </>
          ) : (
            <>
              <button type="button" className="rl-btn rl-go" disabled={!named || taken} onClick={update}>save and exit</button>
              <button type="button" className="rl-btn" onClick={() => setF(rec)}>revert</button>
              {isAdmin && (
                <>
                  <span className="rl-gap" />
                  {sure ? (
                    <>
                      <span className="rl-warn">
                        {users ? `저자 ${users}명의 목록에서도 빠집니다.` : '쓰는 저자가 없습니다.'} 되돌릴 수 없습니다.
                      </span>
                      <button type="button" className="rl-btn rl-danger" onClick={remove}>정말 삭제</button>
                      <button type="button" className="rl-btn" onClick={() => setSure(false)}>취소</button>
                    </>
                  ) : (
                    <button type="button" className="rl-btn rl-danger" onClick={() => setSure(true)}>delete</button>
                  )}
                </>
              )}
            </>
          )}
        </Fld>
      </div>
    </div>
  )
}
