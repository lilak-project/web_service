import { useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'

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

export default function ServiceManagePanel({ service, initialIcon, first, last, onMove, onChanged }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const svc = service
  const tint = service.color || undefined                    // existing colour tints the icon
  const startIcon = service.icon || initialIcon || 'lilak'   // the icon actually on the card
  const [icon, setIcon] = useState(startIcon)
  const [label, setLabel] = useState(service.label || '')
  const [vis, setVis] = useState(service.visibility || 2)
  const [msg, setMsg] = useState('')
  const dirty = (icon !== startIcon) || (label !== (service.label || ''))

  async function save() {
    try {
      await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, label: label.trim() })
      setMsg(L('저장됨', 'saved')); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function changeVis(v) {
    setVis(Number(v))
    try { await launcher.put(`/admin/services/${svc.name}`, { visibility: Number(v) }); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  async function removeService() {
    if (!window.confirm(L(`'${svc.name}' 서비스를 삭제할까요? 데이터가 사라집니다.`, `Delete service '${svc.name}'? Its data is removed.`))) return
    try { await launcher.delete(`/admin/services/${svc.name}`); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  return (
    <div style={{ padding: '14px 14px 16px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* name + icon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border-default)' }}>
          <Icon name={icon} size={22} weight={ICON_WEIGHT} color={tint} />
        </span>
        <input style={field} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
        <IconPick value={icon} onChange={setIcon} color={tint} />
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
      </div>

      {/* visibility + reorder + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('공개 범위', 'Visibility')}</span>
        <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel}>
          {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
        </select>

        <span style={{ width: 12 }} />
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('순서', 'Order')}</span>
        <Button variant="ghost" size="sm" icon disabled={first} title={t('manage_move_up')} onClick={() => onMove(-1)}><Icon name="caret-up" size={15} /></Button>
        <Button variant="ghost" size="sm" icon disabled={last} title={t('manage_move_down')} onClick={() => onMove(1)}><Icon name="caret-down" size={15} /></Button>

        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={removeService} title={L('서비스 삭제', 'Delete service')} style={{ color: 'var(--danger-text)' }}>
          <Icon name="trash" size={15} /> {L('삭제', 'Delete')}
        </Button>
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</div>}
    </div>
  )
}
