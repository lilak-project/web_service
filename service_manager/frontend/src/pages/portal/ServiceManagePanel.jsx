import { useState, useEffect } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS, LayoutEditor } from 'lilak-ui'
import { launcher, serviceApi } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT, ICON_CHOICES } from './IconPick'

const rnd = (a) => a[Math.floor(Math.random() * a.length)]

/**
 * ServiceManagePanel — management content shown INSIDE a service card when Home is
 * in manage mode and the card is opened. Exactly: rename, change icon, visibility,
 * reorder, and delete. (Access + invite codes live in Account.)
 */

const VIS_OPTS = [
  { v: 1, key: 'portal_vis_private' },
  { v: 2, key: 'portal_vis_protected' },
  { v: 3, key: 'portal_vis_admin' },
]
const field = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', flex: 1, minWidth: 150,
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}
const sel = { height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 6px', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }

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
  const [msg, setMsg] = useState('')
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
        : (e?.response?.data?.detail || L('불러오기 실패', 'Failed to load')))
    }
  }
  async function saveLayout() {
    setLySaving(true); setLyErr('')
    try { const { data } = await serviceApi(svc.name).put('/layout', layout); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(e?.response?.data?.detail || L('저장 실패', 'Save failed')) }
    finally { setLySaving(false) }
  }
  async function resetLayout() {
    setLyErr('')
    try { const { data } = await serviceApi(svc.name).post('/layout/reset'); setLayout(data); setLyDirty(false) }
    catch (e) { setLyErr(e?.response?.data?.detail || L('초기화 실패', 'Reset failed')) }
  }

  async function save() {
    try {
      if (isBuiltin) {
        await launcher.put('/admin/home-builtin', { key: builtinKey, icon, color, label: label.trim() })
      } else {
        await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, color, label: label.trim() })
      }
      setMsg(L('저장됨', 'saved')); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function changeVis(v) {
    setVis(Number(v))
    try { await launcher.put(`/admin/services/${svc.name}`, { visibility: Number(v) }); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function archiveService() {
    if (!window.confirm(L(`'${svc.name}'을(를) 보관함으로 옮길까요? 데이터는 삭제되고 서비스 정의만 보관되어 나중에 복구할 수 있습니다.`,
      `Move '${svc.name}' to the archive? Its data is deleted; the service definition is kept so you can restore it later.`))) return
    try { await launcher.post(`/admin/services/${svc.name}/archive`); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function removeService() {
    if (!window.confirm(L(`'${svc.name}' 서비스를 완전히 삭제할까요? 서비스와 데이터가 모두 사라지고 복구할 수 없습니다.`,
      `Permanently delete '${svc.name}'? The service and its data are gone for good — no restore.`))) return
    try { await launcher.delete(`/admin/services/${svc.name}`); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  return (
    <div style={{ padding: '14px 14px 16px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* name on line 1; the icon/colour/random/save editors always drop to their
          own line, left-aligned (the name input grows, so keeping them inline would
          push them to the right edge). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border-default)' }}>
          <Icon name={icon} size={22} weight={ICON_WEIGHT} color={color} />
        </span>
        <input style={field} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
        <div style={{ flexBasis: '100%', height: 0 }} aria-hidden="true" />
        <IconPick value={icon} onChange={setIcon} color={color} />
        <ColorPicker value={color} onChange={setColor} />
        <Button variant="secondary" size="sm" onClick={() => { setIcon(rnd(ICON_CHOICES)); setColor(rnd(AVATAR_COLORS)) }} title={L('랜덤', 'Random')}><Icon name="refresh" size={13} /></Button>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
      </div>

      {/* visibility (services only) + reorder + delete (services only) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {!isBuiltin && (
          <>
            <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('공개 범위', 'Visibility')}</span>
            <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel}>
              {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
            </select>
            <span style={{ width: 12 }} />
          </>
        )}
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('순서', 'Order')}</span>
        <Button variant="ghost" size="sm" icon disabled={first} title={t('manage_move_up')} onClick={() => onMove(-1)}><Icon name="caret-up" size={15} /></Button>
        <Button variant="ghost" size="sm" icon disabled={last} title={t('manage_move_down')} onClick={() => onMove(1)}><Icon name="caret-down" size={15} /></Button>

        <div style={{ flex: 1 }} />
        {!isBuiltin && (
          <>
            <Button variant="ghost" size="sm" onClick={archiveService} title={L('데이터만 삭제하고 서비스는 보관함으로', 'Delete data, keep the service in the archive')}>
              <Icon name="archive" size={15} /> {L('보관함으로', 'Archive')}
            </Button>
            <Button variant="ghost" size="sm" onClick={removeService} title={L('서비스 완전 삭제', 'Delete permanently')} style={{ color: 'var(--danger-text)' }}>
              <Icon name="trash" size={15} /> {L('완전 삭제', 'Delete')}
            </Button>
          </>
        )}
      </div>

      {/* who administers this service (managers + scoped admins) */}
      {!isBuiltin && admins && (
        <div style={{ borderTop: '1px dashed var(--border-subtle)', paddingTop: 10, fontSize: 'var(--fs-small, 12px)' }}>
          <div style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('관리자', 'Administrators')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {(admins.managers || []).map((n) => <span key={'m' + n} style={{ fontSize: 'var(--fs-micro, 10px)', padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>{n} · {L('전체', 'global')}</span>)}
            {(admins.scoped || []).map((a, i) => <span key={'s' + i} style={{ fontSize: 'var(--fs-micro, 10px)', fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>{a.username} · {a.project ? a.project : L('서비스 전체', 'whole service')}{a.group ? ` (${a.group})` : ''}</span>)}
            {(admins.managers || []).length + (admins.scoped || []).length === 0 && <span style={{ color: 'var(--text-muted)' }}>—</span>}
          </div>
        </div>
      )}

      {/* tab / menu layout (services only) — lazy: only loads on open */}
      {!isBuiltin && (
        <div style={{ borderTop: '1px dashed var(--border-subtle)', paddingTop: 10 }}>
          {!lyOpen ? (
            <Button variant="ghost" size="sm" onClick={openLayout} title={L('탭과 왼쪽 메뉴바 구성 편집', 'Edit tabs and left menu bar')}>
              <Icon name="browse" size={14} /> {L('탭 / 메뉴 구성', 'Tabs / menu layout')}
            </Button>
          ) : lyErr && !layout ? (
            <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{lyErr}</div>
          ) : layout ? (
            <>
              <LayoutEditor value={layout} onChange={(c) => { setLayout(c); setLyDirty(true) }}
                onSave={saveLayout} onReset={resetLayout} dirty={lyDirty} saving={lySaving} />
              {lyErr && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--danger-text)', marginTop: 6 }}>{lyErr}</div>}
            </>
          ) : (
            <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('불러오는 중…', 'Loading…')}</div>
          )}
        </div>
      )}

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</div>}
    </div>
  )
}
