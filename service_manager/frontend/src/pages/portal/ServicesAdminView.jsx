import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import ServiceManage from './ServiceManage'

/**
 * ServicesAdminView — the portal admin's SERVICE-management screen (inline).
 * Register a service (managed/external) and configure each service's visibility /
 * removal. Per-account permissions live in the Users screen; per-project
 * create/manage lives in the Home (service) screen's inline panel.
 */

const VIS_OPTS = [
  { v: 1, key: 'portal_vis_private' },
  { v: 2, key: 'portal_vis_protected' },
  { v: 3, key: 'portal_vis_admin' },
]
const sectionHdr = { fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)', margin: '4px 0 8px' }
const kindBadge = { fontSize: 'var(--fs-micro, 10px)', padding: '1px 6px', borderRadius: 999, backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }
const selectStyle = { height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 6px', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }
const card = { border: '1px solid var(--border-default)', borderRadius: 8, padding: 10, marginBottom: 8 }
const fieldStyle = { ...selectStyle, height: 28, flex: 1, minWidth: 0 }

export default function ServicesAdminView({ onChanged }) {
  const { t } = useLang()
  const [services, setServices] = useState([])
  const [users, setUsers] = useState([])
  const [managing, setManaging] = useState(null)   // service name expanded for management
  const [hs, setHs] = useState(null)          // handshake info {endpoint, register_token}
  const [copied, setCopied] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [err, setErr] = useState('')

  const hsSnippet = hs ? (
    `curl -X POST "${hs.endpoint}" \\\n` +
    `  -H "Authorization: Bearer ${hs.register_token}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"name":"myservice","kind":"dashboard","mode":"external",` +
    `"url":"https://YOUR-SERVICE-URL","health":"/health","accepts_portal_token":true}'`
  ) : ''

  async function copySnippet() {
    let ok = false
    try { await navigator.clipboard.writeText(hsSnippet); ok = true }
    catch {
      try {
        const ta = document.createElement('textarea'); ta.value = hsSnippet
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove()
      } catch { /* selectable */ }
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  const blankReg = {
    name: '', kind: 'elog', mode: 'managed', visibility: 2,
    start_cmd: '', start_cwd: '', start_env: '', url: '', token: '', health: '/',
    accepts_portal_token: false, multi_project: false, import_export: false,
  }
  const [reg, setReg] = useState(blankReg)
  const [probe, setProbe] = useState(null)
  const [regMsg, setRegMsg] = useState('')
  const setR = (k) => (e) => setReg((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  function parseEnv(text) {
    const out = {}
    for (const line of (text || '').split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
    return out
  }

  async function load() {
    try {
      const [s, h, u] = await Promise.all([launcher.get('/admin/services'), launcher.get('/admin/handshake-info'), launcher.get('/admin/users')])
      setServices(s.data); setHs(h.data); setUsers(u.data)
    } catch (e) { setErr(e?.response?.data?.detail || t('portal_admin_load_fail')) }
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function setVis(name, v) {
    await launcher.put(`/admin/services/${name}`, { visibility: Number(v) })
    setServices((s) => s.map((x) => (x.name === name ? { ...x, visibility: Number(v) } : x)))
    onChanged?.()
  }
  async function removeService(name) {
    if (!window.confirm(t('portal_admin_remove_confirm', name))) return
    await launcher.delete(`/admin/services/${name}`); await load(); onChanged?.()
  }
  async function testConn() {
    setProbe(null); setRegMsg('')
    try { setProbe((await launcher.post('/admin/external-services/test', { url: reg.url.trim(), token: reg.token.trim() || undefined, health: reg.health.trim() || '/' })).data) }
    catch (e) { setProbe({ reachable: false }); setRegMsg(e?.response?.data?.detail || '') }
  }
  async function registerService() {
    setRegMsg('')
    try {
      await launcher.post('/admin/services', {
        name: reg.name.trim(), kind: reg.kind.trim() || 'elog', mode: reg.mode,
        visibility: Number(reg.visibility), accepts_portal_token: reg.accepts_portal_token,
        multi_project: reg.multi_project, import_export: reg.import_export, health: reg.health.trim() || '/',
        start_cmd: reg.mode === 'managed' ? (reg.start_cmd.trim() || undefined) : undefined,
        start_cwd: reg.mode === 'managed' ? (reg.start_cwd.trim() || undefined) : undefined,
        start_env: reg.mode === 'managed' ? parseEnv(reg.start_env) : undefined,
        url: reg.mode === 'external' ? reg.url.trim() : undefined,
        token: reg.mode === 'external' ? (reg.token.trim() || undefined) : undefined,
      })
      setReg(blankReg); setProbe(null); setRegMsg(t('portal_ext_added')); await load(); onChanged?.()
    } catch (e) { setRegMsg(e?.response?.data?.detail || t('portal_ext_fail')) }
  }

  return (
    <div>
      {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--fs-small, 12px)', marginBottom: 10 }}>{err}</div>}

      {/* Primary path: a service self-registers via handshake. Paste this into the
          service (set the portal URL + token); the long manual form is a fallback. */}
      <div style={sectionHdr}>{t('portal_hs_title')}</div>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{t('portal_hs_desc')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="secondary" onClick={copySnippet} disabled={!hs}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('portal_guide_copied') : t('portal_guide_copy')}
          </Button>
        </div>
        <pre style={{ margin: 0, padding: 10, borderRadius: 6, background: 'var(--surface-3, var(--surface-2))',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny, 11px)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          color: 'var(--text-primary)' }}>{hsSnippet || '…'}</pre>
        <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>
          {t('portal_hs_guide_hint')}
        </div>
      </div>

      <div style={sectionHdr}>{t('portal_admin_services')}</div>
      {services.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{t('projects_empty')}</div>
      ) : services.map((svc) => (
        <div key={svc.name} style={{ borderTop: '1px solid var(--border-subtle)', padding: '7px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--fs-small, 13px)' }}>{svc.name}</span>
            <span style={kindBadge}>{svc.kind}</span>
            {svc.mode === 'external' && <span style={kindBadge}>external</span>}
            {svc.multi_project && <span style={kindBadge}>{t('portal_reg_multi')}</span>}
            {svc.import_export && <span style={kindBadge}>I/E</span>}
            <div style={{ flex: 1 }} />
            <Button size="sm" variant={managing === svc.name ? 'secondary' : 'ghost'}
              onClick={() => setManaging((m) => (m === svc.name ? null : svc.name))}>
              {managing === svc.name ? t('portal_proj_close') : t('portal_svc_manage')}
            </Button>
            <select value={svc.visibility} onChange={(e) => setVis(svc.name, e.target.value)} style={selectStyle}>
              {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
            </select>
            <Button size="sm" variant="ghost" icon title={t('portal_admin_remove')} onClick={() => removeService(svc.name)}><Icon name="trash" size={14} /></Button>
          </div>
          {managing === svc.name && <ServiceManage svc={svc} users={users} />}
        </div>
      ))}

      <div style={{ ...sectionHdr, marginTop: 18, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setShowManual((v) => !v)}>
        <Icon name={showManual ? 'close' : 'plus'} size={12} /> {t('portal_admin_register_manual')}
      </div>
      {showManual && (
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input placeholder={t('portal_ext_name')} value={reg.name} onChange={setR('name')} style={fieldStyle} />
          <input placeholder={t('portal_ext_kind')} value={reg.kind} onChange={setR('kind')} style={{ ...fieldStyle, maxWidth: 88 }} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={reg.mode} onChange={setR('mode')} style={{ ...fieldStyle, maxWidth: 130 }}>
            <option value="managed">{t('portal_reg_managed')}</option>
            <option value="external">{t('portal_reg_external')}</option>
          </select>
          <select value={reg.visibility} onChange={setR('visibility')} style={{ ...fieldStyle, maxWidth: 130 }}>
            {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
          </select>
          <input placeholder={t('portal_ext_health')} value={reg.health} onChange={setR('health')} style={{ ...fieldStyle, maxWidth: 120 }} />
        </div>
        {reg.mode === 'managed' ? (
          <>
            <input placeholder={t('portal_reg_cmd')} value={reg.start_cmd} onChange={setR('start_cmd')} style={fieldStyle} />
            <input placeholder={t('portal_reg_cwd')} value={reg.start_cwd} onChange={setR('start_cwd')} style={fieldStyle} />
            <textarea placeholder={t('portal_reg_env')} value={reg.start_env} onChange={setR('start_env')}
              rows={2} style={{ ...fieldStyle, height: 'auto', padding: '6px 10px', fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
          </>
        ) : (
          <>
            <input placeholder={t('portal_ext_url')} value={reg.url} onChange={setR('url')} style={fieldStyle} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input placeholder={t('portal_ext_token')} value={reg.token} onChange={setR('token')} style={fieldStyle} />
              <Button size="sm" variant="ghost" disabled={!reg.url.trim()} onClick={testConn}>{t('portal_ext_test')}</Button>
              {probe && (
                <span style={{ fontSize: 'var(--fs-small, 12px)', whiteSpace: 'nowrap', color: probe.reachable ? 'var(--ok-text, #2f9e44)' : 'var(--danger-text)' }}>
                  {probe.reachable ? `✓ ${t('portal_ext_reachable')}` : `✕ ${t('portal_ext_unreachable')}`}{probe.status ? ` (${probe.status})` : ''}
                </span>
              )}
            </div>
          </>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', marginTop: 2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}><input type="checkbox" checked={reg.accepts_portal_token} onChange={setR('accepts_portal_token')} /> {t('portal_ext_sso')}</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}><input type="checkbox" checked={reg.multi_project} onChange={setR('multi_project')} /> {t('portal_reg_multi')}</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: reg.multi_project ? 0.6 : 1 }}
            title={reg.multi_project ? t('portal_reg_ie_implied') : undefined}>
            <input type="checkbox" checked={reg.import_export || reg.multi_project} disabled={reg.multi_project} onChange={setR('import_export')} /> {t('portal_reg_importexport')}</label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {regMsg && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{regMsg}</span>}
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="primary" disabled={!reg.name.trim() || (reg.mode === 'external' && !reg.url.trim())} onClick={registerService}>{t('portal_ext_register')}</Button>
        </div>
      </div>
      )}
    </div>
  )
}
