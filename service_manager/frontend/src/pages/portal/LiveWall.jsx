import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { useLang } from '../../context/LangContext'
import LiveTiles from './LiveTiles'

/**
 * LiveWall — the live mode. A full-viewport surface (the portal header, tabs
 * and account menu are gone; only Done remains) filled from the top edge with
 * live cards, never scrolling. Cards take the height their numbers need (at
 * least twice a normal card); each card's real height is measured, and the
 * cards are packed into columns top-to-bottom, left-to-right, until the window
 * is full — that is one page. ◀ ▶ beside Done turn pages. Only cards whose
 * service answers `/api/live` are shown; hidden cards never are.
 */
const GAP = 12
const COL_MIN = 380
const MAX_COLS = 3
const BAR_H = 52

function pack(cards, heights, cols, areaH, fallbackH) {
  const pages = []
  let page = Array.from({ length: cols }, () => [])
  let colH = new Array(cols).fill(0)
  let c = 0
  for (const card of cards) {
    const h = Math.min(areaH, heights.get(card.name) ?? fallbackH)
    if (colH[c] > 0 && colH[c] + GAP + h > areaH) {
      c += 1
      if (c >= cols) { pages.push(page); page = Array.from({ length: cols }, () => []); colH = new Array(cols).fill(0); c = 0 }
    }
    page[c].push(card)
    colH[c] += (colH[c] > 0 ? GAP : 0) + h
  }
  if (page.some((col) => col.length)) pages.push(page)
  return pages.length ? pages : [Array.from({ length: cols }, () => [])]
}

export default function LiveWall({ cards, big, onDone, iconFor }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const areaRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [page, setPage] = useState(0)
  const [heights, setHeights] = useState(() => new Map())
  const cardMin = big ? 190 : 160

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => setDims({ w: el.clientWidth - 2 * GAP, h: el.clientHeight - 2 * GAP })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // One observer for every card on screen: a card that grows (more tiles came
  // in) re-packs the pages so nothing is ever cut off or pushed off screen.
  const roRef = useRef(null)
  if (!roRef.current && typeof ResizeObserver !== 'undefined') {
    roRef.current = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = null
        for (const e of entries) {
          const key = e.target.getAttribute('data-live-key')
          const h = Math.ceil(e.target.getBoundingClientRect().height)
          if (key && Math.abs((prev.get(key) ?? 0) - h) > 1) { next = next || new Map(prev); next.set(key, h) }
        }
        return next || prev
      })
    })
  }
  useEffect(() => () => roRef.current?.disconnect(), [])
  const observe = useCallback((el) => { if (el && roRef.current) roRef.current.observe(el) }, [])

  const cols = Math.max(1, Math.min(MAX_COLS, Math.floor((dims.w + GAP) / (COL_MIN + GAP))))
  const pages = pack(cards, heights, cols, Math.max(cardMin, dims.h), cardMin)
  const cur = Math.min(page, pages.length - 1)
  useEffect(() => { if (page !== cur) setPage(cur) }, [cur, page])
  const columns = pages[cur]

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDone?.()
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') setPage((p) => Math.min(pages.length - 1, p + 1))
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPage((p) => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pages.length, onDone])

  const dot = (p) => (p.multi_project ? 'var(--info-text)' : p.running ? 'var(--ok-text, #2f9e44)' : 'var(--text-muted)')

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--app-bg)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column' }}>
      {/* the one bar: pager + Done */}
      <div style={{ height: BAR_H, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <Icon name="broadcast" size={18} color="var(--warning-text, #e67700)" />
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('라이브', 'Live')} · {cards.length}</span>
        <span style={{ flex: 1 }} />
        {pages.length > 1 && (
          <>
            <Button variant="secondary" size="sm" disabled={cur === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} title={L('이전', 'Previous')}><Icon name="caret-left" size={15} /> {L('이전', 'Prev')}</Button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 48, textAlign: 'center' }}>{cur + 1} / {pages.length}</span>
            <Button variant="secondary" size="sm" disabled={cur >= pages.length - 1} onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))} title={L('다음', 'Next')}>{L('다음', 'Next')} <Icon name="caret-right" size={15} /></Button>
            <span style={{ width: 8 }} />
          </>
        )}
        <Button variant="primary" size="sm" onClick={onDone} style={{ minWidth: 76, justifyContent: 'center' }}>{L('완료', 'Done')}</Button>
      </div>
      {/* the wall */}
      <div ref={areaRef} style={{ flex: 1, minHeight: 0, padding: GAP, display: 'flex', gap: GAP, alignItems: 'flex-start', overflow: 'hidden' }}>
        {cards.length === 0 && (
          <div style={{ flex: 1, textAlign: 'center', paddingTop: 80, color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>
            {L('라이브를 지원하는 서비스가 없습니다.', 'No service supports live yet.')}
          </div>
        )}
        {columns.map((col, c) => (
          <div key={c} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP }}>
            {col.map((p) => (
              <div key={p.name} ref={observe} data-live-key={p.name}
                style={{ minHeight: cardMin, maxHeight: Math.max(cardMin, dims.h), overflow: 'hidden', border: '1.5px solid var(--border-strong, #94a3b8)', borderRadius: 16, background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px 6px', flexShrink: 0 }}>
                  <Icon name={iconFor(p.name, p.icon)} size={30} weight="fill" color={p.color || 'var(--text-primary)'} />
                  <span style={{ fontSize: 18, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label || p.name}</span>
                  <span style={{ marginLeft: 'auto', width: 10, height: 10, borderRadius: 999, background: dot(p), flexShrink: 0 }} />
                </div>
                <LiveTiles service={p} big wall pad="4px 18px 16px" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
