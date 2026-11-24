import { Fragment, useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/**
 * SyncAll — every service's link to another portal, in one place (Settings → Sync).
 *
 * The service's own panel (manage mode) still links one service or one project;
 * this asks one main for all of them at once (one pin), approves another
 * server's whole request at once, and syncs every link now.
 *
 * A link's first sync never costs this server its data: a main with nothing
 * there is given this server's copy, and anything replaced is zipped to
 * data/_backups first.
 */
const mono = { fontFamily: 'var(--font-mono)' }

export default function SyncAll() {
  const { lang } = useLang()
  const [rows, setRows] = useState(null)
  const [asked, setAsked] = useState([])
  const [url, setUrl] = useState('')
  const [live, setLive] = useState(true)
  const [pick, setPick] = useState(null)        // services ticked; null = every one not linked yet
  const [sent, setSent] = useState(null)        // { pin, results } of the last request
  const [allowTwo, setAllowTwo] = useState(true)
  const flash = (m, tone) => notify(m, tone)
  const err = (e) => flash(e?.response?.data?.detail || String(e), 'bad')

  const load = () => launcher.get('/admin/sync-all').then((r) => setRows(r.data)).catch(err)
  const loadAsked = () => launcher.get('/admin/sync-all/requests').then((r) => setAsked(r.data)).catch(() => {})
  useEffect(() => { load(); loadAsked() }, [])

  // While anything is moving (a sync running, a request waiting on main): look again.
  const moving = (rows || []).some((r) => r.busy || r.pending.some((p) => p.status === 'pending')
    || r.links.some((l) => l.busy))
  useEffect(() => {
    const a = moving ? setInterval(load, 4000) : null
    const b = setInterval(loadAsked, 10000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [moving])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <div className="set-msg">…</div>

  const free = rows.filter((r) => !r.role)
  const chosen = pick ?? new Set(free.map((r) => r.svc))
  const toggle = (svc) => setPick(() => {
    const n = new Set(chosen); n.has(svc) ? n.delete(svc) : n.add(svc); return n
  })
  const subs = rows.filter((r) => r.role === 'sub' || r.links.some((l) => l.role === 'sub'))

  async function request() {
    try {
      const { data } = await launcher.post('/admin/sync-all/request',
        { url: url.trim(), live, services: [...chosen] })
      setSent(data); setPick(new Set())   // sent: tick nothing again until the next pick
      const bad = data.results.filter((x) => !x.ok).length
      flash(tr('p_sa_sent', data.results.length - bad, data.pin), bad ? 'warn' : 'ok')
      load()
    } catch (e) { err(e) }
  }
  async function runAll() {
    try {
      const { data } = await launcher.post('/admin/sync-all/run')
      flash(tr('p_sa_started', data.started.filter((x) => x.job_id).length), 'ok')
      setTimeout(load, 500)
    } catch (e) { err(e) }
  }
  async function decide(g, action) {
    try {
      const { data } = await launcher.post('/admin/sync-all/requests/decide',
        { batch: g.batch, action, accept_push: allowTwo })
      const bad = data.results.filter((x) => !x.ok)
      flash(bad.length ? bad.map((x) => `${x.svc}: ${x.error}`).join(' · ')
        : (action === 'approve' ? tr('p_sa_approved', data.results.length) : tr('p_rejected')),
      bad.length ? 'warn' : 'ok')
      loadAsked(); load()
    } catch (e) { err(e) }
  }

  const state = (r) => {
    if (r.role === 'main') return <Pill tone="ok">main{r.accept_push ? ' ⇄' : ''}</Pill>
    if (r.role === 'sub') return <Pill tone={r.last_error ? 'bad' : 'ok'}>sub{r.two_way ? ' ⇄' : ' ←'}</Pill>
    const p = r.pending.find((x) => x.status === 'pending')
    if (p) return <Pill tone="warn">{tr('p_waiting')}</Pill>
    return <Pill>{tr('p_off')}</Pill>
  }

  return (
    <>
      <Tunnels />
      <Panel title={tr('p_sa_requests')} hint={asked.length ? String(asked.length) : ''}>
        {asked.length === 0 && <Field label="">{<span style={fieldMuted}>{tr('p_sa_no_requests')}</span>}</Field>}
        {asked.map((g) => (
          <Fragment key={g.batch}>
            <Field label={tr('p_pin')}>
              <b style={mono}>{g.pin}</b>
              <span style={fieldMuted}>{g.from_name || '?'} ({g.from_url || '?'}) · {g.by || '?'}</span>
            </Field>
            <Field label={tr('p_sa_services')}>
              <span style={mono}>
                {g.items.map((it) => `${it.svc}${it.project ? `/${it.project}` : ''}${it.two_way ? ' ⇄' : ''}`).join(', ')}
              </span>
            </Field>
            <FieldActions>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, ...fieldMuted }}>
                <input type="checkbox" checked={allowTwo} onChange={(e) => setAllowTwo(e.target.checked)} />
                {tr('p_allow_two_way')}
              </label>
              <Button variant="primary" style={{ minWidth: 150 }} onClick={() => decide(g, 'approve')}>{tr('p_sa_approve_all', g.items.length)}</Button>
              <Button variant="dangerSoft" onClick={() => decide(g, 'reject')}>{tr('p_reject')}</Button>
            </FieldActions>
          </Fragment>
        ))}
      </Panel>

      <Panel title={tr('p_sa_services_here')}
        right={<Button variant="secondary" onClick={load}>{tr('p_refresh')}</Button>}>
        {rows.map((r) => (
          <Field key={r.svc} label={r.svc}>
            {!r.role && (
              <input type="checkbox" checked={chosen.has(r.svc)} onChange={() => toggle(r.svc)}
                title={tr('p_sa_include')} />
            )}
            {state(r)}
            {r.db && <Pill>{tr('p_sa_db')}</Pill>}
            <span style={{ ...fieldMuted, ...mono }}>
              {r.main_url || ''}
              {r.busy ? ` · ${tr('p_syncing')}` : r.last_sync ? ` · ${r.last_sync}` : ''}
              {r.last_error ? ` · ${r.last_error}` : ''}
              {r.pending.map((p) => (p.status === 'pending'
                ? ` · ${p.url} ${tr('p_pin')} ${p.bpin || p.pin}`
                : ` · ${p.url} ${p.error || p.status}`)).join('')}
              {r.links.length ? ` · ${tr('p_sa_own_links', r.links.length)}` : ''}
            </span>
          </Field>
        ))}
        <FieldActions>
          <Button variant="primary" disabled={!subs.length} onClick={runAll}>{tr('p_sa_sync_all')}</Button>
          <span style={fieldMuted}>{tr('p_sa_sync_all_hint')}</span>
        </FieldActions>
      </Panel>

      <Panel title={tr('p_sa_link_all')}>
        <Field label={tr('p_sa_main_address')}>
          <input style={{ ...fieldInput, flex: 1, minWidth: 220, ...mono }} value={url}
            onChange={(e) => setUrl(e.target.value)} placeholder="https://main.example.org" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, ...fieldMuted }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            {tr('p_live')}
          </label>
        </Field>
        <Field label={tr('p_what_this_is')}>{tr('p_sa_link_hint')}</Field>
        <FieldActions>
          <Button style={{ minWidth: 190 }} variant="primary" disabled={!url.trim() || !chosen.size} onClick={request}>
            {tr('p_sa_ask', chosen.size)}
          </Button>
          {sent && <span style={fieldMuted}>{tr('p_pin')} <b style={mono}>{sent.pin}</b></span>}
        </FieldActions>
        {sent && sent.results.filter((x) => !x.ok).map((x) => (
          <Field key={x.svc} label={x.svc}><span style={{ color: 'var(--dock-danger-text)' }}>{x.error}</span></Field>
        ))}
      </Panel>
      <History />
    </>
  )
}

/** Link requests sent and received, kept folded: what was asked, of whom, how it went. */
function History() {
  const [rows, setRows] = useState(null)
  useEffect(() => { launcher.get('/admin/sync-all/history').then((r) => setRows(r.data)).catch(() => setRows([])) }, [])
  if (!rows) return null
  const when = (t) => (t ? new Date(t * 1000).toLocaleString() : '—')
  return (
    <Panel fold open={false} title={tr('p_sa_history')} hint={String(rows.length)}>
      {rows.length === 0 && <Field label="">{tr('p_sa_no_requests')}</Field>}
      {rows.map((r, i) => (
        <Field key={i} label={`${r.dir === 'sent' ? '→' : '←'} ${r.svc}${r.project ? '/' + r.project : ''}`}>
          <span style={{ ...fieldMuted, ...mono }}>{when(r.at)}</span>
          <span style={mono}>{r.url}{r.name ? ` (${r.name})` : ''}{r.by ? ` · ${r.by}` : ''}</span>
          <Pill tone={['joined', 'approved'].includes(r.status) ? 'ok' : ['pending', 'held'].includes(r.status) ? 'warn' : undefined}>{r.status}</Pill>
          {/* The other server held the request with an opinion: what it said. */}
          {(r.comments || []).map((m, j) => <span key={j} style={fieldMuted}>{m.by}: {m.text}</span>)}
          {r.pin && <span style={fieldMuted}>{tr('p_pin')} <b style={mono}>{r.pin}</b></span>}
          {r.error && <span style={{ color: 'var(--dock-danger-text)' }}>{r.error}</span>}
        </Field>))}
    </Panel>
  )
}

// SSH tunnels from this Mac (~/.ssh/config Hosts with a LocalForward). The
// server answers an empty list anywhere but a Mac, so the panel stays away there.
function Tunnels() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState('')
  const load = () => launcher.get('/admin/system/tunnels').then((r) => setList(r.data)).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [])
  async function act(name, what) {
    setBusy(name)
    try { await launcher.post(`/admin/system/tunnels/${encodeURIComponent(name)}/${what}`) }
    catch (e) { notify(e?.response?.data?.detail || String(e), 'bad') }
    setBusy(''); load()
  }
  if (!list.length) return null
  return (
    <Panel title={tr('p_tunnels')} right={<Button variant="secondary" onClick={load}>{tr('p_refresh')}</Button>}>
      {list.map((t) => (
        <Field key={t.name} label={t.name}>
          {t.up ? <Pill tone="ok">{tr('p_tunnel_up')}</Pill> : <Pill>{tr('p_tunnel_down')}</Pill>}
          <span style={{ ...fieldMuted, ...mono, flex: 1 }}>localhost:{t.port} → {t.hostname || t.name} {t.to}</span>
          {t.up && <Button variant="secondary" onClick={() => window.open(`http://localhost:${t.port}`, '_blank')}>{tr('p_tunnel_open')}</Button>}
          <Button variant={t.up ? 'secondary' : 'primary'} style={{ minWidth: 90 }} disabled={busy === t.name}
            onClick={() => act(t.name, t.up ? 'down' : 'up')}>
            {busy === t.name ? '…' : tr(t.up ? 'p_tunnel_disconnect' : 'p_tunnel_connect')}
          </Button>
        </Field>
      ))}
      <Field label="">{<span style={fieldMuted}>{tr('p_tunnel_hint')}</span>}</Field>
    </Panel>
  )
}
