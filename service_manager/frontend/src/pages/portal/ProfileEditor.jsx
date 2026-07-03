import { useState } from 'react'
import { Avatar, AVATAR_ICONS, AVATAR_COLORS, randomAvatar, Button, Icon } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'

/**
 * ProfileEditor — the elog-style account profile, in the portal. The portal account
 * is a SUPERSET of an elog user; these fields (display name, phone, experiment role,
 * participation dates, avatar shape+colour) propagate to elog on the next SSO entry.
 * Uses the same kit Avatar / AVATAR_ICONS / AVATAR_COLORS elog uses, so the profile
 * looks identical in both.
 */

const rowS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const input = {
  height: 30, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px',
  backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)',
}
const lbl = { minWidth: 120, fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)' }

export default function ProfileEditor({ me, onSaved }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const [f, setF] = useState({
    display_name: me.display_name || '', phone: me.phone || '', experiment_role: me.experiment_role || '',
    participation_from: me.participation_from || '', participation_to: me.participation_to || '',
    profile_shape: me.profile_shape || '', profile_color: me.profile_color || '',
  })
  const [openIcons, setOpenIcons] = useState(false)
  const [msg, setMsg] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const roll = () => { const a = randomAvatar(); setF((s) => ({ ...s, profile_shape: a.profile_shape, profile_color: a.profile_color })) }

  async function save() {
    try {
      await launcher.post('/account/profile', {
        display_name: f.display_name.trim() || null, phone: f.phone.trim() || null,
        experiment_role: f.experiment_role.trim() || null,
        participation_from: f.participation_from || null, participation_to: f.participation_to || null,
        profile_color: f.profile_color || null, profile_shape: f.profile_shape || null,
      })
      setMsg(L('저장됨', 'saved')); onSaved?.()
    } catch (e) { setMsg(e?.response?.data?.detail || L('실패', 'failed')) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* avatar */}
      <div style={rowS}>
        <span style={lbl}>{L('프로필 아바타', 'Profile avatar')}</span>
        <Avatar icon={f.profile_shape} color={f.profile_color} seed={me.username} size={48} />
        <Button size="sm" variant="secondary" onClick={roll}><Icon name="refresh" size={13} /> {L('랜덤', 'Random')}</Button>
        <Button size="sm" variant={openIcons ? 'primary' : 'ghost'} onClick={() => setOpenIcons((o) => !o)}>{L('아이콘 고르기', 'Pick icon')}</Button>
      </div>
      {openIcons && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, border: '1px solid var(--border-default)', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AVATAR_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setF((s) => ({ ...s, profile_color: c }))} title={c}
                style={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: c, cursor: 'pointer',
                  border: f.profile_color === c ? '2px solid var(--text-primary)' : '1px solid var(--border-default)' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
            {AVATAR_ICONS.map((ic) => (
              <button key={ic} type="button" title={ic} onClick={() => setF((s) => ({ ...s, profile_shape: ic }))}
                style={{ display: 'grid', placeItems: 'center', padding: 3, borderRadius: 8, cursor: 'pointer',
                  border: f.profile_shape === ic ? '2px solid var(--btn-primary-bg)' : '1px solid transparent',
                  background: f.profile_shape === ic ? 'var(--surface-2)' : 'transparent' }}>
                <Avatar icon={ic} color={f.profile_color || '#64748b'} size={30} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* fields */}
      <div style={rowS}>
        <span style={lbl}>{L('표시 이름', 'Display name')}</span>
        <input value={f.display_name} onChange={set('display_name')} style={{ ...input, flex: 1 }} placeholder={me.username} />
      </div>
      <div style={rowS}>
        <span style={lbl}>{L('전화', 'Phone')}</span>
        <input value={f.phone} onChange={set('phone')} style={{ ...input, flex: 1 }} placeholder="010-…" />
      </div>
      <div style={rowS}>
        <span style={lbl}>{L('실험 역할', 'Experiment role')}</span>
        <input value={f.experiment_role} onChange={set('experiment_role')} style={{ ...input, flex: 1 }} placeholder={L('예: shifter / operator', 'e.g. shifter / operator')} />
      </div>
      <div style={rowS}>
        <span style={lbl}>{L('참여 기간', 'Participation')}</span>
        <input type="date" value={f.participation_from} onChange={set('participation_from')} style={input} />
        <span style={{ color: 'var(--text-muted)' }}>~</span>
        <input type="date" value={f.participation_to} onChange={set('participation_to')} style={input} />
      </div>

      <div style={{ ...rowS, marginTop: 2 }}>
        {msg && <span style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{msg}</span>}
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="primary" onClick={save}>{L('프로필 저장', 'Save profile')}</Button>
      </div>
    </div>
  )
}
