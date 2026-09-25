/**
 * Field — the pieces every Settings screen is built from (direction C, "묶음").
 *
 * A page is a grey ground holding white PANELS. A panel's title is its header
 * strip, and inside it everything is a row of one text size:
 *
 *   <Panel title="계정" hint="jungwoo · 매니저">
 *     <div className={FIELD_CARD_CLASS}>
 *       <Field label="이메일">a@b.c <Pill tone="ok">확인됨</Pill></Field>
 *       <FieldActions><Button>변경</Button></FieldActions>
 *     </div>
 *   </Panel>
 *
 * Field/FieldActions each emit TWO grid cells, so they only work as direct
 * children of a `.set-card` container (FieldActions leaves the label cell empty).
 */

import { useState } from 'react'
import { Icon } from 'lilak-ui'

import './settings.css'

// One step up from the old --fs-small: these rows are the page, not a footnote.
export const FIELD_TEXT = { fontSize: 'var(--fs-medium, 14px)' }

/** The rows grid. Kept as a style object for the call sites that spread it, but
 *  the look comes from `.set-card` (settings.css) — a grid needs a stylesheet to
 *  put a rule between rows and not after the last one. */
export const fieldGrid = {}
export const FIELD_CARD_CLASS = 'set-card'

/**
 * Panel — a white box on the grey ground with its name in the header strip.
 * `danger` paints the strip red; use it once per page, at the bottom, for the
 * things that cannot be undone.
 */
export function Panel({ title, hint, right, danger, bare, fold, open: openProp, style, children }) {
  // `fold`: the strip becomes the handle for its own body. Local state, because
  // nothing outside the panel needs to know — and a panel you closed stays shut
  // while you work in the one below it.
  const [open, setOpen] = useState(openProp !== false)
  const shown = !fold || open
  return (
    <section className={`set-panel${danger ? ' danger' : ''}`} style={style}>
      {(title || hint || right) && (
        <header className="set-bar">
          {fold ? (
            <button type="button" className={`set-plain set-fold${open ? ' open' : ''}`}
              onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <Icon name="caret-right" size={12} />
              <b>{title}</b>
            </button>
          ) : title && <b>{title}</b>}
          {hint && <span className="hint">{hint}</span>}
          <span className="sp" />
          {right}
        </header>
      )}
      {shown && (bare ? children : <div className={FIELD_CARD_CLASS}>{children}</div>)}
    </section>
  )
}

/** One record in a list panel: `<Row>` is a flex line with a rule above it. */
export function Row({ className, style, children }) {
  return <div className={`set-row${className ? ' ' + className : ''}`} style={style}>{children}</div>
}

/** The status vocabulary: tone is undefined | "ok" | "warn" | "bad". */
export function Pill({ tone, children }) {
  return <span className={`set-pill${tone ? ` ${tone}` : ''}`}>{children}</span>
}

/** Label cell + value cell. `align="start"` for a tall value (a wrapping chip list). */
export function Field({ label, align, children }) {
  return (
    <>
      <span style={{ ...FIELD_TEXT,
        alignItems: align === 'start' ? 'flex-start' : undefined }}>{label}</span>
      <div style={{ ...FIELD_TEXT, color: 'var(--text-primary)', minWidth: 0,
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

/** Secondary text inside a row ("no grants yet"), at the page's one size. */
export const fieldMuted = { ...FIELD_TEXT, color: 'var(--text-secondary)' }

/** A removable/plain chip — same text size and corner as everything else. */
export const fieldChip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, ...FIELD_TEXT,
  padding: '0 4px 0 8px', borderRadius: 'var(--radius-lg, 5px)',
  border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }

/** The one input style, for the places that cannot use a plain <input>. */
export const fieldInput = {
  height: 28, borderRadius: 'var(--radius-lg, 5px)', ...FIELD_TEXT,
  padding: '0 9px', background: 'var(--input-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--input-border)', boxSizing: 'border-box', minWidth: 0 }

/** Deprecated: a heading above a card. Panels carry their own title now. */
export function SettingsHead({ title, hint, children }) {
  return (
    <div className="set-bar">
      <b>{title}</b>
      <span className="sp" />
      {hint && <span className="hint">{hint}</span>}
      {children}
    </div>
  )
}
