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
 * Open: Esc (command mode) then Enter. Close: Esc.
 */
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

export default function PortalChat({ open, onClose, user, onUnread, go }) {
  const [room, setRoom] = useState(() => {
    try { return JSON.parse(user?.preferences_json || '{}').chatRoom || 'portal' } catch { return 'portal' }
  })
  const [rooms, setRooms] = useState([])
  const [picking, setPicking] = useState(false)
  const [msgs, setMsgs] = useState([])
  const [me, setMe] = useState(null)
  const [text, setText] = useState('')
  const [reply, setReply] = useState(null)
  const [atts, setAtts] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
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

  const roomLabel = (k) => {
    if (k === 'portal') return tr('pc_room_all')
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
      if (e?.response?.status === 403 && room !== 'portal') setRoom('portal')
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
  useLayoutEffect(() => { fit() }, [msgs, open, fit, skip])

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
    setPicking(false); setReply(null)
    if (k === room) return
    setRoom(k)
    launcher.put('/account/prefs', { chatRoom: k }).catch(() => {})
  }

  async function send() {
    if (busy || (!text.trim() && !atts.length)) return
    setBusy(true)
    try {
      const { data } = await launcher.post('/chat/messages', { room, body: text, reply_to_id: reply?.id || null, attachments: atts })
      setText(''); setAtts([]); setReply(null); setErr(''); setAt(null); newest()
      lastId.current = Math.max(lastId.current, data.id - 1)
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
    ...(room !== 'portal' ? [{ key: 'agent', label: tr('pc_at_agent') }] : []),
    ...(me?.admin ? [{ key: 'all', label: tr('pc_at_all') }] : []),
  ].filter((p) => p.key.toLowerCase().includes(at.q) || p.label.toLowerCase().includes(at.q)).slice(0, 6)
  const pick = (p) => {
    const el = inputRef.current
    const head = text.slice(0, at.from) + '@' + p.key + ' '
    setText(head + text.slice(el?.selectionStart ?? text.length)); setAt(null)
    setTimeout(() => { el?.focus(); el?.setSelectionRange(head.length, head.length) }, 0)
  }

  const onKey = (e) => {
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
      if (at) setAt(null); else if (picking) setPicking(false); else if (reply) setReply(null); else onClose?.()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  if (!open) return null
  return (
    <div className="pc-root" onKeyDown={onKey}>
      <div className="pc-list" ref={listRef}>
        {msgs.length === 0 && <div className="pc-line pc-empty">{tr('pc_empty', roomLabel(room))}</div>}
        {msgs.map((m) => {
          const col = colourOf(m)
          return (
            <div key={m.id} className="pc-group">
              <div className={`pc-line${m.user_id === me?.id ? ' mine' : ''}${m.user_id !== me?.id && (m.mentions || []).some((x) => x === 0 || x === me?.id) ? ' at-me' : ''}`} style={{ '--pc-col': col }}>
                {/* The author's own account icon, small: the one on their account card. */}
                <Avatar icon={m.author_shape} color={col} seed={m.author_username || m.author_name} size={14} />
                <b className="pc-name">{m.author_name}</b>
                <div className="pc-body">
                  {m.reply_to_id && <span className="pc-quote">↳ {m.reply_to_author}: {m.reply_to_body || '…'}</span>}
                  {m.deleted ? <i className="pc-gone">{tr('pc_deleted')}</i> : <span className="pc-text"><Body text={m.body} re={atRe} /></span>}
                  {(m.attachments || []).length > 0 && <div className="pc-atts">{m.attachments.map((a) => <Att key={a.id} a={a} room={room} />)}</div>}
                </div>
                {/* Time and the actions share one slot: on hover the icons take the
                    time's place, so nothing in the line moves or widens. */}
                <span className="pc-side">
                  <span className="pc-time">{timeOf(m.created_at)}</span>
                  {!m.deleted && (
                    <span className="pc-acts">
                      <button type="button" title={tr('pc_reply')} aria-label={tr('pc_reply')}
                        onClick={() => { setReply(m); inputRef.current?.focus() }}><Icon name="reply" size={13} /></button>
                      {(m.user_id === me?.id || me?.admin) && (
                        <button type="button" title={tr('pc_delete')} aria-label={tr('pc_delete')} onClick={() => del(m)}><Icon name="trash" size={13} /></button>
                      )}
                    </span>
                  )}
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
        })}
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
                {r.key === 'portal' ? tr('pc_room_all') : <><span className="svc">{r.service_label}</span> {r.label}</>}
                {counts.rooms?.[r.key] && r.key !== room && (
                  <b className="pc-n">{counts.rooms[r.key].mentions ? `@${counts.rooms[r.key].mentions} ` : ''}{counts.rooms[r.key].unread || ''}</b>
                )}
              </button>
            ))}
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
        {reply && <div className="pc-quote">{tr('pc_replying', reply.author_name)}: {reply.body.slice(0, 80)} <button type="button" onClick={() => setReply(null)}><Icon name="x" size={10} /></button></div>}
        {atts.length > 0 && (
          <div className="pc-atts">{atts.map((a) => (
            <span key={a.id} className="pc-file">{a.name}<button type="button" onClick={() => setAtts((all) => all.filter((x) => x.id !== a.id))}><Icon name="x" size={10} /></button></span>
          ))}</div>
        )}
        <div className="pc-row">
          <textarea ref={inputRef} rows={1} value={text} onChange={onText}
            onPaste={(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f) } }}
            placeholder={room === 'portal' ? tr('pc_ph_all') : tr('pc_ph_project')} />
          <button type="button" className="pc-icon" onClick={() => fileRef.current?.click()} title={tr('pc_attach')}><Icon name="attach" size={14} /></button>
          <button type="button" className="pc-icon" disabled={busy} onClick={send} title={tr('pc_send')}><Icon name="send" size={14} /></button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = '' }} />
        </div>
        {err && <div className="pc-err">{err}</div>}
      </div>
    </div>
  )
}
