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
import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs, RackActions,
  useRackList, useRackKeys,
  RackPaneStrip, useMergeMode, RackMergeButtons, RackMerge,
  RackEditClass,
  bySome, FilterBar, FacetRows,
  PORTAL_BASE, PORTAL_PROJECT, brandStyle, projectKey, load, authHeaders,
} from 'lilak-ui/racklist'
// The same renderer elog writes its logs with: GFM (so `- [ ]` is a checkbox)
// and one newline means one line break, because a note is typed, not typeset.
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { remarkSoftBreaks } from 'lilak-ui/log/Markdown.jsx'
import MarkdownArea, { TAG_RE, EMBED_RE, embedSpec } from './MarkdownArea.jsx'
import 'katex/dist/katex.min.css'
import 'lilak-ui/racklist/rack.css'
import './note.css'

const VIEW_KEY = projectKey('nt', 'view')
/** Where a file a note embeds is served from. */
const fileSrc = (name) => `${PORTAL_BASE}/api/file/${encodeURIComponent(name)}`
/** A file dropped into a note: stored beside the notes, named back. Not `api`
 *  — a multipart body writes its own content type, boundary and all. */
async function putFile(file) {
  const form = new FormData()
  form.append('f', file)
  const r = await fetch(`${PORTAL_BASE}/api/file`, { method: 'POST', headers: authHeaders(), body: form })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `올리지 못했습니다 (${r.status}).`)
  return (await r.json()).name
}
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
/** A tag lives in the body and nowhere else, so renaming one is an edit to the
 *  text: `#old` becomes `#new` wherever the tag rule says a tag starts. The
 *  character in front is kept — it is what made it a tag rather than part of a
 *  word, and `#oldish` is a different tag entirely. */
export function renameBodyTag(body, from, to) {
  return String(body || '').replace(TAG_RE, (m, lead, name) =>
    (name === from ? `${lead}#${to}` : m))
}

const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'date', w: 100, min: 84, label: 'date' },   // a whole 2026-08-04 at 15px
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
  { k: 'date', w: 100, min: 84, label: 'date' },
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
  text: (t) => t.text || '', title: (t) => t.title || '', date: (t) => t.date || '',
}

/** Which todos the tab shows. A list of things to do is mostly the ones not
 *  done; the done ones are a record, and both together are the whole note. */
const TODO_SCOPES = [
  { k: 'open', label: '남은 일', is: (t) => !t.done },
  { k: 'all', label: '전체', is: () => true },
  { k: 'done', label: '끝난 일', is: (t) => t.done },
]
const CLS_SORTERS = { name: (r) => r.name, count: (r) => r.count }

const FIXED = [
  { id: 'notes', kind: 'notes', label: 'notes' },
  { id: 'todos', kind: 'todos', label: 'todos' },
  { id: 'tags', kind: 'classes', label: 'tags' },
]

export default function App() {
  const [index, setIndex] = useState(null)       // { notes, templates }
  const [todos, setTodos] = useState([])
  // The note a right-click (or 새 노트) just opened: its title takes the caret,
  // so the first thing you can do with a note is name it.
  const [fresh, setFresh] = useState(null)
  const [bodyHits, setBodyHits] = useState(null)   // ids whose BODY matched

  const notes = index?.notes || []
  // The list carries a first line, not the body, so a local miss asks the
  // server to look inside; either way it is one search.
  const search = useCallback((n, q) => [n.title, n.date, n.excerpt, ...tagsOf(n)]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    || bodyHits?.has(n.id), [bodyHits])
  const scopeOf = useCallback((t, sort) => {
    if (t?.kind !== 'notes') return []
    const list = t.tag ? notes.filter((n) => inTag(n, t.tag)) : notes
    return [...list].sort(bySome(SORTERS[sort?.k || 'date'], sort?.dir ?? -1))
  }, [notes])

  // The todo tab's own scope is this service's alone, so it reads its stored
  // value itself; the hook keeps it with the rest of the view.
  const [tscope, setTscope] = useState(() => load(VIEW_KEY, {}).tscope || 'open')
  const L = useRackList({
    key: 'nt', fixed: FIXED, firstTab: 'notes', sorters: SORTERS, scopeOf, search,
    cols: { '': COLS, 'c:': CLS_COLS, 't:': TODO_COLS },
    sort: null, clsSort: { k: 'count', dir: -1 },
    remember: { tscope },
  })

  // The same names the render has always used.
  const { tab, tabs, openTab, closeTab, scope, rows, filter, panes, split, vw, findRef } = L
  const { sort, setSort, clsSort, setClsSort, query, setQuery, note, setNote, err, setErr } = L
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked } = L
  const { drag } = L
  const cols = L.colsOf('')
  const clsCols = L.colsOf('c:')
  const todoCols = L.colsOf('t:')

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

  // The editors are kept across a visit to another service: a note deleted in
  // the meantime must not come back as an editor with nothing behind it.
  useEffect(() => {
    if (index) {
      panes.keep((t) => (t.kind === 'edittag'
        ? notes.some((n) => inTag(n, t.who))        // the tag is still worn
        : t.kind                                    // mergetags: not a note
          ? true
          : notes.some((n) => n.id === t.id)))
    }
  }, [index])   // eslint-disable-line react-hooks/exhaustive-deps

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

  const todoRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const keep = (TODO_SCOPES.find((x) => x.k === tscope) || TODO_SCOPES[0]).is
    const list = tab?.kind === 'todos'
      ? todos.filter(keep).filter((t) => !q || [t.text, t.title, ...(t.tags || [])]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
      : []
    const s = sort && TODO_SORTERS[sort.k] ? sort : { k: 'date', dir: -1 }
    return [...list].sort(bySome(TODO_SORTERS[s.k], s.dir))
  }, [todos, tab, query, sort, tscope])


  const classes = useMemo(() => {
    if (tab?.kind !== 'classes') return []
    const names = [...new Set(notes.flatMap(tagsOf))]
    return names.map((name) => ({ name, count: notes.filter((n) => inTag(n, name)).length }))
      .sort(bySome(CLS_SORTERS[clsSort.k] || CLS_SORTERS.name, clsSort.dir))
  }, [notes, tab, clsSort])

  // Tags drift here too — the same merge as the other racks, except the fold
  // is one PUT per note, because a tag is text inside the file.
  const onTags = tab?.kind === 'classes'
  const merge = useMergeMode(onTags)
  const mergeCols = useMemo(() => [{ k: 'chk', w: 26, min: 26, fix: true }, ...clsCols], [clsCols])

  // The editor only shows once there is something to edit in it.
  const showEdit = L.showEdit && !!index
  const showList = !showEdit || L.showList
  const openEdit = (id, label) => { panes.open({ id, label }); setFresh(id) }
  /** Which notes wear any of these tags — what the tag editor lists. */
  const tagUsers = useCallback((names) => notes
    .filter((n) => names.some((t) => inTag(n, t)))
    .map((n) => ({ id: n.id, label: n.title || n.id })), [notes])
  useRackKeys({
    onClose: () => { const cur = panes.current(panes.cols[0]); if (cur) panes.close(cur.id) },
    onNew: () => create(null),
  })

  // A file dropped anywhere but the editor: the browser's own answer is to
  // leave the app and show the picture, which inside the portal's frame reads
  // as the service disappearing. The editor's handler runs first and marks the
  // drop as taken; what is left here is refused quietly.
  useEffect(() => {
    const stop = (e) => { if (!e.defaultPrevented && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  async function create(template) {
    try {
      const { body } = await ask('/notes', { method: 'POST', body: JSON.stringify({ title: '제목 없음', template }) })
      await reload()
      openEdit(body.id, body.title)
      setNote(template ? `'${template}' 템플릿으로 만들었습니다.` : '새 노트를 만들었습니다.')
    } catch (e) { setNote(String(e.message || e)) }
  }
  /** Today's note, under the name it always has. One a day: if today's is
   *  already there this opens it instead of making a second one, and a
   *  template called `daily` is used when there is one. */
  async function openDaily() {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const title = `Daily ${day}`
    const had = notes.find((n) => n.title === title)
    if (had) { openEdit(had.id, had.title); setNote(`'${title}'을 열었습니다.`); return }
    try {
      const template = (index?.templates || []).includes('daily') ? 'daily' : null
      const { body } = await ask('/notes', { method: 'POST', body: JSON.stringify({ title, template }) })
      // The tag lives in the body, like every other tag here.
      if (!bodyTags(body.body).includes('daily')) {
        await putNote(body.id, body.version,
          { title, body: body.body ? `${body.body.replace(/\n+$/, '')}\n\n#daily` : '#daily' })
      }
      await reload()
      openEdit(body.id, title)
      setNote(`'${title}'을 만들었습니다.`)
    } catch (e) { setNote(String(e.message || e)) }
  }
  /** Folding tags here is not one document save: a tag is text inside a file,
   *  so it is one save per note. A save can fail or lose a race, so it stops
   *  at the first one that does and says how far it got — half a merge the
   *  user knows about beats a whole one they do not. */
  async function mergeTags(gone, to, users, said) {
    let done = 0
    let stopped = ''
    for (const u of users) {
      try {
        const { body: cur } = await ask(`/notes/${encodeURIComponent(u.id)}`)
        let text = cur.body
        for (const g of gone) text = renameBodyTag(text, g, to)
        if (text === cur.body) continue
        const { conflict, body } = await putNote(u.id, cur.version, { title: cur.title, body: text })
        if (conflict) { stopped = `'${cur.title}'이(가) 그 사이 바뀌었습니다`; break }
        if (body) done += 1
      } catch (e) { stopped = String(e.message || e); break }
    }
    await reload()
    panes.close('mergetags')
    merge.off()
    setNote(stopped
      ? `${stopped} — 노트 ${done}편까지 바꿨습니다.`
      : said ? `${said} · 노트 ${done}편`
        : `태그 ${gone.length + 1}개를 '${to}' 하나로 합쳤습니다 · 노트 ${done}편`)
  }
  async function toggleTodo(t) {
    try {
      const { conflict, body } = await ask('/todos', { method: 'PUT',
        body: JSON.stringify({ id: t.id, line: t.line, done: !t.done, text: t.text }) })
      if (conflict) { setNote(body.detail || '노트가 바뀌었습니다.'); await reload(); return }
      await reload()
    } catch (e) { setNote(String(e.message || e)) }
  }
  /** The note as it reads, in a tab of its own — and that page is also what
   *  prints, because a PDF with Korean in it needs the system's fonts, which is
   *  the one thing a JS pdf library makes hard and a print dialog makes free. */
  function preview(ids) {
    if (!ids.length) { setNote('볼 노트를 고르세요.'); return }
    window.open(`${PORTAL_BASE}/?print=${ids.join(',')}`, '_blank', 'noopener')
  }

  const { chosen } = L

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
          <button type="button" className="rl-btn rl-go" title="오늘 날짜의 노트 — 있으면 열고, 없으면 만듭니다"
            onClick={openDaily}>daily</button>
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
            onClick={() => preview([...picked])}>미리보기 ({picked.size})</button>
          {onTags && (
            <RackMergeButtons merge={merge} noun="태그"
              onOpen={(names) => panes.open({ id: 'mergetags', kind: 'mergetags', names,
                label: `태그 ${names.length}개 합치기` })} />
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {tabs.length > FIXED.length && (
            <button type="button" className="rl-btn" title="열어둔 탭을 모두 닫습니다"
              onClick={L.closeOpened}>
              탭 닫기 ({tabs.length - FIXED.length})
            </button>
          )}
          {panes.count > 0 && (
            <button type="button" className="rl-btn" title="편집 패널의 탭을 모두 닫습니다"
              onClick={panes.closeAll}>
              편집 닫기 ({panes.count})
            </button>
          )}
          <span className="rl-gap" />
          {tab?.kind === 'notes' && <FilterBar f={filter} />}
          {tab?.kind === 'todos' && TODO_SCOPES.map((x) => (
            <button key={x.k} type="button" className={`rl-btn${tscope === x.k ? ' on' : ''}`}
              onClick={() => setTscope(x.k)}>
              {x.label} ({todos.filter(x.is).length})
            </button>
          ))}
          <span className="rl-sp" />
          {/* One box: the list, or — while the filter is choosing — the values
              on offer. */}
          <input ref={findRef} type="search" className="rl-find"
            value={filter.mode ? filter.find : query}
            placeholder={filter.mode ? '고를 값 찾기   (⌘F)' : '제목 · 태그 · 본문   (⌘F)'}
            onChange={(e) => (filter.mode ? filter.setFind : setQuery)(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane" style={showEdit ? split.leftStyle : undefined}>
            <RackTabs tabs={tabs} active={L.active} fixed={FIXED}
              onPick={L.setActive} onClose={closeTab} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !index && <p className="rl-msg">읽는 중…</p>}

            {index && tab?.kind === 'notes' && (
              <RackTable cols={cols} onDrag={drag('')}
                facet={filter.tableFacet}
                sort={sort || { k: 'date', dir: -1 }}
                onSort={(k) => setSort((s) => {
                  const now = s || { k: 'date', dir: -1 }
                  return now.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={filter.mode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                <FacetRows f={filter} />
                {!filter.mode && rows.map((n, i) => {
                  const on = picked.has(n.id)
                  const open = panes.tabs.some((t) => t.id === n.id)
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
                {!filter.mode && rows.length === 0 && <p className="rl-msg">해당하는 노트가 없습니다.</p>}
              </RackTable>
            )}

            {index && tab?.kind === 'todos' && (
              <RackTable cols={todoCols} onDrag={drag('t:')}
                sort={sort && TODO_SORTERS[sort.k] ? sort : { k: 'date', dir: -1 }}
                onSort={(k) => setSort((s) => (s?.k === k ? { k, dir: -s.dir } : { k, dir: 1 }))}>
                {todoRows.map((t, i) => (
                  <RackRow key={`${t.id}:${t.line}`} cols={todoCols} tone={TONE}
                    className={`rl-hit${t.done ? ' rl-done' : ''}`}
                    title="눌러서 끝냄 · 오른쪽 클릭으로 그 노트"
                    onClick={() => toggleTodo(t)}
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
                    }} />
                ))}
                {todoRows.length === 0 && <p className="rl-msg">할 일이 없습니다 — 노트에 `- [ ] 할 일`을 적으면 여기 모입니다.</p>}
              </RackTable>
            )}

            {index && tab?.kind === 'classes' && (
              <RackTable cols={merge.mode ? mergeCols : clsCols} onDrag={drag('c:')} sort={clsSort}
                onSort={(k) => setClsSort((s) => (s.k === k ? { k, dir: -s.dir } : { k, dir: 1 }))}
                head={merge.mode ? merge.head(classes.map((r) => r.name)) : null}>
                {classes.map((r, i) => {
                  const chosen = merge.mode && merge.has(r.name)
                  return (
                  <RackRow key={r.name} cols={merge.mode ? mergeCols : clsCols} tone={TONE}
                    className={`rl-hit${chosen ? ' on' : ''}`}
                    onClick={() => (merge.mode ? merge.toggle(r.name)
                      : openTab({ id: `tag:${r.name}`, kind: 'notes', tag: r.name, label: r.name }))}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      panes.open({ id: `edittag:${r.name}`, kind: 'edittag', who: r.name, label: r.name })
                    }}
                    cell={{
                      ...(merge.mode ? { chk: <input type="checkbox" checked={chosen} tabIndex={-1}
                        readOnly aria-label={`${r.name} 선택`} /> } : {}),
                      num: i + 1, name: r.name, count: r.count }} />
                  )
                })}
                {classes.length === 0 && <p className="rl-msg">아직 태그가 없습니다.</p>}
              </RackTable>
            )}
          </div>)}

          {showList && showEdit && <div {...split.handleProps} />}
          {showEdit && panes.cols.map((c) => {
            const cur = panes.current(c)
            return (
              <div key={c} className="rl-pane rl-epane" onMouseDown={() => panes.setCol(c)}>
                <RackPaneStrip panes={panes} col={c} />
                {cur.kind === 'mergetags' ? (() => {
                  const all = [...new Set(notes.flatMap(tagsOf))]
                  const live = (cur.names || []).filter((t) => all.includes(t))
                  const users = notes.filter((n) => live.some((t) => inTag(n, t)))
                  return (
                    <RackMerge names={cur.names || []} noun="태그" exists={all}
                      count={(t) => notes.filter((n) => inTag(n, t)).length}
                      users={users.map((n) => n.title || n.id)}
                      onMerge={(gone, to) => mergeTags(gone, to, users)}
                      onCancel={() => panes.close(cur.id)} />
                  )
                })() : cur.kind === 'edittag' ? (
                  /* The same editor every rack-list service gives a class.
                     What is ours is the save: a tag is text in the notes, so
                     renaming one rewrites every note that wears it. */
                  <RackEditClass name={cur.who} noun="태그" wears="쓰는 노트" unit="편"
                    exists={[...new Set(notes.flatMap(tagsOf))].sort()}
                    wearing={tagUsers}
                    onOpen={(id) => openEdit(id, (notes.find((n) => n.id === id) || {}).title)}
                    onSave={async (gone, to, said) => {
                      const users = notes.filter((n) => gone.some((t) => inTag(n, t)))
                      await mergeTags(gone.filter((t) => t !== to), to, users, said)
                      panes.close(cur.id)
                    }}
                    onCancel={() => panes.close(cur.id)} />
                ) : (
                <Editor id={cur.id} say={setNote} onSaved={reload}
                  takeCaret={cur.id === fresh} onCaret={() => setFresh(null)}
                  onPrint={() => preview([cur.id])}
                  onClosed={(cid) => { panes.close(cid); reload() }} />
                )}
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
/** Only the two things a person writes — and the file keeps a last newline the
 *  editor does not, which is not a change anyone made. Everything else (the
 *  version, the date) comes back from the server on every save and would read
 *  as one. */
const sameNote = (a, b) => a.title === b.title
  && String(a.body || '').trimEnd() === String(b.body || '').trimEnd()
const putNote = (id, baseVersion, v) => ask(`/notes/${encodeURIComponent(id)}`, {
  method: 'PUT',
  body: JSON.stringify({ baseVersion, title: v.title, body: v.body }),
})

/** The note is read when the tab opens, not from the list — the list carries a
 *  first line, and this needs the file. */
function Editor({ id, say, onSaved, onClosed, onPrint, takeCaret, onCaret }) {
  const [n, setN] = useState(null)
  const [f, setF] = useState(null)
  const [open, setOpen] = useState(false)     // the fold beside the title
  const [read, setRead] = useState(false)    // the note as it reads, in place
  const orig = useRef(null)                  // how the tab found it — revert
  const live = useRef({})                    // the latest, for the last save
  const titleRef = useRef(null)
  live.current = { f, n }
  useEffect(() => {
    let alive = true
    setN(null)
    ask(`/notes/${encodeURIComponent(id)}`)
      .then(({ body }) => {
        if (!alive) return
        setN(body); setF(body); orig.current = body
        if (!takeCaret) return
        // A note just opened: the caret goes to its title. A name the app chose
        // is selected (type over it); one a person wrote is left alone, caret
        // at the end.
        requestAnimationFrame(() => {
          const el = titleRef.current
          if (!el) return
          el.focus()
          if (body.title === '제목 없음') el.select()
          else el.setSelectionRange(el.value.length, el.value.length)
          onCaret?.()
        })
      })
      .catch((e) => say(String(e.message || e)))
    return () => { alive = false }
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps

  // The note saves itself a moment after you stop typing. A keystroke is not a
  // decision worth confirming, and a note that is only on screen is a note you
  // can lose; what you can still undo is the whole sitting, with revert.
  useEffect(() => {
    if (!f || !n || sameNote(f, n)) return
    const t = setTimeout(() => { saveNote() }, 800)
    return () => clearTimeout(t)
  }, [f, n])   // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the tab inside that moment must not drop the last sentence.
  useEffect(() => () => {
    const { f: cur, n: disk } = live.current
    if (cur && disk && !sameNote(cur, disk)) putNote(id, disk.version, cur)
  }, [id])
  // ⌘S saves the note you are in, wherever the caret is. ABOVE the early
  // return: a hook that only runs once the note has loaded is a hook the first
  // render did not have, and React drops the whole tree over it (#310) — which
  // is a blank pane, not a missing shortcut.
  useRackKeys({ onSave: () => { if (f && n) saveNote() } })

  if (!f || !n) return <p className="rl-msg">읽는 중…</p>
  const dirty = !sameNote(f, n)
  // Tags live in the BODY now (#태그), so this is what the note will carry the
  // moment it is saved — shown rather than edited.
  const tags = bodyTags(f.body)
  async function saveNote() {
    const { conflict, body } = await putNote(id, n.version, f)
    if (conflict) {
      say(body.detail || '다른 곳에서 바뀌었습니다.')
      setN(body.current); setF(body.current)
      return
    }
    // Only what is on disk: `f` is what is being typed, and a save that lands
    // mid-sentence must not take the caret back with it.
    setN(body)
    onSaved?.()
  }
  async function remove() {
    await ask(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    say(`'${n.title}' 삭제됨`)
    onClosed?.(id)
  }

  return (
    <div className="nt-edit">
      {/* The buttons sit above the title: everything below them is the note.
          The same bar every editor in every rack-list service wears. */}
      {/* The note saves itself; save is still here for the hand that wants to
          press it, and it is the one button that says whether it is needed. */}
      <RackActions key={id}
        onSave={() => saveNote()} saveDisabled={!dirty}
        hint={dirty ? '쓰는 중…' : '저장됨'}
        onCancel={() => onClosed?.(id)}
        extra={<>
          <button type="button" className={`rl-btn${read ? ' on' : ''}`}
            onClick={() => setRead(!read)}>{read ? '편집' : '미리보기'}</button>
          {read ? <button type="button" className="rl-btn" onClick={onPrint}>인쇄 · PDF</button> : null}
        </>}
        onRevert={() => setF(orig.current)} revertTitle="이 탭을 열었을 때로 되돌립니다"
        onDelete={remove}
        deleteWarn="파일이 지워집니다. 되돌릴 수 없습니다." />

      {/* Reading, the sheet carries the title and the date itself. */}
      <div className="nt-titlerow" hidden={read}>
        <input className="nt-title" ref={titleRef} value={f.title} placeholder="제목"
          onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} />
        {/* Everything that is not the title or the body is behind this. */}
        <button type="button" className="nt-fold" onClick={() => setOpen(!open)}
          title={open ? '접기' : '날짜 · 태그 · 파일 이름'} aria-expanded={open}>
          <i className="rl-caret">{open ? '▾' : '▸'}</i>
          {tags.length ? <span className="nt-tagline">{tags.map((t) => `#${t}`).join(' ')}</span> : null}
        </button>
      </div>
      {open && !read && (
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

      {read ? (
        /* The same sheet the print page draws, inside the pane — reading does
           not need a tab of its own, only printing does. */
        <div className="nt-read">
          <article className="nt-sheet">
            <h1>{f.title}</h1>
            <p className="nt-meta">{f.date}</p>
            <Rendered>{f.body}</Rendered>
          </article>
        </div>
      ) : (
        <MarkdownArea value={f.body} fileSrc={fileSrc} placeholder="markdown. #태그 로 태그를, `- [ ] 할 일`로 todos 탭에."
          onFiles={(file) => putFile(file).catch((e) => { say(String(e.message || e)); return null })}
          onChange={(v) => setF((s) => ({ ...s, body: v }))} />
      )}
    </div>
  )
}

// ─── Reading ────────────────────────────────────────────────────────────────
/** The body, rendered — with `#태그` drawn as a tag rather than left as the
 *  text it is in the file. react-markdown hands text through as strings, so the
 *  tags are picked out of those on the way to the page. */
function tagify(children) {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    const out = []
    let last = 0
    for (const m of child.matchAll(TAG_RE)) {
      const at = m.index + m[1].length
      if (at > last) out.push(child.slice(last, at))
      out.push(<span className="nt-tag" key={at}>#{m[2]}</span>)
      last = at + 1 + m[2].length
    }
    out.push(child.slice(last))
    return out
  })
}
const tagged = (Tag) => function Tagged({ node, children, ...rest }) {
  return <Tag {...rest}>{tagify(children)}</Tag>
}
/** `![alt|400](…)` — the width rides in the alt text, as it does in the
 *  editor and in Obsidian. */
function Img({ node, alt, ...rest }) {
  const [text, w] = embedSpec(alt || '')
  return <img alt={text} {...rest} style={w ? { width: `${w}px` } : undefined} />
}
/** A link out of the note opens a tab of its own: this page is inside the
 *  portal's frame, and a site that refuses to be framed would otherwise just
 *  not arrive. */
function Link({ node, ...rest }) {
  return <a {...rest} target="_blank" rel="noreferrer" />
}
const RENDER = {
  p: tagged('p'), li: tagged('li'), td: tagged('td'), blockquote: tagged('blockquote'),
  h1: tagged('h1'), h2: tagged('h2'), h3: tagged('h3'), h4: tagged('h4'),
  img: Img, a: Link,
}
function Rendered({ children }) {
  // Maths is `$x^2$` and `$$…$$`, which KaTeX draws here and the editor leaves
  // as the text it is — the file is the same either way.
  // `![[name]]` is Obsidian's embed, not markdown — here it is turned into the
  // markdown image it means. Only on the way to the page: the file keeps its
  // own spelling.
  const md = String(children || '').replace(EMBED_RE, (_, spec) => {
    const [name] = embedSpec(spec)
    return `![${spec}](${fileSrc(name)})`
  })
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkSoftBreaks]}
      rehypePlugins={[rehypeKatex]} components={RENDER}>
      {md}
    </ReactMarkdown>
  )
}

// ─── Printing ───────────────────────────────────────────────────────────────
/** The notes, rendered as a document and handed to the browser's printer —
 *  which is also its PDF writer, with the system's fonts, which is the whole
 *  reason not to carry a PDF library and a 10MB Korean font. */
export function PrintView({ ids }) {
  const [notes, setNotes] = useState(null)
  // No dialog of its own: this is the note as it reads, and printing is one of
  // the things you may then do with it.
  useEffect(() => {
    Promise.all(ids.map((id) => ask(`/notes/${encodeURIComponent(id)}`).then((r) => r.body)))
      .then(setNotes)
      .catch(() => setNotes([]))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!notes) return <p className="nt-print-msg">읽는 중…</p>
  if (!notes.length) return <p className="nt-print-msg">노트를 읽지 못했습니다.</p>
  return (
    <div className="nt-print">
      <div className="nt-print-bar">
        <button type="button" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
        <span>인쇄 대화상자에서 “PDF로 저장”을 고르면 파일이 됩니다.</span>
      </div>
      {notes.map((n) => (
        <article key={n.id} className="nt-sheet">
          <h1>{n.title}</h1>
          {/* The tags are in the body, drawn as tags — repeating them here
              would be the same words twice. */}
          <p className="nt-meta">
            {n.date}
            {Object.entries(n.fields || {}).map(([k, v]) => ` · ${k}: ${v}`)}
          </p>
          <Rendered>{n.body}</Rendered>
        </article>
      ))}
    </div>
  )
}
