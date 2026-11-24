import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { Panel, Field, Pill, fieldChip, fieldMuted } from './Field'
import { notify } from './settingsMsg'
import { McpTokens } from './SystemAdmin'

// Manager-only: which Claude/Codex clients reach /mcp, from where, as whom, through which share set.
// Connections are the MCP clients the portal saw in the last 7 days (kept in the DB).
const ago = (sec) => {
  const s = Math.max(0, Date.now() / 1000 - sec)
  return s < 60 ? tr('p_mcp_now') : s < 3600 ? tr('p_mcp_min_ago', Math.round(s / 60))
    : s < 86400 ? tr('p_mcp_hour_ago', Math.round(s / 3600)) : tr('p_mcp_day_ago', Math.round(s / 86400))
}
const LIVE = 15 * 60   // seen within this many seconds = connected now

export default function McpView() {
  const [conns, setConns] = useState(null)
  const [tokens, setTokens] = useState([])
  const [sets, setSets] = useState([])
  const load = () => Promise.all([
    launcher.get('/admin/mcp-connections').then((r) => setConns(r.data)),
    launcher.get('/admin/mcp-tokens').then((r) => setTokens(r.data)),
    launcher.get('/share-sets').then((r) => setSets(r.data.sets || [])),
  ]).catch((e) => notify(e?.response?.data?.detail || String(e), 'bad'))
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])

  // Every set, plus any other scope a token carries ("" = the whole portal).
  const usable = tokens.filter((t) => !t.revoked && !t.expired)
  const scopes = [...new Set([...sets.map((s) => `set:${s.name}`), ...usable.map((t) => t.scope_label), ...(conns || []).map((c) => c.scope_label)])]
  const now = Date.now() / 1000
  const live = (conns || []).filter((c) => now - c.last < LIVE)

  return (
    <>
      <Panel title={tr('p_mcp_by_set')} right={<Button variant="secondary" onClick={load}>{tr('p_refresh')}</Button>}>
        {scopes.map((sc) => {
          const tk = usable.filter((t) => t.scope_label === sc)
          const on = live.filter((c) => c.scope_label === sc)
          return (
            <Field key={sc || '*'} label={sc ? sc.replace(/^set:/, '') : tr('p_mcp_all')}>
              <Pill tone={tk.length ? 'ok' : undefined}>{tr('p_mcp_n_tokens', tk.length)}</Pill>
              <Pill tone={on.length ? 'ok' : undefined}>{tr('p_mcp_n_live', on.length)}</Pill>
              {tk.map((t) => <span key={t.id} style={fieldChip}>{t.name}{t.can_write ? ' ✎' : ''}</span>)}
            </Field>
          )
        })}
      </Panel>

      <Panel fold title={tr('p_mcp_connections')} hint={tr('p_mcp_conn_hint')}>
        {conns && !conns.length && <Field label="—">{tr('p_mcp_no_conn')}</Field>}
        {(conns || []).map((c, i) => (
          <Field key={i} label={c.client || c.agent.split(' ')[0] || tr('p_mcp_unknown_client')}>
            <Pill tone={now - c.last < LIVE ? 'ok' : undefined}>{ago(c.last)}</Pill>
            <Pill>{c.scope_label ? c.scope_label.replace(/^set:/, '') : tr('p_mcp_all')}</Pill>
            <span style={fieldChip}>{c.token}{c.write ? ' ✎' : ''}</span>
            <span style={fieldChip}>{c.owner}</span>
            <span style={fieldMuted}>
              {c.where} · {tr('p_mcp_calls', c.calls)}{c.tool ? ` (${c.tool})` : ''} · {tr('p_mcp_since')} {ago(c.first)}
            </span>
          </Field>
        ))}
      </Panel>

      <McpTokens onChanged={load} />
    </>
  )
}
