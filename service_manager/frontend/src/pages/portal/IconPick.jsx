import { useEffect, useRef, useState } from 'react'
import { Button, Icon, PROJECT_ICONS } from 'lilak-ui'

// Shared visual icon picker (used by NewServiceView + ServiceManage). Icons render
// in DUOTONE — the house style for service marks.
export const ICON_CHOICES = Array.from(new Set(PROJECT_ICONS))
export const DEFAULT_ICON = ICON_CHOICES[0]
export const ICON_WEIGHT = 'duotone'

/**
 * IconPick — a button showing the current icon; click for a grid of the actual
 * icons (no typing names blind). The popover is position:fixed so an ancestor's
 * overflow:hidden (the expanded service card) can't clip it; it flips above when
 * there's no room below.
 */
export default function IconPick({ value, onChange, disabled, color }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const btnRef = useRef(null)

  function place() {
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const W = 6 * 34 + 16, H = 210
    let left = Math.min(b.left, window.innerWidth - W - 8)
    let top = b.bottom + 4
    if (top + H > window.innerHeight - 8) top = Math.max(8, b.top - H - 4)
    setPos({ top, left: Math.max(8, left) })
  }
  function toggle() { if (!open) place(); setOpen((o) => !o) }

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', away)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <span ref={btnRef} style={{ display: 'inline-flex' }}>
        <Button variant="secondary" disabled={disabled} onClick={toggle}
          style={{ width: 52, justifyContent: 'center' }} title={value}>
          <Icon name={value} size={18} weight={ICON_WEIGHT} color={color || undefined} />
        </Button>
      </span>
      {open && pos && (
        <div ref={ref} style={{
          position: 'fixed', zIndex: 1000, top: pos.top, left: pos.left, display: 'grid',
          gridTemplateColumns: 'repeat(6, 30px)', gap: 4, padding: 8, maxHeight: 210, overflowY: 'auto',
          backgroundColor: 'var(--surface)', border: '1px solid var(--border-default)', borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        }}>
          {ICON_CHOICES.map((ic) => (
            <button key={ic} type="button" title={ic}
              onClick={() => { onChange(ic); setOpen(false) }}
              style={{
                display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
                border: ic === value ? '2px solid var(--btn-primary-bg)' : '1px solid var(--input-border)',
                backgroundColor: ic === value ? 'var(--info-bg, var(--surface-2))' : 'var(--surface)',
              }}>
              <Icon name={ic} size={16} weight={ICON_WEIGHT} color={color || undefined} />
            </button>
          ))}
        </div>
      )}
    </>
  )
}
