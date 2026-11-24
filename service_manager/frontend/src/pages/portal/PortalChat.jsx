import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon, MANAGER_COLOR, avatarFor, tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import './chat.css'

// An author's colour: their account icon's (a manager's is black).
const colourOf = (m) => (m.author_admin ? MANAGER_COLOR : (m.author_color || avatarFor(m.author_username || m.author_name).profile_color))

/**
 * PortalChat — the chat as thin strips over whatever the cover is showing
 * (design C4: one line per message, the author's icon and colour at its left
 * edge, the time at the right, an agent's answer as a tinted line under it).
 * No page of its own: the input is a bubble coming out of the account icon at
 * the foot of the (folded) bar, and the conversation stacks above it. Outside
 * the bubbles every click goes through to the page underneath.
 *
 * Rooms: "portal" (everyone) or "svc/proj" (who may enter it), picked from the
 * chip on the input; the last one is the account's (prefs.chatRoom).
 * `@agent <task>` in a project room asks that project's platform agent; its
 * answer appears under the message when the worker has one.
 *
 * Open: Space in command mode (the portal's foldKey). Close: Esc.
 */
// Where the chat sits and how big it is: the viewer's own, kept in this browser.
// Corners are named the vi way: h left, l right, k up, j down (hj = bottom left).
const LAY_KEY = 'lilak-chat-layout'
const LAY0 = { pos: 'hj', size: 'm', height: 'normal' }
const OPTS = { pos: ['hj', 'lj', 'hk', 'lk'], size: ['s', 'm', 'l'], height: ['short', 'normal', 'full'] }
const readLay = () => { try { return { ...LAY0, ...JSON.parse(localStorage.getItem(LAY_KEY) || '{}') } } catch { return LAY0 } }
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } },
}
// The chat's /commands: listed while `/` is typed, completed with Tab or Enter.
const CMDS = [
  { name: 'issue', opts: ['bug', 'idea', 'ask', 'local'], more: true },
  { name: 'todo', more: true },
  { name: 'move', opts: OPTS.pos },
  { name: 'size', opts: OPTS.size },
  { name: 'height', opts: OPTS.height },
  { name: 'clear' },
  { name: 'room', more: true },
  { name: 'open', more: true },
  { name: 'help' },
]
const KIND = { bug: 'bug', idea: 'recommendation', recommendation: 'recommendation', ask: 'inquiry', inquiry: 'inquiry',
  '버그': 'bug', '제안': 'recommendation', '문의': 'inquiry', local: 'local' }
/** `/issue [kind] text` (old name `/report`) → { kind, body, subject } (subject: the first line, cut at 60). */
function parseReport(line) {
  const raw = line.trim().replace(/^\/(issue|report)/, '').trim()
  const first = raw.split(/\s+/)[0] || ''
  const kind = KIND[first.toLowerCase()] || 'inquiry'
  const body = KIND[first.toLowerCase()] ? raw.slice(first.length).trim() : raw
  const line1 = body.split('\n')[0].trim()
  return { kind, body, subject: line1.length > 60 ? line1.slice(0, 59) + '…' : line1 }
}

/** `/todo`: a to-do line at the end of today's Daily note in the note service, made the way
 *  the note page's `daily` button makes it when there is none yet. A `>> day` in `text` becomes
 *  its due day (see dueMark). */
const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** `>> 2026-11-5`, `>>today`, `>> .`, `>> 오늘`, `>> 0`, `>> +3`, `>> -1` → `» 2026-11-05`:
 *  the form the note page draws as a due chip (its editor makes the same change as you type).
 *  A number is days from today. */
export const dueMark = (text, day) => text.replace(/(^|\s)(?:>>|»|📅)\s*(today|\.|오늘|\d{4}-\d{1,2}-\d{1,2}|[+-]?\d{1,3})(?=\s|$)/i,
  (_, sp, d) => {
    if (/^(today|\.|오늘)$/i.test(d)) d = '0'
    if (/^[+-]?\d{1,3}$/.test(d)) {
      const [y, m, dd] = day.split('-').map(Number)
      const t = new Date(y, m - 1, dd + Number(d))
      return `${sp}» ${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    }
    const [y, m, dd] = d.split('-')
    return `${sp}» ${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`
  })
async function addTodo(proj, text) {
  const api = async (path, opt = {}) => {
    const r = await fetch(`/pp/note/${encodeURIComponent(proj)}/api${path}`,
      { credentials: 'same-origin', ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(d.detail || `note ${r.status}`), { status: r.status })
    return d
  }
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const list = await api('/notes')
  let note = (list.notes || []).find((n) => (n.title || '').startsWith(`Daily ${day}`))
  if (!note) {
    const title = `Daily ${day} (${WDAY[now.getDay()]})`
    note = await api('/notes', { method: 'POST', body: JSON.stringify({ title, template: (list.templates || []).includes('daily') ? 'daily' : null }) })
    if (!/(^|\s)#daily\b/.test(note.body || '')) {
      note = await api(`/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ baseVersion: note.version,
        body: note.body ? `${note.body.replace(/\n+$/, '')}\n\n#daily` : '#daily' }) })
    }
  }
  // Read, add to the end, write on that version; a note changed in between is read again.
  for (let i = 0; i < 3; i++) {
    const n = await api(`/notes/${note.id}`)
    try {
      await api(`/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ baseVersion: n.version, body: `${(n.body || '').replace(/\s+$/, '')}\n- [ ] ${dueMark(text, day)}\n` }) })
      return n.title
    } catch (e) { if (e.status !== 409) throw e }
  }
  throw new Error('note busy')
}

const POLL_OPEN = 3000
const POLL_SHUT = 20000
const timeOf = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
const isImg = (a) => /^image\//.test(a.type || '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name || '')

/** Body text with @mentions marked — the names of the room's members (`re`), as the
 *  server resolves them. Plain text otherwise: no markup is trusted. */
function Body({ text, re }) {
  const parts = String(text || '').split(re)
  return <>{parts.map((p, i) => (i % 2 ? <b key={i} className="pc-at">{p}</b> : p))}</>
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function Att({ a, room }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let u = null, alive = true
    if (!isImg(a)) return undefined
    launcher.get(`/chat/files/${a.id}`, { params: { room }, responseType: 'blob' })
      .then((r) => { if (alive) { u = URL.createObjectURL(r.data); setUrl(u) } }).catch(() => {})
    return () => { alive = false; if (u) URL.revokeObjectURL(u) }
  }, [a.id, room])
  const open = async () => {
    try {
      const r = await launcher.get(`/chat/files/${a.id}`, { params: { room }, responseType: 'blob' })
      const u = URL.createObjectURL(r.data)
      const el = document.createElement('a'); el.href = u; el.download = a.name; el.click()
      setTimeout(() => URL.revokeObjectURL(u), 5000)
    } catch { /* gone */ }
  }
  // A picture that arrives later makes its line taller: let the list re-fit (see fit()).
  if (url) return <img className="pc-img" src={url} alt={a.name} onClick={open} onLoad={() => window.dispatchEvent(new Event('resize'))} />
  return <button type="button" className="pc-file" onClick={open}><Icon name="attach" size={12} /> {a.name}</button>
}

export default function PortalChat({ open, onClose, user, onUnread, go, cards = [], onOpenCard }) {
  const [room, setRoom] = useState(() => {
    try { return JSON.parse(user?.preferences_json || '{}').chatRoom || 'portal' } catch { return 'portal' }
  })
  const [rooms, setRooms] = useState([])
  const [picking, setPicking] = useState(false)
  const [msgs, setMsgs] = useState([])
  const [me, setMe] = useState(null)
  const [text, setText] = useState('')
  const [reply, setReply] = useState(null)
  const [thread, setThread] = useState(null)                 // the root message whose thread is open, beside the chat
  const [tText, setTText] = useState('')                     // what is being written in that thread
  const [lay, setLay] = useState(readLay)
  const [cmdI, setCmdI] = useState(0)                        // the highlighted /command
  const [dropping, setDropping] = useState(false)
  // This viewer's own lines in the room's history (a /report sent, a /command's answer) and
  // where the history was cleared: kept in this browser, never sent to the room.
  const [locals, setLocals] = useState([])
  const [cleared, setCleared] = useState(0)
  const [atts, setAtts] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(null)                  // projects with no room yet, while opening one
  const [notice, setNotice] = useState('')                   // a /command's answer (not a message)
  const [members, setMembers] = useState([])                 // who can be @mentioned in this room
  const [at, setAt] = useState(null)                         // the @name being typed: { from, q, i }
  const [counts, setCounts] = useState({ rooms: {}, unread: 0, mentions: 0 })   // unread, kept on the account
  const [skip, setSkip] = useState(0)                        // newest messages paged past (0 = at the newest)
  const skipRef = useRef(0); skipRef.current = skip
  const shown = useRef(0)                                    // how many lines fit() last drew
  const noMore = useRef(false)                               // the room's first message is loaded
  const [more, setMore] = useState(false)                    // something older than what is drawn
  const pages = useRef([])                                   // the skips paged through, to step forward again
  const readTop = useRef({})
  const lastId = useRef(0)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const tInputRef = useRef(null)
  const tListRef = useRef(null)
  useEffect(() => { store.set(LAY_KEY, lay) }, [lay])
  useEffect(() => { window.dispatchEvent(new Event('resize')) }, [lay])     // re-fit to the new size
  useEffect(() => { setLocals(store.get('lilak-chat-local:' + room, [])); setCleared(store.get('lilak-chat-cleared:' + room, 0)) }, [room])
  const addLocal = (text) => {
    const top = msgs.length ? msgs[msgs.length - 1].id : 0
    const next = [...store.get('lilak-chat-local:' + room, []), { id: 'L' + Date.now(), after: top, text, time: new Date().toTimeString().slice(0, 5) }].slice(-50)
    store.set('lilak-chat-local:' + room, next); setLocals(next)
  }

  const roomLabel = (k) => {
    if (k === 'portal') return tr('pc_room_all')
    if (k === 'system') return tr('pc_room_system')
    const r = rooms.find((x) => x.key === k)
    return r ? `${r.service_label} · ${r.label}` : k
  }

  // The room's messages from the start, then only what is new.
  const load = useCallback(async (fresh) => {
    try {
      const { data } = await launcher.get('/chat/messages', { params: { room, after: fresh ? 0 : lastId.current } })
      setMe(data.me)
      const up = new Map((data.updates || []).map((m) => [m.id, m]))
      setMsgs((old) => {
        const base = (fresh ? [] : old).map((m) => up.get(m.id) || m)
        const seen = new Set(base.map((m) => m.id))
        const add = data.messages.filter((m) => !seen.has(m.id))
        if (!fresh && add.length && skipRef.current) {       // paged back: stay on the same lines
          pages.current = pages.current.map((n) => (n ? n + add.length : 0))
          setSkip((n) => n + add.length)
        }
        return [...base, ...add]
      })
      const top = data.messages.length ? data.messages[data.messages.length - 1].id : null
      if (top) lastId.current = Math.max(fresh ? 0 : lastId.current, top)
      else if (fresh) lastId.current = 0
      if (fresh) noMore.current = data.messages.length < 80
      setErr('')
      return top
    } catch (e) {
      // A project room this account can no longer enter: back to the portal room.
      // …or one nobody has opened (404).
      if ([403, 404].includes(e?.response?.status) && room !== 'portal') setRoom('portal')
      else setErr(errText(e, tr('p_failed')))
      return null
    }
  }, [room])

  useEffect(() => { lastId.current = 0; noMore.current = false; pages.current = []; setSkip(0); setAt(null); setMsgs([]); load(true) }, [room]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    launcher.get('/chat/members', { params: { room } }).then((r) => setMembers(r.data)).catch(() => setMembers([]))
  }, [open, room])
  const atRe = useMemo(() => {
    const names = [...new Set([...members.flatMap((u) => [u.username, u.name]), 'agent', 'all'].filter(Boolean))]
    return new RegExp('(@(?:' + names.sort((a, b) => b.length - a.length).map(escRe).join('|') + ')(?![A-Za-z0-9_]))', 'gi')
  }, [members])
  useEffect(() => {
    const t = setInterval(() => load(false), open ? POLL_OPEN : POLL_SHUT)
    return () => clearInterval(t)
  }, [open, load])
  useEffect(() => {
    if (!open) return
    launcher.get('/chat/rooms').then((r) => setRooms(r.data)).catch(() => {})
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  // Unread is the account's (every room, any browser): asked now and then, and a room
  // open here is marked read up to its newest message.
  const askUnread = useCallback(() => launcher.get('/chat/unread').then((r) => setCounts(r.data)).catch(() => {}), [])
  useEffect(() => {
    askUnread()
    const t = setInterval(askUnread, POLL_SHUT)
    return () => clearInterval(t)
  }, [askUnread])
  useEffect(() => {
    const top = msgs.length ? msgs[msgs.length - 1].id : 0
    if (!open || !top || (readTop.current[room] || 0) >= top) return
    readTop.current[room] = top
    launcher.post('/chat/read', { room, id: top }).then(askUnread).catch(() => {})
  }, [msgs, open, room, askUnread])
  useEffect(() => { onUnread?.(counts.unread || 0, counts.mentions || 0) }, [counts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Only whole messages: from the newest up, as many as fit under the list's
  // height; the first that would be cut, and everything older, is not drawn.
  // (A scrolling list sliced the top message in half.)
  const fit = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const room = parseFloat(getComputedStyle(el).maxHeight) || window.innerHeight * 0.62
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0
    let used = 0, full = false, past = skipRef.current, n = 0
    for (const g of [...el.children].reverse()) {
      g.style.display = ''
      if (past > 0 || full) { past -= 1; g.style.display = 'none'; continue }   // paged past, or no room left
      const h = g.getBoundingClientRect().height + (used ? gap : 0)
      if (used + h > room) { full = true; g.style.display = 'none'; continue }
      used += h; n += 1
    }
    shown.current = n
    setMore(full || !noMore.current)
  }, [])
  // Threads, worked out from what is loaded: a reply belongs to the first message up its
  // reply chain (a deleted one, or one not loaded, ends the chain there). The room shows
  // the roots, each with how many replies it has; a thread shows its root and replies.
  // Deleted messages are not drawn at all.
  const live = useMemo(() => msgs.filter((m) => !m.deleted && m.id > cleared), [msgs, cleared])
  const rootOf = useMemo(() => {
    const by = new Map(live.map((m) => [m.id, m]))
    const memo = new Map()
    const up = (m) => {
      if (memo.has(m.id)) return memo.get(m.id)
      const p = m.reply_to_id && by.get(m.reply_to_id)
      const r = p ? up(p) : m.id
      memo.set(m.id, r)
      return r
    }
    return (m) => up(m)
  }, [live])
  const replies = useMemo(() => {
    const n = {}
    for (const m of live) { const r = rootOf(m); if (r !== m.id) n[r] = (n[r] || 0) + 1 }
    return n
  }, [live, rootOf])
  const roots = live.filter((m) => rootOf(m) === m.id)
  // The viewer's own lines go in after the message that was newest when they were made.
  const view = useMemo(() => {
    const out = [], ls = [...locals].sort((x, y) => x.after - y.after)
    let i = 0
    for (const m of roots) {
      while (i < ls.length && ls[i].after < m.id) out.push({ ...ls[i++], local: true })
      out.push(m)
    }
    while (i < ls.length) out.push({ ...ls[i++], local: true })
    return out
  }, [roots, locals]) // eslint-disable-line react-hooks/exhaustive-deps
  const threadLines = thread ? live.filter((m) => m.id === thread || rootOf(m) === thread) : []
  const openThread = (m) => { setThread(rootOf(m)); setReply(null); setTimeout(() => tInputRef.current?.focus(), 0) }
  useEffect(() => { setThread(null) }, [room])
  useLayoutEffect(() => { const el = tListRef.current; if (el) el.scrollTop = el.scrollHeight }, [thread, threadLines.length])

  useLayoutEffect(() => { fit() }, [msgs, open, fit, skip, locals, cleared])

  // The list does not scroll (see fit): older messages are a page back, fetched as needed.
  async function older() {
    const next = skip + Math.max(1, shown.current)
    let total = msgs.length
    if (total && total - next < 20 && !noMore.current) {
      try {
        const { data } = await launcher.get('/chat/messages', { params: { room, before: msgs[0].id } })
        if (!data.messages.length) noMore.current = true
        total += data.messages.length
        setMsgs((old) => [...data.messages.filter((m) => !old.some((o) => o.id === m.id)), ...old])
      } catch { /* stay where we are */ }
    }
    if (next >= total) { setMore(false); return }             // already at the room's first message
    pages.current.push(skip)
    setSkip(next)
  }
  const newer = () => setSkip(pages.current.pop() || 0)
  const newest = () => { pages.current = []; setSkip(0) }
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  // Sent here by a page (`lilak:chat`): that room, the input started for it.
  useEffect(() => {
    if (!go) return
    if (go.room && go.room !== room) setRoom(go.room)
    if (go.text) setText(go.text)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [go?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickRoom = (k) => {
    setPicking(false); setReply(null); setAdding(null); setNotice('')
    if (k === room) return
    setRoom(k)
    launcher.put('/account/prefs', { chatRoom: k }).catch(() => {})
  }

  async function openRoom(r) {
    try {
      const { data } = await launcher.post('/chat/rooms', { service: r.service, project: r.project })
      setRooms((all) => (all.some((x) => x.key === data.key) ? all : [...all, data]))
      setAdding(null)
      pickRoom(data.key)
    } catch (e) { setErr(errText(e, tr('p_failed'))) }
  }

  // The system room reads `/commands` before anything is sent: they work the
  // portal itself and are answered here, not stored.
  const findCard = (q) => {
    const w = q.trim().toLowerCase()
    return cards.find((c) => [c.label, c.name, c.project_card].some((x) => x && x.toLowerCase() === w))
      || cards.find((c) => [c.label, c.name].some((x) => x && x.toLowerCase().includes(w)))
  }
  async function command(line) {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    if (cmd === 'issue' || cmd === 'report') {
      // `/issue [bug|idea|ask|local] what happened…` → Issues, with what is attached; the
      // subject is the first line. It stays in this room's history, for this viewer.
      const r = parseReport(line)
      if (!r.body) return tr('pc_cmd_report_usage')
      try {
        await launcher.post('/reports', { kind: r.kind, subject: r.subject, body: r.body, attachments: atts })
        const n = atts.length
        setAtts([])
        addLocal(tr('pc_cmd_reported', tr('pc_kind_' + r.kind), r.subject) + (n ? ` · ${tr('pc_att_n', n)}` : ''))
        return ''
      } catch (e) { return errText(e, tr('p_failed')) }
    }
    if (cmd === 'todo') {
      if (!arg) return tr('pc_cmd_todo_usage')
      // The note project this account opens (its card's), else the service's main one.
      const c = cards.find((x) => x.name === 'note')
      const proj = c?.entry_project || c?.project_card || 'note'
      try {
        const title = await addTodo(proj, arg)
        addLocal(tr('pc_cmd_todo_done', title, arg))
        return ''
      } catch (e) { return tr('pc_cmd_todo_fail', String(e.message || e)) }
    }
    if (cmd in OPTS && cmd !== 'pos') {
      if (!OPTS[cmd].includes(arg)) return tr('pc_cmd_opts', cmd, OPTS[cmd].join(' | '))
      setLay((l) => ({ ...l, [cmd]: arg })); return ''
    }
    if (cmd === 'move') {
      if (!OPTS.pos.includes(arg)) return tr('pc_cmd_opts', 'move', OPTS.pos.join(' | '))
      setLay((l) => ({ ...l, pos: arg })); return ''
    }
    if (cmd === 'clear') {
      // The history, for this viewer: messages up to now and their own lines go from view.
      const top = msgs.length ? msgs[msgs.length - 1].id : 0
      store.set('lilak-chat-cleared:' + room, top); setCleared(top)
      store.set('lilak-chat-local:' + room, []); setLocals([])
      return ''
    }
    if (cmd === 'open' && arg) {
      const c = findCard(arg)
      if (!c) return tr('pc_cmd_nocard', arg)
      onOpenCard?.(c)
      return tr('pc_cmd_opened', c.label || c.name)
    }
    if (cmd === 'room' && arg) {
      const w = arg.toLowerCase()
      const r = rooms.find((x) => roomLabel(x.key).toLowerCase().includes(w) || x.key.toLowerCase().includes(w))
      if (!r) return tr('pc_cmd_noroom', arg)
      pickRoom(r.key)
      return tr('pc_cmd_room', roomLabel(r.key))
    }
    return CMDS.map((c) => `/${c.name} — ${tr('pc_cmd_d_' + c.name)}`).join('\n')
  }

  async function send() {
    if (busy || (!text.trim() && !atts.length)) return
    // A /command, in any room: worked here, never sent as a message.
    if (text.trim().startsWith('/')) {
      const line = text.trim()
      setText(''); setAt(null)
      setNotice(await command(line))
      return
    }
    setNotice('')
    setBusy(true)
    try {
      const { data } = await launcher.post('/chat/messages', { room, body: text, reply_to_id: reply?.id || null, attachments: atts })
      setText(''); setAtts([]); setReply(null); setErr(''); setAt(null); newest()
      lastId.current = Math.max(lastId.current, data.id - 1)
      await load(false)
    } catch (e) { setErr(errText(e, tr('p_failed'))) } finally { setBusy(false) }
  }
  async function sendThread() {
    if (busy || !tText.trim() || !thread) return
    setBusy(true)
    try {
      await launcher.post('/chat/messages', { room, body: tText, reply_to_id: thread, attachments: [] })
      setTText(''); setErr('')
      await load(false)
    } catch (e) { setErr(errText(e, tr('p_failed'))) } finally { setBusy(false) }
  }
  async function addFiles(files) {
    for (const f of files) {
      const fd = new FormData(); fd.append('file', f)
      try { const { data } = await launcher.post('/chat/upload', fd); setAtts((a) => [...a, data]) }
      catch (e) { setErr(errText(e, tr('p_failed'))) }
    }
  }
  async function del(m) {
    try { await launcher.delete(`/chat/messages/${m.id}`); setMsgs((all) => all.map((x) => (x.id === m.id ? { ...x, deleted: true, body: '', attachments: [] } : x))) }
    catch (e) { setErr(errText(e, tr('p_failed'))) }
  }

  // @ completion: the room's members (and agent / all where they mean something).
  const onText = (e) => {
    const v = e.target.value
    setText(v)
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, e.target.selectionStart))
    setAt(m ? { from: e.target.selectionStart - m[2].length - 1, q: m[2].toLowerCase(), i: 0 } : null)
  }
  const picks = !at ? [] : [
    ...members.filter((u) => u.id !== me?.id).map((u) => ({ key: u.username, label: u.name, u })),
    ...(room !== 'portal' && room !== 'system' ? [{ key: 'agent', label: tr('pc_at_agent') }] : []),
    ...(me?.admin ? [{ key: 'all', label: tr('pc_at_all') }] : []),
  ].filter((p) => p.key.toLowerCase().includes(at.q) || p.label.toLowerCase().includes(at.q)).slice(0, 6)
  const pick = (p) => {
    const el = inputRef.current
    const head = text.slice(0, at.from) + '@' + p.key + ' '
    setText(head + text.slice(el?.selectionStart ?? text.length)); setAt(null)
    setTimeout(() => { el?.focus(); el?.setSelectionRange(head.length, head.length) }, 0)
  }

  // While a /command is typed: the commands (or its options) that fit, and for /report what
  // will be sent — so it is plain before Enter whether the command is right.
  const cmdPicks = useMemo(() => {
    const t = text
    if (!t.startsWith('/') || t.includes('\n')) return []
    const m = /^\/(\S*)(\s+(\S*))?$/.exec(t)
    if (!m) return []
    if (m[2] === undefined) return CMDS.filter((c) => c.name.startsWith(m[1].toLowerCase()))
      .map((c) => ({ key: c.name, fill: '/' + c.name + (c.opts || c.more ? ' ' : ''), label: tr('pc_cmd_d_' + c.name) }))
    const c = CMDS.find((x) => x.name === m[1].toLowerCase())
    return (c?.opts || []).filter((o) => o.startsWith((m[3] || '').toLowerCase()) && o !== m[3])
      .map((o) => ({ key: `${c.name} ${o}`, fill: `/${c.name} ${o}${c.more ? ' ' : ''}`, label: tr(`pc_opt_${c.name}_${o}`) }))
  }, [text])
  useEffect(() => { setCmdI(0) }, [cmdPicks.length])
  const reportPreview = /^\/(issue|report)\s+\S/.test(text) ? parseReport(text) : null
  const fill = (p) => { setText(p.fill); setTimeout(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(p.fill.length, p.fill.length) }, 0) }

  const onKey = (e) => {
    if (cmdPicks.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); setCmdI((i) => (i + (e.key === 'ArrowDown' ? 1 : cmdPicks.length - 1)) % cmdPicks.length); return
      }
      const p = cmdPicks[Math.min(cmdI, cmdPicks.length - 1)]
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && p.fill.trim() !== text.trim())) { e.preventDefault(); fill(p); return }
    }
    if (picks.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setAt((a) => ({ ...a, i: (a.i + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(picks[Math.min(at.i, picks.length - 1)]); return }
    }
    if (e.key === 'PageUp') { e.preventDefault(); older(); return }
    if (e.key === 'PageDown') { e.preventDefault(); newer(); return }
    if (e.key === 'Escape') {
      // Ours, not the portal's: the portal would read it as command mode.
      e.preventDefault(); e.stopPropagation()
      if (cmdPicks.length && text.length > 1) setText('/'); else if (at) setAt(null); else if (picking) setPicking(false); else if (reply) setReply(null); else if (thread) setThread(null); else onClose?.()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  // One message as a strip (C4). `inThread`: drawn in the thread beside the chat.
  const strip = (m, inThread) => {
    // A line written by a program for its owner (an MCP token, e.g. Claude answering
    // @claude) is drawn as that program, not as the person.
    const col = m.via ? '#7f77dd' : colourOf(m)
    return (
      <div key={m.id} className="pc-group">
        <div className={`pc-line${m.user_id === me?.id ? ' mine' : ''}${m.user_id !== me?.id && (m.mentions || []).some((x) => x === 0 || x === me?.id) ? ' at-me' : ''}`} style={{ '--pc-col': col }}>
          {m.via
            ? <span className="pc-dot" title={tr('pc_via', m.via, m.author_name)}><Icon name="robot" size={9} color="#fff" /></span>
            : <Avatar icon={m.author_shape} color={col} seed={m.author_username || m.author_name} size={14} />}
          <b className="pc-name" title={m.via ? tr('pc_via', m.via, m.author_name) : undefined}>{m.via || m.author_name}</b>
          <div className="pc-body">
            {m.reply_to_id && !inThread && rootOf(m) === m.id && <span className="pc-quote">↳ {m.reply_to_author}: {m.reply_to_body || '…'}</span>}
            <span className="pc-text"><Body text={m.body} re={atRe} /></span>
            {(m.attachments || []).length > 0 && <div className="pc-atts">{m.attachments.map((a) => <Att key={a.id} a={a} room={room} />)}</div>}
            {!inThread && replies[m.id] > 0 && (
              <button type="button" className={`pc-thread${thread === m.id ? ' on' : ''}`} onClick={() => (thread === m.id ? setThread(null) : openThread(m))}>
                <Icon name="chats" size={11} /> {tr('pc_replies', replies[m.id])}
              </button>
            )}
          </div>
          {/* Time and the actions share one slot: on hover the icons take the
              time's place, so nothing in the line moves or widens. */}
          <span className="pc-side">
            <span className="pc-time">{timeOf(m.created_at)}</span>
            <span className="pc-acts">
              {!inThread && (
                <button type="button" title={tr('pc_reply')} aria-label={tr('pc_reply')} onClick={() => openThread(m)}><Icon name="reply" size={13} /></button>
              )}
              {(m.user_id === me?.id || me?.admin) && (
                <button type="button" title={tr('pc_delete')} aria-label={tr('pc_delete')} onClick={() => del(m)}><Icon name="trash" size={13} /></button>
              )}
            </span>
          </span>
        </div>
        {m.run && (
          <div className={`pc-line pc-agent ${m.run.status}`}>
            <span className="pc-dot"><Icon name="robot" size={9} color="#fff" /></span>
            <b className="pc-name">agent</b>
            <div className="pc-body"><span className="pc-text">{m.run.result || '…'}</span></div>
            <span className="pc-side"><span className="pc-time">{tr('pc_run_' + m.run.status)}</span></span>
          </div>
        )}
      </div>
    )
  }

  // Files dropped anywhere on the chat are attached, as the clip button does.
  const dropProps = {
    onDragOver: (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDropping(true) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false) },
    onDrop: (e) => { e.preventDefault(); setDropping(false); const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f) },
  }

  if (!open) return null
  return (
    <div className={`pc-wrap pc-at-${lay.pos} pc-size-${lay.size} pc-h-${lay.height}${dropping ? ' dropping' : ''}`} onKeyDown={onKey} {...dropProps}>
    <div className="pc-root">
      <div className="pc-list" ref={listRef}>
        {view.length === 0 && <div className="pc-line pc-empty">{tr('pc_empty', roomLabel(room))}</div>}
        {view.map((m) => (m.local
          ? <div key={m.id} className="pc-group"><div className="pc-line pc-local"><Icon name="info" size={12} /><span className="pc-text">{m.text}</span><span className="pc-side"><span className="pc-time">{m.time}</span></span></div></div>
          : strip(m, false)))}
      </div>
      <div className="pc-input">
        <div className="pc-bar">
          <button type="button" className="pc-room" onClick={() => setPicking((p) => !p)} title={tr('pc_room_pick')}>
            {roomLabel(room)} <Icon name="caret-down" size={10} />
            {Object.keys(counts.rooms || {}).some((k) => k !== room) && <i className="pc-dot2" />}
          </button>
          {more && (
            <button type="button" className="pc-room" onClick={older} title="PageUp">↑ {tr('pc_older')}</button>
          )}
          {skip > 0 && <button type="button" className="pc-room" onClick={newest}>↓ {tr('pc_newest')}</button>}
          <span className="pc-hint">{tr('pc_hint')}</span>
        </div>
        {picking && (
          <div className="pc-rooms" role="listbox">
            {(rooms.length ? rooms : [{ key: 'portal' }]).map((r) => (
              <button key={r.key} type="button" role="option" aria-selected={r.key === room}
                className={r.key === room ? 'on' : ''} onClick={() => pickRoom(r.key)}>
                {r.key === 'portal' ? tr('pc_room_all') : r.key === 'system' ? tr('pc_room_system') : <><span className="svc">{r.service_label}</span> {r.label}</>}
                {counts.rooms?.[r.key] && r.key !== room && (
                  <b className="pc-n">{counts.rooms[r.key].mentions ? `@${counts.rooms[r.key].mentions} ` : ''}{counts.rooms[r.key].unread || ''}</b>
                )}
              </button>
            ))}
            {/* A project's room is there once someone opens it. */}
            <button type="button" className="pc-add" onClick={() => (adding ? setAdding(null)
              : launcher.get('/chat/rooms/new').then((r) => setAdding(r.data)).catch((e) => setErr(errText(e, tr('p_failed')))))}>
              <Icon name="plus" size={11} /> {tr('pc_room_open')}
            </button>
            {adding && (adding.length ? adding.map((r) => (
              <button key={r.key} type="button" className="pc-new" onClick={() => openRoom(r)}>
                <span className="svc">{r.service_label}</span> {r.label}
              </button>
            )) : <span className="pc-new pc-none">{tr('pc_room_none')}</span>)}
          </div>
        )}
        {picks.length > 0 && (
          <div className="pc-rooms" role="listbox">
            {picks.map((p, i) => (
              <button key={p.key} type="button" role="option" aria-selected={i === at.i} className={i === at.i ? 'on' : ''}
                onMouseDown={(e) => { e.preventDefault(); pick(p) }}>
                {p.u && <Avatar icon={p.u.shape} color={p.u.admin ? MANAGER_COLOR : (p.u.color || avatarFor(p.u.username).profile_color)} seed={p.u.username} size={14} />}
                {' '}<b>@{p.key}</b> {p.label !== p.key && <span className="svc">{p.label}</span>}
              </button>
            ))}
          </div>
        )}
        {cmdPicks.length > 0 && (
          <div className="pc-rooms pc-cmds" role="listbox">
            {cmdPicks.map((p, i) => (
              <button key={p.key} type="button" role="option" aria-selected={i === cmdI} className={i === cmdI ? 'on' : ''}
                onMouseDown={(e) => { e.preventDefault(); fill(p) }}>
                <b>/{p.key}</b> <span className="svc">{p.label}</span>
              </button>
            ))}
          </div>
        )}
        {reportPreview && (
          <div className="pc-preview">
            {reportPreview.body
              ? tr('pc_report_preview', tr('pc_kind_' + reportPreview.kind), reportPreview.subject, atts.length)
              : tr('pc_cmd_report_usage')}
          </div>
        )}
        {notice && <div className="pc-notice">{notice}</div>}
        {reply && <div className="pc-quote">{tr('pc_replying', reply.author_name)}: {reply.body.slice(0, 80)} <button type="button" onClick={() => setReply(null)}><Icon name="x" size={10} /></button></div>}
        {atts.length > 0 && (
          <div className="pc-atts">{atts.map((a) => (
            <span key={a.id} className="pc-file">{a.name}<button type="button" onClick={() => setAtts((all) => all.filter((x) => x.id !== a.id))}><Icon name="x" size={10} /></button></span>
          ))}</div>
        )}
        <div className="pc-row">
          <textarea ref={inputRef} rows={1} value={text} onChange={onText}
            onPaste={(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f) } }}
            placeholder={room === 'portal' ? tr('pc_ph_all') : room === 'system' ? tr('pc_ph_system') : tr('pc_ph_project')} />
          <button type="button" className="pc-icon" onClick={() => fileRef.current?.click()} title={tr('pc_attach')}><Icon name="attach" size={14} /></button>
          <button type="button" className="pc-icon" disabled={busy} onClick={send} title={tr('pc_send')}><Icon name="send" size={14} /></button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = '' }} />
        </div>
        {err && <div className="pc-err">{err}</div>}
      </div>
    </div>
    {thread && (
      <div className="pc-tpanel">
        <div className="pc-bar">
          <b className="pc-tt"><Icon name="chats" size={12} /> {tr('pc_thread')}</b>
          <button type="button" className="pc-room" onClick={() => setThread(null)} title="Esc">× {tr('pc_thread_close')}</button>
        </div>
        <div className="pc-tlist" ref={tListRef}>{threadLines.map((m) => strip(m, true))}</div>
        <div className="pc-row">
          <textarea ref={tInputRef} rows={1} value={tText} onChange={(e) => setTText(e.target.value)} placeholder={tr('pc_thread_ph')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); sendThread() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setThread(null); inputRef.current?.focus() }
            }} />
          <button type="button" className="pc-icon" disabled={busy} onClick={sendThread} title={tr('pc_send')}><Icon name="send" size={14} /></button>
        </div>
      </div>
    )}
    </div>
  )
}
