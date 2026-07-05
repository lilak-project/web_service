import { useEffect, useRef, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { DEFAULT_ICON, ICON_CHOICES } from './IconPick'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

/**
 * NewServiceView — the in-portal "create an empty service" form (opened from the
 * admin-only Home card). Enter a name + tab list; the portal scaffolds a
 * lilak_ui-based service into the data volume, builds it, and registers it — all
 * via one async job whose progress we poll.
 *
 * The result is a real, portal-integrated service (SSO, portal-managed accounts,
 * default portal rules) that shows up in the Home list on completion.
 */

let _tabSeq = 1
// regular tabs get a random icon (re-rollable + click-to-pick); built-in tabs pass their own
const newTab = (over = {}) => ({ key: _tabSeq++, id: '', label: '', icon: rnd(ICON_CHOICES), kind: '', ...over })

const field = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px',
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}
const lbl = { fontSize: 'var(--fs-small, 12px)', fontWeight: 600, color: 'var(--text-secondary)' }

export default function NewServiceView({ onCreated }) {
  const { t, lang } = useLang()
  const [name, setName] = useState('')
  const [service, setService] = useState('')
  const [icon, setIcon] = useState(DEFAULT_ICON)
  const [color, setColor] = useState('#000000')
  const [commandBar, setCommandBar] = useState(true)   // collapsible bottom command bar
  const [tabs, setTabs] = useState(() => [newTab({ id: 'home', label: lang === 'ko' ? '홈' : 'Home', icon: 'home' })])
  const [job, setJob] = useState(null)          // {status, log, error, name}
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const poll = useRef(null)
  const logBox = useRef(null)

  useEffect(() => () => clearInterval(poll.current), [])
  useEffect(() => { if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight }, [job])

  const nameOk = /^[a-z][a-z0-9_]*$/.test(name)
  const running = job && (job.status === 'queued' || job.status === 'running')
  const done = job && job.status === 'done'

  function setTab(key, patch) { setTabs((ts) => ts.map((x) => (x.key === key ? { ...x, ...patch } : x))) }
  function delTab(key) { setTabs((ts) => ts.filter((x) => x.key !== key)) }

  async function create() {
    setErr('')
    if (!nameOk) { setErr(t('newsvc_name_bad')); return }
    const cleanTabs = tabs
      .map((x) => ({ id: x.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''), label: (x.label || x.id).trim(), icon: x.icon || 'circle', kind: x.kind || '' }))
      .filter((x) => x.id)
    if (!cleanTabs.length) { setErr(t('newsvc_tabs_bad')); return }
    const settings = cleanTabs.some((x) => x.kind === 'settings')   // a Settings tab was added
    setBusy(true)
    try {
      const { data } = await launcher.post('/admin/services/scaffold', {
        name, service: service.trim(), icon, tabs: cleanTabs, color, settings, command_bar: commandBar,
      })
      setJob({ status: 'queued', log: [], name: data.name })
      poll.current = setInterval(() => pollOnce(data.job_id), 1200)
    } catch (e) {
      setErr(e?.response?.data?.detail || t('newsvc_failed'))
    } finally { setBusy(false) }
  }

  async function pollOnce(jobId) {
    try {
      const { data } = await launcher.get(`/admin/services/scaffold/${jobId}`)
      setJob(data)
      if (data.status === 'done' || data.status === 'error') {
        clearInterval(poll.current)
        if (data.status === 'done') onCreated?.()
      }
    } catch { /* keep polling */ }
  }

  function reset() {
    clearInterval(poll.current); setJob(null); setName(''); setService('')
    _tabSeq = 1; setTabs([newTab({ id: 'home', label: lang === 'ko' ? '홈' : 'Home', icon: 'home' })])
    setErr('')
  }

  return (
    <div style={{ padding: '14px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 620 }}>
      <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{t('newsvc_intro')}</div>

      {/* name + brand + colour */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span style={lbl}>{t('newsvc_name')}</span>
          <input style={{ ...field, borderColor: name && !nameOk ? 'var(--danger-border, #e5484d)' : field.border }}
            value={name} placeholder="mysvc" disabled={!!job}
            onChange={(e) => setName(e.target.value.toLowerCase())} />
          <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)' }}>{t('newsvc_name_rule')}</span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 }}>
          <span style={lbl}>{t('newsvc_brand')}</span>
          <input style={field} value={service} placeholder={t('newsvc_brand_ph')} disabled={!!job}
            onChange={(e) => setService(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>{t('newsvc_icon')}</span>
          <div style={{ display: 'flex', alignItems: 'center', height: 30 }}>
            <IconPick value={icon} onChange={setIcon} disabled={!!job} color={color} />
          </div>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>{t('newsvc_color')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30 }}>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>&nbsp;</span>
          <div style={{ display: 'flex', alignItems: 'center', height: 30 }}>
            <Button variant="secondary" disabled={!!job} onClick={() => {
              setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS))
              setTabs((ts) => ts.map((x) => (x.kind ? x : { ...x, icon: rnd(ICON_CHOICES) })))   // re-roll regular tab icons
            }}>
              <Icon name="refresh" size={13} /> {t('newsvc_random')}
            </Button>
          </div>
        </label>
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={lbl}>{t('newsvc_tabs')}</span>
        {tabs.map((tb) => (
          <div key={tb.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={{ ...field, width: 120 }} value={tb.id} placeholder="id" disabled={!!job}
              onChange={(e) => setTab(tb.key, { id: e.target.value })} />
            <input style={{ ...field, flex: 1, minWidth: 0 }} value={tb.label} placeholder={t('newsvc_tab_label')} disabled={!!job}
              onChange={(e) => setTab(tb.key, { label: e.target.value })} />
            <IconPick value={tb.icon} disabled={!!job} onChange={(ic) => setTab(tb.key, { icon: ic })} />
            {/* built-in kind badge (community / settings tabs added via the buttons below) */}
            <span style={{ width: 72, flexShrink: 0, textAlign: 'center', fontSize: 'var(--fs-tiny, 11px)',
              color: tb.kind ? 'var(--info-text)' : 'var(--text-muted)',
              background: tb.kind ? 'var(--info-bg)' : 'transparent', borderRadius: 999, padding: '2px 0' }}>
              {tb.kind === 'community' ? t('newsvc_tab_kind_community')
                : tb.kind === 'settings' ? t('newsvc_tab_kind_settings')
                : t('newsvc_tab_kind_basic')}
            </span>
            <Button variant="ghost" icon disabled={!!job || tabs.length <= 1} onClick={() => delTab(tb.key)} title={t('newsvc_tab_del')}>
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
        {!job && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setTabs((ts) => [...ts, newTab()])}>
              <Icon name="plus" size={13} /> {t('newsvc_tab_add')}
            </Button>
            <Button variant="secondary" disabled={tabs.some((x) => x.kind === 'community')}
              onClick={() => setTabs((ts) => [...ts, newTab({ id: 'community', label: lang === 'ko' ? '커뮤니티' : 'Community', icon: 'community', kind: 'community' })])}>
              <Icon name="community" size={13} /> {t('newsvc_tab_add_community')}
            </Button>
            <Button variant="secondary" disabled={tabs.some((x) => x.kind === 'settings')}
              onClick={() => setTabs((ts) => [...ts, newTab({ id: 'set', label: lang === 'ko' ? '설정' : 'Settings', icon: 'settings', kind: 'settings' })])}>
              <Icon name="settings" size={13} /> {t('newsvc_tab_add_settings')}
            </Button>
          </div>
        )}
      </div>

      {!job && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={commandBar} onChange={(e) => setCommandBar(e.target.checked)} />
          {t('newsvc_command_bar')}
        </label>
      )}

      {err && (
        <div style={{ padding: '8px 10px', borderRadius: 8, fontSize: 'var(--fs-small, 12px)',
          backgroundColor: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{err}</div>
      )}

      {/* actions */}
      {!job ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={busy || !nameOk} onClick={create}>
            <Icon name="plus" size={14} /> {t('newsvc_create')}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-small, 12px)', fontWeight: 600 }}>
            {running && <Icon name="loader" size={14} />}
            {done && <Icon name="check" size={14} style={{ color: 'var(--success-text, #2e7d32)' }} />}
            {job.status === 'error' && <Icon name="x" size={14} style={{ color: 'var(--danger-text)' }} />}
            <span>
              {running ? t('newsvc_building', job.name)
                : done ? t('newsvc_done', job.name)
                : t('newsvc_error')}
            </span>
          </div>
          {job.error && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{job.error}</div>}
          <pre ref={logBox} style={{
            margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 'var(--fs-micro, 10px)', lineHeight: 1.5,
            backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap',
          }}>{(job.log || []).join('\n') || '…'}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            {done && <Button variant="primary" onClick={() => window.open(`/p/${job.name}/`, '_blank')}>
              <Icon name="external-link" size={13} /> {t('newsvc_enter')}
            </Button>}
            {!running && <Button variant="secondary" onClick={reset}>{t('newsvc_again')}</Button>}
          </div>
        </div>
      )}
    </div>
  )
}
