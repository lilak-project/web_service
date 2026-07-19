import { useRef, useState, useLayoutEffect, useEffect } from 'react'

/**
 * MasonryGrid — a row-major masonry for the home service cards.
 *
 * True CSS masonry isn't shipped yet, so this uses the standard grid trick: a grid
 * of small fixed row-units (ROW px), and each item spans as many rows as its
 * measured height needs. Columns are ~COL-wide and fill the width, so the grid
 * gains a column each time the area grows past another COL. `dense` flow backfills
 * the gaps a tall (opened) card leaves, so its column grows downward and the
 * neighbours reflow up into the freed space.
 *
 * A card can span the FULL width (all columns) via <MasonryItem full> — used for
 * the icon editor, which wants its wide two-column layout.
 */
const ROW = 8    // px per grid row unit (smaller = finer height fit)
const GAP = 12   // px gap between cards (both axes)
const COL = 340  // min column width; columns = floor(area / COL)

export function MasonryGrid({ children }) {
  return (
    <div style={{
      display: 'grid',
      // min(COL, 100%) so a screen narrower than one column doesn't overflow.
      gridTemplateColumns: `repeat(auto-fill, minmax(min(${COL}px, 100%), 1fr))`,
      gridAutoRows: `${ROW}px`,
      gridAutoFlow: 'row dense',
      alignItems: 'start',
      columnGap: `${GAP}px`,
      rowGap: 0,               // vertical spacing comes from the per-item row span
    }}>{children}</div>
  )
}

/**
 * One grid cell. Measures its child's height and claims that many row-units, so the
 * grid packs cards of any height. `recomputeKey` forces a re-measure (e.g. on
 * open/close) in case ResizeObserver is throttled. `full` spans every column.
 */
export function MasonryItem({ full = false, recomputeKey, children }) {
  const ref = useRef(null)
  const [span, setSpan] = useState(8)

  const measure = () => {
    const el = ref.current
    if (!el) return
    const h = el.getBoundingClientRect().height
    // rows to cover height H, then + GAP so cards don't touch vertically
    setSpan(Math.max(1, Math.ceil((h + GAP) / ROW)))
  }

  useLayoutEffect(() => { measure() })            // every render (cheap; height is cached)
  useEffect(() => { measure() }, [recomputeKey])  // and explicitly on open/close
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div style={{ gridRow: `span ${span}`, gridColumn: full ? '1 / -1' : undefined, minWidth: 0 }}>
      <div ref={ref}>{children}</div>
    </div>
  )
}
