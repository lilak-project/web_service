import { useEffect, useRef, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { DEFAULT_ICON, ICON_CHOICES } from './IconPick'
import { Panel, Field, FieldActions, fieldInput, fieldMuted } from './Field'

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

const field = { ...fieldInput }

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
    <div className="svc-mg">
      {/* The intro is a paragraph, so it goes in a ROW, not in the strip: the
          strip is a fixed 42px and a paragraph there wraps the title with it. */}
      <Panel title={t('newsvc_title')}>
        <Field label={t('newsvc_title')}>{t('newsvc_intro')}</Field>

        <Field label={t('newsvc_name')}>
          <input style={{ ...field, flex: 1, borderColor: name && !nameOk ? 'var(--danger-text)' : undefined }}
            value={name} placeholder="mysvc" disabled={!!job}
            onChange={(e) => setName(e.target.value.toLowerCase())} />
          <span style={fieldMuted}>{t('newsvc_name_rule')}</span>
        </Field>

        <Field label={t('newsvc_brand')}>
          <input style={{ ...field, flex: 1 }} value={service} placeholder={t('newsvc_brand_ph')} disabled={!!job}
            onChange={(e) => setService(e.target.value)} />
        </Field>

        <Field label={t('newsvc_icon')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
            borderRadius: 'var(--rack-radius, 0)', border: '1px solid var(--border-strong)' }}>
            <Icon name={icon} size={20} weight="fill" color={color} />
          </span>
          <IconPick value={icon} onChange={setIcon} disabled={!!job} color={color} />
        </Field>

        <Field label={t('newsvc_color')}>
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="secondary" disabled={!!job} onClick={() => {
            setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS))
            setTabs((ts) => ts.map((x) => (x.kind ? x : { ...x, icon: rnd(ICON_CHOICES) })))   // re-roll regular tab icons
          }}>
            <Icon name="refresh" size={13} /> {t('newsvc_random')}
          </Button>
        </Field>

        {!job && (
          <Field label={t('newsvc_bottom_bar')}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={commandBar} onChange={(e) => setCommandBar(e.target.checked)} />
              {t('newsvc_command_bar')}
            </label>
          </Field>
        )}
      </Panel>

      <Panel bare title={t('newsvc_tabs')} hint={String(tabs.length)}>
        {tabs.map((tb) => (
          <div key={tb.key} className="set-row">
            <input style={{ ...field, width: 90, flexShrink: 0 }} value={tb.id} placeholder="id" disabled={!!job}
              onChange={(e) => setTab(tb.key, { id: e.target.value })} />
            <input style={{ ...field, flex: 1, minWidth: 120 }} value={tb.label} placeholder={t('newsvc_tab_label')} disabled={!!job}
              onChange={(e) => setTab(tb.key, { label: e.target.value })} />
            <IconPick value={tb.icon} disabled={!!job} onChange={(ic) => setTab(tb.key, { icon: ic })} />
            {/* kind badge only for built-in tabs; a plain tab shows none, freeing
                the width for the label at narrow column sizes */}
            {tb.kind && (
              <span className="set-pill">
                {tb.kind === 'community' ? t('newsvc_tab_kind_community')
                  : tb.kind === 'settings' ? t('newsvc_tab_kind_settings')
                  : tb.kind === 'parameter' ? t('newsvc_tab_kind_parameter')
                  : t('newsvc_tab_kind_basic')}
              </span>
            )}
            <Button variant="dangerSoft" disabled={!!job || tabs.length <= 1} onClick={() => delTab(tb.key)} title={t('newsvc_tab_del')}>
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
        {!job && (
          <div className="set-row">
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
            <Button variant="secondary" disabled={tabs.some((x) => x.kind === 'parameter')}
              onClick={() => setTabs((ts) => [...ts, newTab({ id: 'param', label: lang === 'ko' ? '파라미터' : 'Parameter', icon: 'sliders', kind: 'parameter' })])}>
              <Icon name="sliders" size={13} /> {t('newsvc_tab_add_parameter')}
            </Button>
          </div>
        )}
      </Panel>

      {/* Building is a job with a log, so it gets its own panel rather than a
          strip under the form: it outlives the form and you watch it. */}
      {(err || job) && (
        <Panel bare title={t('newsvc_create')}
          hint={job ? (running ? t('newsvc_building', job.name) : done ? t('newsvc_done', job.name) : t('newsvc_error')) : undefined}>
          {err && <div className="set-row" style={{ color: 'var(--danger-text)' }}>{err}</div>}
          {job?.error && <div className="set-row" style={{ color: 'var(--danger-text)' }}>{job.error}</div>}
          {job && (
            <>
              <pre ref={logBox} style={{
                margin: 14, maxHeight: 200, overflow: 'auto', fontSize: 'var(--fs-small, 13px)', lineHeight: 1.5,
                backgroundColor: 'var(--surface-2)', color: 'var(--text-secondary)',
                borderRadius: 'var(--rack-radius, 0)', padding: 10, whiteSpace: 'pre-wrap',
              }}>{(job.log || []).join('\n') || '…'}</pre>
              <div className="set-row">
                {done && <Button variant="primary" onClick={() => window.open(`/p/${job.name}/`, '_blank')}>
                  <Icon name="link" size={13} /> {t('newsvc_enter')}
                </Button>}
                {!running && <Button variant="secondary" onClick={reset}>{t('newsvc_again')}</Button>}
              </div>
            </>
          )}
        </Panel>
      )}

      {!job && (
        <Panel bare>
          <div className="set-row">
            <Button variant="primary" disabled={busy || !nameOk} onClick={create}>
              <Icon name="plus" size={14} /> {t('newsvc_create')}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  )
}
