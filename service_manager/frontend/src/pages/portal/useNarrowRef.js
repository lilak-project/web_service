import { useEffect, useRef, useState } from 'react'

/**
 * useNarrowRef — [ref, narrow]. `narrow` is true while the observed element is
 * under `bp` px wide. Used by card panels to lay their controls out on a second
 * line when the card is in a narrow (multi-column) grid slot.
 */
export function useNarrowRef(bp = 460) {
  const ref = useRef(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < bp))
    ro.observe(el)
    return () => ro.disconnect()
  }, [bp])
  return [ref, narrow]
}
