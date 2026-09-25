import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'
import { Panel, Row, fieldInput } from './Field'
import { notify } from './settingsMsg'

/**
 * LinksView — the body of the home "링크" card.
 *
 * Read mode is what almost everyone sees: a plain list of anchors to things the
 * portal does NOT run (an instrument's own page, a wiki, a PDF on another host).
 * `manage` (admins, in Home manage mode) swaps in the editor for the same list.
 *
 * The list is edited and saved WHOLE — reordering is part of editing, and a
 * whole-list PUT means no per-item ids to keep in sync between client and file.
 */


/** Trim a URL down to what tells you where it goes: host (+ port), or the path. */
function where(url) {
  try { const u = new URL(url, window.location.origin); return u.host + (u.pathname === '/' ? '' : u.pathname) }
  catch { return url }
}

export default function LinksView({ links, manage, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [rows, setRows] = useState(links || [])
  const setMsg = (m, tone) => m && notify(m, tone)
  const [saving, setSaving] = useState(false)

  // The card stays mounted while the cover refreshes, so take new props as truth
  // unless the admin has unsaved edits (dirty is derived, so this is safe).
  useEffect(() => { setRows(links || []) }, [links])

  const dirty = JSON.stringify(rows) !== JSON.stringify(links || [])

  function edit(i, key, value) {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: value } : row)))
  }
  function add() { setRows((r) => [...r, { label: '', url: '' }]) }
  function remove(i) { setRows((r) => r.filter((_, j) => j !== i)) }
  function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    setRows((r) => { const c = [...r]; [c[i], c[j]] = [c[j], c[i]]; return c })
  }
  async function save() {
    setSaving(true)
    try {
      // Drop blank rows rather than making the server reject the whole save for
      // one the admin added and then left empty.
      const links = rows.filter((r) => (r.label || '').trim() && (r.url || '').trim())
      const { data } = await launcher.put('/admin/links', { links })
      setRows(data.links); setMsg(L('링크 저장됨', 'links saved'), 'ok'); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('저장 실패', 'Save failed'), 'bad') }
    finally { setSaving(false) }
  }

  if (!manage) {
    return (
      <div className="svc-mg">
        <Panel bare title={L('링크', 'Links')} hint={String(rows.length)}>
          {rows.length === 0 && (
            <Row className="empty">{L('아직 링크가 없습니다. 관리 모드에서 추가하세요.', 'No links yet — add them in manage mode.')}</Row>
          )}
          {rows.map((r, i) => (
            // rel="noreferrer" with target=_blank: without it the opened page gets
            // a handle on this one via window.opener.
            <a key={i} href={r.url} target="_blank" rel="noreferrer" className="set-row set-link">
              <Icon name={r.icon || 'link'} size={18} weight={ICON_WEIGHT} color={r.color || 'var(--text-secondary)'} />
              <span>{r.label}</span>
              {r.note && <span className="sub">{r.note}</span>}
              <span className="sp" />
              <span className="sub mono">{where(r.url)}</span>
              <Icon name="link" size={13} color="var(--text-muted)" />
            </a>
          ))}
        </Panel>
      </div>
    )
  }

  return (
    <div className="svc-mg">
      <Panel bare title={L('링크', 'Links')} hint={String(rows.length)}
        right={<Button variant="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? L('저장 중…', 'Saving…') : L('저장', 'Save')}
        </Button>}>
        {rows.map((r, i) => (
          <div key={i} className="set-row">
            <IconPick value={r.icon || 'link'} onChange={(v) => edit(i, 'icon', v)} color={r.color || 'var(--text-secondary)'} />
            <ColorPicker value={r.color || AVATAR_COLORS[0]} onChange={(v) => edit(i, 'color', v)} />
            <input style={{ ...fieldInput, width: 150 }} value={r.label} placeholder={L('이름', 'Name')}
              onChange={(e) => edit(i, 'label', e.target.value)} />
            <input style={{ ...fieldInput, flex: 1, minWidth: 200 }} value={r.url} placeholder="https://…"
              onChange={(e) => edit(i, 'url', e.target.value)} />
            <input style={{ ...fieldInput, width: 130 }} value={r.note || ''} placeholder={L('설명(선택)', 'Note (optional)')}
              onChange={(e) => edit(i, 'note', e.target.value)} />
            <span className="sp" />
            <Button variant="secondary" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="caret-up" size={14} /></Button>
            <Button variant="secondary" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon name="caret-down" size={14} /></Button>
            <Button variant="dangerSoft" onClick={() => remove(i)}><Icon name="trash" size={14} /></Button>
          </div>
        ))}
        <Row>
          <Button variant="secondary" onClick={add}><Icon name="plus" size={14} /> {L('링크 추가', 'Add link')}</Button>
        </Row>
      </Panel>
    </div>
  )
}
