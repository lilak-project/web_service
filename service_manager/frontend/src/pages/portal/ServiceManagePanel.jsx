import { useState, useEffect } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS, LayoutEditor, tr } from 'lilak-ui'
import { launcher, serviceApi, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT, ICON_CHOICES } from './IconPick'
import SyncPanel from './SyncPanel'
import LogBox from './LogBox'
import { downloadFrom } from './download'
import { Panel, Field, FieldActions, Pill, fieldInput, fieldMuted, fieldChip } from './Field'
import { notify } from './settingsMsg'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

/**
 * ServiceManagePanel — management content shown INSIDE a service card when Home is
 * in manage mode and the card is opened. Exactly: rename, change icon, visibility,
 * reorder, and delete. (Access + invite codes live in Account.)
 */

const VIS_OPTS = [
  { v: 0, key: 'portal_vis_public' },
  { v: 1, key: 'portal_vis_private' },
  { v: 2, key: 'portal_vis_protected' },
  { v: 3, key: 'portal_vis_admin' },
]
const field = { ...fieldInput, flex: 1, minWidth: 150 }
const sel = { ...fieldInput, maxWidth: 220 }

export default function ServiceManagePanel({ service, builtinKey, initialIcon, first, last, onMove, onChanged }) {
  const { t, lang } = useLang()
  const svc = service
  const isBuiltin = !!builtinKey                              // builtins: rename/icon/order only
  const startIcon = service.icon || initialIcon || 'lilak'   // the icon actually on the card
  const startColor = service.color || '#000000'
  const startLabel = isBuiltin ? (service.label || '') : (service.label || '')
  const [icon, setIcon] = useState(startIcon)
  const [color, setColor] = useState(startColor)
  const [label, setLabel] = useState(startLabel)
  const [vis, setVis] = useState(service.visibility || 2)
  // Whether the PORTAL brings this up when it starts. It matters beyond
  // convenience: a service the portal spawned lives in the portal's cgroup and
  // under its memory ceiling, one started by hand does not.
  const [auto, setAuto] = useState(!!service.autostart)
  const setMsg = (m, tone = 'bad') => notify(m, tone)
  // Builtins only: take the card off THIS portal's cover. Stored in the data
  // volume (data/_portal/home.json), so it is a per-server choice, not a build.
  const [hidden, setHidden] = useState(!!service.hidden)
  const [liveHidden, setLiveHidden] = useState(!!service.live_hidden)
  const [admins, setAdmins] = useState(null)   // { managers:[names], scoped:[{username,project}] }
  const dirty = (icon !== startIcon) || (color !== startColor) || (label !== startLabel)

  // Who administers this service — global managers + scoped (service/project) admins.
  useEffect(() => {
    if (isBuiltin) return
    launcher.get(`/services/${svc.name}/admins`).then((r) => setAdmins(r.data)).catch(() => {})
  }, [svc.name, isBuiltin])

  // Tab/menu layout — loaded lazily from the service's own /api/layout through the
  // proxy (so opening manage mode doesn't auto-start every service). Same editor +
  // config the service's Settings 탭 uses.
  const [lyOpen, setLyOpen] = useState(false)
  const [layout, setLayout] = useState(null)
  const [lyDirty, setLyDirty] = useState(false)
  const [lySaving, setLySaving] = useState(false)
  const [lyErr, setLyErr] = useState('')

  async function openLayout() {
    setLyOpen(true)
    if (layout) return
    setLyErr('')
    try { const { data } = await serviceApi(svc.name).get('/layout'); setLayout(data) }
    catch (e) {
      const code = e?.response?.status
      setLyErr(code === 404
        ? tr("p_this_service_does_not_support")
        : (errText(e, tr("p_failed_to_load"))))
    }
  }
  async function saveLayout() {
    setLySaving(true); setLyErr('')
    try { const { data } = await serviceApi(svc.name).put('/layout', layout); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(errText(e, tr("p_save_failed"))) }
    finally { setLySaving(false) }
  }
  async function resetLayout() {
    setLyErr('')
    try { const { data } = await serviceApi(svc.name).post('/layout/reset'); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(errText(e, tr("p_reset_failed"))) }
  }

  async function save() {
    try {
      if (isBuiltin) {
        await launcher.put('/admin/home-builtin', { key: builtinKey, icon, color, label: label.trim() })
      } else {
        await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, color, label: label.trim() })
      }
      setMsg(tr("p_saved"), 'ok'); onChanged?.()
    } catch (e) { setMsg(errText(e, tr("p_failed"))) }
  }
  async function toggleHidden() {
    const next = !hidden
    setHidden(next)                                     // optimistic
    try {
      if (isBuiltin) await launcher.put('/admin/home-builtin', { key: builtinKey, hidden: next })
      else await launcher.put('/admin/home-service', { name: svc.name, hidden: next })
      onChanged?.()
    } catch (e) { setHidden(!next); setMsg(errText(e, tr("p_failed"))) }
  }
  async function toggleLiveHidden() {
    const next = !liveHidden
    setLiveHidden(next)
    try { await launcher.put('/admin/home-service', { name: svc.name, live_hidden: next }); onChanged?.() }
    catch (e) { setLiveHidden(!next); setMsg(errText(e, tr("p_failed"))) }
  }
  async function toggleAuto() {
    const next = !auto
    setAuto(next)                                   // optimistic
    try { await launcher.put(`/admin/services/${svc.name}/autostart`, { autostart: next }); onChanged?.() }
    catch (e) { setAuto(!next); setMsg(errText(e, tr("p_failed"))) }
  }
  async function changeVis(v) {
    setVis(Number(v))
    try { await launcher.put(`/admin/services/${svc.name}`, { visibility: Number(v) }); onChanged?.() }
    catch (e) { setMsg(errText(e, tr("p_failed"))) }
  }
  async function archiveService() {
    if (!window.confirm(tr("p_move_to_the_archive_its", svc.name))) return
    try { await launcher.post(`/admin/services/${svc.name}/archive`); onChanged?.() }
    catch (e) { setMsg(errText(e, tr("p_failed"))) }
  }
  async function removeService() {
    if (!window.confirm(tr("p_permanently_delete_the_service_and", svc.name))) return
    try { await launcher.delete(`/admin/services/${svc.name}`); onChanged?.() }
    catch (e) { setMsg(errText(e, tr("p_failed"))) }
  }

  return (
    <div className="svc-mg">
      {/* Which code is running: the repository and the commit. Only for a
          service that is its own git repo — one that lives inside the stack's
          repo would just report the stack's commit, so it reports nothing. A
          commit not yet pushed has no page to link to, and says so. */}
      {!isBuiltin && service.version?.sha && (
        <Panel title={tr("p_code_3")} hint={service.version.date || ''}>
          <Field label={tr("p_repository")}>
            {service.version.url ? (
              <a href={service.version.url} target="_blank" rel="noreferrer" className="set-ext">
                {service.version.url.replace(/^https?:\/\//, '')} ↗
              </a>
            ) : <span style={fieldMuted}>{tr("p_no_remote")}</span>}
          </Field>
          <Field label={tr("p_commit")}>
            {service.version.url && service.version.pushed ? (
              <a href={`${service.version.url}/commit/${service.version.sha}`} target="_blank" rel="noreferrer"
                className="set-ext mono">{service.version.sha} ↗</a>
            ) : (
              <span className="mono" style={fieldMuted}
                title={tr("p_not_pushed_to_the_remote")}>
                {service.version.sha} · {tr("p_local")}
              </span>
            )}
          </Field>
        </Panel>
      )}

      <Panel title={tr("p_appearance")} hint={isBuiltin ? tr("p_builtin_card") : svc.name}>
        {/* One control per row with a word beside it: four squares in a line
            said nothing about which one did what. */}
        <Field label={tr("p_icon")}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
            borderRadius: 'var(--rack-radius, 0)', border: '1px solid var(--border-strong)' }}>
            <Icon name={icon} size={20} weight={ICON_WEIGHT} color={color} />
          </span>
          <IconPick value={icon} onChange={setIcon} color={color} />
          <span style={fieldMuted}>{tr("p_the_card_shows_the_left")}</span>
        </Field>

        <Field label={tr("p_colour")}>
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="secondary" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }}>
            <Icon name="refresh" size={13} /> {tr("p_random_2")}
          </Button>
          <span style={fieldMuted}>{tr("p_used_for_the_icon_and")}</span>
        </Field>

        <Field label={tr("p_name")}>
          <input style={field} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty} onClick={save}>{tr("p_save")}</Button>
          <span style={fieldMuted}>{tr("p_what_the_card_shows_empty")}</span>
        </FieldActions>

        <Field label={tr("p_order")}>
          <Button variant="secondary" disabled={first} onClick={() => onMove(-1)}><Icon name="caret-up" size={15} /></Button>
          <Button variant="secondary" disabled={last} onClick={() => onMove(1)}><Icon name="caret-down" size={15} /></Button>
          <span style={fieldMuted}>{tr("p_dragging_works_too")}</span>
        </Field>
      </Panel>

      <Panel title={tr("p_on_the_cover")}>
        {!isBuiltin && (
          <Field label={tr("p_visibility")}>
            <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel}>
              {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
            </select>
          </Field>
        )}
        {!isBuiltin && (
          <Field label={tr("p_autostart")}>
            {auto ? <Pill tone="ok">{tr("p_on")}</Pill> : <Pill>{tr("p_off_2")}</Pill>}
            <span style={fieldMuted}>{tr("p_bring_this_service_up_when")}</span>
          </Field>
        )}
        {!isBuiltin && (
          <FieldActions>
            <Button variant={auto ? 'warning' : 'secondary'} onClick={toggleAuto}>
              {auto ? tr("p_turn_autostart_off") : tr("p_turn_autostart_on")}
            </Button>
          </FieldActions>
        )}

        <Field label={tr("p_home_screen")}>
          {hidden ? <Pill tone="warn">{tr("p_hidden")}</Pill> : <Pill tone="ok">{tr("p_shown")}</Pill>}
          <span style={fieldMuted}>{tr("p_hidden_here_still_shown_in")}</span>
        </Field>
        <FieldActions>
          <Button variant={hidden ? 'warning' : 'secondary'} onClick={toggleHidden}>
            <Icon name={hidden ? 'eye' : 'eye-off'} size={15} />
            {hidden ? tr("p_show") : tr("p_hide")}
          </Button>
        </FieldActions>

        {!isBuiltin && (
          <>
            <Field label={tr("p_live_wall")}>
              {liveHidden ? <Pill tone="warn">{tr("p_off_the_wall")}</Pill> : <Pill tone="ok">{tr("p_on_the_wall")}</Pill>}
            </Field>
            <FieldActions>
              <Button variant={liveHidden ? 'warning' : 'secondary'} onClick={toggleLiveHidden}>
                <Icon name="broadcast" size={15} />
                {liveHidden ? tr("p_show_in_live") : tr("p_hide_from_live")}
              </Button>
            </FieldActions>
          </>
        )}

        {!isBuiltin && (
          <Field label={tr("p_administrators")} align="start">
            {!admins ? <span style={fieldMuted}>…</span>
              : (admins.managers || []).length + (admins.scoped || []).length === 0
                ? <span style={fieldMuted}>—</span>
                : <>
                    {(admins.managers || []).map((n) => <span key={'m' + n} style={fieldChip}>{n} · {tr("p_global")}</span>)}
                    {(admins.scoped || []).map((a, i) => (
                      <span key={'s' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>
                        {a.username} · {a.project ? a.project : tr("p_whole_service")}{a.group ? ` (${a.group})` : ''}
                      </span>
                    ))}
                  </>}
          </Field>
        )}
      </Panel>

      {/* tab / menu layout (services only) — lazy: only loads on open */}
      {!isBuiltin && (
        <Panel bare title={tr("p_tabs_menu_layout")}
          right={!lyOpen ? <Button variant="secondary" onClick={openLayout}>{tr("p_edit")}</Button> : null}>
          {!lyOpen ? (
            <div className="set-row empty">{tr("p_the_tabs_and_left_menu")}</div>
          ) : lyErr && !layout ? (
            <div className="set-row empty">{lyErr}</div>
          ) : layout ? (
            <div style={{ padding: 14 }}>
              <LayoutEditor value={layout} onChange={(c) => { setLayout(c); setLyDirty(true) }}
                onSave={saveLayout} onReset={resetLayout} dirty={lyDirty} saving={lySaving} />
              {lyErr && <div style={{ color: 'var(--danger-text)', marginTop: 8 }}>{lyErr}</div>}
            </div>
          ) : (
            <div className="set-row empty">{tr("p_loading")}</div>
          )}
        </Panel>
      )}

      {/* cross-portal mirroring (services only) */}
      {!isBuiltin && (
        <Panel bare title={tr("p_sync_with_another_server")}>
          <div style={{ padding: 14 }}><SyncPanel service={svc} /></div>
        </Panel>
      )}

      {/* What a single managed service printed on its last start. A
          multi-project service runs per project, so its logs are on the
          project rows instead; an external service runs elsewhere and has
          no file here. */}
      {/* A single managed service's whole data folder, as the .zip that
          "import" on another portal turns back into this service. A
          multi-project service exports per project, on its project rows. */}
      {!isBuiltin && !service.multi_project && service.mode === 'managed' && (
        <Panel title={tr("p_move_the_data")}>
          <Field label={tr("p_export")}>
            {tr("p_the_service_s_whole_data")}
          </Field>
          <FieldActions>
            <Button variant="secondary" onClick={() => downloadFrom(`/projects/${service.name}/export`, `${service.name}.zip`)
              .catch((e) => notify(e?.response?.data?.detail || tr("p_export_failed"), 'bad'))}>
              {tr("p_download_zip")}
            </Button>
          </FieldActions>
        </Panel>
      )}

      {!isBuiltin && !service.multi_project && service.mode === 'managed' && (
        <Panel bare fold open={false} title={tr("p_run_log")} hint="service.log">
          <LogBox url={`/admin/services/${service.name}/log`} />
        </Panel>
      )}

      {!isBuiltin && (
        <Panel danger title={tr("p_cannot_be_undone")}>
          <Field label={tr("p_archive_2")}>
            {tr("p_deletes_the_data_keeps_the")}
          </Field>
          <FieldActions>
            <Button variant="secondary" onClick={archiveService}><Icon name="archive" size={15} /> {tr("p_archive_2")}</Button>
          </FieldActions>
          <Field label={tr("p_delete_2")}>
            {tr("p_the_service_and_its_data")}
          </Field>
          <FieldActions>
            <Button variant="dangerSoft" onClick={removeService}><Icon name="trash" size={15} /> {tr("p_delete_2")}</Button>
          </FieldActions>
        </Panel>
      )}
    </div>
  )
}
