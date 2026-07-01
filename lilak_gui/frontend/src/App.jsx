import { LangProvider, IdentityProvider } from 'lilak-ui'
import { DICTS } from './i18n'
import { token } from './api'
import Shell from './components/Shell'

// Portal SSO — the cover frontend stores the JWT before navigating in. Decode it
// client-side for the display name so the shell shows the real user.
function portalName() {
  try {
    const t = token()
    if (!t) return 'guest'
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return p.name || p.username || p.email || 'guest'
  } catch {
    return 'guest'
  }
}

// AppShell (used inside Shell) provides its own command registry — the app only
// supplies language + identity.
export default function App() {
  return (
    <LangProvider dicts={DICTS} defaultLang="ko">
      <IdentityProvider defaultName={portalName()}>
        <Shell />
      </IdentityProvider>
    </LangProvider>
  )
}
