import { useEffect, useState } from 'react'

/**
 * homeCols — a tiny preference for the Home service-card grid:
 *   'multi'  — responsive: 1 column when narrow, up to 3 when wide. Default.
 *   'single' — always one column, no matter how wide the window is.
 *
 * ('auto', the old name of the responsive setting, still reads as 'multi'.)
 *
 * Same shape as portalScale: localStorage-backed, broadcast on a custom event so
 * every consumer (MasonryGrid) and the toggle (AccountMenu) stay in sync in one
 * tab, and the storage event across tabs.
 */
const KEY = 'portal_home_cols'
const EVENT = 'portal-home-cols'
export const HOME_COLS = ['multi', 'single']
export const MAX_COLS = 3

export function getHomeCols() {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  if (v === 'auto') return 'multi'
  return HOME_COLS.includes(v) ? v : 'multi'
}

export function setHomeCols(v) {
  const next = HOME_COLS.includes(v) ? v : 'multi'
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: next }))
  return next
}

export function useHomeCols() {
  const [mode, set] = useState(getHomeCols)
  useEffect(() => {
    const sync = () => set(getHomeCols())
    sync()
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return {
    mode,
    single: mode === 'single',
    setHomeCols,
    toggle: () => setHomeCols(getHomeCols() === 'single' ? 'multi' : 'single'),
  }
}
