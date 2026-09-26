/**
 * author manager — the table, with tabs, a selection and an edit view.
 *
 * The shape of the screen:
 *
 *   저자 ─────────────────────────────── nameplate (the module's name)
 *   add  clear  select all      [search] command line — acts on the selection
 *   total │ my list │ affiliation │ groups │ CENS ×   tabs
 *   # ☐ affil. 이름 name │ nm. email …    the head, sticky
 *   …rows…                                26px each
 *
 * A tab is either a list of AUTHORS (total, my list, or one affiliation/group),
 * a list of CLASSES (the affiliations or the groups themselves), or one record
 * being EDITED. Picking a class opens a tab of its authors; right-clicking any
 * row opens a tab that edits it. Tabs you opened carry an ×; the four fixed
 * ones do not.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import './rack.css'

// ─── Portal integration (same contract as the rest of the services) ─────────
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''
const PORTAL_PARTS = PORTAL_BASE.split('/').filter(Boolean)
const PORTAL_PROJECT = PORTAL_PARTS.length ? PORTAL_PARTS[PORTAL_PARTS.length - 1] : ''
const MYLIST_KEY = `am.mylist.${PORTAL_PROJECT}`

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
const inAff = (a, tag) => (a.affiliations || []).some((x) => x.tag === tag)
const inGrp = (a, name) => (a.groups || []).some((g) => g.group === name)

const D = '·'   // a cell with nothing in it still shows its column

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
  const [myList, setMyList] = useState(() => {
    try { return JSON.parse(localStorage.getItem(MYLIST_KEY) || '[]') } catch { return [] }
  })

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  useEffect(() => {
    try { localStorage.setItem(MYLIST_KEY, JSON.stringify(myList)) } catch { /* private mode */ }
  }, [myList])
  // One line of status, and it clears itself.
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 4000)
    return () => clearTimeout(t)
  }, [note])

  const authors = doc?.authors || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

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
    // Paper order: by core, then by the name a paper would print.
    return [...list].sort((a, b) => {
      const c = (coreOf(a) ?? 99) - (coreOf(b) ?? 99)
      return c !== 0 ? c : engName(a).localeCompare(engName(b))
    })
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
      note: r.note || r.label || '',
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
  const toggle = (id) => setPicked((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  function addToMyList() {
    if (!picked.size) { setNote('선택된 저자가 없습니다.'); return }
    setMyList((l) => [...l, ...[...picked].filter((id) => !l.includes(id))])
    setNote(`My List에 ${picked.size}명 담았습니다.`)
  }

  // ── editing one record ──
  async function save(patch) {
    if (!doc) return
    const body = {
      authors: patch.authors || doc.authors,
      affiliations: patch.affiliations || doc.affiliations,
      groups: patch.groups || doc.groups,
    }
    try {
      const r = await putDoc(doc.version, body)
      if (r.conflict) { setNote('다른 사람이 먼저 저장했습니다 — 새로 읽어주세요.'); return }
      setDoc(r.doc)
      setNote('저장했습니다.')
    } catch (e) { setNote(String(e.message || e)) }
  }

  const allPicked = rows.length > 0 && rows.every((a) => picked.has(a.id))

  return (
    <div className="am">
      <section className="am-mod">
        <header className="am-bar">
          <b>저자</b>
          <span className="am-n">{doc ? `${authors.length}명` : ''}</span>
          <span className="am-sp" />
          <span className="am-n">{PORTAL_PROJECT}</span>
        </header>

        {/* What the selection can do, then the one search line on the right. */}
        <div className="am-cmd">
          <button type="button" className="am-btn" onClick={addToMyList}>add</button>
          <button type="button" className="am-btn" disabled={!picked.size}
            onClick={() => setPicked(new Set())}>clear</button>
          <button type="button" className="am-btn" disabled={tab?.kind !== 'authors' || !rows.length}
            onClick={() => setPicked((s) => {
              const n = new Set(s)
              if (allPicked) rows.forEach((a) => n.delete(a.id))
              else rows.forEach((a) => n.add(a.id))
              return n
            })}>{allPicked ? 'select none' : 'select all'}</button>
          {picked.size > 0 && <span className="am-n">{picked.size} 선택</span>}
          <span className="am-sp" />
          <input type="search" className="am-find" value={query} placeholder="이름 · 이메일 · 소속 · 그룹"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        {/* The tabs sit ON the table, the way a folder's tabs sit on the folder. */}
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
          <AuthorTable rows={rows} picked={picked} onToggle={toggle}
            onEdit={(a) => openTab({ id: `edit:${a.id}`, kind: 'edit', label: korName(a) || engName(a) || 'author', who: a.id })} />
        )}
        {doc && tab?.kind === 'classes' && (
          <ClassTable rows={classes} of={tab.of}
            onOpen={(r) => openTab({
              id: `${tab.of}:${r.name}`, kind: 'authors', label: r.name,
              ...(tab.of === 'affiliation' ? { aff: r.name } : { grp: r.name }),
            })}
            onEdit={(r) => openTab({ id: `editcls:${tab.of}:${r.name}`, kind: 'editcls', label: r.name, of: tab.of, who: r.name })} />
        )}
        {doc && tab?.kind === 'edit' && (
          <EditAuthor author={authors.find((a) => a.id === tab.who)} doc={doc} onSave={save} />
        )}
        {doc && tab?.kind === 'editcls' && (
          <EditClass name={tab.who} of={tab.of} doc={doc} onSave={save} />
        )}

        <footer className="am-foot">
          <span>{note || '왼쪽 클릭으로 선택, 오른쪽 클릭으로 편집.'}</span>
          <span className="am-sp" />
          <span className="am-mono">{rows.length ? `${rows.length}줄` : ''}</span>
        </footer>
      </section>
    </div>
  )
}

// ─── The author table ───────────────────────────────────────────────────────
function AuthorTable({ rows, picked, onToggle, onEdit }) {
  return (
    <div className="am-tab-body">
      <div className="am-row am-head">
        <span className="am-chk" />
        <span className="am-gut">#</span>
        <span className="am-c">affil.</span>
        <span className="am-c">이름</span>
        <span className="am-c">name</span>
        <i className="am-rule" />
        <span className="am-c am-nm">nm.</span>
        <span className="am-c">email</span>
        <span className="am-c am-pos">position</span>
        <span className="am-c am-num">core</span>
        <span className="am-c am-cite">last</span>
        <span className="am-c am-cite">first</span>
        <span className="am-c am-cite">init</span>
      </div>
      {rows.length === 0 && <p className="am-msg">해당하는 저자가 없습니다.</p>}
      {rows.map((a, i) => {
        const cur = currentAff(a)
        const on = picked.has(a.id)
        return (
          <div key={a.id || i} className={`am-row am-hit${on ? ' on' : ''}`}
            onClick={() => onToggle(a.id)}
            onContextMenu={(e) => { e.preventDefault(); onEdit(a) }}>
            <span className="am-chk">
              <input type="checkbox" checked={on} tabIndex={-1} readOnly
                aria-label={`${korName(a) || engName(a)} 선택`} />
            </span>
            <span className="am-gut">{i + 1}</span>
            <span className="am-c am-dim">{cur?.tag || D}</span>
            <span className="am-c">{korName(a) || D}</span>
            <span className="am-c am-ink">{engName(a) || a.nick || D}</span>
            <i className="am-rule" />
            <span className="am-c am-mono am-dim am-nm">{citeShort(a) || D}</span>
            <span className="am-c am-mono">{repEmail(a) || D}</span>
            <span className="am-c am-dim am-pos">{cur?.position || D}</span>
            <span className="am-c am-num">{coreOf(a) ?? D}</span>
            <span className="am-c am-cite">{citeLast(a) || D}</span>
            <span className="am-c am-cite">{citeFirst(a) || D}</span>
            <span className="am-c am-cite am-mono">{citeInit(a) || D}</span>
          </div>
        )
      })}
    </div>
  )
}

// ─── The affiliations / groups themselves ───────────────────────────────────
function ClassTable({ rows, of, onOpen, onEdit }) {
  return (
    <div className="am-tab-body">
      <div className="am-row am-crow am-head">
        <span className="am-gut">#</span>
        <span className="am-c">{of === 'affiliation' ? 'affiliation' : 'group'}</span>
        <span className="am-c am-num">people</span>
        <span className="am-c am-dim">note</span>
      </div>
      {rows.length === 0 && <p className="am-msg">{of === 'affiliation' ? '소속이' : '그룹이'} 없습니다.</p>}
      {rows.map((r, i) => (
        <div key={r.name} className="am-row am-crow am-hit"
          onClick={() => onOpen(r)}
          onContextMenu={(e) => { e.preventDefault(); onEdit(r) }}>
          <span className="am-gut">{i + 1}</span>
          <span className="am-c am-ink">{r.name}</span>
          <span className="am-c am-num">{r.count}</span>
          <span className="am-c am-dim">{r.note || D}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Rowset({ children }) { return <div className="am-rec">{children}</div> }
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
    if (!list.length) list.push({ tag: '', position: '', since: '' })
    const i = list.indexOf([...list].sort((x, y) =>
      String(x.since || '').localeCompare(String(y.since || ''))).at(-1))
    list[i] = { ...list[i], [k]: e.target.value }
    return { ...s, affiliations: list }
  })
  return (
    <div className="am-tab-body">
      <Rowset>
        <Fld label="한글 이름">
          <input className="am-in" style={{ width: 90 }} value={f.korFamily || ''} onChange={set('korFamily')} placeholder="성" />
          <input className="am-in" style={{ width: 120 }} value={f.korGiven || ''} onChange={set('korGiven')} placeholder="이름" />
        </Fld>
        <Fld label="English">
          <input className="am-in" style={{ width: 130 }} value={f.engFirst || ''} onChange={set('engFirst')} placeholder="first" />
          <input className="am-in" style={{ width: 110 }} value={f.engMiddle || ''} onChange={set('engMiddle')} placeholder="middle" />
          <input className="am-in" style={{ width: 140 }} value={f.engLast || ''} onChange={set('engLast')} placeholder="last" />
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
      </Rowset>
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
      <Rowset>
        <Fld label="이름">
          <input className="am-in" style={{ width: 220 }} value={f.name || ''} onChange={set('name')} />
          <span className="am-hint">이름을 고치면 이 이름을 쓰는 저자들도 같이 고쳐집니다.</span>
        </Fld>
        <Fld label="설명">
          <input className="am-in" style={{ width: 360 }} value={f.note || ''} onChange={set('note')} />
        </Fld>
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
      </Rowset>
    </div>
  )
}
