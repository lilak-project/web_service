import { useCallback, useEffect, useState } from 'react'
import { Button, Icon, Markdown, tr } from 'lilak-ui'
import Select from 'lilak-ui/components/Select.jsx'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ExpandBox from './ExpandBox'
import { Panel, Row, Pill, fieldInput } from './Field'
import { notify } from './settingsMsg'

/** Issues with something new for this person since they last opened the Issues page: an issue, a comment
 *  or an event by someone else, newer than the newest one seen then. Read each minute and when seen.
 *  ponytail: "seen" is kept in this browser (localStorage), so another device counts again; move it to the
 *  account's prefs if that matters. */
const SEEN = (u) => `lilak-issues-seen:${u}`
const SEEN_EV = 'lilak:issues-seen'
const stamps = (r, me) => [{ t: r.created_at, mine: r.mine }, ...(r.comments || []).map((c) => ({ t: c.created_at, mine: c.mine })),
  ...(r.events || []).map((e) => ({ t: e.created_at, mine: e.actor === me }))].filter((x) => x.t)
const newest = (rows, me) => rows.flatMap((r) => stamps(r, me)).reduce((m, x) => (x.t > m ? x.t : m), '')
function seenGet(me) { try { return localStorage.getItem(SEEN(me)) } catch { return null } }
function seenSet(me, t) { try { localStorage.setItem(SEEN(me), t) } catch { /* private window */ } window.dispatchEvent(new Event(SEEN_EV)) }
export function useIssues(me, isManager) {
  const [n, setN] = useState(0)
  const read = useCallback(async () => {
    if (!me || document.visibilityState !== 'visible') return
    try {
      const rows = (await launcher.get(isManager ? '/admin/reports' : '/reports/mine')).data || []
      const seen = seenGet(me)
      if (seen == null) { seenSet(me, newest(rows, me)); return }     // first time: what is there now counts as seen
      setN(rows.filter((r) => stamps(r, me).some((x) => !x.mine && x.t > seen)).length)
    } catch { /* signed out or offline: keep the last count */ }
  }, [me, isManager])
  useEffect(() => {
    read()
    const timer = setInterval(read, 60 * 1000)
    window.addEventListener(SEEN_EV, read)
    document.addEventListener('visibilitychange', read)
    return () => { clearInterval(timer); window.removeEventListener(SEEN_EV, read); document.removeEventListener('visibilitychange', read) }
  }, [read])
  return n
}

/** The files sent with a report (a chat `/report` with a picture): pictures shown,
 *  others a link — fetched with the session, as the file route asks for it. */
function ReportFiles({ r }) {
  const [urls, setUrls] = useState({})
  useEffect(() => {
    const made = []
    let alive = true
    for (const a of r.attachments || []) {
      launcher.get(`/reports/${r.id}/files/${a.id}`, { responseType: 'blob' })
        .then((res) => { if (!alive) return; const u = URL.createObjectURL(res.data); made.push(u); setUrls((m) => ({ ...m, [a.id]: u })) })
        .catch(() => {})
    }
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)) }
  }, [r.id, (r.attachments || []).length])
  if (!(r.attachments || []).length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {r.attachments.map((a) => (/^image\//.test(a.type || '') && urls[a.id]
        ? <a key={a.id} href={urls[a.id]} target="_blank" rel="noreferrer"><img src={urls[a.id]} alt={a.name} style={{ maxWidth: 240, maxHeight: 160, border: '1px solid var(--dock-border-default)' }} /></a>
        : <a key={a.id} href={urls[a.id]} download={a.name}><Icon name="attach" size={12} /> {a.name}</a>))}
    </div>
  )
}

/**
 * FeedbackView — the portal's issues, shaped like GitHub's so they travel 1:1 (routers/issues.py):
 * an Open / Closed list with search and label filters; each issue a Markdown body and a timeline of
 * comments and events (closed as completed / not planned, reopened, labeled, renamed). Writers edit
 * what they wrote; an admin closes, reopens, labels and deletes. `#n` in a text links to issue n
 * (its GitHub number). Rows reuse the shared ExpandBox so they match the other boxes.
 */
const KIND = {
  bug:            { icon: 'warning-circle', color: '#dc2626', ko: '버그 신고', en: 'Bug' },
  recommendation: { icon: 'lightbulb',      color: '#ca8a04', ko: '제안',      en: 'Recommendation' },
  inquiry:        { icon: 'chats',          color: '#2563eb', ko: '문의',      en: 'Inquiry' },
  local:          { icon: 'home',           color: '#64748b', ko: '이 서버만',  en: 'Local only' } }
const input = fieldInput
const textarea = { ...fieldInput, width: '100%', height: 'auto', minHeight: 0, padding: '9px 10px', resize: 'vertical', lineHeight: 1.5 }
const small = { fontSize: 12, color: 'var(--dock-text-secondary)' }
const isExt = (r) => r.origin === 'github'   // opened on GitHub, no account here
const refs = (s) => (s || '').replace(/(^|[\s(])#(\d+)\b/g, '$1[#$2](#issue-$2)')   // #n → a link to issue n

export default function FeedbackView({ isManager, folded = false, me = '' }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [f, setF] = useState({ kind: 'inquiry', subject: '', body: '' })
  const [rows, setRows] = useState([])
  const [open, setOpen] = useState(null)
  const [tab, setTab] = useState('open')
  const [q, setQ] = useState('')
  const [label, setLabel] = useState('')
  const [author, setAuthor] = useState('')
  const [pad, setPad] = useState(0)   // room under the list, only while an opened issue needs it to reach the top
  const [ext, setExt] = useState('all')   // where it was opened: all | external (GitHub) | here
  const [drafts, setDrafts] = useState({})   // report id -> comment being written
  const [editing, setEditing] = useState(null)   // {rid, cid?, subject?, body}
  const [newLabel, setNewLabel] = useState({})   // report id -> label being typed

  async function load() {
    try {
      const d = (await launcher.get(isManager ? '/admin/reports' : '/reports/mine')).data
      setRows(d)
      if (me) { const t = newest(d, me); if (t && t !== seenGet(me)) seenSet(me, t) }   // opened here: all of it is seen
    }
    catch (e) { notify(e?.response?.data?.detail || 'load failed', 'bad') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // An issue opened (by its row or a #n link) moves up to the top of the page.
  useEffect(() => {
    if (open == null) { setPad(0); return }
    let id = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-issue="${open}"]`)
      if (!el) return
      let sc = el.parentElement   // the box that scrolls
      while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement   // even one with nothing to scroll yet
      sc = sc || document.scrollingElement
      const need = el.getBoundingClientRect().top - (sc === document.scrollingElement ? 0 : sc.getBoundingClientRect().top) - 12
      setPad(Math.max(0, Math.ceil(need - (sc.scrollHeight - sc.clientHeight - sc.scrollTop))))
      id = requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    })
    return () => cancelAnimationFrame(id)
  }, [open, tab])
  async function run(p, ok) { try { const r = await p; if (ok) notify(ok(r), 'ok'); await load(); return true } catch (e) { notify(e?.response?.data?.detail || tr("p_failed"), 'bad'); return false } }

  const submit = () => {
    if (!f.subject.trim() && !f.body.trim()) { notify(tr("p_write_something_first"), 'bad'); return }
    run(launcher.post('/reports', f), () => { setF({ kind: 'inquiry', subject: '', body: '' }); return tr("p_sent_thank_you") })
  }
  const sendComment = (r) => {
    if (!(drafts[r.id] || '').trim()) return
    run(launcher.post(`/reports/${r.id}/comments`, { body: drafts[r.id] }), () => { setDrafts((d) => ({ ...d, [r.id]: '' })); return L('댓글을 남겼습니다', 'Comment added') })
  }
  const close = (r, reason) => run(launcher.post(`/admin/reports/${r.id}/resolve`, { resolved: true, reason }), () => L('닫았습니다', 'Closed'))
  const reopen = (r) => run(launcher.post(`/admin/reports/${r.id}/resolve`, { resolved: false }), () => tr("p_reopened"))
  const setLabels = (r, labels) => run(launcher.put(`/admin/reports/${r.id}/labels`, { labels }))
  const del = (r) => { if (window.confirm(tr("p_delete_this_report"))) run(launcher.delete(`/admin/reports/${r.id}`), () => tr("p_deleted")) }
  const delComment = (r, c) => { if (window.confirm(L('이 댓글을 지울까요?', 'Delete this comment?'))) run(launcher.delete(`/reports/${r.id}/comments/${c.id}`)) }
  const saveEdit = async () => {
    const e = editing
    const p = e.cid ? launcher.put(`/reports/${e.rid}/comments/${e.cid}`, { body: e.body })
      : launcher.put(`/reports/${e.rid}`, { subject: e.subject, body: e.body })
    if (await run(p)) setEditing(null)
  }

  const fmt = (iso) => { try { return new Date(iso + (/[zZ+]/.test(iso.slice(19)) ? '' : 'Z')).toLocaleString() } catch { return iso } }
  const km = (k) => KIND[k] || KIND.inquiry
  const num = (r) => (r.number ? `#${r.number}` : `P${r.id}`)
  const jump = (e) => {   // a #n link inside a text
    const a = e.target.closest?.('a[href^="#issue-"]')
    if (!a) return
    e.preventDefault()
    const t = rows.find((x) => String(x.number) === a.getAttribute('href').slice(7))
    if (t) { setTab(t.status === 'resolved' ? 'closed' : 'open'); setOpen(t.id) }
    else notify(L('이 포털에 없는 이슈입니다', 'Not an issue on this portal'), 'bad')
  }
  const md = (text) => <div onClick={jump} style={{ minWidth: 0 }}><Markdown>{refs(text) || '—'}</Markdown></div>
  const labelPill = (x, onX) => {
    const k = KIND[x]
    return (
      <span key={x} className="set-pill" style={{ color: k?.color, cursor: onX ? 'default' : 'pointer' }}
        onClick={onX ? undefined : (e) => { e.stopPropagation(); setLabel(label === x ? '' : x) }}>
        {k ? L(k.ko, k.en) : x}
        {onX && <span role="button" tabIndex={0} onClick={onX} onKeyDown={(e) => { if (e.key === 'Enter') onX() }} aria-label="remove" style={{ cursor: 'pointer', paddingLeft: 5 }}>×</span>}
      </span>)
  }
  const statusBadge = (r) => r.status === 'resolved'
    ? <Pill tone={r.state_reason === 'not_planned' ? undefined : 'ok'}>{r.state_reason === 'not_planned' ? L('닫힘 · 안 함', 'Closed · not planned') : L('닫힘 · 완료', 'Closed · completed')}</Pill>
    : <Pill tone="warn">{L('열림', 'Open')}</Pill>
  const eventText = (e) => ({
    closed: e.detail === 'not_planned' ? L('안 하기로 하고 닫음', 'closed this as not planned') : L('완료로 닫음', 'closed this as completed'),
    reopened: L('다시 엶', 'reopened this'),
    labeled: L(`라벨 ${e.detail} 붙임`, `added the ${e.detail} label`),
    unlabeled: L(`라벨 ${e.detail} 뗌`, `removed the ${e.detail} label`),
    renamed: L(`제목을 바꿈 (전: ${e.detail})`, `changed the title (was: ${e.detail})`),
  }[e.kind] || e.kind)

  const editor = (rows_ = 4) => (
    <>
      {editing.cid == null && <input value={editing.subject} onChange={(e) => setEditing((s) => ({ ...s, subject: e.target.value }))} style={{ ...input, width: '100%' }} />}
      <textarea value={editing.body} onChange={(e) => setEditing((s) => ({ ...s, body: e.target.value }))} rows={rows_} style={textarea} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit() }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <Button variant="primary" onClick={saveEdit}>{L('저장', 'Save')}</Button>
        <Button variant="ghost" onClick={() => setEditing(null)}>{L('취소', 'Cancel')}</Button>
      </div>
    </>)

  const item = (r) => {
    const m = km(r.kind)
    const timeline = [...(r.comments || []).map((c) => ({ ...c, t: 'c' })), ...(r.events || []).map((e) => ({ ...e, t: 'e' }))]
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    const editingIssue = editing && editing.rid === r.id && editing.cid == null
    return (
      <ExpandBox key={r.id} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}
        outerProps={{ className: open === r.id ? 'on' : undefined, 'data-issue': r.id }}
        style={{ opacity: r.status === 'resolved' ? 0.72 : 1, scrollMarginTop: 12 }}
        icon={<Icon name={m.icon} size={22} color={m.color} weight="duotone" />}
        title={<><span style={{ color: 'var(--dock-text-secondary)' }}>{num(r)}</span> {r.subject || tr("p_no_subject")}</>}
        badges={<>{isExt(r) && <span className="set-pill" title={L('GitHub에서 연 이슈', 'Opened on GitHub')}><Icon name="github-logo" size={12} /> {L('외부', 'external')}</span>}{(r.labels || []).map((x) => labelPill(x))}{statusBadge(r)}</>}
        subtitle={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
          {r.username}{r.origin ? ` (${r.origin})` : ''} · {fmt(r.created_at)}
          {(r.comments || []).length > 0 && <> · <Icon name="chat-circle" size={13} /> {r.comments.length}</>}</span>}
      >
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={small}>
            <a href="#" title={L('이 작성자만 보기', 'Only this author')} onClick={(e) => { e.preventDefault(); setAuthor(author === r.username ? '' : r.username) }}>{r.username}</a>{r.origin ? ` (${r.origin})` : ''} · {fmt(r.created_at)}{r.edited_at ? ` · ${L('수정됨', 'edited')}` : ''}
            {r.upstream && <> · <a href={r.upstream.url} target="_blank" rel="noreferrer">
              <Icon name={r.upstream.where === 'github' ? 'github-logo' : 'link'} size={12} /> {r.upstream.where} #{r.upstream.id}</a></>}
            {(r.mine || isManager) && !editingIssue &&
              <> · <a href="#" onClick={(e) => { e.preventDefault(); setEditing({ rid: r.id, subject: r.subject, body: r.body }) }}>{L('수정', 'Edit')}</a></>}
          </div>
          {editingIssue ? editor(6) : md(r.body)}
          <ReportFiles r={r} />

          {timeline.map((x) => x.t === 'e'
            ? <div key={`e${x.created_at}${x.kind}${x.detail}`} style={{ ...small, paddingLeft: 10, borderLeft: '2px solid var(--dock-border-subtle)' }}>
                <b>{x.actor}</b> {eventText(x)} · {fmt(x.created_at)}</div>
            : <div key={`c${x.id}`} style={{ borderTop: '1px solid var(--dock-border-subtle)', paddingTop: 8 }}>
                <div style={small}>
                  {x.origin === 'github' ? <><Icon name="github-logo" size={12} /> {x.author}</> : x.author}
                  {x.origin && x.origin !== 'github' ? ` · ${x.origin}` : ''} · {fmt(x.created_at)}{x.edited_at ? ` · ${L('수정됨', 'edited')}` : ''}
                  {x.mine && !(editing && editing.cid === x.id) && <> · <a href="#" onClick={(e) => { e.preventDefault(); setEditing({ rid: r.id, cid: x.id, body: x.body }) }}>{L('수정', 'Edit')}</a></>}
                  {(x.mine || isManager) && <> · <a href="#" onClick={(e) => { e.preventDefault(); delComment(r, x) }}>{L('삭제', 'Delete')}</a></>}
                </div>
                {editing && editing.cid === x.id ? editor(3) : md(x.body)}
              </div>)}

          <textarea value={drafts[r.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
            rows={2} placeholder={L('댓글 (Markdown, #번호로 다른 이슈, ⌘↵ 보내기)', 'Comment (Markdown, #n for another issue, ⌘↵ sends)')} style={textarea}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendComment(r) }} />
          <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--dock-border-subtle)', paddingTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="secondary" onClick={() => sendComment(r)}>{L('댓글 달기', 'Comment')}</Button>
            {isManager && (r.status === 'resolved'
              ? <Button variant="ghost" onClick={() => reopen(r)}>{tr("p_reopen")}</Button>
              : <>
                  <Button variant="primary" onClick={() => close(r, 'completed')}>{L('완료로 닫기', 'Close as completed')}</Button>
                  <Button variant="ghost" onClick={() => close(r, 'not_planned')}>{L('안 함으로 닫기', 'Close as not planned')}</Button>
                </>)}
            <div style={{ flex: 1 }} />
            {isManager && <Button variant="dangerSoft" onClick={() => del(r)}><Icon name="trash" size={14} /> {tr("p_delete")}</Button>}
          </div>
          {isManager && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={small}>{L('라벨', 'Labels')}</span>
              {(r.labels || []).map((x) => labelPill(x, () => setLabels(r, r.labels.filter((y) => y !== x))))}
              <input value={newLabel[r.id] || ''} onChange={(e) => setNewLabel((d) => ({ ...d, [r.id]: e.target.value }))} placeholder={L('라벨 추가 ↵', 'add label ↵')}
                list="issue-labels" onKeyDown={(e) => { const v = (newLabel[r.id] || '').trim(); if (e.key === 'Enter' && v) { setLabels(r, [...(r.labels || []), v]); setNewLabel((d) => ({ ...d, [r.id]: '' })) } }}
                style={{ ...input, width: 140 }} />
            </div>)}
        </div>
      </ExpandBox>
    )
  }

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (r) => (!label || (r.labels || []).includes(label)) && (!author || r.username === author) && (ext === 'all' || (ext === 'external') === isExt(r)) && words.every((w) =>
    [num(r), r.subject, r.body, r.username, r.origin, ...(r.comments || []).map((c) => c.body)].join(' ').toLowerCase().includes(w))
  const shown = rows.filter(hit)
  const counts = { open: shown.filter((r) => r.status !== 'resolved').length, closed: shown.filter((r) => r.status === 'resolved').length }
  const list = shown.filter((r) => (tab === 'closed') === (r.status === 'resolved'))
  // One width whatever the count: two digits, then 99+ (no bold on the picked one either — that widened it).
  const tabBtn = (k, text) => (
    <button key={k} type="button" onClick={() => setTab(k)}
      style={{ border: 0, cursor: 'pointer', padding: '2px 8px',
        color: tab === k ? 'var(--dock-text-primary)' : 'var(--dock-text-secondary)',
        background: tab === k ? 'var(--dock-border-subtle)' : 'none' }}>
      {text} <Count n={counts[k]} /></button>)
  return (
    <>
      {/* compose — everyone */}
      <Panel bare fold open={!folded} title={tr("p_new_report")}
        hint={tr("p_bug_recommendation_inquiry")}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(KIND).map(([k, m]) => (
              <button key={k} type="button" onClick={() => setF((s) => ({ ...s, kind: k }))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 13px',
                  cursor: 'pointer', fontSize: 'var(--fs-medium, 14px)',
                  border: `1px solid ${f.kind === k ? m.color : 'var(--dock-border-default)'}`,
                  background: f.kind === k ? m.color : 'transparent',
                  color: f.kind === k ? '#fff' : m.color }}>
                <Icon name={m.icon} size={16} color={f.kind === k ? '#fff' : m.color} /> {L(m.ko, m.en)}
              </button>
            ))}
          </div>
          <input value={f.subject} onChange={(e) => setF((s) => ({ ...s, subject: e.target.value }))}
            placeholder={tr("p_subject")} style={{ ...input, width: '100%' }} />
          <textarea value={f.body} onChange={(e) => setF((s) => ({ ...s, body: e.target.value }))}
            rows={4} placeholder={L('자세히 적어 주세요 (Markdown)', 'Describe it (Markdown)')} style={textarea} />
          <div style={{ display: 'flex' }}><div style={{ flex: 1 }} />
            <Button variant="primary" onClick={submit}>{tr("p_send")}</Button>
          </div>
        </div>
      </Panel>

      {/* the list */}
      <Panel bare fold open={!folded} title={isManager ? tr("p_received_reports") : tr("p_my_reports")}
        hint={String(rows.length)}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {tabBtn('open', L('열림', 'Open'))}{tabBtn('closed', L('닫힘', 'Closed'))}
          {/* A filter, not a third tab: where the issue was opened. */}
          <Select value={ext} onChange={(e) => setExt(e.target.value)} title={L('어디서 연 이슈', 'Where it was opened')} style={{ ...input, width: 150 }}>
            <option value="all">{L('출처: 전부', 'From: all')}</option>
            <option value="external">{L('출처: GitHub', 'From: GitHub')}</option>
            <option value="local">{L('출처: 이 포털', 'From: this portal')}</option>
          </Select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('검색 (제목·본문·작성자·#번호)', 'Search (title, body, author, #n)')}
            style={{ ...input, flex: 1, minWidth: 160 }} />
          {label && <span style={small}>{L('라벨', 'label')}: {labelPill(label)} <a href="#" onClick={(e) => { e.preventDefault(); setLabel('') }}>{L('해제', 'clear')}</a></span>}
          {author && <span style={small}>{L('작성자', 'author')}: <b>{author}</b> <a href="#" onClick={(e) => { e.preventDefault(); setAuthor('') }}>{L('해제', 'clear')}</a></span>}
        </div>
        {list.length === 0
          ? <Row className="empty">{tr("p_nothing_yet")}</Row>
          : <div className="set-list">{list.map(item)}</div>}
      </Panel>
      {isManager && <datalist id="issue-labels">{[...new Set([...Object.keys(KIND), ...rows.flatMap((r) => r.labels || [])])].map((x) => <option key={x} value={x} />)}</datalist>}
      {isManager && <IssueSync L={L} folded={folded} />}
      {pad > 0 && <div style={{ height: pad }} aria-hidden />}
    </>
  )
}

/** Admin: where issues go — GitHub (this is the main portal: token in the server's env) or a main portal
 *  (paired by address + pin, as in HANDSHAKE.md) — and which kinds go. */
function IssueSync({ L, folded }) {
  const [st, setSt] = useState(null)
  const [url, setUrl] = useState('')
  const load = () => launcher.get('/admin/issues').then((r) => setSt(r.data)).catch(() => {})
  useEffect(() => { load() }, [])
  async function run(p, ok) { try { await p; if (ok) notify(ok, 'ok'); await load() } catch (e) { notify(e?.response?.data?.detail || 'failed', 'bad') } }
  if (!st) return null
  const KL = { bug: L('버그', 'Bug'), recommendation: L('제안', 'Recommendation'), inquiry: L('문의', 'Inquiry'), local: L('이 서버만', 'Local only') }
  const where = st.mode === 'github' ? `GitHub ${st.repo}` : st.mode === 'sub' ? `main ${st.main.url}` : L('꺼짐', 'off')
  return (
    <Panel bare fold open={!folded} title={L('이슈 동기화', 'Issue sync')} hint={where}>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{L('올리는 종류', 'Kinds sent')}:</span>
          {Object.entries(st.kinds).map(([k, on]) => (
            <label key={k} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={on} onChange={() => run(launcher.put('/admin/issues/kinds', { kinds: { [k]: !on } }))} /> {KL[k] || k}
            </label>))}
        </div>
        {st.mode === 'github' && <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={st.accept_external} onChange={() => run(launcher.put('/admin/issues/external', { accept: !st.accept_external }))} />
          {L('GitHub 에서 직접 연 이슈(외부)도 받기', 'Take in issues opened on GitHub (external)')}
        </label>}
        {st.mode === 'github' && <div style={{ fontSize: 13, color: 'var(--dock-text-secondary)' }}>
          webhook: <code>{st.webhook_url}</code> {st.webhook ? '✓' : L('— GITHUB_WEBHOOK_SECRET 없음: GitHub 쪽 소식은 안 들어옴', '— no GITHUB_WEBHOOK_SECRET: nothing comes back from GitHub')}
        </div>}
        {st.mode !== 'github' && (st.main
          ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{L('이 포털의 이슈는 main 으로 갑니다', 'Issues go to main')}: {st.main.url}
              <Button variant="dangerSoft" onClick={() => run(launcher.delete('/admin/issues/link'), L('연결을 끊었습니다', 'Unlinked'))}>{L('끊기', 'Unlink')}</Button></div>
          : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://portal.stellarpiece.com" style={{ ...fieldInput, flex: 1, minWidth: 220 }} />
              <Button variant="primary" onClick={() => run(launcher.post('/admin/issues/link', { url }), L('요청했습니다 — main 관리자에게 확인 번호를 알려 주세요', 'Asked — tell main\'s admin the pin'))}>{L('main 에 연결 요청', 'Ask main')}</Button>
              {st.pending && <span>{st.pending.url} · {L('확인 번호', 'pin')} <b>{st.pending.pin}</b> · {st.pending.status}</span>}
            </div>)}
        {st.requests.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {L('연결 요청', 'Link request')} · {r.from_name} · {r.from_url} · {r.by} · {L('확인 번호', 'pin')} <b>{r.pin}</b>
            <Button variant="primary" onClick={() => run(launcher.post(`/admin/issues/requests/${r.id}`, { action: 'approve' }), L('승인했습니다', 'Approved'))}>{L('승인', 'Approve')}</Button>
            <Button variant="ghost" onClick={() => run(launcher.post(`/admin/issues/requests/${r.id}`, { action: 'reject' }))}>{L('거절', 'Reject')}</Button>
          </div>))}
        {st.subs.map((s) => (
          <div key={s.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {L('이슈를 보내는 포털', 'Sends issues here')}: <b>{s.name}</b> {s.url}
            <Button variant="dangerSoft" onClick={() => run(launcher.delete(`/admin/issues/subs/${encodeURIComponent(s.name)}`), L('끊었습니다', 'Removed'))}>{L('끊기', 'Remove')}</Button>
          </div>))}
        <div><Button variant="ghost" onClick={() => run(launcher.post('/admin/issues/sync'), L('보냈습니다', 'Synced'))}>{L('지금 동기화', 'Sync now')}</Button></div>
      </div>
    </Panel>
  )
}

/** A count that never changes the width of what holds it: two digits, then 99+. */
export function Count({ n }) {
  return <span style={{ display: 'inline-block', minWidth: '3ch', textAlign: 'left', fontVariantNumeric: 'tabular-nums' }}>{n > 99 ? '99+' : n}</span>
}
