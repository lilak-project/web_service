import { useLayoutEffect, useRef } from 'react'

/**
 * useFlip — animate elements that MOVE between renders (First-Last-Invert-Play).
 *
 * Every element under `ref` carrying `data-flip-key` has its rect recorded after
 * each render. When `signal` changes (an order preview during a drag), each key
 * that is still on screen but at a new position is first put back where it was
 * with a transform, then released to slide to its new place. Nothing is
 * measured for elements that did not move, and a key seen for the first time
 * (or leaving) is not animated — it simply appears/disappears.
 */
export default function useFlip(ref, signal, ms = 220) {
  const last = useRef(new Map())
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const els = Array.from(root.querySelectorAll('[data-flip-key]'))
    const next = new Map()
    for (const el of els) {
      const key = el.getAttribute('data-flip-key')
      const r = el.getBoundingClientRect()
      next.set(key, r)
      const prev = last.current.get(key)
      if (!prev) continue
      const dx = prev.left - r.left, dy = prev.top - r.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      // Force the inverted position to paint before releasing it.
      void el.offsetWidth
      requestAnimationFrame(() => {
        el.style.transition = `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`
        el.style.transform = ''
        const done = () => { el.style.transition = ''; el.removeEventListener('transitionend', done) }
        el.addEventListener('transitionend', done)
      })
    }
    last.current = next
  }, [signal])  // eslint-disable-line react-hooks/exhaustive-deps
}
