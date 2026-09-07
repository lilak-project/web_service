import { useState } from 'react'
import { Button, Icon, copyText } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { useNarrowRef } from './useNarrowRef'

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
  const [err, setErr] = useState('')
  const viewOnly = service.view_only && !service.can_enter
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

  // Narrow (multi-column) card → status on line 1, the button(s) on the next line.
  const [wrapRef, narrow] = useNarrowRef(460)
  const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 0' }
  // Enter / Stop sized up to match the larger status line (touch-friendly on mobile).
  const btn = { height: 40, borderRadius: 10, padding: '0 16px', minWidth: 88,
    fontSize: 'var(--fs-medium, 14px)', justifyContent: 'center', flexShrink: 0, whiteSpace: 'nowrap' }

  return (
    <div ref={wrapRef} style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)' }}>
      {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--fs-small, 12px)', marginBottom: 6 }}>{err}</div>}
      <div style={row}>
        <span style={{ flexShrink: 0, width: 11, height: 11, borderRadius: '50%',
          background: (service.can_enter && service.running) ? 'var(--ok-text, #2f9e44)' : 'var(--border-strong, #bbb)' }} />
        <span style={{ fontSize: 'var(--fs-medium, 14px)', color: 'var(--text-secondary)' }}>
          {viewOnly ? t('portal_proj_view_only')
            : canRequest ? t('projects_request_hint')
            : service.running ? t('projects_running', service.port) : t('projects_stopped')}
        </span>
        {narrow ? <div style={{ flexBasis: '100%', height: 0 }} aria-hidden="true" /> : <div style={{ flex: 1 }} />}
        {canRequest ? (
          <Button variant="secondary" disabled={busy || service.requested} style={btn} onClick={request}>
            {service.requested ? t('projects_requested') : t('projects_request')}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || viewOnly} style={btn}
            onClick={() => (service.running ? enter() : start())}>
            {service.running ? t('portal_proj_open') : t('portal_proj_start')}
          </Button>
        )}
        {/* Stop is a manage-mode action only. */}
        {manage && service.can_enter && service.running && (
          <Button variant="secondary" disabled={busy} style={btn} onClick={stop}>{t('projects_stop')}</Button>
        )}
      </div>
      {canManage && <ElogAddress service={service} />}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  paddingTop: 10, marginTop: 2, borderTop: '1px dashed var(--border-subtle)' }}>
      <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', flexShrink: 0 }}>
        {t('elog_addr')}
      </span>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)',
                     background: 'var(--surface-2)', color: 'var(--text-primary)',
                     padding: '3px 8px', borderRadius: 6, minWidth: 0,
                     overflowWrap: 'anywhere' }}>{addr}</code>
      <Button variant="ghost" size="sm" onClick={copy} title={t('elog_addr_hint')}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('copied') : t('copy')}
      </Button>
    </div>
  )
}
