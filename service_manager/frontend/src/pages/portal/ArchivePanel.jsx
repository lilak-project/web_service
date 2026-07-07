import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ArchivePanel — the 보관함. Services "data-only deleted" land here: their data is
 * gone but the definition is kept, so an admin can Restore (bring it back empty) or
 * Delete permanently. Renders nothing when the archive is empty, so it only shows up
 * on Home once something has been archived.
 */
export default function ArchivePanel({ signal, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [items, setItems] = useState([])
  const [msg, setMsg] = useState('')

  async function load() {
    try { setItems((await launcher.get('/admin/archived')).data) } catch { setItems([]) }
  }
  useEffect(() => { load() }, [signal])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) { try { await p; setMsg(ok); await load(); onChanged?.() } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) } }

  const restore = (n) => run(launcher.post(`/admin/archived/${n}/restore`), L('복구됨', 'restored'))
  const purge = (n) => { if (window.confirm(L(`'${n}'을(를) 완전히 삭제할까요? 복구할 수 없습니다.`, `Permanently delete '${n}'? No restore.`))) run(launcher.delete(`/admin/archived/${n}`), L('삭제됨', 'deleted')) }

  if (items.length === 0) return null
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 'var(--fs-small, 13px)', fontWeight: 600, color: 'var(--text-secondary)',
        margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="archive" size={15} /> {L('보관함', 'Archive')}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {items.length}</span>
      </div>
      {msg && <div style={{ fontSize: 'var(--fs-tiny, 12px)', color: 'var(--text-muted)', marginBottom: 6 }}>{msg}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((s) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px',
            border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--surface)', opacity: 0.85 }}>
            <Icon name={s.icon || 'box'} size={22} weight="fill" color={s.color || 'var(--text-muted)'} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--fs-medium, 14px)', fontWeight: 600 }}>{s.label || s.name}</div>
              <div style={{ fontSize: 'var(--fs-small, 13px)', color: 'var(--text-muted)' }}>{s.name} · {s.kind}</div>
            </div>
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="secondary" onClick={() => restore(s.name)}>{L('복구', 'Restore')}</Button>
            <Button size="sm" variant="dangerSoft" onClick={() => purge(s.name)}><Icon name="trash" size={14} /> {L('완전 삭제', 'Delete')}</Button>
          </div>
        ))}
      </div>
    </div>
  )
}
