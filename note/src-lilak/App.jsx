/**
 * note — one markdown file per note, listed the way the other RACK services list.
 *
 *   노트 ──────────────────────────────── nameplate (the service's own colour)
 *   + 새 노트 ▾  인쇄  선택 해제   [검색]  command line
 *   notes │ todos │ tags │ KoBRA ×        tabs
 *   ☐ # date title tags 할일 words …     the head: sticky, draggable edges
 *   …rows…                               26px each
 *
 * A note is a FILE: YAML front matter (title, date, tags, and whatever else you
 * put there) and a markdown body. The folder opens in Obsidian unchanged, so
 * nothing here is a format of our own — the todos are GFM checkboxes, and a
 * template is just a note in templates/.
 *
 * The table, tabs, selection and portal plumbing are the kit's `racklist`,
 * shared with author_manager and reference_manager.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs,
  useColumnWidths, useViewportWidth, useSelection, useFindKey, useNote, useViewState,
  bySome, facetOf, passesFilter,
  PORTAL_BASE, PORTAL_PROJECT, brandStyle, projectKey, authHeaders,
} from 'lilak-ui/racklist'
// The same renderer elog writes its logs with: GFM (so `- [ ]` is a checkbox)
// and one newline means one line break, because a note is typed, not typeset.
import Markdown from 'lilak-ui/log/Markdown.jsx'
import MarkdownArea, { TAG_RE } from './MarkdownArea.jsx'
import 'lilak-ui/racklist/rack.css'
import './note.css'

const WIDTH_KEY = projectKey('nt', 'cols')
const VIEW_KEY = projectKey('nt', 'view')
const api = (p, o) => fetch(`${PORTAL_BASE}/api${p}`, {
  ...o, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(o?.headers || {}) },
})
async function ask(p, o) {
  const r = await api(p, o)
  if (r.status === 409) return { conflict: true, body: await r.json() }
  if (!r.ok) throw new Error(`${o?.method || 'GET'} ${p} → ${r.status}`)
  return { body: await r.json() }
}

const D = '·'
const tagsOf = (n) => (n.tags || []).filter(Boolean)
/** The tags a body carries — and the body is the only place one lives.
 *  `#태그` is Obsidian's spelling, and markdown's own rule keeps it apart from
 *  a heading: `# ` has a space after the hash. */
export function bodyTags(body) {
  const out = []
  for (const m of String(body || '').matchAll(TAG_RE)) {
    if (!out.includes(m[2])) out.push(m[2])
  }
  return out
}
const inTag = (n, t) => tagsOf(n).includes(t)

const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'date', w: 92, min: 70, label: 'date' },
  { k: 'title', w: 260, min: 100, label: 'title' },
  { k: 'tags', w: 170, min: 60, label: 'tags' },
  { k: 'todo', w: 52, min: 40, label: '할 일', num: true },
  { k: 'words', w: 58, min: 40, label: 'words', num: true, drop: 1040 },
  { k: 'excerpt', w: 360, min: 120, label: '첫 줄', drop: 1180 },
]
const CLS_COLS = [
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'name', w: 220, min: 80, label: 'tag' },
  { k: 'count', w: 70, min: 46, label: 'notes', num: true },
]
const TODO_COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'text', w: 420, min: 120, label: '할 일' },
  { k: 'title', w: 220, min: 80, label: 'note' },
  { k: 'date', w: 92, min: 70, label: 'date' },
  { k: 'tags', w: 160, min: 60, label: 'tags', drop: 1040 },
]
const TONE = { title: 'ink', text: 'ink', date: 'dim', tags: 'dim', excerpt: 'dim' }

const SORTERS = {
  date: (n) => n.date || '',
  title: (n) => n.title || '',
  tags: (n) => tagsOf(n).join(' '),
  todo: (n) => n.todo || null,
  words: (n) => n.words || null,
  excerpt: (n) => n.excerpt || '',
}
const TODO_SORTERS = {
  text: (t) => t.text || '', title: (t) => t.title || '',
  date: (t) => t.date || '', tags: (t) => (t.tags || []).join(' '),
}
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count }

const FIXED = [
  { id: 'notes', kind: 'notes', label: 'notes' },
  { id: 'todos', kind: 'todos', label: 'todos' },
  { id: 'tags', kind: 'classes', label: 'tags' },
]

export default function App() {
  const [VIEW, saveView] = useViewState(VIEW_KEY)
  const [index, setIndex] = useState(null)       // { notes, templates }
  const [todos, setTodos] = useState([])
  const [err, setErr] = useState('')
  const [note, setNote] = useNote()
  const [tabs, setTabs] = useState(() => [...FIXED,
    ...(VIEW.tabs || []).filter((t) => t?.id && !FIXED.some((f) => f.id === t.id))])
  const [active, setActive] = useState(VIEW.active || 'notes')
  // The editor can be TWO columns, each with its own tabs: two notes open side
  // by side is the point, and a tab is sent across rather than dragged. A tab
  // carries the column it is in; a column with no tabs is not drawn.
  const [etabs, setEtabs] = useState([])            // [{ id, label, col }]
  const [eactive, setEactive] = useState({})
  const [ecol, setECol] = useState(0)               // the column a new note opens in
  const [efull, setEFull] = useState(!!VIEW.efull)  // the editor takes the list's width too
  const [query, setQuery] = useState('')
  const [bodyHits, setBodyHits] = useState(null)   // ids whose BODY matched
  const { drag, sized } = useColumnWidths(WIDTH_KEY, [...COLS, ...CLS_COLS, ...TODO_COLS])
  const vw = useViewportWidth()
  const [sort, setSort] = useState(VIEW.sort || null)
  const [clsSort, setClsSort] = useState(VIEW.clsSort || { k: 'count', dir: -1 })
  const [fmode, setFmode] = useState(false)
  const [fcol, setFcol] = useState(null)
  const [fsel, setFsel] = useState(VIEW.fsel || {})
  const [fon, setFon] = useState(!!VIEW.fon)
  const findRef = useRef(null)
  useFindKey(findRef)

  const reload = useCallback(async () => {
    try {
      const { body } = await ask('/notes')
      setIndex(body)
      const t = await ask('/todos')
      setTodos(t.body.todos)
    } catch (e) { setErr(String(e.message || e)) }
  }, [])
  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    reload()
  }, [reload])
  useEffect(() => {
    saveView({ tabs: tabs.filter((t) => !FIXED.some((f) => f.id === t.id)),
               active, sort, clsSort, fsel, fon, efull })
  }, [tabs, active, sort, clsSort, fsel, fon, efull])   // eslint-disable-line react-hooks/exhaustive-deps

  const notes = index?.notes || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

  // The list carries a first line, not the body — so a search that finds
  // nothing locally asks the server to look INSIDE the notes.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setBodyHits(null); return }
    const t = setTimeout(async () => {
      try {
        const { body } = await ask(`/search?q=${encodeURIComponent(q)}`)
        setBodyHits(new Map(body.hits.map((h) => [h.id, h.text])))
      } catch { setBodyHits(null) }
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const cols = useMemo(() => sized(COLS, vw), [sized, vw])
  const clsCols = useMemo(() => sized(CLS_COLS, vw, 'c:'), [sized, vw])
  const todoCols = useMemo(() => sized(TODO_COLS, vw, 't:'), [sized, vw])

  const scopeOf = useCallback((t) => {
    if (t?.kind !== 'notes') return []
    const list = t.tag ? notes.filter((n) => inTag(n, t.tag)) : notes
    return [...list].sort(bySome(SORTERS[sort?.k || 'date'], sort?.dir ?? -1))
  }, [notes, sort])
  const scope = useMemo(() => scopeOf(tab), [scopeOf, tab])

  const passes = useCallback((n) => passesFilter(n, fsel, SORTERS), [fsel])
  const rows = useMemo(() => {
    const kept = fon ? scope.filter(passes) : scope
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((n) => [n.title, n.date, n.excerpt, ...tagsOf(n)]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      || bodyHits?.has(n.id))
  }, [scope, fon, passes, query, bodyHits])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)

  const todoRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = tab?.kind === 'todos'
      ? todos.filter((t) => !q || [t.text, t.title, ...(t.tags || [])]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
      : []
    const s = sort && TODO_SORTERS[sort.k] ? sort : { k: 'date', dir: -1 }
    return [...list].sort(bySome(TODO_SORTERS[s.k], s.dir))
  }, [todos, tab, query, sort])

  const facet = useMemo(() => facetOf(scope, SORTERS[fcol]), [fcol, scope])
  const picked_ = (k) => fsel[k] || []
  const facetTotal = Object.values(fsel).reduce((t, v) => t + v.length, 0)

  const classes = useMemo(() => {
    if (tab?.kind !== 'classes') return []
    const names = [...new Set(notes.flatMap(tagsOf))]
    return names.map((name) => ({ name, count: notes.filter((n) => inTag(n, name)).length }))
      .sort(bySome(CLS_SORTERS[clsSort.k] || CLS_SORTERS.name, clsSort.dir))
  }, [notes, tab, clsSort])

  const ecols = [...new Set(etabs.map((t) => t.col))].sort((a, b) => a - b)
  const showEdit = ecols.length > 0
  // Two editor columns need the room the list was using; one does not.
  const showList = !showEdit || (vw >= (ecols.length > 1 ? 1500 : 1180) && !efull)

  function openTab(t) {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setActive(t.id)
  }
  function closeTab(id) {
    setTabs((ts) => ts.filter((t) => t.id !== id))
    if (active === id) setActive('notes')
  }
  function openEdit(id, label) {
    const had = etabs.find((t) => t.id === id)
    const col = had ? had.col : ecol
    if (!had) setEtabs((ts) => [...ts, { id, label, col }])
    setEactive((a) => ({ ...a, [col]: id }))
  }
  function closeEdit(id) {
    const gone = etabs.find((t) => t.id === id)
    const left = etabs.filter((t) => t.id !== id)
    setEtabs(left)
    if (!gone) return
    const mine = left.filter((t) => t.col === gone.col)
    setEactive((a) => ({ ...a, [gone.col]: mine.length ? mine[mine.length - 1].id : null }))
    if (!mine.length) setECol(left.length ? left[left.length - 1].col : 0)
  }
  /** Send a note to the other column — which is how the second column comes to
   *  exist, and how it stops existing when its last tab leaves. */
  function moveEdit(id) {
    const t = etabs.find((x) => x.id === id)
    if (!t) return
    // Away from where this column stands: the rightmost column sends left, any
    // other sends right. A single column is on the right of the list, so its
    // note goes to a new column beside it on the left.
    const to = t.col >= Math.max(...etabs.map((x) => x.col)) ? t.col - 1 : t.col + 1
    const left = etabs.filter((x) => x.id !== id && x.col === t.col)
    setEtabs((ts) => ts.map((x) => (x.id === id ? { ...x, col: to } : x)))
    setEactive((a) => ({ ...a, [to]: id, [t.col]: left.length ? left[left.length - 1].id : null }))
    setECol(to)
  }
  useEffect(() => {
    if (!index) return
    const alive = (t) => (t.tag ? notes.some((n) => inTag(n, t.tag)) : FIXED.some((f) => f.id === t.id))
    setTabs((ts) => (ts.every(alive) ? ts : ts.filter(alive)))
  }, [index])   // eslint-disable-line react-hooks/exhaustive-deps

  async function create(template) {
    try {
      const { body } = await ask('/notes', { method: 'POST', body: JSON.stringify({ title: '제목 없음', template }) })
      await reload()
      openEdit(body.id, body.title)
      setNote(template ? `'${template}' 템플릿으로 만들었습니다.` : '새 노트를 만들었습니다.')
    } catch (e) { setNote(String(e.message || e)) }
  }
  async function toggleTodo(t) {
    try {
      const { conflict, body } = await ask('/todos', { method: 'PUT',
        body: JSON.stringify({ id: t.id, line: t.line, done: !t.done, text: t.text }) })
      if (conflict) { setNote(body.detail || '노트가 바뀌었습니다.'); await reload(); return }
      await reload()
    } catch (e) { setNote(String(e.message || e)) }
  }
  /** The browser's own printer, in a tab of its own: a PDF with Korean in it
   *  needs the system's fonts, which is the one thing a JS pdf library makes
   *  hard and a print dialog makes free. */
  function printNotes(ids) {
    if (!ids.length) { setNote('인쇄할 노트를 고르세요.'); return }
    window.open(`${PORTAL_BASE}/?print=${ids.join(',')}`, '_blank', 'noopener')
  }

  const chosen = useMemo(() => rows.filter((n) => picked.has(n.id)), [rows, picked])

  return (
    <div className="rl" style={brandStyle()}>
      <section className="rl-mod">
        <header className="rl-bar">
          <b>노트</b>
          <span className="rl-n">{index ? `${notes.length}개` : ''}</span>
          <span className="rl-sp" />
          <span className="rl-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="rl-cmd">
          <button type="button" className="rl-btn rl-go" onClick={() => create(null)}>+ 새 노트</button>
          {!!index?.templates?.length && (
            /* A template is a note in templates/ — so this list is a folder
               listing, not a feature with a store behind it. */
            <select className="rl-btn rl-go rl-pick" value=""
              onChange={(e) => { if (e.target.value) create(e.target.value) }}>
              <option value="">템플릿으로…</option>
              {index.templates.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={() => printNotes([...picked])}>인쇄 · PDF ({picked.size})</button>
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {tabs.length > FIXED.length && (
            <button type="button" className="rl-btn" title="열어둔 탭을 모두 닫습니다"
              onClick={() => { setTabs(FIXED); setActive('notes') }}>
              탭 닫기 ({tabs.length - FIXED.length})
            </button>
          )}
          {etabs.length > 0 && (
            <button type="button" className="rl-btn" title="편집 패널의 탭을 모두 닫습니다"
              onClick={() => { setEtabs([]); setEactive({}); setECol(0) }}>
              편집 닫기 ({etabs.length})
            </button>
          )}
          <span className="rl-gap" />
          {tab?.kind === 'notes' && (fmode ? (
            <>
              <button type="button" className="rl-btn rl-go"
                onClick={() => { setFmode(false); setFon(facetTotal > 0) }}>
                필터 적용{facetTotal ? ` (${facetTotal})` : ''}
              </button>
              <button type="button" className="rl-btn" onClick={() => setFmode(false)}>취소</button>
            </>
          ) : fon ? (
            <>
              <button type="button" className="rl-btn rl-danger"
                onClick={() => { setFon(false); setFsel({}); setFcol(null) }}>필터 풀기</button>
              <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 고치기</button>
            </>
          ) : (
            <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 선택</button>
          ))}
          <span className="rl-sp" />
          <input ref={findRef} type="search" className="rl-find" value={query}
            placeholder="제목 · 태그 · 본문   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane">
            <RackTabs tabs={tabs} active={active} fixed={FIXED}
              onPick={setActive} onClose={closeTab} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !index && <p className="rl-msg">읽는 중…</p>}

            {index && tab?.kind === 'notes' && (
              <RackTable cols={cols} onDrag={drag('')}
                facet={fmode ? { col: fcol, count: (k) => picked_(k).length, onPick: setFcol } : null}
                sort={sort || { k: 'date', dir: -1 }}
                onSort={(k) => setSort((s) => {
                  const now = s || { k: 'date', dir: -1 }
                  return now.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={fmode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                {fmode && !fcol && <p className="rl-msg">위의 레이블을 눌러 어떤 종류로 걸를지 고르세요.</p>}
                {fmode && fcol && facet.map(({ v, count }) => {
                  const on = picked_(fcol).includes(v)
                  return (
                    <button key={v} type="button" className={`rl-frow${on ? ' on' : ''}`}
                      onClick={() => setFsel((s) => {
                        const cur = s[fcol] || []
                        return { ...s, [fcol]: on ? cur.filter((x) => x !== v) : [...cur, v] }
                      })}>
                      <span className="rl-fv">{v}</span><span className="rl-fn">{count}</span>
                    </button>
                  )
                })}
                {!fmode && rows.map((n, i) => {
                  const on = picked.has(n.id)
                  const open = etabs.some((t) => t.id === n.id)
                  return (
                    <RackRow key={n.id} cols={cols} tone={TONE}
                      className={`rl-hit${on ? ' on' : ''}${open ? ' rl-edited' : ''}`}
                      onClick={(e) => hit(i, e.shiftKey)}
                      onContextMenu={(e) => { e.preventDefault(); openEdit(n.id, n.title) }}
                      cell={{
                        chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                          aria-label={`${n.title} 선택`} />,
                        num: i + 1,
                        date: n.date || D,
                        title: n.title,
                        tags: tagsOf(n).join(' ') || D,
                        todo: n.todo ? `${n.todo}` : (n.done ? '✓' : D),
                        words: n.words || D,
                        // While searching, the line the BODY matched on is more
                        // use than the note's first line.
                        excerpt: (bodyHits?.get(n.id) || n.excerpt) || D,
                      }} />
                  )
                })}
                {!fmode && rows.length === 0 && <p className="rl-msg">해당하는 노트가 없습니다.</p>}
              </RackTable>
            )}

            {index && tab?.kind === 'todos' && (
              <RackTable cols={todoCols} onDrag={drag('t:')}
                sort={sort && TODO_SORTERS[sort.k] ? sort : { k: 'date', dir: -1 }}
                onSort={(k) => setSort((s) => (s?.k === k ? { k, dir: -s.dir } : { k, dir: 1 }))}>
                {todoRows.map((t, i) => (
                  <RackRow key={`${t.id}:${t.line}`} cols={todoCols} tone={TONE}
                    className={`rl-hit${t.done ? ' rl-done' : ''}`}
                    onContextMenu={(e) => { e.preventDefault(); openEdit(t.id, t.title) }}
                    cell={{
                      chk: <input type="checkbox" checked={t.done} aria-label={t.text}
                        onChange={() => toggleTodo(t)} onClick={(e) => e.stopPropagation()} />,
                      num: i + 1,
                      text: t.text || D,
                      title: (
                        <button type="button" className="rl-lnk"
                          onClick={(e) => { e.stopPropagation(); openEdit(t.id, t.title) }}>{t.title}</button>
                      ),
                      date: t.date || D,
                      tags: (t.tags || []).join(' ') || D,
                    }} />
                ))}
                {todoRows.length === 0 && <p className="rl-msg">할 일이 없습니다 — 노트에 `- [ ] 할 일`을 적으면 여기 모입니다.</p>}
              </RackTable>
            )}

            {index && tab?.kind === 'classes' && (
              <RackTable cols={clsCols} onDrag={drag('c:')} sort={clsSort}
                onSort={(k) => setClsSort((s) => (s.k === k ? { k, dir: -s.dir } : { k, dir: 1 }))}>
                {classes.map((r, i) => (
                  <RackRow key={r.name} cols={clsCols} tone={TONE} className="rl-hit"
                    onClick={() => openTab({ id: `tag:${r.name}`, kind: 'notes', tag: r.name, label: r.name })}
                    cell={{ num: i + 1, name: r.name, count: r.count }} />
                ))}
                {classes.length === 0 && <p className="rl-msg">아직 태그가 없습니다.</p>}
              </RackTable>
            )}
          </div>)}

          {ecols.map((c) => {
            const mine = etabs.filter((t) => t.col === c)
            const cur = mine.find((t) => t.id === eactive[c]) || mine[0]
            return (
              <div key={c} className="rl-pane rl-epane" onMouseDown={() => setECol(c)}>
                <div className="nt-strip">
                  {/* Double-click gives the editor the list's width too. */}
                  <div className="nt-strip-tabs" onDoubleClick={() => setEFull((v) => !v)}
                    title="두 번 눌러 전체 너비">
                    <RackTabs tabs={mine} active={cur?.id} opened
                      onPick={(id) => setEactive((a) => ({ ...a, [c]: id }))}
                      onClose={closeEdit} />
                  </div>
                  {/* One button, and it is the whole arrangement: a note sent
                      across opens the other column, and the column closes when
                      its last note leaves. */}
                  {/* The arrow says where the note will go, which is away from
                      the side this column is on. */}
                  <button type="button" className="rl-btn nt-send" onClick={() => moveEdit(cur.id)}
                    title={c === ecols[ecols.length - 1] ? '왼쪽으로 보내기' : '오른쪽으로 보내기'}>
                    {c === ecols[ecols.length - 1] ? '←' : '→'}
                  </button>
                  {/* The same thing the double-click does, for anyone who would
                      never find a double-click. */}
                  <button type="button" className="rl-btn nt-send" onClick={() => setEFull((v) => !v)}
                    title={efull ? '목록 다시 보기' : '전체 너비'}>{efull ? '⇥' : '⇤'}</button>
                </div>
                <Editor id={cur.id} say={setNote} onSaved={reload}
                  onPrint={() => printNotes([cur.id])}
                  onClosed={(cid) => { closeEdit(cid); reload() }} />
              </div>
            )
          })}
        </div>

        <footer className="rl-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위, 오른쪽 클릭으로 편집.'}</span>
          <span className="rl-sp" />
          <span className="rl-mono">
            {tab?.kind === 'todos' ? (todoRows.length ? `${todoRows.length}줄` : '')
              : rows.length ? `${rows.length}줄` : ''}
          </span>
        </footer>
      </section>
    </div>
  )
}

// ─── One note ───────────────────────────────────────────────────────────────
/** The note is read when the tab opens, not from the list — the list carries a
 *  first line, and this needs the file. */
function Editor({ id, say, onSaved, onClosed, onPrint }) {
  const [n, setN] = useState(null)
  const [f, setF] = useState(null)
  const [sure, setSure] = useState(false)
  const [open, setOpen] = useState(false)     // the fold beside the title
  useEffect(() => {
    let live = true
    setN(null); setSure(false)
    ask(`/notes/${encodeURIComponent(id)}`)
      .then(({ body }) => { if (live) { setN(body); setF(body) } })
      .catch((e) => say(String(e.message || e)))
    return () => { live = false }
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!f || !n) return <p className="rl-msg">읽는 중…</p>
  const dirty = JSON.stringify(f) !== JSON.stringify(n)
  // Tags live in the BODY now (#태그), so this is what the note will carry the
  // moment it is saved — shown rather than edited.
  const tags = bodyTags(f.body)

  async function saveNote(andClose) {
    const { conflict, body } = await ask(`/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ baseVersion: n.version, title: f.title, body: f.body }),
    })
    if (conflict) {
      say(body.detail || '다른 곳에서 바뀌었습니다.')
      setN(body.current); setF(body.current)
      return
    }
    setN(body); setF(body)
    say('저장했습니다.')
    onSaved?.()
    if (andClose) onClosed?.(id)
  }
  async function remove() {
    await ask(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    say(`'${n.title}' 삭제됨`)
    onClosed?.(id)
  }

  return (
    <div className="nt-edit">
      {/* The buttons sit above the title: everything below them is the note. */}
      <div className="nt-acts">
        <button type="button" className="rl-btn rl-go" disabled={!dirty} onClick={() => saveNote(false)}>save</button>
        <button type="button" className="rl-btn rl-go" onClick={() => saveNote(true)}>save and exit</button>
        <button type="button" className="rl-btn" disabled={!dirty} onClick={() => setF(n)}>revert</button>
        <button type="button" className="rl-btn" onClick={onPrint}>인쇄 · PDF</button>
        <span className="rl-sp" />
        {sure ? (
          <>
            <span className="rl-hint">파일이 지워집니다.</span>
            <button type="button" className="rl-btn rl-danger" onClick={remove}>정말 삭제</button>
            <button type="button" className="rl-btn" onClick={() => setSure(false)}>취소</button>
          </>
        ) : (
          <button type="button" className="rl-btn rl-danger" onClick={() => setSure(true)}>delete</button>
        )}
      </div>

      <div className="nt-titlerow">
        <input className="nt-title" value={f.title} placeholder="제목"
          onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} />
        {/* Everything that is not the title or the body is behind this. */}
        <button type="button" className="nt-fold" onClick={() => setOpen(!open)}
          title={open ? '접기' : '날짜 · 태그 · 파일 이름'} aria-expanded={open}>
          <i className="rl-caret">{open ? '▾' : '▸'}</i>
          {tags.length ? <span className="nt-tagline">{tags.map((t) => `#${t}`).join(' ')}</span> : null}
        </button>
      </div>
      {open && (
        <div className="nt-meta-open">
          <span className="rl-hint">{f.date || '날짜 없음'}</span>
          <span className="rl-hint rl-mono">{f.id}.md</span>
          {Object.entries(f.fields || {}).map(([k, v]) => (
            <span key={k} className="rl-hint"><b className="rl-mono">{k}</b> {String(v ?? '')}</span>
          ))}
          <span className="rl-sp" />
          <span className="rl-hint">{f.body.split(/\s+/).filter(Boolean).length}단어</span>
        </div>
      )}

      <MarkdownArea value={f.body} placeholder="markdown. #태그 로 태그를, `- [ ] 할 일`로 todos 탭에."
        onChange={(v) => setF((s) => ({ ...s, body: v }))} />
    </div>
  )
}

// ─── Printing ───────────────────────────────────────────────────────────────
/** The notes, rendered as a document and handed to the browser's printer —
 *  which is also its PDF writer, with the system's fonts, which is the whole
 *  reason not to carry a PDF library and a 10MB Korean font. */
export function PrintView({ ids }) {
  const [notes, setNotes] = useState(null)
  // The dialog opens by itself, because that is what pressing 인쇄 asked for.
  // `&auto=0` is for reading the page without it — and for a test that should
  // not hang on a print dialog.
  const auto = new URLSearchParams(window.location.search).get('auto') !== '0'
  useEffect(() => {
    Promise.all(ids.map((id) => ask(`/notes/${encodeURIComponent(id)}`).then((r) => r.body)))
      .then((ns) => { setNotes(ns); if (auto) setTimeout(() => window.print(), 400) })
      .catch(() => setNotes([]))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!notes) return <p className="nt-print-msg">읽는 중…</p>
  if (!notes.length) return <p className="nt-print-msg">노트를 읽지 못했습니다.</p>
  return (
    <div className="nt-print">
      <div className="nt-print-bar">
        <button type="button" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
        <span>저장 대화상자에서 “PDF로 저장”을 고르세요.</span>
      </div>
      {notes.map((n) => (
        <article key={n.id} className="nt-sheet">
          <h1>{n.title}</h1>
          <p className="nt-meta">
            {n.date}{tagsOf(n).length ? ` · ${tagsOf(n).join(' · ')}` : ''}
            {Object.entries(n.fields || {}).map(([k, v]) => ` · ${k}: ${v}`)}
          </p>
          <Markdown>{n.body}</Markdown>
        </article>
      ))}
    </div>
  )
}
