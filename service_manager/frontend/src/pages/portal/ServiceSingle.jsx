import { useState } from 'react'
import { Button, Icon, copyText } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Field, FieldActions, Pill, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/**
 * ServiceSingle — inline panel for a single (non-multi-project) service, shown
 * when its Home card is opened. It exposes the service's one instance as a row —
 * the same Enter / Start / Stop controls a project gets — so single services and
 * multi-project services feel the same in the list. Entering opens the service
 * through the `/p/<svc>/` proxy (SSO token handed over).
 */
export default function ServiceSingle({ service, canManage, manage = false, onRequest, onChanged }) {
  const { t } = useLang()
  const svc = service.name
  const [busy, setBusy] = useState(false)
  const setErr = (m) => m && notify(m, 'bad')
  // The service list flags a lapsed verification as view_only WITH can_enter
  // still true (the grant exists), but the proxy refuses entry until the
  // account re-verifies — so view_only alone is what blocks the door.
  const viewOnly = !!service.view_only
  // No access yet, but the user may ask for it — handled inside the card body.
  const canRequest = !service.can_enter && !viewOnly && service.can_request

  function enter() {
    // SSO handoff (same origin): hand the proxied service the portal token.
    const tok = localStorage.getItem('lilak_portal_token')
    if (tok) localStorage.setItem('elog_token', tok)
    window.open(`/p/${svc}/`, '_blank')
  }
  async function start() {
    setBusy(true); setErr('')
    try { await launcher.post(`/projects/${svc}/start`); enter(); onChanged?.() }
    catch (e) { setErr(e?.response?.data?.detail || t('portal_proj_start_fail')) }
    finally { setBusy(false) }
  }
  async function stop() {
    setBusy(true)
    try { await launcher.post(`/projects/${svc}/stop`); onChanged?.() }
    finally { setBusy(false) }
  }
  async function request() {
    if (!onRequest) return
    setBusy(true); setErr('')
    try { await onRequest() }
    catch (e) { setErr(e?.response?.data?.detail || t('projects_request_fail')) }
    finally { setBusy(false) }
  }

  return (
    <div className="svc-mg">
      <Panel title={service.label || service.name} hint={service.name}>
        <Field label={t('projects_state')}>
          {viewOnly ? <Pill>{t('portal_proj_view_only')}</Pill>
            : canRequest ? <Pill tone="warn">{t('projects_request_hint')}</Pill>
              : service.running ? <Pill tone="ok">{t('projects_running', service.port)}</Pill>
                : <Pill>{t('projects_stopped')}</Pill>}
        </Field>
        <FieldActions>
          {canRequest ? (
            <Button variant="secondary" disabled={busy || service.requested} onClick={request}>
              {service.requested ? t('projects_requested') : t('projects_request')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || viewOnly}
              onClick={() => (service.running ? enter() : start())}>
              {service.running ? t('portal_proj_open') : t('portal_proj_start')}
            </Button>
          )}
          {/* Stop is a manage-mode action only. */}
          {manage && service.can_enter && service.running && (
            <Button variant="warning" disabled={busy} onClick={stop}>{t('projects_stop')}</Button>
          )}
        </FieldActions>

        {canManage && <ElogAddress service={service} />}
      </Panel>
    </div>
  )
}

/**
 * The address to register this service under in elog.
 *
 * Written on the card because it is the one thing you need at the moment you are
 * looking at a service and cannot derive by eye: a portal-managed service takes
 * its port from a pool at start time, so its real address changes, and the
 * `portal://` form is what elog resolves per call instead of pinning a number
 * that will be wrong tomorrow. An external service has a fixed address already,
 * so that is what it gets — and `portal://` would not resolve for it anyway.
 *
 * Shown to managers only: it is a registration detail, not something a shifter
 * opening the card needs to read past.
 */
function ElogAddress({ service }) {
  const { t } = useLang()
  const [copied, setCopied] = useState(false)
  const addr = service.mode === 'external'
    ? `${(service.url || '').replace(/\/$/, '')}/api/elog`
    : `portal://${service.name}/api/elog`

  async function copy() {
    // copyText falls back to execCommand: over plain http (a LAN or VPN address)
    // navigator.clipboard does not exist and the button used to do nothing.
    if (await copyText(addr)) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  return (
    <>
      <Field label={t('elog_addr')}>
        <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)',
          color: 'var(--text-primary)', padding: '2px 8px', borderRadius: 'var(--rack-radius, 0)',
          minWidth: 0, overflowWrap: 'anywhere' }}>{addr}</code>
      </Field>
      <FieldActions>
        <Button variant="secondary" onClick={copy} title={t('elog_addr_hint')}>
          <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('copied') : t('copy')}
        </Button>
        <span style={fieldMuted}>{t('elog_addr_hint')}</span>
      </FieldActions>
    </>
  )
}
