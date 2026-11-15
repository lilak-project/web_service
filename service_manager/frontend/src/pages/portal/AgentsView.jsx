import Select from 'lilak-ui/components/Select.jsx'
import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { Field, FieldActions, Panel, Row, Pill, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/** Account menu → Agents: the AI keys the portal holds (a manager's, or a
 *  project admin's for their projects) and the runs handed to platform agents. */
export default function AgentsView({ isManager, focus }) {
  const [keys, setKeys] = useState([])
  const [runs, setRuns] = useState([])
  const [k, setK] = useState({ name: '', provider: 'claude', kind: 'login', secret: '', uses: isManager ? 'portal' : '' })
  const [r, setR] = useState({ service: 'jobboard', project: 'jobboard', task: '', provider: 'claude', approval: 'human' })
  const load = () => {
    launcher.get('/agent/keys').then((x) => setKeys(x.data)).catch(() => {})
    launcher.get('/agent/runs').then((x) => setRuns(x.data)).catch(() => {})
  }
  useEffect(() => { load() }, [])
  // Opened for one run (a page sent `lilak:agent-run`): bring it into view.
  useEffect(() => {
    if (focus) document.getElementById(`ag-run-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus, runs.length])
  // A run in progress: look again until it settles.
  useEffect(() => {
    if (!runs.some((x) => x.status === 'queued' || x.status === 'running')) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [runs])
  const setKf = (f) => (e) => setK((s) => ({ ...s, [f]: e.target.value }))
  const setRf = (f) => (e) => setR((s) => ({ ...s, [f]: e.target.value }))
  const usesOf = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)

  async function addKey() {
    try {
      await launcher.post('/agent/keys', { ...k, uses: usesOf(k.uses) })
      setK((s) => ({ ...s, name: '', secret: '' })); notify(tr('ag_key_added'), 'ok'); load()
    } catch (e) { notify(errText(e, tr('p_failed')), 'bad') }
  }
  async function saveUses(key, text) {
    try { await launcher.put(`/agent/keys/${key.id}`, { uses: usesOf(text) }); load() }
    catch (e) { notify(errText(e, tr('p_failed')), 'bad') }
  }
  async function delKey(key) {
    try { await launcher.delete(`/agent/keys/${key.id}`); load() }
    catch (e) { notify(errText(e, tr('p_failed')), 'bad') }
  }
  async function addRun() {
    try { await launcher.post('/agent/runs', r); setR((s) => ({ ...s, task: '' })); load() }
    catch (e) { notify(errText(e, tr('p_failed')), 'bad') }
  }
  const tone = { done: 'ok', failed: 'bad', running: 'warn', queued: undefined }

  return (
    <>
      <Panel title={tr('ag_keys')} hint={tr('ag_keys_hint')}>
        {keys.length === 0 && <Row className="empty">{tr('ag_no_keys')}</Row>}
        {keys.map((x) => (
          <Field key={x.id} label={<>{x.name} <span style={fieldMuted}>{x.provider} · {x.kind === 'api' ? x.hint : tr('ag_kind_login')}</span></>}>
            <input defaultValue={x.uses.join(', ')} onBlur={(e) => e.target.value !== x.uses.join(', ') && saveUses(x, e.target.value)}
              style={{ ...fieldInput, flex: 1 }} aria-label={tr('ag_uses')} />
            <Button variant="dangerSoft" onClick={() => delKey(x)}>{tr('ag_delete')}</Button>
          </Field>
        ))}
        <Field label={tr('ag_new_key')}>
          <input value={k.name} onChange={setKf('name')} placeholder={tr('ag_name')} style={{ ...fieldInput, width: 130 }} />
          <Select value={k.provider} onChange={setKf('provider')} style={{ ...fieldInput, flex: 'none', minWidth: 130 }}>
            <option value="claude">Claude Code</option>
            <option value="openai">ChatGPT (Codex)</option>
          </Select>
          <Select value={k.kind} onChange={setKf('kind')} style={{ ...fieldInput, flex: 'none', minWidth: 150 }}>
            <option value="login">{tr('ag_kind_login')}</option>
            <option value="api">{tr('ag_kind_api')}</option>
          </Select>
          {k.kind === 'api' && (
            <input type="password" value={k.secret} onChange={setKf('secret')} placeholder="sk-…" autoComplete="off"
              style={{ ...fieldInput, flex: 1 }} data-1p-ignore data-lpignore="true" />
          )}
        </Field>
        <Field label={tr('ag_uses')}>
          <input value={k.uses} onChange={setKf('uses')} placeholder="portal, jobboard/jobboard" style={{ ...fieldInput, flex: 1 }} />
          <span style={fieldMuted}>{tr(isManager ? 'ag_uses_hint' : 'ag_uses_hint_pa')}</span>
        </Field>
        <FieldActions>
          <Button variant="primary" onClick={addKey}>{tr('ag_add_key')}</Button>
        </FieldActions>
      </Panel>

      <Panel title={tr('ag_runs')} hint={tr('ag_runs_hint')}>
        <Field label={tr('ag_where')}>
          <input value={r.service} onChange={setRf('service')} placeholder="service" style={{ ...fieldInput, width: 130 }} />
          <input value={r.project} onChange={setRf('project')} placeholder="project" style={{ ...fieldInput, width: 130 }} />
          <Select value={r.provider} onChange={setRf('provider')} style={{ ...fieldInput, flex: 'none', minWidth: 130 }}>
            <option value="claude">Claude Code</option>
            <option value="openai">ChatGPT (Codex)</option>
          </Select>
          <Select value={r.approval} onChange={setRf('approval')} style={{ ...fieldInput, flex: 'none', minWidth: 170 }}>
            <option value="human">{tr('ag_approval_human')}</option>
            <option value="similar">{tr('ag_approval_similar')}</option>
            <option value="auto">{tr('ag_approval_auto')}</option>
          </Select>
        </Field>
        <Field label={tr('ag_task')}>
          <textarea value={r.task} onChange={setRf('task')} rows={3} style={{ ...fieldInput, flex: 1, height: 'auto', padding: 8 }} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!r.task.trim()} onClick={addRun}>{tr('ag_run')}</Button>
          <span style={fieldMuted}>{tr('ag_run_hint')}</span>
        </FieldActions>
        {runs.map((x) => (
          <Field key={x.id} align="start" label={<><span id={`ag-run-${x.id}`} style={focus === String(x.id) ? { fontWeight: 600 } : undefined}>#{x.id}</span> <Pill tone={tone[x.status]}>{x.status}</Pill></>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
              <span>{x.service}{x.project ? `/${x.project}` : ''} · {x.provider} · {x.approval}
                {x.tokens_out != null && <span style={fieldMuted}> · {tr('ag_tokens', x.tokens_in, x.tokens_out)}{x.cost_usd ? ` · $${x.cost_usd}` : ''}</span>}</span>
              <span style={fieldMuted}>{x.task}</span>
              {x.result && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small)' }}>{x.result}</pre>}
            </div>
          </Field>
        ))}
      </Panel>
    </>
  )
}
