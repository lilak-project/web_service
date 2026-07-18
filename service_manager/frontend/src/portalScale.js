import { useEffect, useState } from 'react'

/**
 * portalScale — a tiny, self-contained "UI size" toggle for the portal cover.
 *
 * Deliberately NOT tied to the kit's colour themes or the index.css
 * data-size/data-density rules: it's a single flag so the whole experiment can be
 * hidden later by removing the two <ScaleToggle/> placements, and deleted by
 * removing this file. Two values only:
 *   compact — today's UI, the default. Nothing changes unless you opt in.
 *   roomy   — the bigger look (centred brand, login-sized nav buttons, …).
 *
 * State lives in localStorage and is mirrored to <html data-portal-scale> for any
 * future CSS; components subscribe via usePortalScale(). Changes broadcast on a
 * custom event so every toggle/consumer on the page stays in sync in one tab, and
 * on the storage event across tabs.
 */

const KEY = 'portal_ui_scale'
const EVENT = 'portal-ui-scale'
export const SCALES = ['compact', 'roomy']

export function getScale() {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  return SCALES.includes(v) ? v : 'compact'
}

export function setScale(v) {
  const next = SCALES.includes(v) ? v : 'compact'
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next)
  if (typeof document !== 'undefined') document.documentElement.dataset.portalScale = next
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: next }))
  return next
}

export function usePortalScale() {
  const [scale, set] = useState(getScale)
  useEffect(() => {
    const sync = () => set(getScale())
    sync()                                     // reflect the attribute on mount
    if (typeof document !== 'undefined') document.documentElement.dataset.portalScale = getScale()
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)   // other tabs
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return {
    scale,
    big: scale === 'roomy',
    setScale,
    toggle: () => setScale(getScale() === 'roomy' ? 'compact' : 'roomy'),
  }
}
