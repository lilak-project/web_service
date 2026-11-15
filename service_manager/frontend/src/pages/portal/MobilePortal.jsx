import { useState } from 'react'
import { Avatar, Icon, MANAGER_COLOR, tr } from 'lilak-ui'
import './mobile.css'

/**
 * MobilePortal — the cover on a phone: a top bar, one page at a time, and a foot
 * bar of tabs (Service, Inbox, one slot held, Account). No service is offered on
 * a phone yet.
 */
export default function MobilePortal({ user, isManager, info, onLogout, authCard }) {
  const [tab, setTab] = useState('service')       // service | inbox | account
  // Signed out: the portal's own sign-in card on the grey ground, no bar. The card
  // sits where the taller sign-up card would be centred, so switching tabs does
  // not move it; logo, host and version stand in the room above it.
  if (authCard) {
    return (
      <div className="mp-root">
        <main className="mp-body mp-auth">
          <div className="mp-auth-sp mp-auth-host">
            <Icon name="lilak" size={40} />
            <b>{info?.host || 'lilak'}</b>
            {info?.version && <small>{info.version}</small>}
          </div>
          <div className="mp-auth-card">{authCard}</div>
          <div className="mp-auth-sp" />
        </main>
      </div>
    )
  }

  // The foot bar: the sign-in card's folder tabs laid along the bottom. The third
  // slot is held for a menu not chosen yet.
  const TABS = [['service', 'squares-four', tr('m_service')], ['inbox', 'envelope', tr('m_inbox')], null, ['account', 'user', tr('m_account')]]

  return (
    <div className="mp-root">
      <header className="mp-bar">
        <Icon name="lilak" size={26} />
        <span className="mp-host">{info?.host || 'lilak'}<small>{info?.version}</small></span>
      </header>

      <main className="mp-body">
        {/* ponytail: no service is offered on a phone yet; a manager-chosen list comes later. */}
        {tab === 'service' && <p className="mp-empty">{tr('m_none')}</p>}
        {tab === 'inbox' && <p className="mp-empty">{tr('m_inbox_none')}</p>}
        {tab === 'account' && (
          <section className="mp-sec">
            <div className="mp-me">
              <Avatar icon={user?.profile_shape} color={isManager ? MANAGER_COLOR : user?.profile_color}
                seed={user?.username} size={44} />
              <span><b>{user?.display_name || user?.username}</b><small>@{user?.username}</small></span>
            </div>
            <div className="mp-list">
              <button type="button" className="mp-row" onClick={() => {
                try { localStorage.setItem('lilak-desktop', '1') } catch { /* private mode */ }
                window.location.reload()
              }}>
                <Icon name="browse" size={18} /><span className="mp-rowtxt"><b>{tr('m_desktop')}</b></span>
              </button>
              <button type="button" className="mp-row out" onClick={onLogout}>
                <Icon name="logout" size={18} /><span className="mp-rowtxt"><b>{tr('p_log_out')}</b></span>
              </button>
            </div>
          </section>
        )}
      </main>

      <nav className="mp-tabs">
        {TABS.map((x, i) => x ? (
          <button key={x[0]} type="button" aria-pressed={tab === x[0]} onClick={() => setTab(x[0])}>
            <Icon name={x[1]} size={22} /><span>{x[2]}</span>
          </button>
        ) : <span key={i} className="mp-tab-later" />)}
      </nav>
    </div>
  )
}
