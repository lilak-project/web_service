import { useEffect, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import { Panel, Row } from './Field'

/**
 * ArchivePanel — the 보관함. Services "data-only deleted" land here: their data is
 * gone but the definition is kept, so an admin can Restore (bring it back empty) or
 * Delete permanently.
 *
 * On the classic cover it renders nothing while the archive is empty, so it only
 * shows up on Home once something has been archived. The sidebar cover opens it
 * as a page of its own (`always`), where an empty archive should say so.
 *
 * Permanent delete is asked in place rather than with window.confirm: the portal
 * asks every other irreversible question that way, and a dialog is a different
 * voice for the same question.
 */
export default function ArchivePanel({ signal, onChanged, always = false }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [items, setItems] = useState([])
  const [msg, setMsg] = useState('')
  const [sure, setSure] = useState('')     // the name whose delete is being asked about

  async function load() {
    try { setItems((await launcher.get('/admin/archived')).data) } catch { setItems([]) }
  }
  useEffect(() => { load() }, [signal])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) {
    try { await p; setMsg(ok); await load(); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  const restore = (n) => run(launcher.post(`/admin/archived/${n}/restore`), L(`'${n}' 복구됨`, `'${n}' restored`))
  const purge = (n) => { setSure(''); run(launcher.delete(`/admin/archived/${n}`), L(`'${n}' 삭제됨`, `'${n}' deleted`)) }

  if (items.length === 0 && !always) return null
  return (
    <div className="svc-mg">
      <Panel bare title={L('보관함', 'Archive')} hint={String(items.length)}>
        <Row className="empty">
          {L('데이터를 지운 서비스의 정의가 여기 남습니다. 복구하면 빈 상태로 돌아오고, 완전 삭제하면 정의까지 지웁니다.',
            'A service whose data was deleted keeps its definition here. Restore brings it back empty; delete removes the definition too.')}
        </Row>
        {msg && <Row className="empty">{msg}</Row>}
        {items.length === 0 && <Row className="empty">{L('보관된 서비스가 없습니다.', 'Nothing is archived.')}</Row>}
        {items.map((s) => (
          <Row key={s.name}>
            <Icon name={s.icon || 'box'} size={16} color={s.color || 'var(--text-muted)'} />
            <span>{s.label || s.name}</span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>{s.name} · {s.kind}</span>
            <span className="sp" />
            {sure === s.name ? (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{L('되돌릴 수 없습니다.', 'This cannot be undone.')}</span>
                <Button variant="danger" onClick={() => purge(s.name)}>{L('정말 삭제', 'Delete for good')}</Button>
                <Button variant="secondary" onClick={() => setSure('')}>{L('취소', 'Cancel')}</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => restore(s.name)}>{L('복구', 'Restore')}</Button>
                <Button variant="dangerSoft" title={L('완전 삭제', 'Delete permanently')}
                  onClick={() => setSure(s.name)}><Icon name="trash" size={15} /></Button>
              </>
            )}
          </Row>
        ))}
      </Panel>
    </div>
  )
}
