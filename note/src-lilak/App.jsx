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
import './strings.js'
import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs, RackActions,
  useRackList, useRackKeys,
  RackPaneStrip, useMergeMode, RackMergeButtons, RackMerge,
  RackEditClass,
  bySome, asSorts, bumpSort, byKeys, FilterBar, FacetRows,
  PORTAL_BASE, PORTAL_PROJECT, brandStyle, projectKey, load, authHeaders, RackBar, takeOpenRequest,
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
import { tr } from 'lilak-ui'

const VIEW_KEY = projectKey('nt', 'view')
/** Where a file a note embeds is served from. */
const fileSrc = (name) => `${PORTAL_BASE}/api/file/${encodeURIComponent(name)}`
/** A file dropped into a note: stored beside the notes, named back. Not `api`
 *  — a multipart body writes its own content type, boundary and all. */
async function putFile(file) {
  const form = new FormData()
  form.append('f', file)
  const r = await fetch(`${PORTAL_BASE}/api/file`, { method: 'POST', headers: authHeaders(), body: form })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || tr("nt_upload_failed", r.status))
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

/** The todo without its tags: they have a column of their own, and a list of a
 *  hundred reads better when the sentence is the sentence. The note keeps them
 *  — this is what the table shows, not what is saved. */
const untagged = (text) => String(text || '')
  .replace(TAG_RE, (m, lead) => lead)
  .replace(/\s{2,}/g, ' ')
  .trim()

const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'date', w: 100, min: 84, label: 'date' },   // a whole 2026-08-04 at 15px
  { k: 'title', w: 260, min: 100, label: 'title' },
  { k: 'tags', w: 170, min: 60, label: 'tags' },
  { k: 'todo', w: 52, min: 40, label: tr("nt_todo"), num: true },
  { k: 'words', w: 58, min: 40, label: 'words', num: true, drop: 1040 },
  { k: 'excerpt', w: 360, min: 120, label: tr("nt_first_line"), drop: 1180 },
]
const CLS_COLS = [
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'name', w: 220, min: 80, label: 'tag' },
  { k: 'count', w: 70, min: 46, label: 'notes', num: true },
]
const TODO_COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 40, min: 30, fix: true, label: '#' },
  { k: 'text', w: 380, min: 120, label: tr("nt_todo") },
  { k: 'tags', w: 150, min: 60, label: 'tags' },
  { k: 'title', w: 200, min: 80, label: 'note' },
  { k: 'date', w: 100, min: 84, label: 'date' },
  { k: 'due', w: 100, min: 84, label: tr("nt_due") },
  { k: 'done', w: 100, min: 84, label: tr("nt_done") },
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
  tags: (t) => (t.tags || []).join(' '), done: (t) => t.doneAt || '',
  // A todo with no date is not due before everything that has one.
  due: (t) => t.due || '9999',
}

/** Which todos the tab shows. A list of things to do is mostly the ones not
 *  done; the done ones are a record, and both together are the whole note. */
/** Due, and not done: the only state a date makes urgent. */
const late = (t) => !t.done && !!t.due && t.due < new Date().toISOString().slice(0, 10)

const TODO_SCOPES = [
  { k: 'open', label: tr("nt_open"), is: (t) => !t.done },
  { k: 'all', label: tr("nt_all"), is: () => true },
  { k: 'done', label: tr("nt_finished"), is: (t) => t.done },
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
    return [...list].sort(byKeys(asSorts(sort).length ? sort : { k: 'date', dir: -1 }, SORTERS))
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
    if (!PORTAL_PROJECT) { setErr(tr("nt_open_via_portal")); return }
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

  // The todo table shares the view's sort stack, which may hold note columns
  // this table has never heard of; it reads the ones it knows.
  const todoSort = useMemo(() => {
    const keys = asSorts(sort).filter((x) => TODO_SORTERS[x.k])
    return keys.length ? keys : [{ k: 'date', dir: -1 }]
  }, [sort])

  const todoRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const keep = (TODO_SCOPES.find((x) => x.k === tscope) || TODO_SCOPES[0]).is
    const list = tab?.kind === 'todos'
      ? todos.filter(keep).filter((t) => !q || [t.text, t.title, ...(t.tags || [])]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
      : []
    return [...list].sort(byKeys(todoSort, TODO_SORTERS))
  }, [todos, tab, query, todoSort, tscope])


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
  // Sent here from another service (#open=<id>, an activity's note): that
  // note opens once the list is in.
  const asked = useRef(takeOpenRequest())
  useEffect(() => {
    if (!index || !asked.current) return
    const n = notes.find((x) => x.id === asked.current)
    asked.current = ''
    if (n) panes.open({ id: n.id, label: n.title || n.id })
  }, [index])   // eslint-disable-line react-hooks/exhaustive-deps
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
      const { body } = await ask('/notes', { method: 'POST', body: JSON.stringify({ title: tr("nt_untitled"), template }) })
      await reload()
      openEdit(body.id, body.title)
      setNote(template ? tr("nt_made_from_template", template) : tr("nt_made_new"))
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
    if (had) { openEdit(had.id, had.title); setNote(tr("nt_opened", title)); return }
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
      setNote(tr("nt_made_named", title))
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
        if (conflict) { stopped = tr("nt_changed_meanwhile", cur.title); break }
        if (body) done += 1
      } catch (e) { stopped = String(e.message || e); break }
    }
    await reload()
    panes.close('mergetags')
    merge.off()
    setNote(stopped
      ? tr("nt_changed_up_to", stopped, done)
      : said ? tr("nt_x_notes", said, done)
        : tr("nt_tags_merged", gone.length + 1, to, done))
  }
  async function toggleTodo(t) {
    try {
      const { conflict, body } = await ask('/todos', { method: 'PUT',
        body: JSON.stringify({ id: t.id, line: t.line, done: !t.done, text: t.text }) })
      if (conflict) { setNote(body.detail || tr("nt_note_changed")); await reload(); return }
      await reload()
    } catch (e) { setNote(String(e.message || e)) }
  }
  /** The note as it reads, in a tab of its own — and that page is also what
   *  prints, because a PDF with Korean in it needs the system's fonts, which is
   *  the one thing a JS pdf library makes hard and a print dialog makes free. */
  function preview(ids) {
    if (!ids.length) { setNote(tr("nt_pick_note")); return }
    window.open(`${PORTAL_BASE}/?print=${ids.join(',')}`, '_blank', 'noopener')
  }

  const { chosen } = L

  return (
    <div className="rl" style={brandStyle()}>
      <section className="rl-mod">
        <RackBar title={tr("nt_notes")} count={index ? tr("nt_n", notes.length) : ''} />

        <div className="rl-cmd">
          <button type="button" className="rl-btn rl-go" onClick={() => create(null)}>{tr("nt_new_note")}</button>
          <button type="button" className="rl-btn rl-go" title={tr("nt_today_hint")}
            onClick={openDaily}>daily</button>
          {!!index?.templates?.length && (
            /* A template is a note in templates/ — so this list is a folder
               listing, not a feature with a store behind it. */
            <select className="rl-btn rl-go rl-pick" value=""
              onChange={(e) => { if (e.target.value) create(e.target.value) }}>
              <option value="">{tr("nt_from_template")}</option>
              {index.templates.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={() => preview([...picked])}>{tr("nt_preview_n", picked.size)}</button>
          {onTags && (
            <RackMergeButtons merge={merge} noun={tr("nt_tag")}
              onOpen={(names) => panes.open({ id: 'mergetags', kind: 'mergetags', names,
                label: tr("nt_merge_n_tags", names.length) })} />
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {tabs.length > FIXED.length && (
            <button type="button" className="rl-btn" title={tr("nt_close_tabs_hint")}
              onClick={L.closeOpened}>{tr("nt_close_tabs_n", tabs.length - FIXED.length)}</button>
          )}
          {panes.count > 0 && (
            <button type="button" className="rl-btn" title={tr("nt_close_editors_hint")}
              onClick={panes.closeAll}>{tr("nt_close_editors_n", panes.count)}</button>
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
            placeholder={filter.mode ? tr("nt_find_value") : tr("nt_find_hint")}
            onChange={(e) => (filter.mode ? filter.setFind : setQuery)(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane" style={showEdit ? split.leftStyle : undefined}>
            <RackTabs tabs={tabs} active={L.active} fixed={FIXED}
              onPick={L.setActive} onClose={closeTab} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !index && <p className="rl-msg">{tr("nt_loading")}</p>}

            {index && tab?.kind === 'notes' && (
              <RackTable cols={cols} onDrag={drag('')}
                facet={filter.tableFacet}
                sort={asSorts(sort).length ? sort : [{ k: 'date', dir: -1 }]}
                onSort={(k) => setSort((s) => bumpSort(asSorts(s).length ? s : { k: 'date', dir: -1 }, k))}
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
                          aria-label={tr("nt_select_x", n.title)} />,
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
                {!filter.mode && rows.length === 0 && <p className="rl-msg">{tr("nt_no_match")}</p>}
              </RackTable>
            )}

            {index && tab?.kind === 'todos' && (
              <RackTable cols={todoCols} onDrag={drag('t:')}
                sort={todoSort}
                onSort={(k) => setSort((s) => bumpSort(todoSort, k))}>
                {todoRows.map((t, i) => (
                  <RackRow key={`${t.id}:${t.line}`} cols={todoCols} tone={TONE}
                    className={`rl-hit${t.done ? ' rl-done' : ''}${late(t) ? ' nt-late' : ''}`}
                    title={tr("nt_todo_hint")}
                    onClick={() => toggleTodo(t)}
                    onContextMenu={(e) => { e.preventDefault(); openEdit(t.id, t.title) }}
                    cell={{
                      chk: <input type="checkbox" checked={t.done} aria-label={t.text}
                        onChange={() => toggleTodo(t)} onClick={(e) => e.stopPropagation()} />,
                      num: i + 1,
                      text: untagged(t.text) || D,
                      title: (
                        <button type="button" className="rl-lnk"
                          onClick={(e) => { e.stopPropagation(); openEdit(t.id, t.title) }}>{t.title}</button>
                      ),
                      date: t.date || D,
                      tags: (t.tags || []).join(' ') || D,
                      due: t.due || D,
                      done: t.doneAt || D,
                    }} />
                ))}
                {todoRows.length === 0 && <p className="rl-msg">{tr("nt_no_todos")}</p>}
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
                        readOnly aria-label={tr("nt_select_x", r.name)} /> } : {}),
                      num: i + 1, name: r.name, count: r.count }} />
                  )
                })}
                {classes.length === 0 && <p className="rl-msg">{tr("nt_no_tags")}</p>}
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
                    <RackMerge names={cur.names || []} noun={tr("nt_tag")} exists={all}
                      count={(t) => notes.filter((n) => inTag(n, t)).length}
                      users={users.map((n) => n.title || n.id)}
                      onMerge={(gone, to) => mergeTags(gone, to, users)}
                      onCancel={() => panes.close(cur.id)} />
                  )
                })() : cur.kind === 'edittag' ? (
                  /* The same editor every rack-list service gives a class.
                     What is ours is the save: a tag is text in the notes, so
                     renaming one rewrites every note that wears it. */
                  <RackEditClass name={cur.who} noun={tr("nt_tag")} wears={tr("nt_notes_using")} unit={tr("nt_unit")}
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
          <span>{note || tr("nt_status_hint")}</span>
          <span className="rl-sp" />
          <span className="rl-mono">
            {tab?.kind === 'todos' ? (todoRows.length ? tr("nt_n_rows", todoRows.length) : '')
              : rows.length ? tr("nt_n_rows", rows.length) : ''}
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
const sameNote = (a, b) => a.title === b.title && (a.date || '') === (b.date || '')
  && String(a.body || '').trimEnd() === String(b.body || '').trimEnd()
const putNote = (id, baseVersion, v) => ask(`/notes/${encodeURIComponent(id)}`, {
  method: 'PUT',
  body: JSON.stringify({ baseVersion, title: v.title, date: v.date, body: v.body }),
})

/** The note is read when the tab opens, not from the list — the list carries a
 *  first line, and this needs the file. */
/** ?solo=<id>: one note's editor and nothing else — what another service
 *  opens as a tab of its own (an activity's note, beside the activity). Its
 *  cancel has no list to go back to; a note deleted here says so. */
export function SoloNote({ id }) {
  const [said, say] = useState('')
  const [gone, setGone] = useState(false)
  const closed = () => { ask(`/notes/${encodeURIComponent(id)}`).catch(() => setGone(true)) }
  return (
    <div className="rl nt-solo" style={brandStyle()}>
      {gone ? <p className="rl-msg">{tr("nt_deleted")}</p> : (
        <Editor id={id} say={say} onClosed={closed}
          onPrint={() => window.open(`${PORTAL_BASE}/?print=${encodeURIComponent(id)}`, '_blank', 'noopener')} />
      )}
      {said && <div className="rl-hint nt-solo-note">{said}</div>}
    </div>
  )
}

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
  // A note just opened: the caret goes to its title. A name the app chose is
  // selected (type over it); one a person wrote is left alone, caret at the
  // end. In an EFFECT, not in the fetch's `then`: the field does not exist
  // until React has drawn the loaded note, and a focus aimed at a ref that is
  // still null is a focus that silently does not happen.
  useEffect(() => {
    if (!takeCaret || !n) return
    const el = titleRef.current
    if (!el) return
    el.focus()
    // Untitled in this language, or in Korean (notes made before English existed).
    if (n.title === tr("nt_untitled") || n.title === '제목 없음') el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
    onCaret?.()
  }, [takeCaret, n])   // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘S saves the note you are in, wherever the caret is. ABOVE the early
  // return: a hook that only runs once the note has loaded is a hook the first
  // render did not have, and React drops the whole tree over it (#310) — which
  // is a blank pane, not a missing shortcut.
  useRackKeys({ onSave: () => { if (f && n) saveNote() } })

  if (!f || !n) return <p className="rl-msg">{tr("nt_loading")}</p>
  const dirty = !sameNote(f, n)
  // Tags live in the BODY now (#태그), so this is what the note will carry the
  // moment it is saved — shown rather than edited.
  const tags = bodyTags(f.body)
  async function saveNote() {
    const { conflict, body } = await putNote(id, n.version, f)
    if (conflict) {
      say(body.detail || tr("nt_changed_elsewhere"))
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
    say(tr("nt_deleted_named", n.title))
    onClosed?.(id)
  }

  return (
    <div className="nt-edit">
      {/* The buttons sit above the title: everything below them is the note.
          The same bar every editor in every rack-list service wears. */}
      {/* The note saves itself; save is still here for the hand that wants to
          press it, and it is the one button that says whether it is needed. */}
      <RackActions key={id}
        onSave={() => saveNote()} saveDisabled={!dirty} pending={dirty}
        onCancel={() => onClosed?.(id)}
        extra={<>
          <button type="button" className={`rl-btn${read ? ' on' : ''}`}
            onClick={() => setRead(!read)}>{read ? tr("nt_edit") : tr("nt_preview")}</button>
          {read ? <button type="button" className="rl-btn" onClick={onPrint}>{tr("nt_print")}</button> : null}
        </>}
        onRevert={() => setF(orig.current)} revertTitle={tr("nt_revert_hint")}
        onDelete={remove}
        deleteWarn={tr("nt_delete_warn")} />

      {/* Reading, the sheet carries the title and the date itself. */}
      {/* One line: the title, its tags, and the fold — a button with a word on
          it, big enough to hit — which opens the date and the file's name below. */}
      <div className="nt-titlerow" hidden={read}>
        <input className="nt-title" ref={titleRef} value={f.title} placeholder={tr("nt_title")}
          onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} />
        {tags.length ? <span className="nt-tagline">{tags.map((t) => `#${t}`).join(' ')}</span> : null}
        <button type="button" className="rl-btn nt-fold" onClick={() => setOpen(!open)}
          title={open ? tr("nt_fold") : tr("nt_date_file")} aria-expanded={open}>{tr("nt_info")} <i className="nt-caret">{open ? '▾' : '▸'}</i>
        </button>
      </div>
      {open && !read && (
        <div className="nt-meta-open">
          <label className="rl-hint">{tr("nt_date_with", ' ')}<input type="date" className="rl-in nt-date" value={f.date || ''}
              onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} />
          </label>
          <span className="rl-hint rl-mono">{f.id}.md</span>
          {Object.entries(f.fields || {}).map(([k, v]) => (
            <span key={k} className="rl-hint"><b className="rl-mono">{k}</b> {String(v ?? '')}</span>
          ))}
          <span className="rl-sp" />
          <span className="rl-hint">{tr("nt_n_words", f.body.split(/\s+/).filter(Boolean).length)}</span>
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
        <MarkdownArea value={f.body} fileSrc={fileSrc} placeholder={tr("nt_body_placeholder")}
          onFiles={(file) => putFile(file).catch((e) => { say(String(e.message || e)); return null })}
          onChange={(v) => setF((s) => ({ ...s, body: v }))} />
      )}
    </div>
  )
}

// ─── Reading ────────────────────────────────────────────────────────────────
/** The body, rendered — with `#태그` drawn as a tag and `📅 2026-12-24` as the
 *  calendar label the editor draws, rather than left as the text they are in
 *  the file. react-markdown hands text through as strings, so both are picked
 *  out of those on the way to the page. */
const CHIP_RE = new RegExp(`${TAG_RE.source}|(📅|✅)\\s*(\\d{4}-\\d{2}-\\d{2})`, 'g')

function tagify(children) {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    const out = []
    let last = 0
    for (const m of child.matchAll(CHIP_RE)) {
      // A tag (lead + #name) or a date (mark + day) — one of the two matched.
      const tag = m[2] !== undefined
      const at = m.index + (tag ? m[1].length : 0)
      if (at > last) out.push(child.slice(last, at))
      out.push(tag
        ? <span className="nt-tag" key={at}>{m[2]}</span>
        : <span className={m[3] === '📅' ? 'nt-due-in' : 'nt-done-in'} key={at}>{m[4]}</span>)
      last = at + (tag ? 1 + m[2].length : m[0].length)
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
  if (!notes) return <p className="nt-print-msg">{tr("nt_loading")}</p>
  if (!notes.length) return <p className="nt-print-msg">{tr("nt_read_failed")}</p>
  return (
    <div className="nt-print">
      <div className="nt-print-bar">
        <button type="button" onClick={() => window.print()}>{tr("nt_print_save_pdf")}</button>
        <span>{tr("nt_print_hint")}</span>
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
