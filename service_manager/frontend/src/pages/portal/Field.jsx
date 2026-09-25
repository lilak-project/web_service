/**
 * Field — the two-column card layout the Settings screens share.
 *
 * Left column is the field's title, right column is its value / edit control, and
 * any buttons for that field go on their OWN line under the value (never beside
 * the title). Everything on these cards is ONE text size — FIELD_TEXT — so a card
 * reads as a table of facts instead of a pile of competing sizes.
 *
 *   <div style={fieldGrid}>
 *     <Field label="Email">a@b.c · verified</Field>
 *     <FieldActions>
 *       <Button>Verify</Button>
 *     </FieldActions>
 *   </div>
 *
 * Field/FieldActions each emit TWO grid cells, so they only work as direct
 * children of a `fieldGrid` container (FieldActions leaves the label cell empty).
 */

import './settings.css'

// One step up from the old --fs-small: these cards are the page, not a footnote.
export const FIELD_TEXT = { fontSize: 'var(--fs-medium, 14px)' }

/** The card the rows live in. Kept as a style object for the call sites that
 *  spread it, but the look now comes from `.set-card` (settings.css) — a grid
 *  needs a stylesheet to put a rule between rows and not after the last one. */
export const fieldGrid = {}
export const FIELD_CARD_CLASS = 'set-card'

/** A heading above a card, and the status pill both used across the pages. */
export function SettingsHead({ title, hint, children }) {
  return (
    <div className="set-head">
      <h2>{title}</h2>
      <span className="sp" />
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  )
}

export function Pill({ tone, children }) {
  return <span className={`set-pill${tone ? ` ${tone}` : ''}`}>{children}</span>
}

/** Label cell + value cell. `align="start"` for a tall value (a wrapping chip list). */
export function Field({ label, align, children }) {
  return (
    <>
      <span style={{ ...FIELD_TEXT, color: 'var(--text-secondary)',
        alignItems: align === 'start' ? 'flex-start' : undefined }}>{label}</span>
      <div style={{ ...FIELD_TEXT, color: 'var(--text-emphasis)', minWidth: 0,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </>
  )
}

/** An empty label cell + a row of buttons in the value column. */
export function FieldActions({ children }) {
  return (
    <>
      <span className="set-actions" />
      <div className="set-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>
    </>
  )
}

/** Muted placeholder for an empty value ("no grants yet"), at the card's one size. */
export const fieldMuted = { ...FIELD_TEXT, color: 'var(--text-muted)' }

/** A removable/plain pill — same text size as everything else on the card. */
export const fieldChip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, ...FIELD_TEXT,
  padding: '2px 4px 2px 8px', borderRadius: 999,
  border: '1px solid var(--border-default)', background: 'var(--surface)',
}
