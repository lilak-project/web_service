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
const COL = 340   // min column width

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

  return (
    <div ref={ref} style={{ display: 'flex', gap: GAP, alignItems: 'flex-start' }}>
      {columns.map((col, c) => (
        <div key={c} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP }}>
          {col}
        </div>
      ))}
    </div>
  )
}
