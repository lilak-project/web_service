import { useState } from 'react'
import { Button, Icon, ColorPicker } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'

/**
 * ManageList — Home's admin "manage mode" (toggled by the gear above the list).
 * Per service: reorder, edit icon / display name / colour, and download data
 * (per-project export for multi-project services). Access grants + invite codes
 * are NOT here — those live in the Account screen.
 */

const field = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px', flex: 1, minWidth: 0,
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}

function ServiceRow({ svc, first, last, onMove, onChanged, L }) {
  const [icon, setIcon] = useState(svc.icon || 'lilak')
  const [color, setColor] = useState(svc.color || '#9333ea')
  const [label, setLabel] = useState(svc.label || '')
  const [projects, setProjects] = useState(null)      // multi-project: lazy-loaded
  const [openDl, setOpenDl] = useState(false)
  const [msg, setMsg] = useState('')
  const dirty = (icon !== (svc.icon || 'lilak')) || (color !== (svc.color || '#9333ea')) || (label !== (svc.label || ''))

  async function save() {
    try {
      await launcher.put(`/admin/services/${svc.name}/appearance`, { icon, color, label: label.trim() })
      setMsg(L('저장됨', 'saved')); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  async function toggleDownloads() {
    const next = !openDl; setOpenDl(next)
    if (next && projects === null) {
      try { setProjects((await launcher.get(`/services/${svc.name}/projects`)).data) }
      catch { setProjects([]) }
    }
  }
  async function exportProj(proj) {
    try {
      const res = await launcher.get(`/services/${svc.name}/projects/${proj}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a'); a.href = url; a.download = `${proj}.zip`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
    } catch (e) { setMsg(e?.response?.data?.detail || L('내보내기 실패', 'export failed')) }
  }

  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 10, backgroundColor: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* reorder */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button type="button" title={L('위로', 'up')} disabled={first} onClick={() => onMove(-1)}
            style={{ border: '1px solid var(--border-default)', background: 'var(--surface)', borderRadius: 4, cursor: first ? 'default' : 'pointer', opacity: first ? 0.35 : 1, lineHeight: 0, padding: 2 }}>
            <Icon name="caret-up" size={12} />
          </button>
          <button type="button" title={L('아래로', 'down')} disabled={last} onClick={() => onMove(1)}
            style={{ border: '1px solid var(--border-default)', background: 'var(--surface)', borderRadius: 4, cursor: last ? 'default' : 'pointer', opacity: last ? 0.35 : 1, lineHeight: 0, padding: 2 }}>
            <Icon name="caret-down" size={12} />
          </button>
        </div>
        {/* preview */}
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border-default)' }}>
          <Icon name={icon} size={22} weight={ICON_WEIGHT} color={color} />
        </span>
        {/* name (label) — id stays fixed as the URL key */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 160 }}>
          <input style={field} value={label} placeholder={svc.name}
            onChange={(e) => setLabel(e.target.value)} />
          <span style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{svc.name}</span>
        </div>
        <IconPick value={icon} onChange={setIcon} color={color} />
        <ColorPicker value={color} onChange={setColor} />
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>{L('저장', 'Save')}</Button>
        {svc.multi_project && (
          <Button variant="secondary" size="sm" onClick={toggleDownloads}>
            <Icon name="download" size={14} /> {L('데이터', 'Data')}
          </Button>
        )}
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', marginTop: 6 }}>{msg}</div>}

      {openDl && svc.multi_project && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 'var(--fs-micro, 10px)', color: 'var(--text-muted)', marginBottom: 4 }}>{L('프로젝트 데이터 내려받기 (.zip)', 'Download project data (.zip)')}</div>
          {projects === null ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>…</span>
            : projects.length === 0 ? <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>—</span>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {projects.map((p) => (
                  <button key={p.name} type="button" onClick={() => exportProj(p.name)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-small, 12px)', padding: '4px 8px', borderRadius: 999, border: '1px solid var(--border-default)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                    {p.label || p.name} <Icon name="download" size={13} />
                  </button>
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

  // Keep local order in sync if the service set changes (add/remove).
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
          onMove={(d) => move(i, d)} onChanged={onChanged} L={L} />
      ))}
    </div>
  )
}
