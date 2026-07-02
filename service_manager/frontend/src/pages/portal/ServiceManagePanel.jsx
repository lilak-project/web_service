import { useState } from 'react'
import { Button, Icon, ColorPicker } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'

/**
 * ServiceManagePanel — the management content shown INSIDE a service card when
 * Home is in manage mode and the card is opened. Edit icon / display name /
 * colour / visibility, download + delete project data (multi-project), and remove
 * the service. Reorder lives on the card row; access + invite codes live in
 * Account.
 */

const VIS_OPTS = [
  { v: 1, key: 'portal_vis_private' },
  { v: 2, key: 'portal_vis_protected' },
  { v: 3, key: 'portal_vis_admin' },
]
const field = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', flex: 1, minWidth: 0,
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}
const sel = { height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 6px', backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }

export default function ServiceManagePanel({ service, initialIcon, onChanged }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const svc = service
  const startIcon = service.icon || initialIcon || 'lilak'      // show the icon actually on the card
  const [icon, setIcon] = useState(startIcon)
  const [color, setColor] = useState(service.color || '#9333ea')
  const [label, setLabel] = useState(service.label || '')
  const [vis, setVis] = useState(service.visibility || 2)
  const [projects, setProjects] = useState(null)
  const [openData, setOpenData] = useState(false)
  const [msg, setMsg] = useState('')
  const dirty = (icon !== startIcon) || (color !== (service.color || '#9333ea')) || (label !== (service.label || ''))

  async function save() {
    try {
      await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, color, label: label.trim() })
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
  async function loadProjects() {
    try { setProjects((await launcher.get(`/services/${svc.name}/projects`)).data) } catch { setProjects([]) }
  }
  async function toggleData() { const n = !openData; setOpenData(n); if (n && projects === null) await loadProjects() }
  async function exportProj(proj) {
    try {
      const res = await launcher.get(`/services/${svc.name}/projects/${proj}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a'); a.href = url; a.download = `${proj}.zip`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
    } catch (e) { setMsg(e?.response?.data?.detail || L('내보내기 실패', 'export failed')) }
  }
  async function deleteProj(proj) {
    if (!window.confirm(L(`프로젝트 '${proj}' 삭제? 데이터가 사라집니다.`, `Delete project '${proj}'? Its data is removed.`))) return
    try { await launcher.delete(`/services/${svc.name}/projects/${proj}`); await loadProjects(); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('삭제 실패', 'delete failed')) }
  }

  return (
    <div style={{ padding: '14px 14px 16px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* icon + name + colour */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border-default)' }}>
          <Icon name={icon} size={22} weight={ICON_WEIGHT} color={color} />
        </span>
        <input style={{ ...field, minWidth: 150 }} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
        <IconPick value={icon} onChange={setIcon} color={color} />
        <ColorPicker value={color} onChange={setColor} />
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
      </div>

      {/* visibility + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{L('공개 범위', 'Visibility')}</span>
        <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel}>
          {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
        </select>
        {svc.multi_project && (
          <Button variant={openData ? 'secondary' : 'ghost'} size="sm" onClick={toggleData}>
            <Icon name="download" size={14} /> {L('데이터·프로젝트', 'Data · projects')}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={removeService} title={L('서비스 삭제', 'Delete service')}
          style={{ color: 'var(--danger-text)' }}>
          <Icon name="trash" size={15} /> {L('삭제', 'Delete')}
        </Button>
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</div>}

      {openData && svc.multi_project && (
        <div style={{ paddingTop: 6, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('프로젝트: 데이터 내려받기(.zip) · 삭제', 'Projects: download data (.zip) · delete')}</div>
          {projects === null ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>…</span>
            : projects.length === 0 ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>—</span>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {projects.map((p) => (
                  <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-small, 12px)' }}>
                    <span style={{ flex: 1, fontFamily: 'var(--font-mono)' }}>{p.label || p.name}</span>
                    <Button variant="ghost" size="sm" icon title={L('내려받기', 'download')} onClick={() => exportProj(p.name)}><Icon name="download" size={14} /></Button>
                    <Button variant="ghost" size="sm" icon title={L('삭제', 'delete')} onClick={() => deleteProj(p.name)}><Icon name="trash" size={14} /></Button>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
