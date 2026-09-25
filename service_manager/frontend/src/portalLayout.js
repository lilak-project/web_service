import { useEffect, useState } from 'react'

/**
 * portalLayout — which cover the portal shows once you are signed in:
 *   'classic' — the card grid that has always been here. Default while the
 *               sidebar is being built, so nobody loses a working Home.
 *   'sidebar' — services in a left sidebar, the selected one in a panel on the
 *               right (see mockups/portal-sidebar-a.html).
 *
 * Same shape as portalScale / homeCols: localStorage-backed and broadcast on a
 * custom event, so the toggle in AccountMenu and the page switch together in one
 * tab, and the storage event carries it across tabs.
 */
const KEY = 'portal_layout'
const EVENT = 'portal-layout'
export const LAYOUTS = ['classic', 'sidebar']

export function getPortalLayout() {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  return LAYOUTS.includes(v) ? v : 'classic'
}

export function setPortalLayout(v) {
  const next = LAYOUTS.includes(v) ? v : 'classic'
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: next }))
  return next
}

export function usePortalLayout() {
  const [layout, set] = useState(getPortalLayout)
  useEffect(() => {
    const sync = () => set(getPortalLayout())
    sync()
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return {
    layout,
    sidebar: layout === 'sidebar',
    setPortalLayout,
    toggle: () => setPortalLayout(getPortalLayout() === 'sidebar' ? 'classic' : 'sidebar'),
  }
}
