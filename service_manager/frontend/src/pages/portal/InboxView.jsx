import { useCallback, useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import Select from 'lilak-ui/components/Select.jsx'
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
// A source is a set's inbox project, or the portal itself (`portal`: path approvals, access
// requests, address changes — app/routers/inbox.py answers the same three calls).
const pp = (src, path, opts = {}) => fetch(src.portal ? `/api/inbox/portal/${path}` : `/pp/${src.svc}/${src.proj}/api/${path}`, {
  ...opts, headers: { ...auth(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
}).then(async (r) => {
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || `${r.status}`)
  return j
})
const KIND = { activity: 'calendar', note: 'notebook', job: 'play', note_delete: 'trash', record_delete: 'trash', tags: 'tag',
  path: 'folder', access: 'key', email: 'user', sync: 'link', issues: 'link', sender: 'robot' }

/** Every waiting candidate of the caller's inboxes (and, with `withDone`, what was decided,
 *  the latest first); read again every 15 s, when the page or its window comes back, and when a
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
    // ponytail: polled, no push channel; a server-sent nudge if 15 s is still too slow.
    const timer = setInterval(read, 15 * 1000)
    window.addEventListener('focus', read)          // back from another window: visibility never changed
    const saved = (e) => { if (e.origin === window.location.origin && e.data?.type === 'lilak:saved') read() }
    window.addEventListener(CHANGED, read)
    window.addEventListener('message', saved)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(timer)
      window.removeEventListener(CHANGED, read)
      window.removeEventListener('message', saved)
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [read])
  return st
}

/** One opened candidate's sections, as the inbox gives them: a fact table, one row a section. */
const TEXT = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }
const MONO = { ...TEXT, fontFamily: 'var(--font-mono)' }
const DIM = { color: 'var(--dock-text-secondary)' }
function Sections({ list, off, onPick }) {
  return (
    <div className="set-card">
      {list.map((s, i) => (
        <Field key={i} label={tr(`p_ib_s_${s.k}`)} align="start">
          {s.k === 'items' ? (
            // Where it would go, one line each; a waiting one's can be left out (unticked).
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {s.rows.map((r) => (
                <label key={r.i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', cursor: s.pick ? 'pointer' : 'default' }}>
                  {s.pick && <input type="checkbox" checked={!off?.has(r.i)} onChange={() => onPick?.(r.i)} />}
                  <span>{r.title}</span>
                  <span style={DIM}>{r.where}</span>
                  <span style={{ background: 'var(--dock-info-bg)', color: 'var(--dock-info-text)', padding: '0 4px' }}>
                    {r.add.map((a) => `#${a}`).join(' ')}</span>
                </label>
              ))}
            </div>
          ) : s.k === 'change' ? (
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
            <div style={s.k === 'error' ? { color: 'var(--dock-danger-text, #b91c1c)' } : s.k === 'makes' || s.k === 'adds' || s.k === 'deletes' ? MONO : TEXT}>
              {s.title && <div style={DIM}>{s.title}</div>}
              {s.text}
            </div>
          )}
        </Field>
      ))}
    </div>
  )
}

const STATUS = { approved: 'ok', checked: undefined, discarded: 'bad', held: 'warn' }
const stillOpen = (c) => c.status === 'waiting' || c.status === 'held'      // held: answered with an opinion, not decided

/** What was said about a candidate (a hold's opinion and what followed), and a line to add to it. */
function Thread({ list, onSay, busy }) {
  const [v, setV] = useState('')
  const say = () => { if (v.trim()) { onSay(v.trim()); setV('') } }
  return (
    <div className="set-card">
      <Field label={tr('p_ib_s_comments')} align="start">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
          {list.map((m, i) => (
            <div key={i} style={TEXT}>
              <span style={DIM}>{[m.by, m.via, String(m.at || '').slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ')}</span>
              <div>{m.text}</div>
            </div>
          ))}
          {onSay && (
            <span style={{ display: 'flex', gap: 6 }}>
              <input value={v} onChange={(e) => setV(e.target.value)} placeholder={tr('p_ib_comment_ph')} aria-label={tr('p_ib_comment_ph')}
                onKeyDown={(e) => { if (e.key === 'Enter') say() }}
                style={{ flex: 1, height: 30, padding: '0 8px', font: 'inherit', border: '1px solid var(--dock-input-border)',
                  background: 'var(--dock-input-bg)', color: 'var(--dock-text-primary)', borderRadius: 'var(--rack-radius, 0)' }} />
              <Button variant="secondary" disabled={busy || !v.trim()} onClick={say}>{tr('p_ib_comment_add')}</Button>
            </span>
          )}
        </div>
      </Field>
    </div>
  )
}
const day = (iso) => String(iso || '').slice(0, 10)

/** Who sends to the inbox (GET /api/inbox/senders): one line a sender — what it sends, how many
 *  wait, are held and were decided, when it last sent, and where a hold's opinion goes back to.
 *  Pressing one shows only its candidates. For looking, not for switching anything off. */
function Senders({ only, onOnly, stamp, isManager }) {
  const [rows, setRows] = useState(null)
  const [adm, setAdm] = useState(null)                   // a manager's: tokens, kinds, the registered ones
  const [f, setF] = useState(null)                       // the registration being written: { token_id, name, kinds, reads, reads_at }
  const [n, setN] = useState(0)
  useEffect(() => { launcher.get('/inbox/senders').then((r) => setRows(r.data || [])).catch(() => setRows([])) }, [stamp, n])
  useEffect(() => { if (isManager) launcher.get('/admin/senders').then((r) => setAdm(r.data)).catch(() => {}) }, [isManager, n])
  if (!rows) return null
  const fail = (e) => notify(e?.response?.data?.detail || tr('p_failed'), 'bad')
  const again = () => { setF(null); setN((x) => x + 1); window.dispatchEvent(new Event(CHANGED)) }
  const save = () => launcher.post('/admin/senders', { ...f, kinds: f.kinds.split(/[\s,]+/).filter(Boolean) }).then(again).catch(fail)
  const drop = (id) => launcher.delete(`/admin/senders/${id}`).then(again).catch(fail)
  const edit = (x) => setF({ token_id: x.token_id, name: x.name, kinds: x.kinds.join(', '), reads: x.reads, reads_at: x.reads_at || '' })
  const box = { height: 30, padding: '0 8px', font: 'inherit', border: '1px solid var(--dock-input-border)',
    background: 'var(--dock-input-bg)', color: 'var(--dock-text-primary)', borderRadius: 'var(--rack-radius, 0)' }
  const reads = (x) => (x.reads === 'schedule' ? (x.reads_at || tr('p_ib_reads_schedule')) : tr(`p_ib_reads_${x.reads}`))
  return (
    <Panel bare fold open={false} title={tr('p_ib_senders')} hint={String(rows.length)}
      right={(only || adm) ? (
        <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {only && <Button variant="secondary" onClick={() => onOnly(null)}>{tr('p_ib_senders_all')}</Button>}
          {adm && !f && <Button variant="secondary" onClick={() => setF({ token_id: '', name: '', kinds: 'note', reads: 'session', reads_at: '' })}>{tr('p_ib_reg_add')}</Button>}
        </span>
      ) : null}>
      {/* A manager registers a token as a sender, or changes one: its name, what it sends, when it reads an answer. */}
      {f && adm && (
        <Row>
          <Select value={f.token_id} onChange={(e) => setF({ ...f, token_id: Number(e.target.value) })} style={box} aria-label={tr('p_ib_from_token')}>
            <option value="">{tr('p_ib_from_token')}…</option>
            {adm.tokens.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tr('p_ib_reg_name')} aria-label={tr('p_ib_reg_name')} style={{ ...box, width: 150 }} />
          <input value={f.kinds} onChange={(e) => setF({ ...f, kinds: e.target.value })} placeholder={adm.kinds.join(', ')} aria-label={tr('p_ib_reg_kinds')} title={adm.kinds.join(', ')} style={{ ...box, width: 170 }} />
          <Select value={f.reads} onChange={(e) => setF({ ...f, reads: e.target.value })} style={box} aria-label={tr('p_ib_reg_reads')}>
            {adm.reads.map((x) => <option key={x} value={x}>{tr(`p_ib_reads_${x}`)}</option>)}
          </Select>
          {f.reads === 'schedule' && <input value={f.reads_at} onChange={(e) => setF({ ...f, reads_at: e.target.value })} placeholder={tr('p_ib_reg_when')} aria-label={tr('p_ib_reg_when')} style={{ ...box, width: 140 }} />}
          <span className="sp" />
          <Button variant="primary" disabled={!f.token_id || !f.name.trim()} onClick={save}>{tr('p_save')}</Button>
          <Button variant="secondary" onClick={() => setF(null)}>{tr('p_cancel')}</Button>
        </Row>
      )}
      {rows.length === 0 && <Row className="empty">{tr('p_ib_senders_none')}</Row>}
      {rows.map((r) => {
        const k = `${r.type}/${r.name}`
        return (
          <Row key={k} className={only?.k === k ? 'on' : undefined} style={{ cursor: 'pointer' }}
            onClick={() => onOnly(only?.k === k ? null : { k, ids: new Set(r.ids), name: r.name })}>
            <Pill>{tr(`p_ib_from_${r.type}`)}</Pill>
            <span>{r.type === 'mail' ? tr('p_ib_from_mail_name') : r.registered?.status === 'approved' ? `${r.registered.name} (${r.name})` : r.name}</span>
            {r.type === 'token' && (r.registered
              ? <Pill tone={r.registered.status === 'approved' ? 'ok' : r.registered.status === 'rejected' ? 'bad' : 'warn'}>
                  {r.registered.status === 'approved' ? reads(r.registered) : tr(`p_ib_reg_${r.registered.status}`)}</Pill>
              : <Pill tone="bad">{tr('p_ib_reg_none')}</Pill>)}
            <span className="sub">{r.kinds.map((x) => tr(`p_ib_k_${x}`)).join(', ')}</span>
            <span className="sp" />
            {r.waiting > 0 && <Pill tone="warn">{tr('p_req_waiting')} {r.waiting}</Pill>}
            {r.held > 0 && <Pill tone="warn">{tr('p_ib_st_held')} {r.held}</Pill>}
            <span className="sub">{tr('p_ib_senders_done', r.done)}{r.last ? ` · ${r.last}` : ''}</span>
            <span className="sub">↩ {tr(`p_ib_back_${r.back}`)}</span>
            {adm && r.registered && (
              <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                <Button variant="secondary" onClick={() => edit(r.registered)}>{tr('p_ib_reg_edit')}</Button>
                <Button variant="dangerSoft" onClick={() => drop(r.registered.token_id)}>{tr('p_ib_reg_drop')}</Button>
              </span>
            )}
          </Row>
        )
      })}
    </Panel>
  )
}

export default function InboxView({ limit, onAll, decided = false, isManager = false }) {
  const all = useInbox(decided)
  // The registered senders by token name: a card names its sender and says when an answer is read.
  const [known, setKnown] = useState({})
  useEffect(() => { launcher.get('/inbox/registered').then((r) => setKnown(r.data || {})).catch(() => {}) }, [all.items.length])
  // A candidate carries its sender as it was when sent (`sendsAs`, stamped by MCP); one from before that is looked up
  // by its token's name (`sender.via` and `from` are both "MCP <token name>").
  const tokenOf = (c) => String(c.sender?.via || c.from || '').replace(/^MCP\s+/, '').trim()
  const senderOf = (c) => (c.sendsAs ? { name: c.sendsAs.name, reads: c.sendsAs.mode, reads_at: c.sendsAs.reads } : known[tokenOf(c)])
  const answer = (x) => (x.reads === 'never' ? tr('p_ib_ans_never') : x.reads === 'schedule' ? tr('p_ib_ans_at', x.reads_at || tr('p_ib_reads_schedule')) : tr('p_ib_ans_session'))
  const [only, setOnly] = useState(null)                // one sender's candidates: { k, ids, name }
  const mineOf = (list) => (only ? list.filter((c) => only.ids.has(`${c.src.portal ? '' : c.src.svc}/${c.src.portal ? '' : c.src.proj}/${c.id}`)) : list)
  const { sources, ready } = all
  const items = mineOf(all.items), done = mineOf(all.done)
  const [open, setOpen] = useState(() => new Set())     // the cards open (several at once)
  const [detail, setDetail] = useState({})
  const [busy, setBusy] = useState(null)
  const [off, setOff] = useState({})                      // per candidate: the items left out (tags)
  const keyOf = (c) => `${c.src.svc}/${c.src.proj}/${c.id}`
  const shown = limit ? items.slice(0, limit) : items
  const many = sources.length > 1

  const load = (c) => {
    const k = keyOf(c)
    if (detail[k]) return
    pp(c.src, `inbox/${encodeURIComponent(c.id)}`)
      .then((d) => setDetail((m) => ({ ...m, [k]: d.sections || [] })),
        (e) => setDetail((m) => ({ ...m, [k]: [{ k: 'error', text: String(e.message || e) }] })))
  }
  const toggle = (c) => {
    const k = keyOf(c)
    setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else { n.add(k); load(c) } return n })
  }
  // Every card open at once (or all shut): read the whole inbox without pressing each.
  const allOpen = shown.length > 0 && shown.every((c) => open.has(keyOf(c)))
  const openAll = () => {
    if (allOpen) { setOpen(new Set()); return }
    shown.forEach(load)
    setOpen(new Set(shown.map(keyOf)))
  }
  const pickOf = (k) => {
    const rows = (detail[k] || []).find((s) => s.k === 'items' && s.pick)?.rows
    return rows && off[k]?.size ? rows.map((r) => r.i).filter((i) => !off[k].has(i)) : undefined
  }
  const flip = (k) => (i) => setOff((m) => {
    const s = new Set(m[k] || [])
    if (s.has(i)) s.delete(i); else s.add(i)
    return { ...m, [k]: s }
  })
  const [titling, setTitling] = useState(null)           // { k, v }: naming an untitled note instead of binning it
  const [holding, setHolding] = useState(null)           // { k, v }: the opinion a hold is given with
  // One more line on a candidate's thread, its state as it was.
  const comment = async (c, text) => {
    setBusy(keyOf(c))
    try {
      await pp(c.src, `inbox/${encodeURIComponent(c.id)}/comment`, { method: 'POST', body: JSON.stringify({ text }) })
      window.dispatchEvent(new Event(CHANGED))
    } catch (e) { notify(String(e.message || e), 'bad') }
    setBusy(null)
  }
  const decide = async (c, action, extra = {}) => {
    setBusy(keyOf(c))
    try {
      const pick = pickOf(keyOf(c))
      await pp(c.src, `inbox/${encodeURIComponent(c.id)}/decide`, { method: 'POST', body: JSON.stringify({ action, ...(pick ? { pick } : {}), ...extra }) })
      notify(tr('p_ib_done', c.title || c.subject || ''), 'ok')
      setOpen((o) => { const n = new Set(o); n.delete(keyOf(c)); return n })
      window.dispatchEvent(new Event(CHANGED))
      if (c.src.portal) window.dispatchEvent(new Event('portal:requests'))     // the menu's own counts follow
    } catch (e) { notify(String(e.message || e), 'bad') }
    setBusy(null)
  }

  const row = (c) => {
    const k = keyOf(c)
    const icon = KIND[c.kind] || 'bell'
    const go = c.actions.find((a) => a !== 'discard' && a !== 'restore' && a !== 'hold')
    const input = { height: 30, minWidth: 220, padding: '0 8px', font: 'inherit', border: '1px solid var(--dock-input-border)',
      background: 'var(--dock-input-bg)', color: 'var(--dock-text-primary)', borderRadius: 'var(--rack-radius, 0)' }
    return (
      <ExpandBox key={k} open={open.has(k)} onToggle={() => toggle(c)} outerProps={{ className: open.has(k) ? 'on' : undefined }}
        padding="6px 13px" titleWeight="var(--rack-weight)"
        icon={<Icon name={icon} size={18} color="var(--dock-text-secondary)" />}
        // One line, as every RACK row: a long name (a job's parameters) is cut, whole on hover.
        oneLine title={c.title || c.subject || '—'}
        badges={<span style={{ display: 'inline-flex', gap: 8, flex: 'none' }}>
          {c.status !== 'waiting' && <Pill tone={STATUS[c.status]}>{tr(`p_ib_st_${c.status}`)}</Pill>}
          <Pill>{tr(`p_ib_k_${c.kind}`)}</Pill>
          {c.mode && stillOpen(c) && <Pill tone="warn">{tr(`p_ib_m_${c.mode}`)}</Pill>}
          {(c.comments || []).length > 0 && <Pill>💬 {c.comments.length}</Pill>}
          {many && <Pill>{c.src.set}</Pill>}
        </span>}
        subtitle={(stillOpen(c) ? [senderOf(c) ? `${senderOf(c).name} · ${answer(senderOf(c))}` : c.from, c.date, c.blocked]
          : [c.from, day(c.decidedAt), c.made && tr('p_ib_made', c.made.label || `${c.made.svc}/${c.made.proj}`)]).filter(Boolean).join(' · ')}
        right={(
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {/* An untitled note matters: give it a title and keep it, rather than bin it. */}
            {c.retitle && (titling?.k === k ? (<>
              <input autoFocus value={titling.v} placeholder={tr('p_ib_title_ph')} aria-label={tr('p_ib_title_ph')}
                onChange={(e) => setTitling({ k, v: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && titling.v.trim()) { decide(c, 'retitle', { title: titling.v.trim() }); setTitling(null) }
                  if (e.key === 'Escape') { e.stopPropagation(); setTitling(null) }
                }}
                style={{ height: 30, minWidth: 200, padding: '0 8px', font: 'inherit', border: '1px solid var(--dock-input-border)',
                  background: 'var(--dock-input-bg)', color: 'var(--dock-text-primary)', borderRadius: 'var(--rack-radius, 0)' }} />
              <Button variant="primary" disabled={!titling.v.trim() || busy === k}
                onClick={() => { decide(c, 'retitle', { title: titling.v.trim() }); setTitling(null) }}>{tr('p_ib_a_retitle_save')}</Button>
              <Button variant="secondary" onClick={() => setTitling(null)}>{tr('p_cancel')}</Button>
            </>) : (
              <Button variant="secondary" disabled={busy === k} onClick={() => setTitling({ k, v: '' })}>{tr('p_ib_a_retitle')}</Button>
            ))}
            {/* The third answer: hold it with an opinion, for whoever asked to read and ask again. */}
            {holding?.k === k && (<>
              <input autoFocus value={holding.v} placeholder={tr('p_ib_hold_ph')} aria-label={tr('p_ib_hold_ph')} style={input}
                onChange={(e) => setHolding({ k, v: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && holding.v.trim()) { decide(c, 'hold', { text: holding.v.trim() }); setHolding(null) }
                  if (e.key === 'Escape') { e.stopPropagation(); setHolding(null) }
                }} />
              <Button variant="primary" disabled={!holding.v.trim() || busy === k}
                onClick={() => { decide(c, 'hold', { text: holding.v.trim() }); setHolding(null) }}>{tr('p_ib_a_hold_save')}</Button>
              <Button variant="secondary" onClick={() => setHolding(null)}>{tr('p_cancel')}</Button>
            </>)}
            {titling?.k !== k && holding?.k !== k && go && <Button variant="primary" disabled={!!c.blocked || busy === k} title={c.blocked || undefined}
              onClick={() => decide(c, go)}>{tr(`p_ib_a_${go}`)}</Button>}
            {/* A sender that reads no answer: a hold's opinion would reach nobody, so it is not offered. */}
            {titling?.k !== k && holding?.k !== k && c.actions.includes('hold') && senderOf(c)?.reads !== 'never' && <Button variant="secondary" disabled={busy === k}
              onClick={() => setHolding({ k, v: '' })}>{tr('p_ib_a_hold')}</Button>}
            {titling?.k !== k && holding?.k !== k && c.actions.includes('discard') && <Button variant="dangerSoft" disabled={busy === k}
              onClick={() => decide(c, 'discard')}>{tr('p_ib_a_discard')}</Button>}
            {c.actions.includes('restore') && <Button variant="secondary" disabled={busy === k}
              onClick={() => decide(c, 'restore')}>{tr('p_ib_a_restore')}</Button>}
          </span>
        )}>
        {((c.comments || []).length > 0 || stillOpen(c)) && (
          <Thread list={c.comments || []} busy={busy === k} onSay={stillOpen(c) ? (text) => comment(c, text) : undefined} />
        )}
        {detail[k] ? <Sections list={detail[k]} off={off[k]} onPick={flip(k)} /> : <Row className="empty">{tr('p_ib_loading')}</Row>}
      </ExpandBox>
    )
  }

  return (
    <>
      {decided && <Senders only={only} onOnly={setOnly} stamp={all.items.length + all.done.length} isManager={isManager} />}
      <Panel bare title={only ? `${tr('p_inbox')} — ${only.name}` : tr('p_inbox')} hint={items.length ? `${items.length}` : undefined}
        right={(shown.length > 0 || onAll) ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {shown.length > 0 && <Button variant="secondary" style={{ minWidth: 96 }} onClick={openAll}>{tr(allOpen ? 'p_ib_close_all' : 'p_ib_open_all')}</Button>}
            {onAll && <Button variant="secondary" onClick={onAll}>{tr('p_inbox_all')}</Button>}
          </span>
        ) : null}>
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
