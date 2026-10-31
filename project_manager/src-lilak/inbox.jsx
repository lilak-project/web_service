import './strings.js'
import { tr } from 'lilak-ui'
import { authHeaders, loadTagSources } from 'lilak-ui/racklist'

/**
 * The inbox class's moving parts (def.jsx declares its fields): what approving
 * makes, and the buttons — in the table's last column and in the editor's
 * bar. Yes makes the record in the service it belongs to — an activity
 * through academic_activities' POST /api/records, a note through note's own
 * POST and PUT — then saves the candidate approved, with where it went; [열기]
 * opens that in a pane here.
 */
const ACTIVITY = ['name', 'kind', 'start', 'startTime', 'end', 'endTime', 'place', 'link', 'comment']
const SVC = { activity: 'academic_activities', note: 'note' }
const RANK = { waiting: 0, approved: 1, discarded: 2 }
const now = () => new Date().toISOString()
const words = (v) => String(v || '').split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean)

const call = (path, opts = {}) => fetch(path, { ...opts,
  headers: { ...authHeaders(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } })
  .then(async (r) => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.detail || `${r.status}`)
    return j
  })
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
const projOf = async (svc) => (await loadTagSources()).find((s) => s.svc === svc)?.proj
  || { academic_activities: 'activities', note: 'note' }[svc]

/** The tags the candidate's project brings (its `project` is a link to one). */
const projectTags = (r, doc) => (doc?.projects || []).find((p) => p.id === (r.project?.id ?? r.project))?.tags || []

/** What approving makes: { record } for an activity, { title, text } for a note. */
export function makes(r, doc) {
  const tags = projectTags(r, doc)
  if (r.target === 'activity') {
    const rec = Object.fromEntries(ACTIVITY.map((k) => [k, String(r[k] || '')]))
    return { record: { ...rec, repeat: null, ...(tags.length ? { tags } : {}) } }
  }
  const from = [r.from, r.date].filter(Boolean).join(', ') + (r.subject ? `, 「${r.subject}」` : '')
  const all = [...new Set([...words(r.noteTags), ...tags])].map((t) => `#${t}`).join(' ')
  return { title: String(r.title || '').trim(),
    text: `${all}\n\n${String(r.body || '').trim()}\n${from ? `\n출처: ${from}\n` : ''}` }
}
const missing = (r, out) => (r.target === 'activity'
  ? (!out.record.name || !/^\d{4}-\d{2}-\d{2}$/.test(out.record.start) ? tr('pm_ib_need_activity') : '')
  : (!out.title ? tr('pm_ib_need_note') : ''))

/** The editor's read-only field: exactly what approving will make. */
export function MakesField({ rec: r, ctx }) {
  const out = makes(r, ctx.doc)
  const bad = missing(r, out)
  if (bad) return <span className="rl-warn">{bad}</span>
  return (
    <div className="rl-mono" style={{ whiteSpace: 'pre-wrap' }}>{r.target === 'activity'
      ? Object.entries(out.record).filter(([, v]) => v && v.length !== 0).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
      : `${out.title}\n\n${out.text}`}</div>
  )
}

/** The candidate saved with what changed, the inbox kept waiting first. */
const save = (ctx, r, change, said) => ctx.commit({
  inbox: (ctx.doc?.inbox || []).map((x) => (x.id === r.id ? { ...r, ...change } : x))
    .sort((a, b) => (RANK[a.status] ?? 0) - (RANK[b.status] ?? 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
}, said)

async function approve(r, ctx) {
  const out = makes(r, ctx.doc)
  const svc = SVC[r.target], p = await projOf(svc)
  let id
  if (r.target === 'activity') {
    id = (await post(`/pp/${svc}/${p}/api/records`, { key: 'activities', record: out.record })).record.id
  } else {
    const n = await post(`/pp/${svc}/${p}/api/notes`, { title: out.title })
    await call(`/pp/${svc}/${p}/api/notes/${encodeURIComponent(n.id)}`,
      { method: 'PUT', body: JSON.stringify({ baseVersion: n.version, body: out.text }) })
    id = n.id
  }
  const change = { status: 'approved', decidedAt: now(), made: { svc, proj: p, id } }
  await save(ctx, r, change, tr('pm_ib_approved', r.target === 'note' ? r.title : r.name))
  return change
}

const openMade = (r, ctx) => ctx.openRecord?.({ ...r.made, label: r.target === 'note' ? r.title : r.name })

/** The buttons a candidate has where it stands: waiting [승인][버림],
 *  approved [열기], discarded [되살리기]. `after` hears what changed (the
 *  editor keeps its form in step). */
export function InboxActions({ r, ctx, after }) {
  if (!r?.id) return null
  const stop = (e) => e.stopPropagation()
  const run = (fn) => async (e) => {
    stop(e)
    try { const ch = await fn(); if (ch) after?.(ch) } catch (err) { ctx.say?.(String(err.message || err)) }
  }
  const out = makes(r, ctx.doc)
  const bad = missing(r, out)
  if (r.status === 'approved') {
    return r.made ? <button type="button" className="rl-btn" onClick={(e) => { stop(e); openMade(r, ctx) }}>{tr('pm_ib_open')}</button> : null
  }
  if (r.status === 'discarded') {
    return (
      <button type="button" className="rl-btn" onClick={run(async () => {
        const ch = { status: 'waiting', decidedAt: '', made: null }
        await save(ctx, r, ch, tr('pm_ib_restored'))
        return ch
      })}>{tr('pm_ib_restore')}</button>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4 }} onClick={stop}>
      <button type="button" className="rl-btn rl-go" disabled={!!bad} title={bad || undefined}
        onClick={run(() => approve(r, ctx))}>{tr('pm_ib_approve')}</button>
      <button type="button" className="rl-btn rl-danger" onClick={run(async () => {
        const ch = { status: 'discarded', decidedAt: now() }
        await save(ctx, r, ch, tr('pm_ib_discarded'))
        return ch
      })}>{tr('pm_ib_discard')}</button>
    </span>
  )
}
