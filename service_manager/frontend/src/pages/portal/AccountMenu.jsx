import { useState, useRef, useEffect } from 'react'
import { Avatar, Icon, MANAGER_COLOR } from 'lilak-ui'
import { useLang } from '../../context/LangContext'

/**
 * AccountMenu — the top-right account control: avatar + name as a button that
 * drops a small menu (Log out) below it. Keeps the header uncluttered — the
 * logout action is one click away instead of always on screen. Closes on
 * outside-click or Escape.
 */
export default function AccountMenu({ user, isManager, onLogout }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const item = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    background: 'transparent', border: 'none', borderRadius: 8, padding: '10px 12px',
    cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-medium, 14px)', color: 'var(--text-primary)',
  }

  return (
    // The trigger shows the profile mark only (no username) — the name lives in the
    // dropdown. flexShrink:0 keeps it whole; its 46px height matches the nav buttons.
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={user.username}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer', font: 'inherit',
          height: 46, padding: '0 10px', color: 'var(--text-secondary)',
          background: open ? 'var(--surface-2)' : 'transparent',
          border: '1px solid transparent', borderRadius: 12 }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--surface-2)' }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent' }}>
        <Avatar icon={user.profile_shape} color={isManager ? MANAGER_COLOR : user.profile_color} seed={user.username} size={38} />
        <Icon name={open ? 'caret-up' : 'caret-down'} size={15} color="var(--text-muted)" />
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', minWidth: 184, maxWidth: 260, zIndex: 1000,
          background: 'var(--surface)', border: '1px solid var(--border-default)', borderRadius: 10,
          boxShadow: '0 6px 22px rgba(0,0,0,.16)', padding: 6 }}>
          {/* The username (hidden on the trigger) lives here, plus role/email. */}
          <div style={{ padding: '6px 12px 10px', marginBottom: 6, borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 'var(--fs-medium, 14px)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.username}{isManager ? ' · admin' : ''}
            </div>
            {user.email && <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>}
          </div>
          <button type="button" style={item}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            onClick={() => { setOpen(false); onLogout() }}>
            <Icon name="logout" size={16} /> {t('projects_logout')}
          </button>
        </div>
      )}
    </div>
  )
}
