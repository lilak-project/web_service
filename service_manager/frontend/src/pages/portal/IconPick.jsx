import { useEffect, useRef, useState } from 'react'
import { Button, Icon, PICKER_ICONS, PROJECT_ICONS } from 'lilak-ui'

// Shared visual icon picker (used by NewServiceView + ServiceManagePanel). Icons
// render in DUOTONE — the house style for service marks.
export const ICON_CHOICES = Array.from(new Set(PICKER_ICONS && PICKER_ICONS.length ? PICKER_ICONS : PROJECT_ICONS))
export const DEFAULT_ICON = (PROJECT_ICONS && PROJECT_ICONS[0]) || ICON_CHOICES[0]
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
  const [q, setQ] = useState('')
  const ref = useRef(null)
  const btnRef = useRef(null)

  const POP_W = 7 * 34 + 16, POP_H = 300
  function place() {
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    let left = Math.min(b.left, window.innerWidth - POP_W - 8)
    let top = b.bottom + 4
    if (top + POP_H > window.innerHeight - 8) top = Math.max(8, b.top - POP_H - 4)
    setPos({ top, left: Math.max(8, left) })
  }
  function toggle() { if (!open) { setQ(''); place() } setOpen((o) => !o) }

  const query = q.trim().toLowerCase()
  const shown = query ? ICON_CHOICES.filter((ic) => ic.includes(query)) : ICON_CHOICES

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
          position: 'fixed', zIndex: 1000, top: pos.top, left: pos.left, width: POP_W,
          display: 'flex', flexDirection: 'column', gap: 6, padding: 8, maxHeight: POP_H,
          backgroundColor: 'var(--surface)', border: '1px solid var(--border-default)', borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…"
            style={{ height: 28, borderRadius: 6, fontSize: 'var(--fs-small, 12px)', padding: '0 8px',
              backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 30px)', gap: 4, overflowY: 'auto' }}>
            {shown.map((ic) => (
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
            {shown.length === 0 && <span style={{ gridColumn: '1 / -1', fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)', padding: 4 }}>no match</span>}
          </div>
        </div>
      )}
    </>
  )
}
