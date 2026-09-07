import { useRef, useState, useEffect, Children } from 'react'
import { useHomeCols, MAX_COLS } from '../../homeCols'

/**
 * MasonryGrid — the home service cards laid out in fixed vertical columns.
 *
 * Columns = floor(width / COL), capped at MAX_COLS (3), so the grid gains a
 * column every ~COL of width up to three. Cards are dealt COLUMN-MAJOR: the
 * first ceil(n/cols) cards fill the left column top to bottom, the next batch
 * the second column, and so on — so reading order is down the left column, then
 * down the right, the way a list in columns is read. Each column is a plain flex
 * stack, so opening a card (it animates taller) simply pushes the cards BELOW it
 * in the same column straight down — no sideways shuffling.
 */
const GAP = 12
const COL = 340   // min column width; a new column appears every (COL + GAP)px

export const TWO_COL_MIN_W = 2 * COL + GAP
export const SINGLE_MAX_W = TWO_COL_MIN_W - 1

/** Deal `n` items into `cols` columns column-major, balancing the counts so the
 *  first columns get the extra item when n does not divide evenly. */
export function dealColumns(items, cols) {
  const n = items.length
  const base = Math.floor(n / cols), extra = n % cols
  const out = []
  let i = 0
  for (let c = 0; c < cols; c++) {
    const size = base + (c < extra ? 1 : 0)
    out.push(items.slice(i, i + size))
    i += size
  }
  return out
}

export function MasonryGrid({ children, maxCols = MAX_COLS, style }) {
  const ref = useRef(null)
  const [cols, setCols] = useState(1)
  const { single } = useHomeCols()   // user pref: 'single' forces one column at any width

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setCols(Math.max(1, Math.min(maxCols, Math.floor((el.clientWidth + GAP) / (COL + GAP)))))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxCols])

  const kids = Children.toArray(children)
  const effCols = single ? 1 : Math.max(1, Math.min(cols, kids.length || 1))
  const columns = dealColumns(kids, effCols)

  const layout = effCols <= 1 ? 'single' : 'multi'
  return (
    <div ref={ref} data-layout={layout} style={{ display: 'flex', gap: GAP, alignItems: 'flex-start', ...style }}>
      {columns.map((col, c) => (
        <div key={c} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP }}>
          {col}
        </div>
      ))}
    </div>
  )
}
