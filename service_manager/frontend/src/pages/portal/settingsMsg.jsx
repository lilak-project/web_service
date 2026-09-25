import { useEffect, useState } from 'react'

/**
 * The Settings screen's ONE status line.
 *
 * Every settings page used to print its own result at the top of its own body —
 * which is exactly where you are not looking after clicking a button near the
 * bottom, so "password changed" and "wrong password" both read as nothing
 * happening. Now every page says it in the same place: a fixed line at the foot
 * of the settings panel, always there so it never shifts the page when it fills.
 *
 *   notify(L('비밀번호 변경됨', 'password changed'), 'ok')
 *   notify(err, 'bad')
 *
 * A module-level event rather than a context: the pages are spread across five
 * files and three levels, and none of them need to re-render when it changes.
 */
const EVENT = 'portal-settings-msg'
const HOLD_MS = 6000

export function notify(text, tone) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { text: String(text ?? ''), tone, at: Date.now() } }))
}

export function SettingsStatus() {
  const [m, setM] = useState(null)
  useEffect(() => {
    const on = (e) => setM(e.detail)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  // Fade the message out on its own, but keep the LINE — a strip that appears and
  // disappears would push the page up and down every time you click something.
  useEffect(() => {
    if (!m) return
    const t = setTimeout(() => setM((cur) => (cur === m ? null : cur)), HOLD_MS)
    return () => clearTimeout(t)
  }, [m])
  return (
    <div className={`set-status${m?.tone ? ' ' + m.tone : ''}`}>
      {m && <>
        <span className="dot" />
        <span className="txt">{m.text}</span>
      </>}
    </div>
  )
}
