import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ExpandBox from './ExpandBox'

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
}
const input = { height: 32, borderRadius: 8, fontSize: 'var(--fs-small, 13px)', padding: '0 10px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)', boxSizing: 'border-box' }
const badge = { fontSize: 'var(--fs-micro, 11px)', padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid transparent' }
const secLbl = { fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', marginBottom: 4 }
const secHdr = { fontSize: 'var(--fs-small, 13px)', fontWeight: 600, margin: '0 0 10px', color: 'var(--text-secondary)' }

export default function FeedbackView({ isManager }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [f, setF] = useState({ kind: 'inquiry', subject: '', body: '' })
  const [mine, setMine] = useState([])
  const [all, setAll] = useState([])
  const [open, setOpen] = useState(null)
  const [drafts, setDrafts] = useState({})   // report id -> reply text being edited
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      setMine((await launcher.get('/reports/mine')).data)
      if (isManager) setAll((await launcher.get('/admin/reports')).data)
    } catch (e) { setMsg(e?.response?.data?.detail || 'load failed') }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { const r = await p; if (ok) setMsg(ok(r)); await load() } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) } }

  const submit = () => {
    if (!f.subject.trim() && !f.body.trim()) { setMsg(L('내용을 입력하세요.', 'Write something first.')); return }
    run(launcher.post('/reports', f), () => { setF({ kind: 'inquiry', subject: '', body: '' }); return L('보냈습니다. 감사합니다!', 'Sent — thank you!') })
  }
  const sendReply = (r) => run(launcher.post(`/admin/reports/${r.id}/reply`, { reply: drafts[r.id] ?? r.reply ?? '' }), () => L('답장 저장됨', 'Reply saved'))
  const toggleResolve = (r) => run(launcher.post(`/admin/reports/${r.id}/resolve`, { resolved: r.status !== 'resolved' }), () => r.status === 'resolved' ? L('다시 열림', 'Reopened') : L('처리완료', 'Resolved'))
  const del = (r) => { if (window.confirm(L('이 리포트를 삭제할까요?', 'Delete this report?'))) run(launcher.delete(`/admin/reports/${r.id}`), () => L('삭제됨', 'deleted')) }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString() } catch { return iso } }
  const km = (k) => KIND[k] || KIND.inquiry
  const statusBadge = (s) => s === 'resolved'
    ? <span style={{ ...badge, background: 'var(--ok-bg, #e6f4ea)', color: 'var(--ok-text, #2f9e44)' }}>{L('처리완료', 'resolved')}</span>
    : <span style={{ ...badge, background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning-text, #b45309)' }}>{L('접수', 'open')}</span>

  const item = (r, admin) => {
    const m = km(r.kind)
    return (
      <ExpandBox key={r.id} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}
        style={{ opacity: r.status === 'resolved' ? 0.72 : 1 }}
        icon={<Icon name={m.icon} size={22} color={m.color} weight="duotone" />}
        title={r.subject || L('(제목 없음)', '(no subject)')}
        badges={<>
          <span style={{ ...badge, color: m.color, borderColor: m.color }}>{L(m.ko, m.en)}</span>
          {statusBadge(r.status)}
        </>}
        subtitle={(admin ? (r.username + ' · ') : '') + fmt(r.created_at)}
      >
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={secLbl}>{L('내용', 'Message')}</div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-small, 13px)' }}>{r.body || '—'}</div>
          </div>
          {admin ? (
            <>
              <div>
                <div style={secLbl}>{L('답장', 'Reply')}</div>
                <textarea value={drafts[r.id] ?? r.reply ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                  rows={3} placeholder={L('답장을 입력…', 'write a reply…')}
                  style={{ ...input, width: '100%', height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => sendReply(r)}>{L('답장 저장', 'Save reply')}</Button>
                <Button size="sm" variant={r.status === 'resolved' ? 'ghost' : 'primary'} onClick={() => toggleResolve(r)}>
                  {r.status === 'resolved' ? L('다시 열기', 'Reopen') : L('처리완료로 변경', 'Mark resolved')}
                </Button>
                <div style={{ flex: 1 }} />
                <Button size="sm" variant="dangerSoft" onClick={() => del(r)}><Icon name="trash" size={14} /> {L('삭제', 'Delete')}</Button>
              </div>
            </>
          ) : (
            <div>
              <div style={secLbl}>{L('관리자 답장', 'Admin reply')}</div>
              <div style={{ fontSize: 'var(--fs-small, 13px)', whiteSpace: 'pre-wrap',
                color: r.reply ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {r.reply || L('아직 답장이 없습니다.', 'No reply yet.')}
              </div>
            </div>
          )}
        </div>
      </ExpandBox>
    )
  }

  const rows = isManager ? all : mine
  return (
    <div style={{ maxWidth: 720 }}>
      {msg && <div style={{ fontSize: 'var(--fs-small, 13px)', color: 'var(--text-muted)', marginBottom: 8 }}>{msg}</div>}

      {/* compose — everyone */}
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 12, padding: 14, marginBottom: 20 }}>
        <div style={{ fontSize: 'var(--fs-small, 13px)', fontWeight: 600, marginBottom: 10 }}>
          {L('버그 신고 · 제안 · 문의', 'Bug report · recommendation · inquiry')}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.entries(KIND).map(([k, m]) => (
            <button key={k} type="button" onClick={() => setF((s) => ({ ...s, kind: k }))}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 9,
                cursor: 'pointer', fontSize: 'var(--fs-small, 13px)', fontWeight: 600,
                border: `1.5px solid ${f.kind === k ? m.color : 'var(--border-default)'}`,
                background: f.kind === k ? m.color : 'transparent',
                color: f.kind === k ? '#fff' : 'var(--text-secondary)' }}>
              <Icon name={m.icon} size={16} color={f.kind === k ? '#fff' : m.color} /> {L(m.ko, m.en)}
            </button>
          ))}
        </div>
        <input value={f.subject} onChange={(e) => setF((s) => ({ ...s, subject: e.target.value }))}
          placeholder={L('제목', 'Subject')} style={{ ...input, width: '100%', marginBottom: 8 }} />
        <textarea value={f.body} onChange={(e) => setF((s) => ({ ...s, body: e.target.value }))}
          rows={4} placeholder={L('내용을 자세히 적어주세요…', 'Describe it in detail…')}
          style={{ ...input, width: '100%', height: 'auto', padding: '8px 10px', resize: 'vertical', marginBottom: 10 }} />
        <div style={{ display: 'flex' }}><div style={{ flex: 1 }} />
          <Button size="sm" variant="primary" onClick={submit}>{L('보내기', 'Send')}</Button>
        </div>
      </div>

      {/* thread */}
      <div style={secHdr}>
        {isManager ? L('받은 리포트', 'Received reports') : L('내 리포트', 'My reports')}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {rows.length}</span>
      </div>
      {rows.length === 0
        ? <div style={{ fontSize: 'var(--fs-small, 13px)', color: 'var(--text-muted)', padding: '8px 2px' }}>{L('아직 없습니다.', 'Nothing yet.')}</div>
        : rows.map((r) => item(r, isManager))}
    </div>
  )
}
