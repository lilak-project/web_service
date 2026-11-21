import { useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ExpandBox from './ExpandBox'
import { Panel, Row, Pill, fieldInput } from './Field'
import { notify } from './settingsMsg'

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
 * FeedbackView — bug reports, recommendations and inquiries.
 * Everyone gets a compose box. A regular user then sees their own thread (status
 * + admin reply, read-only). An admin instead sees every report and can reply,
 * flip open↔resolved, or delete. Report rows reuse the shared ExpandBox so they
 * match the Home / Accounts / Groups boxes.
 */
const KIND = {
  bug:            { icon: 'warning-circle', color: '#dc2626', ko: '버그 신고', en: 'Bug' },
  recommendation: { icon: 'lightbulb',      color: '#ca8a04', ko: '제안',      en: 'Recommendation' },
  inquiry:        { icon: 'chats',          color: '#2563eb', ko: '문의',      en: 'Inquiry' },
  local:          { icon: 'home',           color: '#64748b', ko: '이 서버만',  en: 'Local only' } }
const input = fieldInput
const textarea = { ...fieldInput, width: '100%', height: 'auto', minHeight: 0, padding: '9px 10px', resize: 'vertical', lineHeight: 1.5 }

export default function FeedbackView({ isManager, folded = false }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [f, setF] = useState({ kind: 'inquiry', subject: '', body: '' })
  const [mine, setMine] = useState([])
  const [all, setAll] = useState([])
  const [open, setOpen] = useState(null)
  const [drafts, setDrafts] = useState({})   // report id -> comment being written

  async function load() {
    try {
      setMine((await launcher.get('/reports/mine')).data)
      if (isManager) setAll((await launcher.get('/admin/reports')).data)
    } catch (e) { notify(e?.response?.data?.detail || 'load failed', 'bad') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) notify(ok(r), 'ok'); await load() } catch (e) { notify(e?.response?.data?.detail || tr("p_failed"), 'bad') } }

  const submit = () => {
    if (!f.subject.trim() && !f.body.trim()) { notify(tr("p_write_something_first"), 'bad'); return }
    run(launcher.post('/reports', f), () => { setF({ kind: 'inquiry', subject: '', body: '' }); return tr("p_sent_thank_you") })
  }
  const sendComment = (r) => {
    if (!(drafts[r.id] || '').trim()) return
    run(launcher.post(`/reports/${r.id}/comments`, { body: drafts[r.id] }), () => { setDrafts((d) => ({ ...d, [r.id]: '' })); return L('댓글을 남겼습니다', 'Comment added') })
  }
  const toggleResolve = (r) => run(launcher.post(`/admin/reports/${r.id}/resolve`, { resolved: r.status !== 'resolved' }), () => r.status === 'resolved' ? tr("p_reopened") : tr("p_resolved"))
  const del = (r) => { if (window.confirm(tr("p_delete_this_report"))) run(launcher.delete(`/admin/reports/${r.id}`), () => tr("p_deleted")) }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString() } catch { return iso } }
  const km = (k) => KIND[k] || KIND.inquiry
  const statusBadge = (s) => s === 'resolved'
    ? <Pill tone="ok">{tr("p_resolved_2")}</Pill>
    : <Pill tone="warn">{tr("p_open")}</Pill>

  const item = (r, admin) => {
    const m = km(r.kind)
    return (
      <ExpandBox key={r.id} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}
        outerProps={{ className: open === r.id ? 'on' : undefined }}
        style={{ opacity: r.status === 'resolved' ? 0.72 : 1 }}
        icon={<Icon name={m.icon} size={22} color={m.color} weight="duotone" />}
        title={r.subject || tr("p_no_subject")}
        badges={<>
          <span className="set-pill" style={{ color: m.color }}>{L(m.ko, m.en)}</span>
          {statusBadge(r.status)}
        </>}
        subtitle={(admin ? (r.username + (r.origin ? ` (${r.origin})` : '') + ' · ') : '') + fmt(r.created_at)}
      >
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{r.body || '—'}</div>
          <ReportFiles r={r} />
          {(r.comments || []).map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--dock-border-subtle)', paddingTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--dock-text-secondary)' }}>
                {c.origin === 'github' ? <><Icon name="github-logo" size={12} /> {c.author}</> : c.author}
                {c.origin && c.origin !== 'github' ? ` · ${c.origin}` : ''} · {fmt(c.created_at)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
          {!(r.comments || []).length && !admin &&
            <div style={{ color: 'var(--dock-text-secondary)' }}>{tr("p_no_reply_yet")}</div>}
          {r.upstream && <a href={r.upstream.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            <Icon name={r.upstream.where === 'github' ? 'github-logo' : 'link'} size={12} /> {r.upstream.where} #{r.upstream.id}</a>}
          <textarea value={drafts[r.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
            rows={2} placeholder={L('댓글', 'Comment')} style={textarea} />
          <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--dock-border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => sendComment(r)}>{L('댓글 달기', 'Comment')}</Button>
            {admin && <>
              <Button variant={r.status === 'resolved' ? 'ghost' : 'primary'} onClick={() => toggleResolve(r)}>
                {r.status === 'resolved' ? tr("p_reopen") : tr("p_mark_resolved")}
              </Button>
              <div style={{ flex: 1 }} />
              <Button variant="dangerSoft" onClick={() => del(r)}><Icon name="trash" size={14} /> {tr("p_delete")}</Button>
            </>}
          </div>
        </div>
      </ExpandBox>
    )
  }

  const rows = isManager ? all : mine
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
            rows={4} placeholder={tr("p_describe_it_in_detail")} style={textarea} />
          <div style={{ display: 'flex' }}><div style={{ flex: 1 }} />
            <Button variant="primary" onClick={submit}>{tr("p_send")}</Button>
          </div>
        </div>
      </Panel>

      {/* thread */}
      <Panel bare fold open={!folded} title={isManager ? tr("p_received_reports") : tr("p_my_reports")}
        hint={String(rows.length)}>
        {rows.length === 0
          ? <Row className="empty">{tr("p_nothing_yet")}</Row>
          : <div className="set-list">{rows.map((r) => item(r, isManager))}</div>}
      </Panel>
      {isManager && <IssueSync L={L} folded={folded} />}
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
