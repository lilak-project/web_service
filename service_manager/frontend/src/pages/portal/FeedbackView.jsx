import { useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ExpandBox from './ExpandBox'
import { Panel, Row, Pill, fieldInput } from './Field'
import { notify } from './settingsMsg'

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
const textarea = { ...fieldInput, width: '100%', height: 'auto', minHeight: 0, padding: '9px 10px', resize: 'vertical', lineHeight: 1.5 }

export default function FeedbackView({ isManager }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [f, setF] = useState({ kind: 'inquiry', subject: '', body: '' })
  const [mine, setMine] = useState([])
  const [all, setAll] = useState([])
  const [open, setOpen] = useState(null)
  const [drafts, setDrafts] = useState({})   // report id -> reply text being edited

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
  const sendReply = (r) => run(launcher.post(`/admin/reports/${r.id}/reply`, { reply: drafts[r.id] ?? r.reply ?? '' }), () => tr("p_reply_saved"))
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
        subtitle={(admin ? (r.username + ' · ') : '') + fmt(r.created_at)}
      >
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{r.body || '—'}</div>
          {admin ? (
            <>
              <textarea value={drafts[r.id] ?? r.reply ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                rows={3} placeholder={tr("p_write_a_reply")} style={textarea} />
              <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={() => sendReply(r)}>{tr("p_save_reply")}</Button>
                <Button variant={r.status === 'resolved' ? 'ghost' : 'primary'} onClick={() => toggleResolve(r)}>
                  {r.status === 'resolved' ? tr("p_reopen") : tr("p_mark_resolved")}
                </Button>
                <div style={{ flex: 1 }} />
                <Button variant="dangerSoft" onClick={() => del(r)}><Icon name="trash" size={14} /> {tr("p_delete")}</Button>
              </div>
            </>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid var(--border-default)', paddingTop: 10,
              color: r.reply ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              {r.reply || tr("p_no_reply_yet")}
            </div>
          )}
        </div>
      </ExpandBox>
    )
  }

  const rows = isManager ? all : mine
  return (
    <>
      {/* compose — everyone */}
      <Panel bare title={tr("p_new_report")}
        hint={tr("p_bug_recommendation_inquiry")}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(KIND).map(([k, m]) => (
              <button key={k} type="button" onClick={() => setF((s) => ({ ...s, kind: k }))}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 13px',
                  cursor: 'pointer', fontSize: 'var(--fs-medium, 14px)',
                  border: `1px solid ${f.kind === k ? m.color : 'var(--border-default)'}`,
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
      <Panel bare title={isManager ? tr("p_received_reports") : tr("p_my_reports")}
        hint={String(rows.length)}>
        {rows.length === 0
          ? <Row className="empty">{tr("p_nothing_yet")}</Row>
          : <div className="set-list">{rows.map((r) => item(r, isManager))}</div>}
      </Panel>
    </>
  )
}
