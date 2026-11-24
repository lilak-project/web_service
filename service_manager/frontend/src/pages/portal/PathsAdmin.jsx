import Select from 'lilak-ui/components/Select.jsx'
import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher } from '../../api'
import { Panel, Row, Pill, Field, FieldActions, fieldInput, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/**
 * PathsAdmin — the host paths, outside the portal's data folder, each service may use
 * (app/routers/reach.py). A service asks the portal before it reads or writes one; a path
 * nobody answered waits here. A manager approves, blocks, adds or takes off paths per
 * service, lets one service (or all) use anything, or blocks one (or all) outright.
 * This portal's alone: nothing here is synced to another server.
 */
const TONE = { approved: 'ok', blocked: 'bad', waiting: 'warn' }

export default function PathsAdmin({ onChanged }) {
  const [d, setD] = useState(null)
  const [add, setAdd] = useState({ service: '', path: '' })
  const fail = (e) => notify(e?.response?.data?.detail || tr('p_failed'), 'bad')
  const took = (r) => { setD(r.data); onChanged?.(); window.dispatchEvent(new Event('portal:requests')) }
  useEffect(() => { launcher.get('/admin/reach').then((r) => setD(r.data)).catch(fail) }, [])
  if (!d) return null

  const word = { approved: tr('p_paths_approved'), blocked: tr('p_paths_blocked'), waiting: tr('p_req_waiting') }
  const mode = (service, m) => launcher.put('/admin/reach/mode', { service, mode: m }).then(took).catch(fail)
  const put = (service, path, status) => launcher.post('/admin/reach/paths', { service, path, status }).then(took).catch(fail)
  const drop = (service, path) => launcher.delete('/admin/reach/paths', { data: { service, path } }).then(took).catch(fail)
  const addPath = () => {
    if (!add.service || !add.path.trim()) { notify(tr('p_paths_need'), 'bad'); return }
    put(add.service, add.path.trim(), 'approved').then(() => setAdd((a) => ({ ...a, path: '' })))
  }
  const modes = (value, onPick, label) => (
    <Select value={value} onChange={(e) => onPick(e.target.value)} style={{ ...fieldInput, maxWidth: 200 }} aria-label={label}>
      <option value="list">{tr('p_paths_mode_list')}</option>
      <option value="allow">{tr('p_paths_mode_allow')}</option>
      <option value="block">{tr('p_paths_mode_block')}</option>
    </Select>
  )
  const waiting = d.services.flatMap((s) => s.paths.filter((p) => p.status === 'waiting').map((p) => ({ ...p, service: s.name })))

  return (
    <div>
      <Panel title={tr('p_paths_all')}>
        <Field label={tr('p_paths_every')}>
          {modes(d.all, (m) => mode('', m), tr('p_paths_every'))}
          {d.all !== 'list' && <Pill tone={d.all === 'allow' ? 'warn' : 'bad'}>{tr(d.all === 'allow' ? 'p_paths_all_allowed' : 'p_paths_all_blocked')}</Pill>}
        </Field>
        <Field label={tr('p_what_this_is')}><span style={fieldMuted}>{tr('p_paths_hint')}</span></Field>
      </Panel>

      {waiting.length > 0 && (
        <Panel bare title={tr('p_paths_waiting')} hint={String(waiting.length)}>
          {waiting.map((p) => (
            <Row key={p.service + p.path}>
              <Pill>{p.service}</Pill>
              <span className="mono">{p.path}</span>
              {p.why && <span className="sub">{p.why}</span>}
              <span className="sp" />
              <Button variant="primary" onClick={() => put(p.service, p.path, 'approved')}>{tr('p_approve')}</Button>
              <Button variant="secondary" onClick={() => put(p.service, p.path, 'blocked')}>{tr('p_paths_block')}</Button>
            </Row>
          ))}
        </Panel>
      )}

      <Panel title={tr('p_paths_add')}>
        <Field label={tr('p_paths_add')}>
          <Select value={add.service} onChange={(e) => setAdd((a) => ({ ...a, service: e.target.value }))} style={{ ...fieldInput, maxWidth: 180 }}
            aria-label={tr('p_service_3')}>
            <option value="">{tr('p_service_3')}</option>
            {d.installed.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <input value={add.path} onChange={(e) => setAdd((a) => ({ ...a, path: e.target.value }))} placeholder="/data/run"
            onKeyDown={(e) => { if (e.key === 'Enter') addPath() }} aria-label={tr('p_paths_path')}
            style={{ ...fieldInput, flex: 1, minWidth: 220, fontFamily: 'var(--font-mono)' }} />
        </Field>
        <FieldActions>
          <Button variant="primary" onClick={addPath}>{tr('p_paths_add_btn')}</Button>
          <span style={fieldMuted}>{tr('p_paths_add_hint')}</span>
        </FieldActions>
      </Panel>

      {d.services.map((s) => (
        <Panel bare key={s.name} title={s.label === s.name ? s.name : `${s.label} · ${s.name}`} hint={String(s.paths.length)}
          right={modes(s.mode, (m) => mode(s.name, m), s.name)}>
          {s.paths.length === 0 && <Row className="empty">{tr('p_paths_none')}</Row>}
          {s.paths.map((p) => (
            <Row key={p.path}>
              <span className="mono">{p.path}</span>
              <Pill tone={TONE[p.status]}>{word[p.status] || p.status}</Pill>
              <span className="sub">{[p.why, p.by].filter(Boolean).join(' · ')}</span>
              <span className="sp" />
              {p.status !== 'approved' && <Button variant="secondary" onClick={() => put(s.name, p.path, 'approved')}>{tr('p_approve')}</Button>}
              {p.status !== 'blocked' && <Button variant="secondary" onClick={() => put(s.name, p.path, 'blocked')}>{tr('p_paths_block')}</Button>}
              <Button variant="dangerSoft" onClick={() => drop(s.name, p.path)}>{tr('p_remove_2')}</Button>
            </Row>
          ))}
        </Panel>
      ))}
      {d.services.length === 0 && <Panel bare title={tr('p_paths_title')}><Row className="empty">{tr('p_paths_nobody')}</Row></Panel>}
    </div>
  )
}
