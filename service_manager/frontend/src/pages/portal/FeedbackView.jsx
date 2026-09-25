import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ExpandBox from './ExpandBox'
import { Panel, Row, Pill, fieldInput } from './Field'

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
  inquiry:        { icon: 'chats',          color: '#2563eb', ko: '문의',      en: 'Inquiry' } }
const input = fieldInput
// The label above a block inside an opened report — grey, same size as the rest.
const secLbl = { color: 'var(--text-secondary)', marginBottom: 4 }

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
    ? <Pill tone="ok">{L('처리완료', 'resolved')}</Pill>
    : <Pill tone="warn">{L('접수', 'open')}</Pill>

  const item = (r, admin) => {
    const m = km(r.kind)
    return (
      <ExpandBox key={r.id} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}
        outerProps={{ className: open === r.id ? 'on' : undefined }}
        style={{ opacity: r.status === 'resolved' ? 0.72 : 1 }}
        icon={<Icon name={m.icon} size={22} color={m.color} weight="duotone" />}
        title={r.subject || L('(제목 없음)', '(no subject)')}
        badges={<>
          <span className="set-pill" style={{ color: m.color }}>{L(m.ko, m.en)}</span>
          {statusBadge(r.status)}
        </>}
        subtitle={(admin ? (r.username + ' · ') : '') + fmt(r.created_at)}
      >
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={secLbl}>{L('내용', 'Message')}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{r.body || '—'}</div>
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
                <Button variant="secondary" onClick={() => sendReply(r)}>{L('답장 저장', 'Save reply')}</Button>
                <Button variant={r.status === 'resolved' ? 'ghost' : 'primary'} onClick={() => toggleResolve(r)}>
                  {r.status === 'resolved' ? L('다시 열기', 'Reopen') : L('처리완료로 변경', 'Mark resolved')}
                </Button>
                <div style={{ flex: 1 }} />
                <Button variant="dangerSoft" onClick={() => del(r)}><Icon name="trash" size={14} /> {L('삭제', 'Delete')}</Button>
              </div>
            </>
          ) : (
            <div>
              <div style={secLbl}>{L('관리자 답장', 'Admin reply')}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
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
    <>
      {msg && <div className="set-msg">{msg}</div>}

      {/* compose — everyone */}
      <Panel bare title={L('새 리포트', 'New report')}
        hint={L('버그 신고 · 제안 · 문의', 'bug · recommendation · inquiry')}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(KIND).map(([k, m]) => (
              <button key={k} type="button" onClick={() => setF((s) => ({ ...s, kind: k }))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 13px',
                  cursor: 'pointer', fontSize: 'var(--fs-medium, 14px)',
                  border: `1px solid ${f.kind === k ? m.color : 'var(--border-default)'}`,
                  background: f.kind === k ? m.color : 'transparent',
                  color: f.kind === k ? '#fff' : 'var(--text-primary)' }}>
                <Icon name={m.icon} size={16} color={f.kind === k ? '#fff' : m.color} /> {L(m.ko, m.en)}
              </button>
            ))}
          </div>
          <input value={f.subject} onChange={(e) => setF((s) => ({ ...s, subject: e.target.value }))}
            placeholder={L('제목', 'Subject')} style={{ ...input, width: '100%' }} />
          <textarea value={f.body} onChange={(e) => setF((s) => ({ ...s, body: e.target.value }))}
            rows={4} placeholder={L('내용을 자세히 적어주세요…', 'Describe it in detail…')}
            style={{ ...input, width: '100%', height: 'auto', resize: 'vertical' }} />
          <div style={{ display: 'flex' }}><div style={{ flex: 1 }} />
            <Button variant="primary" onClick={submit}>{L('보내기', 'Send')}</Button>
          </div>
        </div>
      </Panel>

      {/* thread */}
      <Panel bare title={isManager ? L('받은 리포트', 'Received reports') : L('내 리포트', 'My reports')}
        hint={String(rows.length)}>
        {rows.length === 0
          ? <Row className="empty">{L('아직 없습니다.', 'Nothing yet.')}</Row>
          : <div className="set-list">{rows.map((r) => item(r, isManager))}</div>}
      </Panel>
    </>
  )
}
