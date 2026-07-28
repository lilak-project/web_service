import { useRef, useState, useEffect, Children } from 'react'

/**
 * MasonryGrid — the home service cards laid out in fixed vertical columns.
 *
 * Columns = floor(width / COL), so the grid gains a column every ~COL of width.
 * Cards are dealt round-robin into the columns (card i → column i % n), which
 * reads left-to-right, top-to-bottom. Each column is a plain flex stack, so
 * opening a card (it animates taller) simply pushes the cards BELOW it in the same
 * column straight down — no sideways shuffling, no reflow into other columns. The
 * push is smooth for free: it's just normal flow following the opening card's
 * animated height.
 */
const GAP = 12
const COL = 340   // min column width; a new column appears every (COL + GAP)px

// Breakpoints, in terms of the GRID's own width (not the viewport):
//   < SINGLE_MAX_W      → 1 column  (data-layout="single")
//   ≥ TWO_COL_MIN_W     → 2 columns (data-layout="multi"), etc.
// TWO_COL_MIN_W = 2*COL + GAP = 692px. The grid = viewport − 32px page padding
// (16px each side, no scrollbar), so 2 columns kick in at ≈ 724px of window width.
export const TWO_COL_MIN_W = 2 * COL + GAP   // 692 (grid px); ≈ 724px viewport
export const SINGLE_MAX_W = TWO_COL_MIN_W - 1

export function MasonryGrid({ children }) {
  const ref = useRef(null)
  const [cols, setCols] = useState(1)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setCols(Math.max(1, Math.floor((el.clientWidth + GAP) / (COL + GAP))))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const kids = Children.toArray(children)
  const columns = Array.from({ length: cols }, (_, c) => kids.filter((_, i) => i % cols === c))

  // Name the two states so they're easy to refer to (and style) from the DOM.
  const layout = cols <= 1 ? 'single' : 'multi'
  return (
    <div ref={ref} data-layout={layout} style={{ display: 'flex', gap: GAP, alignItems: 'flex-start' }}>
      {columns.map((col, c) => (
        <div key={c} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP }}>
          {col}
        </div>
      ))}
    </div>
  )
}
