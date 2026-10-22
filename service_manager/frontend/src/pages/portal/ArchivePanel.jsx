import { useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
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
  const [items, setItems] = useState([])
  const [msg, setMsg] = useState('')
  const [sure, setSure] = useState('')     // the name whose delete is being asked about

  async function load() {
    try { setItems((await launcher.get('/admin/archived')).data) } catch { setItems([]) }
  }
  useEffect(() => { load() }, [signal])  // eslint-disable-line react-hooks/exhaustive-deps
  async function run(p, ok) {
    try { await p; setMsg(ok); await load(); onChanged?.() }
    catch (e) { setMsg(e?.response?.data?.detail || tr("p_failed")) }
  }

  const restore = (n) => run(launcher.post(`/admin/archived/${n}/restore`), tr("p_restored", n))
  const purge = (n) => { setSure(''); run(launcher.delete(`/admin/archived/${n}`), tr("p_deleted_2", n)) }

  if (items.length === 0 && !always) return null
  return (
    <div className="svc-mg">
      <Panel bare title={tr("p_archive_3")} hint={String(items.length)}>
        <Row className="empty">
          {tr("p_a_service_whose_data_was")}
        </Row>
        {msg && <Row className="empty">{msg}</Row>}
        {items.length === 0 && <Row className="empty">{tr("p_nothing_is_archived")}</Row>}
        {items.map((s) => (
          <Row key={s.name}>
            <Icon name={s.icon || 'box'} size={16} color={s.color || 'var(--text-muted)'} />
            <span>{s.label || s.name}</span>
            <span className="mono" style={{ color: 'var(--text-muted)' }}>{s.name} · {s.kind}</span>
            <span className="sp" />
            {sure === s.name ? (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{tr("p_this_cannot_be_undone")}</span>
                <Button variant="danger" onClick={() => purge(s.name)}>{tr("p_delete_for_good")}</Button>
                <Button variant="secondary" onClick={() => setSure('')}>{tr("p_cancel")}</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => restore(s.name)}>{tr("p_restore")}</Button>
                <Button variant="dangerSoft" title={tr("p_delete_permanently")}
                  onClick={() => setSure(s.name)}><Icon name="trash" size={15} /></Button>
              </>
            )}
          </Row>
        ))}
      </Panel>
    </div>
  )
}
