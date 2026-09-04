import { useEffect, useState } from 'react'
import { Button, Icon, ColorPicker, AVATAR_COLORS } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import IconPick, { ICON_WEIGHT } from './IconPick'

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

const field = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px',
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}
const BODY = { padding: '12px 14px 14px 46px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }

/** Trim a URL down to what tells you where it goes: host (+ port), or the path. */
function where(url) {
  try { const u = new URL(url, window.location.origin); return u.host + (u.pathname === '/' ? '' : u.pathname) }
  catch { return url }
}

export default function LinksView({ links, manage, onChanged }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [rows, setRows] = useState(links || [])
  const [msg, setMsg] = useState('')
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
    setSaving(true); setMsg('')
    try {
      // Drop blank rows rather than making the server reject the whole save for
      // one the admin added and then left empty.
      const links = rows.filter((r) => (r.label || '').trim() && (r.url || '').trim())
      const { data } = await launcher.put('/admin/links', { links })
      setRows(data.links); setMsg(L('저장됨', 'saved')); onChanged?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('저장 실패', 'Save failed')) }
    finally { setSaving(false) }
  }

  if (!manage) {
    if (!rows.length) {
      return <div style={BODY}>
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>
          {L('아직 링크가 없습니다. 관리 모드에서 추가하세요.', 'No links yet — add them in manage mode.')}
        </span>
      </div>
    }
    return (
      <div style={BODY}>
        {rows.map((r, i) => (
          // rel="noreferrer" with target=_blank: without it the opened page gets a
          // handle on this one via window.opener.
          <a key={i} href={r.url} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit', padding: '4px 0' }}>
            <Icon name={r.icon || 'link'} size={18} weight={ICON_WEIGHT} color={r.color || 'var(--text-secondary)'} />
            <span style={{ fontSize: 'var(--fs-small, 13px)', fontWeight: 500 }}>{r.label}</span>
            {r.note && <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{r.note}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{where(r.url)}</span>
            <Icon name="arrow-up-right" size={13} color="var(--text-muted)" />
          </a>
        ))}
      </div>
    )
  }

  return (
    <div style={BODY}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <IconPick value={r.icon || 'link'} onChange={(v) => edit(i, 'icon', v)} color={r.color || 'var(--text-secondary)'} />
          <ColorPicker value={r.color || AVATAR_COLORS[0]} onChange={(v) => edit(i, 'color', v)} />
          <input style={{ ...field, width: 150 }} value={r.label} placeholder={L('이름', 'Name')}
            onChange={(e) => edit(i, 'label', e.target.value)} />
          <input style={{ ...field, flex: 1, minWidth: 200 }} value={r.url} placeholder="https://…  또는  /p/elog/"
            onChange={(e) => edit(i, 'url', e.target.value)} />
          <input style={{ ...field, width: 130 }} value={r.note || ''} placeholder={L('설명(선택)', 'Note (optional)')}
            onChange={(e) => edit(i, 'note', e.target.value)} />
          <Button variant="ghost" size="sm" icon disabled={i === 0} onClick={() => move(i, -1)}><Icon name="caret-up" size={14} /></Button>
          <Button variant="ghost" size="sm" icon disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon name="caret-down" size={14} /></Button>
          <Button variant="ghost" size="sm" icon onClick={() => remove(i)} style={{ color: 'var(--danger-text)' }}><Icon name="trash" size={14} /></Button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button variant="secondary" size="sm" onClick={add}><Icon name="plus" size={14} /> {L('링크 추가', 'Add link')}</Button>
        <div style={{ flex: 1 }} />
        {msg && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{msg}</span>}
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? L('저장 중…', 'Saving…') : L('저장', 'Save')}
        </Button>
      </div>
    </div>
  )
}
