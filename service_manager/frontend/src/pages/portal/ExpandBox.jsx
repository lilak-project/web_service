import { Icon } from 'lilak-ui'

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
  padding = '8px 14px', titleSize = 'var(--fs-medium, 14px)', titleWeight = 600,
}) {
  const border = `${open ? '2px' : '1.5px'} ${manage ? 'dashed' : 'solid'} ${open ? 'var(--btn-primary-bg, #2563eb)' : 'var(--border-strong, #94a3b8)'}`
  return (
    <div style={{ border, borderRadius: 12, overflow: 'hidden', background: 'var(--surface)', marginBottom: 10, ...style }}>
      <div onClick={toggleable ? onToggle : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 13, padding,
          cursor: toggleable ? 'pointer' : 'default',
          // A fast double-click on a clickable header would otherwise select the
          // title + inner text (native double-click text selection). Not on the
          // expanded children — only the header row is unselectable.
          ...(toggleable ? { userSelect: 'none', WebkitUserSelect: 'none' } : {}) }}>
        {toggleable && caret && <Icon name={open ? 'caret-down' : 'caret-right'} size={15} color="var(--text-muted)" style={{ flexShrink: 0 }} />}
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
      {open && <div style={divider ? { borderTop: '1px solid var(--border-default)' } : undefined}>{children}</div>}
    </div>
  )
}
