import { useState } from 'react'
import { Button } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

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

  const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0' }
  // Enter / Stop sized up to match the larger status line (touch-friendly on mobile).
  const btn = { height: 40, borderRadius: 10, padding: '0 16px', minWidth: 88,
    fontSize: 'var(--fs-medium, 14px)', justifyContent: 'center', flexShrink: 0, whiteSpace: 'nowrap' }

  return (
    <div style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)' }}>
      {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--fs-small, 12px)', marginBottom: 6 }}>{err}</div>}
      <div style={row}>
        <span style={{ flexShrink: 0, width: 11, height: 11, borderRadius: '50%',
          background: (service.can_enter && service.running) ? 'var(--ok-text, #2f9e44)' : 'var(--border-strong, #bbb)' }} />
        <span style={{ fontSize: 'var(--fs-medium, 14px)', color: 'var(--text-secondary)' }}>
          {viewOnly ? t('portal_proj_view_only')
            : canRequest ? t('projects_request_hint')
            : service.running ? t('projects_running', service.port) : t('projects_stopped')}
        </span>
        <div style={{ flex: 1 }} />
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
    </div>
  )
}
