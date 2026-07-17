import { useState } from 'react'
import { Avatar, AVATAR_ICONS, AVATAR_COLORS, randomAvatar, MANAGER_COLOR, Button, Icon, searchIcons } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ProfileEditor — the portal account's avatar (profile_shape icon + profile_colour),
 * shared with elog via SSO. Picks are staged locally; nothing is applied until Save.
 * Colour is role-gated like elog: admins are locked to MANAGER_COLOR (black); others
 * pick from AVATAR_COLORS and can never take the manager colour.
 */

const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

export default function ProfileEditor({ me, onSaved }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const isManager = me.is_admin || me.role === 'manager'
  const MC = me.manager_color || MANAGER_COLOR
  // Global managers lock to black; scoped (service/project) admins lock to dark grey.
  const scopedAdmin = !isManager && !!me.scoped_admin
  const locked = isManager || scopedAdmin
  const lockColor = isManager ? MC : (me.scoped_admin_color || '#4b5563')

  const initShape = me.profile_shape || ''
  const initColor = locked ? lockColor : (me.profile_color || '')
  const [shape, setShape] = useState(initShape)
  const [color, setColor] = useState(initColor)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  // Name OR the icon's own Phosphor tags, so "nut" finds `acorn`.
  const shown = searchIcons(q, AVATAR_ICONS)

  const effColor = locked ? lockColor : color
  const dirty = shape !== initShape || (!locked && color !== initColor)

  const pick = (nextShape = shape, nextColor = color) => {
    setShape(nextShape); setColor(locked ? lockColor : nextColor); setMsg('')
  }
  const roll = () => { const a = randomAvatar(); pick(a.profile_shape, a.profile_color) }

  async function save() {
    setBusy(true)
    try {
      // When the colour is locked, OMIT it — the shown colour is derived from the
      // role, so sending it would store something that outlives the role, and
      // sending null would wipe the colour they had before the role. Leaving the
      // field out keeps it for when they're demoted / the grant is revoked.
      await launcher.post('/account/profile', {
        profile_shape: shape || null,
        ...(locked ? {} : { profile_color: color || null }),
      })
      setMsg(L('저장됨', 'saved')); onSaved?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={rowS}>
        <Avatar icon={shape} color={effColor} seed={me.username} size={40} />
        {shape && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }}>{shape}</span>}
        <Button size="sm" variant="secondary" onClick={roll}><Icon name="refresh" size={13} /> {L('랜덤', 'Random')}</Button>
        <Button size="sm" variant={open ? 'primary' : 'ghost'} onClick={() => { setQ(''); setOpen((o) => !o) }}>{open ? L('닫기', 'Close') : L('고르기', 'Pick')}</Button>
        <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={save}>{L('저장', 'Save')}</Button>
        {locked && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{isManager ? L('관리자는 검은색 고정', 'managers locked to black') : L('부분 관리자는 짙은 회색 고정', 'scoped admins locked to grey')}</span>}
        {dirty && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('저장 안 됨', 'unsaved')}</span>}
        {msg && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{msg}</span>}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--border-default)', borderRadius: 8 }}>
          {/* colour — only non-admins choose; admins are fixed to black */}
          {!locked && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {AVATAR_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => pick(shape, c)} title={c}
                  style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: c, cursor: 'pointer',
                    border: color === c ? '2px solid var(--text-primary)' : '1px solid var(--border-default)' }} />
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={L('검색 (이름 또는 태그: nut, ufo…)', 'search (name or tag: nut, ufo…)')}
              style={{ flex: 1, height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px',
                backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }} />
            <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{shown.length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxHeight: 170, overflowY: 'auto' }}>
            {shown.map((ic) => (
              <button key={ic} type="button" title={ic} onClick={() => pick(ic, color)}
                style={{ display: 'grid', placeItems: 'center', padding: 3, borderRadius: 8, cursor: 'pointer',
                  border: shape === ic ? '2px solid var(--btn-primary-bg)' : '1px solid transparent',
                  background: shape === ic ? 'var(--surface-2)' : 'transparent' }}>
                <Avatar icon={ic} color={effColor || '#64748b'} size={28} />
              </button>
            ))}
            {shown.length === 0 && (
              <span style={{ gridColumn: '1 / -1', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', padding: 4 }}>
                {L('결과 없음', 'no match')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
