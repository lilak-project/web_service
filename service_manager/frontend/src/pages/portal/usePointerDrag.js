import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * usePointerDrag — home-screen style drag for the cover cards and group bands.
 *
 * Pointer events, not HTML5 drag-and-drop: the browser's DnD gives a ghost you
 * cannot style, fires dragover many times a frame, and flips before/after the
 * moment the pointer crosses a midpoint — which is the jitter. Here:
 *
 *   • the drag starts only after the pointer moved SLOP px (a click stays a click)
 *   • the card follows the pointer as a floating ghost; its slot stays behind
 *   • hit-testing runs once per animation frame against the current rects of
 *     every `[data-flip-key]` element under `containerRef`
 *   • "before / after" only flips once the pointer has left a dead zone around
 *     the target's middle (hysteresis), so hovering near the middle is calm
 *   • the caller receives (key, kind, target, after, targetKind) previews and
 *     one commit on release; everything visual (the FLIP slide) is the caller's
 *
 * `isTarget(dragKey, kind, targetKey)` says which elements count for this drag.
 */
const SLOP = 6
const DEAD_ZONE = 0.18          // fraction of the target's height around its middle

export default function usePointerDrag({ containerRef, isTarget, onPreview, onCommit, onCancel }) {
  const [drag, setDrag] = useState(null)      // { key, kind, w, h } once active
  const st = useRef(null)                     // mutable drag state (pointer, offsets, last target)
  const ghostRef = useRef(null)
  const cbs = useRef({})
  cbs.current = { isTarget, onPreview, onCommit, onCancel }

  const stop = useCallback(() => {
    const s = st.current
    if (!s) return
    window.removeEventListener('pointermove', s.move)
    window.removeEventListener('pointerup', s.up)
    window.removeEventListener('pointercancel', s.up)
    if (s.raf) cancelAnimationFrame(s.raf)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    st.current = null
    setDrag(null)
  }, [])

  useEffect(() => () => stop(), [stop])

  const hitTest = useCallback((x, y) => {
    const s = st.current
    const root = containerRef.current
    if (!s || !root) return
    const els = Array.from(root.querySelectorAll('[data-flip-key]'))
    // Innermost first: a card inside a band is checked before the band itself.
    const hits = []
    for (const el of els) {
      const key = el.getAttribute('data-flip-key')
      if (!key || key === s.key) continue
      if (!cbs.current.isTarget(s.key, s.kind, key)) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hits.push({ key, r, group: key.startsWith('#g:') })
    }
    if (!hits.length) return
    const hit = hits.find((h) => !h.group) || hits[0]
    const mid = hit.r.top + hit.r.height / 2
    let after = y > mid
    if (hit.key === s.lastTarget && Math.abs(y - mid) < hit.r.height * DEAD_ZONE) after = s.lastAfter
    if (hit.key === s.lastTarget && after === s.lastAfter) return
    s.lastTarget = hit.key; s.lastAfter = after
    cbs.current.onPreview?.(s.key, s.kind, hit.key, after, hit.group ? 'group' : 'card')
  }, [containerRef])

  const startDrag = useCallback((e, key, kind) => {
    if (e.button != null && e.button !== 0) return
    if (st.current) return
    e.preventDefault()
    const root = containerRef.current
    const el = root?.querySelector(`[data-flip-key="${(window.CSS && CSS.escape) ? CSS.escape(key) : key}"]`)
    const r = el?.getBoundingClientRect()
    const s = {
      key, kind, active: false,
      startX: e.clientX, startY: e.clientY,
      offX: e.clientX - (r?.left ?? 0), offY: e.clientY - (r?.top ?? 0),
      w: r?.width ?? 320, h: r?.height ?? 64,
      lastTarget: null, lastAfter: null, raf: 0, x: e.clientX, y: e.clientY,
    }
    s.move = (ev) => {
      s.x = ev.clientX; s.y = ev.clientY
      if (!s.active) {
        if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) < SLOP) return
        s.active = true
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'grabbing'
        setDrag({ key, kind, w: s.w, h: s.h })
      }
      const g = ghostRef.current
      if (g) { g.style.left = `${s.x - s.offX}px`; g.style.top = `${s.y - s.offY}px` }
      if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; hitTest(s.x, s.y) })
    }
    s.up = () => {
      const wasActive = s.active
      stop()
      if (wasActive) cbs.current.onCommit?.(key, kind)
      else cbs.current.onCancel?.(key, kind)
    }
    st.current = s
    window.addEventListener('pointermove', s.move)
    window.addEventListener('pointerup', s.up)
    window.addEventListener('pointercancel', s.up)
  }, [containerRef, hitTest, stop])

  return { drag, startDrag, ghostRef }
}
