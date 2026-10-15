import { useState, useEffect } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS, LayoutEditor } from 'lilak-ui'
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
  const L = (ko, en) => (lang === 'ko' ? ko : en)
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
        ? L('이 서비스는 탭 구성 편집을 지원하지 않습니다.', 'This service does not support tab layout editing.')
        : (errText(e, L('불러오기 실패', 'Failed to load'))))
    }
  }
  async function saveLayout() {
    setLySaving(true); setLyErr('')
    try { const { data } = await serviceApi(svc.name).put('/layout', layout); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(errText(e, L('저장 실패', 'Save failed'))) }
    finally { setLySaving(false) }
  }
  async function resetLayout() {
    setLyErr('')
    try { const { data } = await serviceApi(svc.name).post('/layout/reset'); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(errText(e, L('초기화 실패', 'Reset failed'))) }
  }

  async function save() {
    try {
      if (isBuiltin) {
        await launcher.put('/admin/home-builtin', { key: builtinKey, icon, color, label: label.trim() })
      } else {
        await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, color, label: label.trim() })
      }
      setMsg(L('저장됨', 'saved'), 'ok'); onChanged?.()
    } catch (e) { setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function toggleHidden() {
    const next = !hidden
    setHidden(next)                                     // optimistic
    try {
      if (isBuiltin) await launcher.put('/admin/home-builtin', { key: builtinKey, hidden: next })
      else await launcher.put('/admin/home-service', { name: svc.name, hidden: next })
      onChanged?.()
    } catch (e) { setHidden(!next); setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function toggleLiveHidden() {
    const next = !liveHidden
    setLiveHidden(next)
    try { await launcher.put('/admin/home-service', { name: svc.name, live_hidden: next }); onChanged?.() }
    catch (e) { setLiveHidden(!next); setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function toggleAuto() {
    const next = !auto
    setAuto(next)                                   // optimistic
    try { await launcher.put(`/admin/services/${svc.name}/autostart`, { autostart: next }); onChanged?.() }
    catch (e) { setAuto(!next); setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function changeVis(v) {
    setVis(Number(v))
    try { await launcher.put(`/admin/services/${svc.name}`, { visibility: Number(v) }); onChanged?.() }
    catch (e) { setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function archiveService() {
    if (!window.confirm(L(`'${svc.name}'을(를) 보관함으로 옮길까요? 데이터는 삭제되고 서비스 정의만 보관되어 나중에 복구할 수 있습니다.`,
      `Move '${svc.name}' to the archive? Its data is deleted; the service definition is kept so you can restore it later.`))) return
    try { await launcher.post(`/admin/services/${svc.name}/archive`); onChanged?.() }
    catch (e) { setMsg(errText(e, L('실패', 'failed'))) }
  }
  async function removeService() {
    if (!window.confirm(L(`'${svc.name}' 서비스를 완전히 삭제할까요? 서비스와 데이터가 모두 사라지고 복구할 수 없습니다.`,
      `Permanently delete '${svc.name}'? The service and its data are gone for good — no restore.`))) return
    try { await launcher.delete(`/admin/services/${svc.name}`); onChanged?.() }
    catch (e) { setMsg(errText(e, L('실패', 'failed'))) }
  }

  return (
    <div className="svc-mg">
      {/* Which code is running: the repository and the commit. Only for a
          service that is its own git repo — one that lives inside the stack's
          repo would just report the stack's commit, so it reports nothing. A
          commit not yet pushed has no page to link to, and says so. */}
      {!isBuiltin && service.version?.sha && (
        <Panel title={L('코드', 'Code')} hint={service.version.date || ''}>
          <Field label={L('저장소', 'Repository')}>
            {service.version.url ? (
              <a href={service.version.url} target="_blank" rel="noreferrer" className="set-ext">
                {service.version.url.replace(/^https?:\/\//, '')} ↗
              </a>
            ) : <span style={fieldMuted}>{L('원격 저장소 없음', 'no remote')}</span>}
          </Field>
          <Field label={L('커밋', 'Commit')}>
            {service.version.url && service.version.pushed ? (
              <a href={`${service.version.url}/commit/${service.version.sha}`} target="_blank" rel="noreferrer"
                className="set-ext mono">{service.version.sha} ↗</a>
            ) : (
              <span className="mono" style={fieldMuted}
                title={L('아직 원격에 푸시되지 않은 커밋', 'not pushed to the remote yet')}>
                {service.version.sha} · {L('로컬', 'local')}
              </span>
            )}
          </Field>
        </Panel>
      )}

      <Panel title={L('모양', 'Appearance')} hint={isBuiltin ? L('내장 카드', 'builtin card') : svc.name}>
        {/* One control per row with a word beside it: four squares in a line
            said nothing about which one did what. */}
        <Field label={L('아이콘', 'Icon')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
            borderRadius: 'var(--rack-radius, 0)', border: '1px solid var(--border-strong)' }}>
            <Icon name={icon} size={20} weight={ICON_WEIGHT} color={color} />
          </span>
          <IconPick value={icon} onChange={setIcon} color={color} />
          <span style={fieldMuted}>{L('왼쪽이 카드에 보이는 모습, 오른쪽을 눌러 고릅니다.', 'The card shows the left one; press the right to pick.')}</span>
        </Field>

        <Field label={L('색', 'Colour')}>
          <ColorPicker value={color} onChange={setColor} />
          <Button variant="secondary" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }}>
            <Icon name="refresh" size={13} /> {L('무작위', 'Random')}
          </Button>
          <span style={fieldMuted}>{L('아이콘과 카드에 함께 쓰입니다.', 'Used for the icon and the card together.')}</span>
        </Field>

        <Field label={L('이름', 'Name')}>
          <input style={field} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
          <span style={fieldMuted}>{L('카드에 보이는 이름입니다. 비우면 서비스 이름을 씁니다.', 'What the card shows. Empty falls back to the service name.')}</span>
        </FieldActions>

        <Field label={L('순서', 'Order')}>
          <Button variant="secondary" disabled={first} onClick={() => onMove(-1)}><Icon name="caret-up" size={15} /></Button>
          <Button variant="secondary" disabled={last} onClick={() => onMove(1)}><Icon name="caret-down" size={15} /></Button>
          <span style={fieldMuted}>{L('끌어서 옮길 수도 있습니다.', 'Dragging works too.')}</span>
        </Field>
      </Panel>

      <Panel title={L('표시', 'On the cover')}>
        {!isBuiltin && (
          <Field label={L('공개 범위', 'Visibility')}>
            <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel}>
              {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
            </select>
          </Field>
        )}
        {!isBuiltin && (
          <Field label={L('자동 시작', 'Autostart')}>
            {auto ? <Pill tone="ok">{L('켜짐', 'on')}</Pill> : <Pill>{L('꺼짐', 'off')}</Pill>}
            <span style={fieldMuted}>{L('포탈이 시작될 때 이 서비스도 함께 띄웁니다.', 'Bring this service up when the portal starts.')}</span>
          </Field>
        )}
        {!isBuiltin && (
          <FieldActions>
            <Button variant={auto ? 'warning' : 'secondary'} onClick={toggleAuto}>
              {auto ? L('자동 시작 끄기', 'Turn autostart off') : L('자동 시작 켜기', 'Turn autostart on')}
            </Button>
          </FieldActions>
        )}

        <Field label={L('홈 화면', 'Home screen')}>
          {hidden ? <Pill tone="warn">{L('숨김', 'hidden')}</Pill> : <Pill tone="ok">{L('표시됨', 'shown')}</Pill>}
          <span style={fieldMuted}>{L('숨겨도 관리 모드에서는 계속 보입니다.', 'Hidden here, still shown in manage mode.')}</span>
        </Field>
        <FieldActions>
          <Button variant={hidden ? 'warning' : 'secondary'} onClick={toggleHidden}>
            <Icon name={hidden ? 'eye' : 'eye-off'} size={15} />
            {hidden ? L('다시 표시', 'Show') : L('숨기기', 'Hide')}
          </Button>
        </FieldActions>

        {!isBuiltin && (
          <>
            <Field label={L('라이브 모드', 'Live wall')}>
              {liveHidden ? <Pill tone="warn">{L('제외됨', 'off the wall')}</Pill> : <Pill tone="ok">{L('포함됨', 'on the wall')}</Pill>}
            </Field>
            <FieldActions>
              <Button variant={liveHidden ? 'warning' : 'secondary'} onClick={toggleLiveHidden}>
                <Icon name="broadcast" size={15} />
                {liveHidden ? L('라이브에 다시 표시', 'Show in live') : L('라이브에서 빼기', 'Hide from live')}
              </Button>
            </FieldActions>
          </>
        )}

        {!isBuiltin && (
          <Field label={L('관리자', 'Administrators')} align="start">
            {!admins ? <span style={fieldMuted}>…</span>
              : (admins.managers || []).length + (admins.scoped || []).length === 0
                ? <span style={fieldMuted}>—</span>
                : <>
                    {(admins.managers || []).map((n) => <span key={'m' + n} style={fieldChip}>{n} · {L('전체', 'global')}</span>)}
                    {(admins.scoped || []).map((a, i) => (
                      <span key={'s' + i} style={{ ...fieldChip, fontFamily: 'var(--font-mono)' }}>
                        {a.username} · {a.project ? a.project : L('서비스 전체', 'whole service')}{a.group ? ` (${a.group})` : ''}
                      </span>
                    ))}
                  </>}
          </Field>
        )}
      </Panel>

      {/* tab / menu layout (services only) — lazy: only loads on open */}
      {!isBuiltin && (
        <Panel bare title={L('탭 · 메뉴 구성', 'Tabs · menu layout')}
          right={!lyOpen ? <Button variant="secondary" onClick={openLayout}>{L('편집', 'Edit')}</Button> : null}>
          {!lyOpen ? (
            <div className="set-row empty">{L('이 서비스의 탭과 왼쪽 메뉴바 구성을 고칩니다.', 'The tabs and left menu bar this service shows.')}</div>
          ) : lyErr && !layout ? (
            <div className="set-row empty">{lyErr}</div>
          ) : layout ? (
            <div style={{ padding: 14 }}>
              <LayoutEditor value={layout} onChange={(c) => { setLayout(c); setLyDirty(true) }}
                onSave={saveLayout} onReset={resetLayout} dirty={lyDirty} saving={lySaving} />
              {lyErr && <div style={{ color: 'var(--danger-text)', marginTop: 8 }}>{lyErr}</div>}
            </div>
          ) : (
            <div className="set-row empty">{L('불러오는 중…', 'Loading…')}</div>
          )}
        </Panel>
      )}

      {/* cross-portal mirroring (services only) */}
      {!isBuiltin && (
        <Panel bare title={L('다른 서버와 동기화', 'Mirror another server')}>
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
        <Panel title={L('데이터 옮기기', 'Move the data')}>
          <Field label={L('내보내기', 'Export')}>
            {L('이 서비스의 데이터 폴더 전체를 .zip 으로 받습니다. 다른 포털에서 가져오면 그대로 옮겨집니다.',
              'The service\'s whole data folder as a .zip; importing it on another portal brings it across as is.')}
          </Field>
          <FieldActions>
            <Button variant="secondary" onClick={() => downloadFrom(`/projects/${service.name}/export`, `${service.name}.zip`)
              .catch((e) => notify(e?.response?.data?.detail || L('내보내지 못했습니다.', 'Export failed.'), 'bad'))}>
              {L('.zip 받기', 'Download .zip')}
            </Button>
          </FieldActions>
        </Panel>
      )}

      {!isBuiltin && !service.multi_project && service.mode === 'managed' && (
        <Panel bare fold open={false} title={L('실행 로그', 'Run log')} hint="service.log">
          <LogBox url={`/admin/services/${service.name}/log`} />
        </Panel>
      )}

      {!isBuiltin && (
        <Panel danger title={L('되돌릴 수 없는 것', 'Cannot be undone')}>
          <Field label={L('보관함으로', 'Archive')}>
            {L('데이터는 지우고 서비스 정의만 남깁니다. 나중에 되살릴 수 있습니다.', 'Deletes the data, keeps the definition so you can restore it later.')}
          </Field>
          <FieldActions>
            <Button variant="secondary" onClick={archiveService}><Icon name="archive" size={15} /> {L('보관함으로', 'Archive')}</Button>
          </FieldActions>
          <Field label={L('완전 삭제', 'Delete')}>
            {L('서비스와 데이터가 모두 사라집니다. 복구할 수 없습니다.', 'The service and its data go for good — no restore.')}
          </Field>
          <FieldActions>
            <Button variant="dangerSoft" onClick={removeService}><Icon name="trash" size={15} /> {L('완전 삭제', 'Delete')}</Button>
          </FieldActions>
        </Panel>
      )}
    </div>
  )
}
