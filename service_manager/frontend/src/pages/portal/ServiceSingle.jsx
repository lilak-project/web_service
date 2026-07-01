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
export default function ServiceSingle({ service, canManage, onChanged }) {
  const { t } = useLang()
  const svc = service.name
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const viewOnly = service.view_only && !service.can_enter

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

  const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }

  return (
    <div style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)' }}>
      {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--fs-small, 12px)', marginBottom: 6 }}>{err}</div>}
      <div style={row}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: service.running ? 'var(--ok-text, #2f9e44)' : 'var(--border-strong, #bbb)' }} />
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
          {viewOnly ? t('portal_proj_view_only')
            : service.running ? t('projects_running', service.port) : t('projects_stopped')}
        </span>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="primary" disabled={busy || viewOnly}
          onClick={() => (service.running ? enter() : start())}>
          {service.running ? t('portal_proj_open') : t('portal_proj_start')}
        </Button>
        {canManage && service.running && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={stop}>{t('projects_stop')}</Button>
        )}
      </div>
    </div>
  )
}
