import { useState } from 'react'
import { Avatar, AVATAR_ICONS, AVATAR_COLORS, randomAvatar, Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ProfileEditor — the portal account's avatar (profile_shape icon + profile_colour).
 * The avatar is the cross-service identity: it uses the same kit Avatar / AVATAR_ICONS
 * / AVATAR_COLORS elog uses, and flows to elog via SSO so the profile looks identical.
 * (Other elog fields like phone / experiment role / participation are elog-experiment
 * -specific and set inside elog, not here.)
 */

const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const lbl = { minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }

export default function ProfileEditor({ me, onSaved }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [shape, setShape] = useState(me.profile_shape || '')
  const [color, setColor] = useState(me.profile_color || '')
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')

  async function save(nextShape = shape, nextColor = color) {
    setShape(nextShape); setColor(nextColor)
    try {
      await launcher.post('/account/profile', { profile_shape: nextShape || null, profile_color: nextColor || null })
      setMsg(L('저장됨', 'saved')); onSaved?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }
  const roll = () => { const a = randomAvatar(); save(a.profile_shape, a.profile_color) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={rowS}>
        <span style={lbl}>{L('프로필 아바타', 'Profile avatar')}</span>
        <Avatar icon={shape} color={color} seed={me.username} size={40} />
        <Button size="sm" variant="secondary" onClick={roll}><Icon name="refresh" size={13} /> {L('랜덤', 'Random')}</Button>
        <Button size="sm" variant={open ? 'primary' : 'ghost'} onClick={() => setOpen((o) => !o)}>{open ? L('닫기', 'Close') : L('고르기', 'Pick')}</Button>
        {msg && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</span>}
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--border-default)', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AVATAR_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => save(shape, c)} title={c}
                style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: c, cursor: 'pointer',
                  border: color === c ? '2px solid var(--text-primary)' : '1px solid var(--border-default)' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxHeight: 170, overflowY: 'auto' }}>
            {AVATAR_ICONS.map((ic) => (
              <button key={ic} type="button" title={ic} onClick={() => save(ic, color)}
                style={{ display: 'grid', placeItems: 'center', padding: 3, borderRadius: 8, cursor: 'pointer',
                  border: shape === ic ? '2px solid var(--btn-primary-bg)' : '1px solid transparent',
                  background: shape === ic ? 'var(--surface-2)' : 'transparent' }}>
                <Avatar icon={ic} color={color || '#64748b'} size={28} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
