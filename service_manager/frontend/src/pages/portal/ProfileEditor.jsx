import { useState } from 'react'
import { Avatar, AVATAR_ICONS, AVATAR_COLORS, randomAvatar, MANAGER_COLOR, Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ProfileEditor — the portal account's avatar (profile_shape icon + profile_colour),
 * shared with elog via SSO. Colour is role-gated exactly like elog: admins/managers
 * always use the reserved MANAGER_COLOR (black) and can't pick another; non-admins
 * choose from AVATAR_COLORS and can never take the manager colour.
 */

const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const lbl = { minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }

export default function ProfileEditor({ me, onSaved }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const isAdmin = me.is_admin || me.role === 'manager'
  const MC = me.manager_color || MANAGER_COLOR
  const [shape, setShape] = useState(me.profile_shape || '')
  const [color, setColor] = useState(isAdmin ? MC : (me.profile_color || ''))
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const effColor = isAdmin ? MC : color

  async function save(nextShape = shape, nextColor = color) {
    const c = isAdmin ? MC : nextColor
    setShape(nextShape); setColor(c)
    try {
      await launcher.post('/account/profile', { profile_shape: nextShape || null, profile_color: c || null })
      setMsg(L('저장됨', 'saved')); onSaved?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  const roll = () => {
    const a = randomAvatar()
    save(a.profile_shape, isAdmin ? MC : a.profile_color)   // admins: new icon, colour stays black
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={rowS}>
        <span style={lbl}>{L('프로필 아바타', 'Profile avatar')}</span>
        <Avatar icon={shape} color={effColor} seed={me.username} size={40} />
        <Button size="sm" variant="secondary" onClick={roll}><Icon name="refresh" size={13} /> {L('랜덤', 'Random')}</Button>
        <Button size="sm" variant={open ? 'primary' : 'ghost'} onClick={() => setOpen((o) => !o)}>{open ? L('닫기', 'Close') : L('고르기', 'Pick')}</Button>
        {isAdmin && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{L('관리자는 검은색 고정', 'admins are locked to black')}</span>}
        {msg && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</span>}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--border-default)', borderRadius: 8 }}>
          {/* colour — only non-admins choose; admins are fixed to black */}
          {!isAdmin && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {AVATAR_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => save(shape, c)} title={c}
                  style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: c, cursor: 'pointer',
                    border: color === c ? '2px solid var(--text-primary)' : '1px solid var(--border-default)' }} />
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxHeight: 170, overflowY: 'auto' }}>
            {AVATAR_ICONS.map((ic) => (
              <button key={ic} type="button" title={ic} onClick={() => save(ic, color)}
                style={{ display: 'grid', placeItems: 'center', padding: 3, borderRadius: 8, cursor: 'pointer',
                  border: shape === ic ? '2px solid var(--btn-primary-bg)' : '1px solid transparent',
                  background: shape === ic ? 'var(--surface-2)' : 'transparent' }}>
                <Avatar icon={ic} color={effColor || '#64748b'} size={28} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
