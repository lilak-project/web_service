import { useEffect, useState } from 'react'
import { Icon } from 'lilak-ui'

// Body open/close animation, asset_manager-style: a grid-template-rows 0fr↔1fr
// transition grows/shrinks the body to its natural height with no measuring. On
// open the children mount first, then grow next frame; on close they shrink, then
// unmount after the transition (so a collapsed card runs no work / makes no calls).
const ANIM_MS = 520

/**
 * ExpandBox — the one collapsible "box" shared by the three list surfaces that
 * behave identically: Home service cards, Accounts, and Groups. Clicking anywhere
 * on the header row toggles it open/closed; the box gets a clear border that
 * highlights (blue) when open. A big leading icon + a large title read at a glance.
 *
 * Slots:
 *   icon      — leading mark (service icon / Avatar / GroupMark), rendered big.
 *   title     — the name (large, bold).
 *   badges    — small chips shown inline after the title.
 *   subtitle  — muted line under the title.
 *   right     — actions parked at the right edge; clicks there do NOT toggle
 *               (they stopPropagation) unless the handler itself toggles.
 *   children  — revealed under the header when `open`.
 *
 * toggleable=false → header is inert (e.g. a Home card you can only "Request").
 * manage=true      → dashed border (Home admin manage mode).
 * divider=true     → a top rule between header and children.
 * padding/titleSize → per-surface sizing (Home service cards run larger than the
 *   compact Accounts/Groups rows).
 */
export default function ExpandBox({
  open, onToggle, toggleable = true, manage = false, divider = true, caret = true,
  icon, title, badges, subtitle, right, children, style,
  padding = '8px 14px', titleSize = 'var(--fs-medium, 14px)', titleWeight = 600, radius = 12,
}) {
  // `render` = children mounted; `grown` = grid expanded. Open: mount now, then grow
  // once the body has mounted (a frame later, so 0fr paints first and the transition
  // runs). Close: shrink now, unmount after the transition so a collapsed card does
  // no work.
  const [render, setRender] = useState(open)
  const [grown, setGrown] = useState(open)
  useEffect(() => {
    if (open) { setRender(true); return }
    setGrown(false)
    const t = setTimeout(() => setRender(false), ANIM_MS)
    return () => clearTimeout(t)
  }, [open])
  useEffect(() => {
    if (!open || !render) return
    // rAF grows right after the 0fr paint (smooth); a short timer is a fallback so a
    // backgrounded tab — where rAF never fires — still opens instead of sticking shut.
    const raf = requestAnimationFrame(() => setGrown(true))
    const t = setTimeout(() => setGrown(true), 60)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [open, render])

  // Keep the border WIDTH fixed (only the colour changes on open) — a thicker open
  // border shrank the content box and nudged the icon/title ~1px down-right.
  const border = `1.5px ${manage ? 'dashed' : 'solid'} ${open ? 'var(--btn-primary-bg, #2563eb)' : 'var(--border-strong, #94a3b8)'}`
  return (
    <div style={{ border, borderRadius: radius, overflow: 'hidden', background: 'var(--surface)', marginBottom: 10, ...style }}>
      <div onClick={toggleable ? onToggle : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 13, padding,
          cursor: toggleable ? 'pointer' : 'default',
          // A fast double-click on a clickable header would otherwise select the
          // title + inner text (native double-click text selection). Not on the
          // expanded children — only the header row is unselectable.
          ...(toggleable ? { userSelect: 'none', WebkitUserSelect: 'none' } : {}) }}>
        {toggleable && caret && (
          // One glyph rotated 90° on open (not caret-right↔caret-down, whose slightly
          // different shapes nudged the icon/title). Same box → nothing shifts; the
          // rotation also animates.
          <Icon name="caret-right" size={15} color="var(--text-muted)"
            style={{ flexShrink: 0, transition: 'transform .2s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        )}
        {icon != null && <div style={{ flexShrink: 0, display: 'flex' }}>{icon}</div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: titleSize, fontWeight: titleWeight }}>{title}</span>
            {badges}
          </div>
          {subtitle != null && <div style={{ fontSize: 'var(--fs-small, 13px)', color: 'var(--text-muted)', marginTop: 0, lineHeight: 1.25 }}>{subtitle}</div>}
        </div>
        {right != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}>{right}</div>
        )}
      </div>
      {render && (
        <div style={{ display: 'grid', gridTemplateRows: grown ? '1fr' : '0fr',
          transition: `grid-template-rows ${ANIM_MS}ms ease` }}>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <div style={divider ? { borderTop: '1px solid var(--border-default)' } : undefined}>{children}</div>
          </div>
        </div>
      )}
    </div>
  )
}
