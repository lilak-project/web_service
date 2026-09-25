import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyTheme,
  applyPreset,
  loadFonts,
  Button,
  Input,
  Card,
  useMediaQuery,
} from 'lilak-ui'
import {
  Users,
  SignOut,
  Plus,
  Minus,
  PencilSimple,
  Trash,
  MagnifyingGlass,
  UserList,
  Buildings,
  UsersThree,
  Copy,
  FloppyDisk,
  ListDashes,
  ArrowUp,
  Paperclip,
  LinkSimple,
  KeyReturn,
  Broom,
  UsersFour,
} from '@phosphor-icons/react'

// ─── Portal integration (same contract as asset_manager) ─────────────────────
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''
const PORTAL_PARTS = PORTAL_BASE.split('/').filter(Boolean)
const PORTAL_PROJECT = PORTAL_PARTS.length ? PORTAL_PARTS[PORTAL_PARTS.length - 1] : ''
const SERVER = !!PORTAL_PROJECT

function portalUser() {
  try {
    const t = localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
    if (!t) return null
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const email = p.email || p.username || 'portal'
    return { email, name: p.name || p.username || email, role: p.role || p.prole || '' }
  } catch { return null }
}

function isAdminUser(user) {
  if (!PORTAL_BASE) return false
  return ['manager', 'admin'].includes(String(user?.role || '').toLowerCase())
}

const BRAND = '#0d9488'          // teal — matches the kit's teal preset (nav bars)
const PHOTO_COLOR = '#0f766e'    // darker teal for photo/camera affordances

const K = (key) => `authors.project.${PORTAL_PROJECT || 'local'}.${key}`
const readJson = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback } }
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* full */ } }
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

// ─── Server storage (whole-document, version-guarded — same as asset_manager) ─
function authHeaders() {
  const t = localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
  return t ? { Authorization: `Bearer ${t}` } : {}
}
async function fetchServerData() {
  const r = await fetch(`${PORTAL_BASE}/api/data`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`GET /api/data → ${r.status}`)
  return r.json()
}
async function putServerData(baseVersion, doc) {
  const r = await fetch(`${PORTAL_BASE}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ baseVersion, ...doc }),
  })
  if (r.status === 409) return { conflict: true, current: (await r.json()).current }
  if (!r.ok) throw new Error(`PUT /api/data → ${r.status}`)
  return { doc: await r.json() }
}

// ─── Small helpers ────────────────────────────────────────────────────────────
async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}
// Photos are rasterized to JPEG (same policy as asset_manager).
async function fileToJpegDataUrl(file, maxDim = 1200) {
  const raw = await fileToDataUrl(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = raw
    })
    const w = img.naturalWidth || img.width || 1000
    const h = img.naturalHeight || img.height || 1000
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch { return raw }
}
function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename || 'file'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
function formatDate(v) {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleDateString()
}

// Names --------------------------------------------------------------------
const korName = (a) => `${a.korFamily || ''}${a.korGiven || ''}`.trim()
const engName = (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
const displayName = (a) => a.nick || korName(a) || engName(a) || '(이름 없음)'

// Latest affiliation entry (by since date).
function currentAff(a) {
  const list = [...(a.affiliations || [])].filter((x) => x.tag)
  if (!list.length) return null
  list.sort((x, y) => String(x.since || '').localeCompare(String(y.since || '')))
  return list[list.length - 1]
}
// Representing email: explicit, else latest affiliation email, else first email.
function repEmail(a) {
  if (a.repEmail) return a.repEmail
  const cur = currentAff(a)
  if (cur?.email) return cur.email
  return (a.emails || [])[0] || ''
}
// Smallest core number across the author's groups (10 = least important default).
function coreOf(a) {
  const cores = (a.groups || []).map((g) => Number(g.core)).filter((n) => Number.isFinite(n) && n >= 1)
  return cores.length ? Math.min(...cores) : 10
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [authStatus] = useState(PORTAL_BASE ? 'ready' : 'no-portal')
  const [authUser] = useState(PORTAL_BASE ? (portalUser() || { email: 'portal', name: 'portal' }) : null)
  const isAdmin = isAdminUser(authUser)
  const isMobile = useMediaQuery('(max-width: 760px)')

  const [authors, setAuthors] = useState(() => readJson(K('authors'), []))
  const [affiliations, setAffiliations] = useState(() => readJson(K('affiliations'), []))
  const [groups, setGroups] = useState(() => readJson(K('groups'), []))
  const [myList, setMyList] = useState(() => readJson(K('myList'), []))
  const [tab, setTab] = useState(() => localStorage.getItem(K('tab')) || 'authors')
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef(null)
  const [dialog, setDialog] = useState(null)
  const pageRef = useRef(null)

  useEffect(() => {
    loadFonts()
    applyTheme()
    applyPreset('teal')
    const root = document.documentElement
    root.style.setProperty('--brand', BRAND)
    // White bars with teal icons — the preset paints nav-* teal, which hides
    // teal icons on it.
    root.style.setProperty('--nav-bg', '#ffffff')
    root.style.setProperty('--nav-border', '#c2ded9')
    root.style.setProperty('--nav-text', '#0b6f64')
    root.style.setProperty('--nav-text-muted', '#8aa8a3')
    root.style.setProperty('--border-default', '#9dc4bd')
    root.style.setProperty('--border-subtle', '#c2ded9')
  }, [])
  useEffect(() => { localStorage.setItem(K('tab'), tab) }, [tab])
  useEffect(() => { writeJson(K('myList'), myList) }, [myList])
  useEffect(() => {
    writeJson(K('authors'), authors); writeJson(K('affiliations'), affiliations); writeJson(K('groups'), groups)
  }, [authors, affiliations, groups])

  // Server sync (hydrate + debounced whole-doc save with 409 reload).
  const serverVersion = useRef(null)
  const syncedRef = useRef('')
  const [hydrated, setHydrated] = useState(!SERVER)
  function applyServerDoc(doc) {
    serverVersion.current = doc.version
    syncedRef.current = JSON.stringify({ authors: doc.authors || [], affiliations: doc.affiliations || [], groups: doc.groups || [] })
    setAuthors(doc.authors || [])
    setAffiliations(doc.affiliations || [])
    setGroups(doc.groups || [])
  }
  useEffect(() => {
    if (!SERVER) return
    let cancelled = false
    ;(async () => {
      try {
        const doc = await fetchServerData()
        if (!cancelled) applyServerDoc(doc)
      } catch {
        if (!cancelled) show('서버 연결 실패 — 이 기기의 사본을 표시합니다.', 'warn')
      } finally { if (!cancelled) setHydrated(true) }
    })()
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!SERVER || !hydrated || serverVersion.current === null) return
    const payload = JSON.stringify({ authors, affiliations, groups })
    if (payload === syncedRef.current) return
    const t = setTimeout(async () => {
      try {
        const res = await putServerData(serverVersion.current, JSON.parse(payload))
        if (res.conflict) { applyServerDoc(res.current); show('다른 사용자가 먼저 저장 — 최신으로 갱신했습니다.', 'warn') }
        else { serverVersion.current = res.doc.version; syncedRef.current = payload }
      } catch { show('서버 저장 실패 — 변경사항이 아직 반영되지 않았습니다.', 'warn') }
    }, 600)
    return () => clearTimeout(t)
  }, [authors, affiliations, groups, hydrated])

  function show(message, kind = 'info') {
    setNotice({ text: message, kind })
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { noticeTimer.current = null; setNotice('') }, 2000)
  }
  const askConfirm = (message, onConfirm) => setDialog({ message, onConfirm })
  function signOut() { window.location.assign('/projects') }

  // ── Author CRUD ──
  function createAuthor(form) {
    const name = String(form.nick || '').trim() || korName(form) || engName(form)
    if (!name) { show('이름(간편이름 또는 성명)을 입력하세요.', 'warn'); return false }
    const now = new Date().toISOString()
    const a = { id: newId(), createdAt: now, updatedAt: now, ...form }
    setAuthors((items) => [a, ...items])
    show(`${displayName(a)} 등록됨`)
    return true
  }
  function updateAuthor(id, patch) {
    const now = new Date().toISOString()
    setAuthors((items) => items.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: now } : a)))
    const cur = authors.find((a) => a.id === id)
    show(`${displayName({ ...cur, ...patch })}의 정보를 변경했습니다.`)
  }
  function deleteAuthor(id) {
    const a = authors.find((x) => x.id === id)
    askConfirm(`${displayName(a || {})}를 삭제할까요? 되돌릴 수 없습니다.`, () => {
      setAuthors((items) => items.filter((x) => x.id !== id))
      setMyList((list) => list.filter((x) => x !== id))
      show('삭제했습니다.')
    })
  }
  function toggleMyList(id) {
    const a = authors.find((x) => x.id === id)
    if (myList.includes(id)) {
      setMyList((list) => list.filter((x) => x !== id))
      show(`${displayName(a || {})} 제거 · 총 ${myList.length - 1}명`)
    } else {
      setMyList((list) => [id, ...list])
      show(`${displayName(a || {})} 추가 · 총 ${myList.length + 1}명`)
    }
  }

  // ── Class (affiliation / group) CRUD — records keyed by name ──
  function classStore(kind) { return kind === 'affiliation' ? [affiliations, setAffiliations] : [groups, setGroups] }
  function createClass(kind, form) {
    const name = String(form.shortName || form.fullName || '').trim()
    if (!name) { show('이름을 입력하세요.', 'warn'); return false }
    const [list, setList] = classStore(kind)
    if (list.some((x) => x.name === name)) { show(`'${name}'은(는) 이미 있습니다.`, 'warn'); return false }
    setList((cur) => [...cur, { name, createdBy: authUser?.email || '', ...form }])
    show(`'${name}' 등록됨`)
    return true
  }
  function updateClass(kind, oldName, patch) {
    const [, setList] = classStore(kind)
    const newName = String(patch.shortName || patch.fullName || oldName).trim() || oldName
    setList((cur) => {
      const others = cur.filter((x) => x.name !== oldName && x.name !== newName)
      const rec = cur.find((x) => x.name === oldName) || { name: oldName }
      return [...others, { ...rec, ...patch, name: newName }]
    })
    if (newName !== oldName) {
      // rename propagates into every author's membership entries
      setAuthors((items) => items.map((a) => ({
        ...a,
        affiliations: kind === 'affiliation' ? (a.affiliations || []).map((x) => (x.tag === oldName ? { ...x, tag: newName } : x)) : a.affiliations,
        groups: kind === 'group' ? (a.groups || []).map((x) => (x.group === oldName ? { ...x, group: newName } : x)) : a.groups,
      })))
    }
    show('저장했습니다.')
  }
  function deleteClass(kind, name) {
    askConfirm(`'${name}'을(를) 삭제할까요? 저자들의 목록에서도 제거됩니다.`, () => {
      const [, setList] = classStore(kind)
      setList((cur) => cur.filter((x) => x.name !== name))
      setAuthors((items) => items.map((a) => ({
        ...a,
        affiliations: kind === 'affiliation' ? (a.affiliations || []).filter((x) => x.tag !== name) : a.affiliations,
        groups: kind === 'group' ? (a.groups || []).filter((x) => x.group !== name) : a.groups,
      })))
      show('삭제했습니다.')
    })
  }
  // Make-group from My List: create the group + add membership to every listed author.
  function makeGroupForMyList(form) {
    if (!myList.length) { show('먼저 저자를 My List에 추가하세요.', 'warn'); return false }
    if (!createClass('group', form)) return false
    const name = String(form.shortName || form.fullName).trim()
    const set = new Set(myList)
    setAuthors((items) => items.map((a) => {
      if (!set.has(a.id)) return a
      if ((a.groups || []).some((g) => g.group === name)) return a
      return { ...a, groups: [...(a.groups || []), { group: name, role: '', core: 10 }] }
    }))
    show(`'${name}' 그룹 생성 · ${myList.length}명 추가`)
    return true
  }

  // Derived --------------------------------------------------------------
  const affOptions = useMemo(() => affiliations.map((x) => x.name).sort(), [affiliations])
  const grpOptions = useMemo(() => groups.map((x) => x.name).sort(), [groups])
  const filteredAuthors = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q ? authors.filter((a) => {
      const hay = [a.nick, korName(a), engName(a), a.abvName, repEmail(a), ...(a.emails || []),
        ...(a.affiliations || []).map((x) => x.tag), ...(a.groups || []).map((x) => x.group)].join(' ').toLowerCase()
      return hay.includes(q)
    }) : authors
    return [...base].sort((x, y) => displayName(x).localeCompare(displayName(y), 'ko'))
  }, [authors, query])
  const myAuthors = useMemo(
    () => myList.map((id) => authors.find((a) => a.id === id)).filter(Boolean),
    [authors, myList],
  )
  const myListSet = useMemo(() => new Set(myList), [myList])

  // ↑/↓ move the open card within the current list.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (!expandedId || (tab !== 'authors' && tab !== 'mylist')) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      const list = tab === 'mylist' ? myAuthors : filteredAuthors
      const i = list.findIndex((a) => a.id === expandedId)
      if (i < 0) return
      const next = i + (e.key === 'ArrowDown' ? 1 : -1)
      if (next < 0 || next >= list.length) return
      e.preventDefault()
      setExpandedId(list[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedId, tab, myAuthors, filteredAuthors])

  if (authStatus !== 'ready') return <NoPortalScreen />

  const tabs = [
    { id: 'authors', label: 'Authors', Glyph: ListDashes },
    { id: 'mylist', label: 'My List', Glyph: UserList },
    { id: 'affiliation', label: 'Affil.', Glyph: Buildings },
    { id: 'group', label: 'Group', Glyph: UsersThree },
  ]
  const tabIconSize = isMobile ? 29 : 19

  return (
    <div className="app">
      <header className="topbar">
        {notice ? (
          <div
            className={`topbar-notice${notice.text.length > 28 ? ' is-long' : ''}`}
            role="button"
            onClick={() => { if (noticeTimer.current) { window.clearTimeout(noticeTimer.current); noticeTimer.current = null } setNotice('') }}
          >
            <span className={`notice-dot is-${notice.kind}`} />
            <span className="topbar-notice-text">{notice.text}</span>
          </div>
        ) : (
          <>
            <div className="topbar-title">
              <Users size={isMobile ? 24 : 20} weight="fill" color={BRAND} />
              <span className="topbar-project">{PORTAL_PROJECT || 'Authors'}</span>
              {authUser && <span className="topbar-user">{String(authUser.email).split('@')[0]}</span>}
            </div>
            <div className="topbar-right">
              <button type="button" className="topbar-logout" title="나가기" onClick={signOut}>
                <SignOut size={isMobile ? 24 : 17} weight="fill" color={BRAND} />
              </button>
            </div>
          </>
        )}
      </header>
      <main className="page" ref={pageRef}>
        {tab === 'authors' && (
          <div className="stack">
            <Card>
              <div className="search-box">
                <span className="mylist-icon-cell"><MagnifyingGlass size={18} weight="fill" color={BRAND} /></span>
                <Input size="md" value={query} placeholder="이름 · 이메일 · 소속 · 그룹 검색" onChange={(e) => setQuery(e.target.value)} />
              </div>
            </Card>
            <div className="list-toolbar">
              <span className="list-count">총 {filteredAuthors.length}명</span>
            </div>
            <div className="result-list result-list-full">
              {!query.trim() && <NewAuthorCard onCreate={createAuthor} affOptions={affOptions} grpOptions={grpOptions} />}
              {filteredAuthors.length === 0 && <Card><p className="muted">일치하는 저자가 없습니다.</p></Card>}
              {filteredAuthors.map((a) => (
                <AuthorRow
                  key={a.id}
                  author={a}
                  expanded={expandedId === a.id}
                  onToggle={() => setExpandedId(expandedId === a.id ? '' : a.id)}
                  inMyList={myListSet.has(a.id)}
                  onToggleMyList={() => toggleMyList(a.id)}
                  onUpdate={updateAuthor}
                  onDelete={isAdmin ? () => deleteAuthor(a.id) : null}
                  affOptions={affOptions}
                  grpOptions={grpOptions}
                  isAdmin={isAdmin}
                />
              ))}
            </div>
          </div>
        )}
        {tab === 'mylist' && (
          <MyListPage
            authors={myAuthors}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            toggleMyList={toggleMyList}
            onClear={() => { if (myList.length) askConfirm('My List를 모두 비울까요?', () => { setMyList([]); show('비웠습니다.') }) }}
            onMakeGroup={makeGroupForMyList}
            onUpdate={updateAuthor}
            affiliations={affiliations}
            affOptions={affOptions}
            grpOptions={grpOptions}
            isAdmin={isAdmin}
            notify={show}
          />
        )}
        {tab === 'affiliation' && (
          <ClassPage
            kind="affiliation"
            records={affiliations}
            authors={authors}
            onCreate={(f) => createClass('affiliation', f)}
            onUpdate={(o, p) => updateClass('affiliation', o, p)}
            onDelete={isAdmin ? (n) => deleteClass('affiliation', n) : null}
            myListSet={myListSet}
            toggleMyList={toggleMyList}
          />
        )}
        {tab === 'group' && (
          <ClassPage
            kind="group"
            records={groups}
            authors={authors}
            onCreate={(f) => createClass('group', f)}
            onUpdate={(o, p) => updateClass('group', o, p)}
            onDelete={isAdmin ? (n) => deleteClass('group', n) : null}
            myListSet={myListSet}
            toggleMyList={toggleMyList}
          />
        )}
      </main>
      <nav className="tabbar">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`tabbar-tab${tab === item.id ? ' is-active' : ''}`}
            onClick={() => {
              if (tab === item.id) { setExpandedId(''); pageRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }
              else setTab(item.id)
            }}
            title={item.label}
          >
            <span className="tabbar-glyph">
              <item.Glyph size={tabIconSize} weight="fill" color={tab === item.id ? BRAND : '#9aa3b2'} />
              {item.id === 'mylist' && myList.length > 0 && <span className="tab-total"> {myList.length}</span>}
            </span>
            <span className="tabbar-label">{item.label}</span>
          </button>
        ))}
      </nav>
      {dialog && (
        <div className="scanner-backdrop" onClick={() => setDialog(null)}>
          <section className="scanner-modal" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 600 }}>{dialog.message}</p>
            <div className="action-row">
              <button type="button" className="amber-btn danger-btn" onClick={() => { dialog.onConfirm(); setDialog(null) }}>확인</button>
              <Button variant="secondary" size="md" onClick={() => setDialog(null)}>취소</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function NoPortalScreen() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100dvh', padding: 24, textAlign: 'center' }}>
      <div>
        <Users size={44} weight="fill" color={BRAND} />
        <p>이 앱은 LILAK 포털을 통해 열어야 합니다.</p>
        <a href="/projects">포털로 이동</a>
      </div>
    </div>
  )
}

// ─── Reusable field editors ──────────────────────────────────────────────────
function PhotoField({ value, onChange, label = '사진' }) {
  const ref = useRef(null)
  return (
    <div className="photo-row">
      <div className="photo-stack">
        <div className="photo-slot">
          <div className="photo-box">
            {value ? <img src={value} alt="" /> : <Users size={28} weight="fill" color="#c2c8d2" />}
          </div>
          <span className="photo-label">{label}</span>
        </div>
        <button type="button" className="slot-edit-btn" onClick={() => ref.current?.click()}>
          {value ? '사진 변경' : '사진 추가'}
        </button>
        {value && (
          <button type="button" className="slot-edit-btn" style={{ borderColor: '#e0c4c4', color: '#a32d2d' }} onClick={() => onChange('')}>삭제</button>
        )}
      </div>
      <input ref={ref} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onChange(await fileToJpegDataUrl(f)) }} />
    </div>
  )
}

// Multi-line list editor (emails / links): one value per line.
function LinesField({ label, value = [], onChange, placeholder }) {
  return (
    <label>
      {label}
      <textarea
        className="edit-textarea"
        value={(value || []).join('\n')}
        placeholder={placeholder || '한 줄에 하나씩'}
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).length || e.target.value === '' ? e.target.value.split('\n') : value)}
        onBlur={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      />
    </label>
  )
}

// Attachments editor: add files (stored as data URLs), list + delete.
function FilesField({ label, value = [], onChange }) {
  const ref = useRef(null)
  async function add(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    const added = []
    for (const f of files) added.push({ name: f.name, type: f.type, data: await fileToDataUrl(f) })
    onChange([...(value || []), ...added])
  }
  return (
    <div className="files-field">
      <span className="field-label">{label}</span>
      {(value || []).map((f, i) => (
        <div key={`${f.name}-${i}`} className="file-row">
          <Paperclip size={15} weight="fill" color="#667085" />
          <button type="button" className="file-name" onClick={() => downloadDataUrl(f.data, f.name)}>{f.name}</button>
          <button type="button" className="file-del" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash size={14} weight="fill" color="#a32d2d" /></button>
        </div>
      ))}
      <button type="button" className="slot-edit-btn" onClick={() => ref.current?.click()}><Paperclip size={15} weight="fill" /> 파일 추가</button>
      <input ref={ref} type="file" multiple hidden onChange={add} />
    </div>
  )
}

// Affiliation membership rows: [tag ▾][position][email][since][삭제] + 추가
function AffRowsField({ value = [], onChange, options }) {
  const rows = value || []
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="rows-field">
      <span className="field-label">Affiliations (날짜별)</span>
      {rows.map((r, i) => (
        <div key={i} className="aff-row">
          <select className="edit-select" value={r.tag || ''} onChange={(e) => set(i, { tag: e.target.value })}>
            <option value="">(소속 선택)</option>
            {options.map((n) => <option key={n} value={n}>{n}</option>)}
            {r.tag && !options.includes(r.tag) && <option value={r.tag}>{r.tag}</option>}
          </select>
          <input className="loc-input" placeholder="position" value={r.position || ''} onChange={(e) => set(i, { position: e.target.value })} />
          <input className="loc-input" placeholder="email" value={r.email || ''} onChange={(e) => set(i, { email: e.target.value })} />
          <input className="loc-input" type="date" value={r.since || ''} onChange={(e) => set(i, { since: e.target.value })} />
          <button type="button" className="file-del" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash size={15} weight="fill" color="#a32d2d" /></button>
        </div>
      ))}
      <button type="button" className="slot-edit-btn" onClick={() => onChange([...rows, { tag: '', position: '', email: '', since: new Date().toISOString().slice(0, 10) }])}>
        <Plus size={15} weight="bold" /> Affiliation 추가
      </button>
    </div>
  )
}

// Group membership rows: [group ▾][role][core 1-10][삭제] + 추가
function GrpRowsField({ value = [], onChange, options }) {
  const rows = value || []
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="rows-field">
      <span className="field-label">Groups</span>
      {rows.map((r, i) => (
        <div key={i} className="grp-row">
          <select className="edit-select" value={r.group || ''} onChange={(e) => set(i, { group: e.target.value })}>
            <option value="">(그룹 선택)</option>
            {options.map((n) => <option key={n} value={n}>{n}</option>)}
            {r.group && !options.includes(r.group) && <option value={r.group}>{r.group}</option>}
          </select>
          <input className="loc-input" placeholder="role" value={r.role || ''} onChange={(e) => set(i, { role: e.target.value })} />
          <select className="edit-select" value={r.core ?? 10} onChange={(e) => set(i, { core: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>core {n}</option>)}
          </select>
          <button type="button" className="file-del" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash size={15} weight="fill" color="#a32d2d" /></button>
        </div>
      ))}
      <button type="button" className="slot-edit-btn" onClick={() => onChange([...rows, { group: '', role: '', core: 10 }])}>
        <Plus size={15} weight="bold" /> Group 추가
      </button>
    </div>
  )
}

// The full author form (shared by edit + create).
function AuthorForm({ form, setForm, affOptions, grpOptions }) {
  const F = (k, label, ph) => (
    <label key={k}>
      {label}
      <Input size="md" value={form[k] || ''} placeholder={ph || ''} onChange={(e) => setForm((c) => ({ ...c, [k]: e.target.value }))} />
    </label>
  )
  return (
    <>
      <PhotoField value={form.photo || ''} onChange={(v) => setForm((c) => ({ ...c, photo: v }))} />
      {F('nick', '간편이름 *')}
      <div className="pair-row">
        {F('korFamily', '한글 성')}
        {F('korGiven', '한글 이름')}
      </div>
      <div className="pair-row three">
        {F('engFirst', 'English first')}
        {F('engMiddle', 'middle')}
        {F('engLast', 'last')}
      </div>
      {F('abvName', '논문 줄임 이름', '예: J. W. Lee')}
      {F('repEmail', 'Representing email', '비우면 최신 affiliation email 사용')}
      <LinesField label="Emails (여러 개)" value={form.emails} onChange={(v) => setForm((c) => ({ ...c, emails: Array.isArray(v) ? v : c.emails }))} placeholder="한 줄에 하나씩" />
      {F('phone', 'Phone')}
      <LinesField label="Homepage / Links (여러 개)" value={form.links} onChange={(v) => setForm((c) => ({ ...c, links: Array.isArray(v) ? v : c.links }))} placeholder="https://…" />
      <FilesField label="첨부파일" value={form.attachments} onChange={(v) => setForm((c) => ({ ...c, attachments: v }))} />
      <AffRowsField value={form.affiliations} onChange={(v) => setForm((c) => ({ ...c, affiliations: v }))} options={affOptions} />
      <GrpRowsField value={form.groups} onChange={(v) => setForm((c) => ({ ...c, groups: v }))} options={grpOptions} />
    </>
  )
}

// ─── Author cards ────────────────────────────────────────────────────────────
function AuthorRow({ author, expanded, onToggle, inMyList, onToggleMyList, onUpdate, onDelete, affOptions, grpOptions, isAdmin }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(author)
  const rowRef = useRef(null)
  useEffect(() => {
    setForm(author)
    if (!expanded) setEditing(false)
  }, [author, expanded])
  useEffect(() => {
    if (expanded && rowRef.current) rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [expanded])
  const cur = currentAff(author)
  const affsSorted = [...(author.affiliations || [])].sort((x, y) => String(y.since || '').localeCompare(String(x.since || '')))
  return (
    <div ref={rowRef} className={`asset-row${expanded ? ' is-open' : ''}`}>
      <div className="asset-row-head">
        <div className="asset-photo">
          {author.photo ? <img src={author.photo} alt="" /> : <Users size={22} weight="fill" color="#c2c8d2" />}
        </div>
        <div className="asset-row-open" role="button" tabIndex={0} onClick={onToggle}>
          <div className="asset-row-main">
            <strong>{displayName(author)}</strong>
            <span className="history-meta">{cur ? `${cur.tag}${cur.position ? ` · ${cur.position}` : ''}` : ''}</span>
          </div>
        </div>
        <button
          type="button"
          className={`asset-add${inMyList ? ' is-on' : ''}`}
          title={inMyList ? 'My List에서 제거' : 'My List에 추가'}
          onClick={(e) => { e.stopPropagation(); onToggleMyList() }}
        >
          {inMyList ? <Minus size={22} weight="bold" color="#ffffff" /> : <Plus size={22} weight="bold" color="#ffffff" />}
        </button>
      </div>
      {expanded && (
        <div className="asset-row-body">
          {editing ? (
            <div className="asset-edit">
              <div className="action-row">
                <button type="button" className="amber-btn" onClick={() => { onUpdate(author.id, form); setEditing(false) }}>Save</button>
                <Button variant="secondary" size="md" onClick={() => { setForm(author); setEditing(false) }}>Cancel</Button>
              </div>
              <AuthorForm form={form} setForm={setForm} affOptions={affOptions} grpOptions={grpOptions} />
              <div className="action-row">
                <button type="button" className="amber-btn" onClick={() => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ArrowUp size={18} weight="bold" /> 맨 위로</button>
              </div>
            </div>
          ) : (
            <div className="detail-body">
              <div className="action-row">
                <button type="button" className="amber-btn" onClick={() => setEditing(true)}><PencilSimple size={18} weight="fill" /> Edit</button>
                {onDelete && <button type="button" className="amber-btn danger-btn" onClick={onDelete}><Trash size={18} weight="fill" /> Delete</button>}
              </div>
              <h3 className="asset-full-name">{displayName(author)}</h3>
              <dl className="kv">
                <dt>한글 이름</dt><dd>{korName(author) || '-'}</dd>
                <dt>English</dt><dd>{engName(author) || '-'}</dd>
                <dt>줄임 이름</dt><dd>{author.abvName || '-'}</dd>
                <dt>Email</dt>
                <dd>
                  {repEmail(author) || '-'}
                  {(author.emails || []).filter((e) => e && e !== repEmail(author)).map((e) => <div key={e} className="muted-line">{e}</div>)}
                </dd>
                <dt>Phone</dt><dd>{author.phone || '-'}</dd>
                <dt>Links</dt>
                <dd>
                  {(author.links || []).length
                    ? (author.links || []).map((l) => <div key={l}><a href={l} target="_blank" rel="noreferrer"><LinkSimple size={12} weight="bold" /> {l}</a></div>)
                    : '-'}
                </dd>
                <dt>첨부파일</dt>
                <dd>
                  {(author.attachments || []).length
                    ? (author.attachments || []).map((f, i) => (
                      <div key={i}><button type="button" className="file-name" onClick={() => downloadDataUrl(f.data, f.name)}><Paperclip size={12} weight="fill" /> {f.name}</button></div>
                    ))
                    : '-'}
                </dd>
              </dl>
              <div className="tl-block">
                <span className="field-label">Affiliations</span>
                {affsSorted.length === 0 && <p className="muted">등록된 affiliation이 없습니다.</p>}
                {affsSorted.map((x, i) => (
                  <div key={i} className="tl-row">
                    <span className="mono tl-date">{x.since || '-'}</span>
                    <strong>{x.tag}</strong>
                    <span className="history-meta">{[x.position, x.email].filter(Boolean).join(' · ')}</span>
                  </div>
                ))}
              </div>
              <div className="tl-block">
                <span className="field-label">Groups</span>
                {(author.groups || []).length === 0 && <p className="muted">등록된 그룹이 없습니다.</p>}
                {(author.groups || []).map((g, i) => (
                  <div key={i} className="tl-row">
                    <span className="type-chip type-save">core {g.core ?? 10}</span>
                    <strong>{g.group}</strong>
                    <span className="history-meta">{g.role || ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NewAuthorCard({ onCreate, affOptions, grpOptions }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({})
  function done() { setForm({}); setOpen(false) }
  return (
    <div className={`asset-row${open ? ' is-open' : ''}`}>
      <div className="asset-row-head" role="button" tabIndex={0} onClick={() => (open ? done() : setOpen(true))}>
        <div className="asset-photo"><Plus size={24} weight="bold" color={BRAND} /></div>
        <div className="asset-row-open">
          <div className="asset-row-main"><strong>새 저자 등록</strong></div>
        </div>
      </div>
      {open && (
        <div className="asset-row-body">
          <div className="asset-edit">
            <div className="action-row">
              <button type="button" className="amber-btn" onClick={() => { if (onCreate(form)) done() }}>Save</button>
              <Button variant="secondary" size="md" onClick={done}>Cancel</Button>
            </div>
            <AuthorForm form={form} setForm={setForm} affOptions={affOptions} grpOptions={grpOptions} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── My List: name tools ─────────────────────────────────────────────────────
function MyListPage({ authors, expandedId, setExpandedId, toggleMyList, onClear, onMakeGroup, onUpdate, affiliations, affOptions, grpOptions, isAdmin, notify }) {
  const [sep, setSep] = useState(', ')
  const [out, setOut] = useState('')
  const [groupOpen, setGroupOpen] = useState(false)
  const [gform, setGform] = useState({})
  const sepReal = sep.replaceAll('⏎', '\n')

  function joined(mapper) {
    return authors.map(mapper).filter(Boolean).join(sepReal)
  }
  async function copyOut(text) {
    const v = text ?? out
    try { await navigator.clipboard.writeText(v); notify('복사했습니다.') }
    catch { notify('복사 실패 — 직접 선택해 복사하세요.', 'warn') }
  }
  // LaTeX authors: core asc → alphabetical; superscript indices per current affiliation.
  function paperAuthors() {
    const ordered = [...authors].sort((a, b) => {
      const c = coreOf(a) - coreOf(b)
      if (c !== 0) return c
      const an = a.abvName || engName(a) || displayName(a)
      const bn = b.abvName || engName(b) || displayName(b)
      return an.localeCompare(bn)
    })
    const affIdx = new Map()
    const affLine = (tag) => {
      const rec = affiliations.find((x) => x.name === tag)
      return rec ? [rec.fullName || rec.name, rec.address].filter(Boolean).join(', ') : tag
    }
    for (const a of ordered) {
      const cur = currentAff(a)
      if (cur?.tag && !affIdx.has(cur.tag)) affIdx.set(cur.tag, affIdx.size + 1)
    }
    const names = ordered.map((a) => {
      const nm = a.abvName || engName(a) || displayName(a)
      const cur = currentAff(a)
      const sup = cur?.tag ? `$^{${affIdx.get(cur.tag)}}$` : ''
      return `  ${nm}${sup}`
    })
    const affs = [...affIdx.entries()].map(([tag, i]) => `$^{${i}}$ ${affLine(tag)}\\\\`)
    return `\\author{%\n${names.join(',\n')}\n}\n\n% affiliations\n${affs.join('\n')}`
  }

  return (
    <div className="stack">
      <Card>
        <label className="field-label">출력</label>
        <textarea className="edit-textarea out-area" value={out} placeholder="아래 버튼으로 이름 목록을 생성하세요" onChange={(e) => setOut(e.target.value)} />
        <div className="mylist-head-grid" style={{ marginTop: 8 }}>
          <button type="button" className="loc-photo-btn mylist-icon-cell" title="복사" onClick={() => copyOut()}>
            <Copy size={18} weight="fill" color="#ffffff" />
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="loc-input" style={{ flex: 1 }} value={sep} placeholder="구분기호 (예: , )" onChange={(e) => setSep(e.target.value)} />
            <button type="button" className="hp-nav" title="줄바꿈 추가" onClick={() => setSep((s) => s + '⏎')}><KeyReturn size={16} weight="bold" /> 엔터</button>
          </div>
        </div>
        <div className="mylist-actions" style={{ marginTop: 10 }}>
          <button type="button" className="mylist-btn" disabled={!authors.length} onClick={() => setGroupOpen((o) => !o)}>
            <UsersFour size={20} weight="fill" color="#0f766e" /><span>Make group</span>
          </button>
          <button type="button" className="mylist-btn" disabled={!authors.length} onClick={onClear}>
            <Broom size={20} weight="fill" color="#0f766e" /><span>Clear</span>
          </button>
        </div>
        <div className="mylist-actions" style={{ marginTop: 6 }}>
          <button type="button" className="mylist-btn tone-amber" disabled={!authors.length} onClick={() => setOut(joined((a) => korName(a) || displayName(a)))}><span>이름 나열</span></button>
          <button type="button" className="mylist-btn tone-amber" disabled={!authors.length} onClick={() => setOut(joined((a) => engName(a) || displayName(a)))}><span>Full names</span></button>
          <button type="button" className="mylist-btn tone-amber" disabled={!authors.length} onClick={() => setOut(joined((a) => a.abvName || engName(a) || displayName(a)))}><span>Abv. names</span></button>
          <button type="button" className="mylist-btn tone-amber" disabled={!authors.length} onClick={() => setOut(paperAuthors())}><span>Paper authors</span></button>
        </div>
        {groupOpen && (
          <div className="restore-confirm" style={{ marginTop: 10 }}>
            <p>새 그룹을 만들고 My List의 {authors.length}명을 추가합니다.</p>
            <label>Full name<Input size="md" value={gform.fullName || ''} onChange={(e) => setGform((c) => ({ ...c, fullName: e.target.value }))} /></label>
            <label>Short name<Input size="md" value={gform.shortName || ''} onChange={(e) => setGform((c) => ({ ...c, shortName: e.target.value }))} /></label>
            <label>Description<textarea className="edit-textarea" value={gform.description || ''} onChange={(e) => setGform((c) => ({ ...c, description: e.target.value }))} /></label>
            <div className="pair-row">
              <label>Creation date<input className="loc-input" type="date" value={gform.creationDate || ''} onChange={(e) => setGform((c) => ({ ...c, creationDate: e.target.value }))} /></label>
              <label>End date<input className="loc-input" type="date" value={gform.endDate || ''} onChange={(e) => setGform((c) => ({ ...c, endDate: e.target.value }))} /></label>
            </div>
            <div className="action-row">
              <button type="button" className="amber-btn" onClick={() => { if (onMakeGroup(gform)) { setGform({}); setGroupOpen(false) } }}>저장하기</button>
              <Button variant="secondary" size="md" onClick={() => setGroupOpen(false)}>취소</Button>
            </div>
          </div>
        )}
      </Card>
      <div className="list-toolbar"><span className="list-count">총 {authors.length}명</span></div>
      <div className="result-list result-list-full">
        {authors.length === 0 && <Card><p className="muted">My List가 비어 있습니다.</p></Card>}
        {authors.map((a) => (
          <AuthorRow
            key={a.id}
            author={a}
            expanded={expandedId === a.id}
            onToggle={() => setExpandedId(expandedId === a.id ? '' : a.id)}
            inMyList
            onToggleMyList={() => toggleMyList(a.id)}
            onUpdate={onUpdate}
            onDelete={null}
            affOptions={affOptions}
            grpOptions={grpOptions}
            isAdmin={isAdmin}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Class pages (affiliation / group) ───────────────────────────────────────
const CLASS_META = {
  affiliation: {
    createLabel: '새 affiliation 등록',
    memberKey: (a) => (a.affiliations || []).map((x) => x.tag),
    fields: [
      { k: 'fullName', l: 'Full name' },
      { k: 'shortName', l: 'Short name *' },
      { k: 'address', l: 'Address' },
      { k: 'phone', l: 'Phone' },
    ],
    lines: [{ k: 'links', l: 'Reference links' }],
    hasFiles: false,
  },
  group: {
    createLabel: '새 group 등록',
    memberKey: (a) => (a.groups || []).map((x) => x.group),
    fields: [
      { k: 'fullName', l: 'Full name' },
      { k: 'shortName', l: 'Short name *' },
      { k: 'description', l: 'Description', area: true },
      { k: 'creationDate', l: 'Creation date', date: true },
      { k: 'endDate', l: 'End date', date: true },
    ],
    lines: [{ k: 'links', l: 'Reference links' }],
    hasFiles: true,
  },
}

function ClassForm({ meta, form, setForm }) {
  return (
    <>
      <PhotoField value={form.photo || ''} onChange={(v) => setForm((c) => ({ ...c, photo: v }))} />
      {meta.fields.map((f) => (
        <label key={f.k}>
          {f.l}
          {f.area ? (
            <textarea className="edit-textarea" value={form[f.k] || ''} onChange={(e) => setForm((c) => ({ ...c, [f.k]: e.target.value }))} />
          ) : f.date ? (
            <input className="loc-input" type="date" value={form[f.k] || ''} onChange={(e) => setForm((c) => ({ ...c, [f.k]: e.target.value }))} />
          ) : (
            <Input size="md" value={form[f.k] || ''} onChange={(e) => setForm((c) => ({ ...c, [f.k]: e.target.value }))} />
          )}
        </label>
      ))}
      {meta.lines.map((f) => (
        <LinesField key={f.k} label={f.l} value={form[f.k]} onChange={(v) => setForm((c) => ({ ...c, [f.k]: Array.isArray(v) ? v : c[f.k] }))} placeholder="https://…" />
      ))}
      {meta.hasFiles && <FilesField label="첨부파일" value={form.attachments} onChange={(v) => setForm((c) => ({ ...c, attachments: v }))} />}
    </>
  )
}

function ClassPage({ kind, records, authors, onCreate, onUpdate, onDelete, myListSet, toggleMyList }) {
  const meta = CLASS_META[kind]
  const [query, setQuery] = useState('')
  const [openName, setOpenName] = useState('')
  const sorted = useMemo(() => [...records].sort((a, b) => a.name.localeCompare(b.name)), [records])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter((r) => [r.name, r.fullName, r.shortName].filter(Boolean).join(' ').toLowerCase().includes(q))
  }, [sorted, query])
  return (
    <div className="stack">
      <Card>
        <div className="search-box">
          <span className="mylist-icon-cell"><MagnifyingGlass size={18} weight="fill" color={BRAND} /></span>
          <Input size="md" value={query} placeholder="이름 검색" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </Card>
      {!query.trim() && <NewClassCard meta={meta} onCreate={onCreate} />}
      {filtered.length === 0 && <Card><p className="muted">등록된 항목이 없습니다.</p></Card>}
      {filtered.map((rec) => (
        <ClassCard
          key={rec.name}
          kind={kind}
          meta={meta}
          rec={rec}
          authors={authors}
          open={openName === rec.name}
          onToggle={() => setOpenName(openName === rec.name ? '' : rec.name)}
          onUpdate={onUpdate}
          onDelete={onDelete}
          myListSet={myListSet}
          toggleMyList={toggleMyList}
        />
      ))}
    </div>
  )
}

function NewClassCard({ meta, onCreate }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({})
  function done() { setForm({}); setOpen(false) }
  return (
    <div className={`asset-row${open ? ' is-open' : ''}`}>
      <div className="asset-row-head" role="button" tabIndex={0} onClick={() => (open ? done() : setOpen(true))}>
        <div className="asset-photo"><Plus size={24} weight="bold" color={BRAND} /></div>
        <div className="asset-row-open"><div className="asset-row-main"><strong>{meta.createLabel}</strong></div></div>
      </div>
      {open && (
        <div className="asset-row-body loc-body loc-edit">
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={() => { if (onCreate(form)) done() }}>Save</button>
            <Button variant="secondary" size="md" onClick={done}>Cancel</Button>
          </div>
          <ClassForm meta={meta} form={form} setForm={setForm} />
        </div>
      )}
    </div>
  )
}

function ClassCard({ kind, meta, rec, authors, open, onToggle, onUpdate, onDelete, myListSet, toggleMyList }) {
  const [editing, setEditing] = useState(false)
  const initForm = () => ({ ...rec })
  const [form, setForm] = useState(initForm)
  const cardRef = useRef(null)
  useEffect(() => { setForm(initForm()) }, [rec])
  useEffect(() => {
    if (!open) setEditing(false)
    else if (cardRef.current) cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [open])
  const members = useMemo(
    () => authors.filter((a) => meta.memberKey(a).includes(rec.name)),
    [authors, rec.name],
  )
  return (
    <div ref={cardRef} className={`asset-row${open ? ' is-open' : ''}`}>
      <div className="asset-row-head">
        <div className="asset-photo">
          {rec.photo ? <img src={rec.photo} alt="" /> : (kind === 'affiliation' ? <Buildings size={22} weight="fill" color="#9aa3b2" /> : <UsersThree size={22} weight="fill" color="#9aa3b2" />)}
        </div>
        <button type="button" className="asset-row-open" onClick={onToggle}>
          <span className="loc-main">
            <strong>{rec.name}</strong>
            <span className="history-meta">{rec.fullName && rec.fullName !== rec.name ? `${rec.fullName} · ` : ''}{members.length}명</span>
          </span>
        </button>
      </div>
      {open && editing && (
        <div className="asset-row-body loc-body loc-edit">
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={() => { onUpdate(rec.name, form); setEditing(false) }}>저장</button>
            <Button variant="secondary" size="md" onClick={() => setEditing(false)}>취소</Button>
          </div>
          <ClassForm meta={meta} form={form} setForm={setForm} />
        </div>
      )}
      {open && !editing && (
        <div className="asset-row-body loc-body">
          <div className="hcard-actions">
            <button type="button" className="amber-btn" onClick={() => setEditing(true)}><PencilSimple size={18} weight="fill" /> 편집</button>
            {onDelete && <button type="button" className="amber-btn danger-btn" onClick={() => onDelete(rec.name)}><Trash size={18} weight="fill" /> 삭제</button>}
          </div>
          {rec.photo && (
            <div className="photo-row"><div className="photo-slot"><div className="photo-box"><img src={rec.photo} alt="" /></div></div></div>
          )}
          <dl className="kv">
            {meta.fields.map((f) => (rec[f.k] ? <React.Fragment key={f.k}><dt>{f.l.replace(' *', '')}</dt><dd>{rec[f.k]}</dd></React.Fragment> : null))}
            {(rec.links || []).length > 0 && (
              <><dt>Links</dt><dd>{rec.links.map((l) => <div key={l}><a href={l} target="_blank" rel="noreferrer">{l}</a></div>)}</dd></>
            )}
          </dl>
          {meta.hasFiles && (rec.attachments || []).length > 0 && (
            <div className="tl-block">
              <span className="field-label">첨부파일</span>
              {(rec.attachments || []).map((f, i) => (
                <div key={i}><button type="button" className="file-name" onClick={() => downloadDataUrl(f.data, f.name)}><Paperclip size={12} weight="fill" /> {f.name}</button></div>
              ))}
            </div>
          )}
          <div className="loc-items">
            {members.length === 0 && <p className="muted">구성원이 없습니다.</p>}
            {members.map((a) => {
              const mem = kind === 'affiliation'
                ? (a.affiliations || []).filter((x) => x.tag === rec.name).sort((x, y) => String(y.since || '').localeCompare(String(x.since || '')))[0]
                : (a.groups || []).find((x) => x.group === rec.name)
              const sub = kind === 'affiliation'
                ? [mem?.position, mem?.since].filter(Boolean).join(' · ')
                : [mem?.role, mem?.core != null ? `core ${mem.core}` : ''].filter(Boolean).join(' · ')
              return (
                <div key={a.id} className="loc-item">
                  <strong>{displayName(a)}</strong>
                  <span className="history-meta">{sub}</span>
                  <button
                    type="button"
                    className={`asset-circle${myListSet.has(a.id) ? ' is-on' : ''}`}
                    title={myListSet.has(a.id) ? 'My List에서 제거' : 'My List에 추가'}
                    onClick={() => toggleMyList(a.id)}
                  >
                    {myListSet.has(a.id) ? <Minus size={15} weight="bold" color="#fff" /> : <Plus size={15} weight="bold" color="#fff" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
