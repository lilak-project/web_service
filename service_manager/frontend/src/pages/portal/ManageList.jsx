import { useState } from 'react'
import { Button, Icon, ColorPicker } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'

/**
 * ManageList — Home's admin "manage mode" (toggled by the gear above the list).
 * Everything the old Services screen did EXCEPT access grants + invite codes
 * (those live in Account) and handshake registration (in the Guide/handshake tab):
 *   • edit icon / display name / colour
 *   • visibility (private / protected / admin)
 *   • reorder
 *   • download project data (.zip) and delete projects — for multi-project services
 *   • remove the service
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

function ServiceRow({ svc, first, last, onMove, onChanged }) {
  const { t, lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [icon, setIcon] = useState(svc.icon || 'lilak')
  const [color, setColor] = useState(svc.color || '#9333ea')
  const [label, setLabel] = useState(svc.label || '')
  const [vis, setVis] = useState(svc.visibility || 2)
  const [projects, setProjects] = useState(null)      // multi-project: lazy-loaded
  const [openData, setOpenData] = useState(false)
  const [msg, setMsg] = useState('')
  const dirty = (icon !== (svc.icon || 'lilak')) || (color !== (svc.color || '#9333ea')) || (label !== (svc.label || ''))

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
    try { setProjects((await launcher.get(`/services/${svc.name}/projects`)).data) }
    catch { setProjects([]) }
  }
  async function toggleData() {
    const next = !openData; setOpenData(next)
    if (next && projects === null) await loadProjects()
  }
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

  const moveBtn = (dir, disabled, title, ic) => (
    <button type="button" title={title} disabled={disabled} onClick={() => onMove(dir)}
      style={{ border: '1px solid var(--border-default)', background: 'var(--surface)', borderRadius: 4, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, lineHeight: 0, padding: 2 }}>
      <Icon name={ic} size={12} />
    </button>
  )

  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 10, backgroundColor: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {moveBtn(-1, first, L('위로', 'up'), 'caret-up')}
          {moveBtn(1, last, L('아래로', 'down'), 'caret-down')}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border-default)' }}>
          <Icon name={icon} size={22} weight={ICON_WEIGHT} color={color} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 150 }}>
          <input style={field} value={label} placeholder={svc.name} onChange={(e) => setLabel(e.target.value)} />
          <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{svc.name}</span>
        </div>
        <IconPick value={icon} onChange={setIcon} color={color} />
        <ColorPicker value={color} onChange={setColor} />
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <select value={vis} onChange={(e) => changeVis(e.target.value)} style={sel} title={L('공개 범위', 'Visibility')}>
          {VIS_OPTS.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
        </select>
        {svc.multi_project && (
          <Button variant={openData ? 'secondary' : 'ghost'} size="sm" onClick={toggleData}>
            <Icon name="download" size={14} /> {L('데이터·프로젝트', 'Data · projects')}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" icon title={L('서비스 삭제', 'Delete service')} onClick={removeService}>
          <Icon name="trash" size={15} />
        </Button>
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginTop: 6 }}>{msg}</div>}

      {openData && svc.multi_project && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('프로젝트: 데이터 내려받기(.zip) · 삭제', 'Projects: download data (.zip) · delete')}</div>
          {projects === null ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>…</span>
            : projects.length === 0 ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>—</span>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {projects.map((p) => (
                  <div key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-small, 12px)' }}>
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

export default function ManageList({ services, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [order, setOrder] = useState(() => (services || []).map((s) => s.name))

  const byName = Object.fromEntries((services || []).map((s) => [s.name, s]))
  const names = order.filter((n) => byName[n]).concat((services || []).map((s) => s.name).filter((n) => !order.includes(n)))
  const rows = names.map((n) => byName[n]).filter(Boolean)

  async function move(idx, dir) {
    const j = idx + dir
    if (j < 0 || j >= rows.length) return
    const next = rows.map((s) => s.name)
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setOrder(next)
    try { await launcher.put('/admin/service-order', { names: next }); onChanged?.() }
    catch { /* keep local order */ }
  }

  if (!rows.length) {
    return <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>{L('서비스 없음', 'No services')}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((s, i) => (
        <ServiceRow key={s.name} svc={s} first={i === 0} last={i === rows.length - 1}
          onMove={(d) => move(i, d)} onChanged={onChanged} />
      ))}
    </div>
  )
}
