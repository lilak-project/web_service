import { useCallback, useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher } from '../../api'
import ExpandBox from './ExpandBox'
import { Field, Panel, Pill, Row } from './Field'
import { notify } from './settingsMsg'

/**
 * The inboxes on the cover: what is waiting for a yes, from the inbox of every share
 * set the caller is in (GET /api/inbox/sources), each row naming its set when there
 * are more than one. The cover knows nothing about a candidate: each project's
 * GET /api/pending gives cards (title, kind, from, the buttons), opening one asks
 * GET /api/inbox/{id} for sections to draw, and a button posts its action to
 * /api/inbox/{id}/decide — the inbox makes the record where it goes. Home shows the
 * first five; the account menu all of them.
 */
const CHANGED = 'lilak:inbox-changed'
const auth = () => ({ Authorization: `Bearer ${localStorage.getItem('lilak_portal_token') || ''}` })
const pp = (src, path, opts = {}) => fetch(`/pp/${src.svc}/${src.proj}/api/${path}`, {
  ...opts, headers: { ...auth(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
}).then(async (r) => {
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || `${r.status}`)
  return j
})
const KIND = { activity: 'calendar', note: 'notebook', job: 'play' }

/** Every waiting candidate of the caller's inboxes (and, with `withDone`, what was decided,
 *  the latest first); read again each minute, when the page comes back in sight, and when a
 *  decision is made anywhere on it. */
export function useInbox(withDone = false) {
  const [st, setSt] = useState({ items: [], done: [], sources: [], ready: false })
  const read = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    const each = (sources, path) => Promise.all(sources.map((s) => pp(s, path)
      .then((d) => (d.items || []).map((c) => ({ ...c, src: s }))).catch(() => []))).then((l) => l.flat())
    try {
      const sources = (await launcher.get('/inbox/sources')).data || []
      const [items, done] = await Promise.all([each(sources, 'pending'), withDone ? each(sources, 'decided?limit=50') : []])
      done.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
      setSt({ items, done, sources, ready: true })
    } catch { setSt((s) => ({ ...s, ready: true })) }
  }, [withDone])
  useEffect(() => {
    read()
    const timer = setInterval(read, 60 * 1000)
    const saved = (e) => { if (e.origin === window.location.origin && e.data?.type === 'lilak:saved') read() }
    window.addEventListener(CHANGED, read)
    window.addEventListener('message', saved)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener(CHANGED, read)
      window.removeEventListener('message', saved)
      document.removeEventListener('visibilitychange', read)
    }
  }, [read])
  return st
}

/** One opened candidate's sections, as the inbox gives them: a fact table, one row a section. */
const TEXT = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }
const MONO = { ...TEXT, fontFamily: 'var(--font-mono)' }
const DIM = { color: 'var(--dock-text-secondary)' }
function Sections({ list }) {
  return (
    <div className="set-card">
      {list.map((s, i) => (
        <Field key={i} label={tr(`p_ib_s_${s.k}`)} align="start">
          {s.k === 'change' ? (
            <div>
              {s.title && <div style={DIM}>{s.title}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr 1fr', gap: '0 13px', alignItems: 'baseline' }}>
                {s.rows.map(([k, was, now]) => [
                  <span key={k} style={DIM}>{k}</span>,
                  <span key={`${k}o`} style={was !== now ? { ...DIM, textDecoration: 'line-through' } : DIM}>{was || '—'}</span>,
                  // What changes is the one thing lit; the rest says "the same".
                  <span key={`${k}n`} style={was !== now ? { background: 'var(--dock-info-bg)', color: 'var(--dock-info-text)', padding: '0 4px', justifySelf: 'start' } : DIM}>{was !== now ? now : '='}</span>,
                ])}
              </div>
            </div>
          ) : s.k === 'mail' ? (
            <div>
              {s.subject && <div>{s.subject}</div>}
              <div style={DIM}>
                {s.link && <a href={s.link} target="_blank" rel="noreferrer">{tr('p_ib_mail_open')}</a>}
                {s.attachments?.length > 0 && <span>{s.link ? ' · ' : ''}📎 {s.attachments.join(', ')}</span>}
              </div>
              {s.text && <div style={{ ...TEXT, marginTop: 4 }}>{s.text}</div>}
            </div>
          ) : (
            <div style={s.k === 'error' ? { color: 'var(--dock-danger-text, #b91c1c)' } : s.k === 'makes' || s.k === 'adds' ? MONO : TEXT}>
              {s.title && <div style={DIM}>{s.title}</div>}
              {s.text}
            </div>
          )}
        </Field>
      ))}
    </div>
  )
}

const STATUS = { approved: 'ok', checked: undefined, discarded: 'bad' }
const day = (iso) => String(iso || '').slice(0, 10)

export default function InboxView({ limit, onAll, decided = false }) {
  const { items, done, sources, ready } = useInbox(decided)
  const [open, setOpen] = useState(null)
  const [detail, setDetail] = useState({})
  const [busy, setBusy] = useState(null)
  const keyOf = (c) => `${c.src.svc}/${c.src.proj}/${c.id}`
  const shown = limit ? items.slice(0, limit) : items
  const many = sources.length > 1

  const toggle = (c) => {
    const k = keyOf(c)
    if (open === k) { setOpen(null); return }
    setOpen(k)
    pp(c.src, `inbox/${encodeURIComponent(c.id)}`)
      .then((d) => setDetail((m) => ({ ...m, [k]: d.sections || [] })),
        (e) => setDetail((m) => ({ ...m, [k]: [{ k: 'error', text: String(e.message || e) }] })))
  }
  const decide = async (c, action) => {
    setBusy(keyOf(c))
    try {
      await pp(c.src, `inbox/${encodeURIComponent(c.id)}/decide`, { method: 'POST', body: JSON.stringify({ action }) })
      notify(tr('p_ib_done', c.title || c.subject || ''), 'ok')
      setOpen(null)
      window.dispatchEvent(new Event(CHANGED))
    } catch (e) { notify(String(e.message || e), 'bad') }
    setBusy(null)
  }

  const row = (c) => {
    const k = keyOf(c)
    const icon = KIND[c.kind] || 'bell'
    const go = c.actions.find((a) => a !== 'discard' && a !== 'restore')
    return (
      <ExpandBox key={k} open={open === k} onToggle={() => toggle(c)} outerProps={{ className: open === k ? 'on' : undefined }}
        padding="6px 13px" titleWeight="var(--rack-weight)"
        icon={<Icon name={icon} size={18} color="var(--dock-text-secondary)" />}
        // One line, as every RACK row: a long name (a job's parameters) is cut, whole on hover.
        oneLine title={c.title || c.subject || '—'}
        badges={<span style={{ display: 'inline-flex', gap: 8, flex: 'none' }}>
          {c.status !== 'waiting' && <Pill tone={STATUS[c.status]}>{tr(`p_ib_st_${c.status}`)}</Pill>}
          <Pill>{tr(`p_ib_k_${c.kind}`)}</Pill>
          {c.mode && c.status === 'waiting' && <Pill tone="warn">{tr(`p_ib_m_${c.mode}`)}</Pill>}
          {many && <Pill>{c.src.set}</Pill>}
        </span>}
        subtitle={(c.status === 'waiting' ? [c.from, c.date, c.blocked]
          : [c.from, day(c.decidedAt), c.made && tr('p_ib_made', `${c.made.svc}/${c.made.proj}`)]).filter(Boolean).join(' · ')}
        right={(
          <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            {go && <Button variant="primary" disabled={!!c.blocked || busy === k} title={c.blocked || undefined}
              onClick={() => decide(c, go)}>{tr(`p_ib_a_${go}`)}</Button>}
            {c.actions.includes('discard') && <Button variant="dangerSoft" disabled={busy === k}
              onClick={() => decide(c, 'discard')}>{tr('p_ib_a_discard')}</Button>}
            {c.actions.includes('restore') && <Button variant="secondary" disabled={busy === k}
              onClick={() => decide(c, 'restore')}>{tr('p_ib_a_restore')}</Button>}
          </span>
        )}>
        {detail[k] ? <Sections list={detail[k]} /> : <Row className="empty">{tr('p_ib_loading')}</Row>}
      </ExpandBox>
    )
  }

  return (
    <>
      <Panel bare title={tr('p_inbox')} hint={items.length ? `${items.length}` : undefined}
        right={onAll ? <Button variant="secondary" onClick={onAll}>{tr('p_inbox_all')}</Button> : null}>
        {shown.length > 0 && <div className="set-list">{shown.map(row)}</div>}
        {ready && !items.length && <Row className="empty">{tr('p_inbox_none')}</Row>}
        {limit && items.length > limit && <Row className="empty">{tr('p_inbox_more', items.length - limit)}</Row>}
      </Panel>
      {/* What was decided, the latest first: approved, checked, and discarded (kept 10 days, can come back). */}
      {decided && (
        <Panel bare fold open={false} title={tr('p_ib_decided')} hint={done.length ? `${done.length}` : undefined}>
          {done.length > 0 ? <div className="set-list">{done.map(row)}</div>
            : ready && <Row className="empty">{tr('p_ib_decided_none')}</Row>}
        </Panel>
      )}
    </>
  )
}
