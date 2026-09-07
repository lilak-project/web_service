import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon } from 'lilak-ui'
import { useLang } from '../../context/LangContext'
import LiveTiles from './LiveTiles'
import { dealColumns } from './MasonryGrid'

/**
 * LiveWall — the live mode. A full-viewport surface (the portal header, tabs
 * and account menu are gone; only Done remains) filled from the top edge with
 * fixed-height live cards, never scrolling: as many cards as fit the window
 * make one page, and ◀ ▶ beside Done turn pages when there are more. Only
 * cards whose service answers `/api/live` are shown; hidden cards never are.
 *
 * Card height defaults to twice a normal card header (a setting later).
 */
const GAP = 12
const COL_MIN = 340
const MAX_COLS = 4
const BAR_H = 52

export default function LiveWall({ cards, big, onDone, iconFor }) {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const areaRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [page, setPage] = useState(0)
  const cardH = big ? 168 : 128

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(1, Math.min(MAX_COLS, Math.floor((dims.w + GAP) / (COL_MIN + GAP))))
  const rows = Math.max(1, Math.floor((dims.h + GAP) / (cardH + GAP)))
  const perPage = cols * rows
  const pages = Math.max(1, Math.ceil(cards.length / perPage))
  const cur = Math.min(page, pages - 1)
  useEffect(() => { if (page !== cur) setPage(cur) }, [cur, page])
  const slice = cards.slice(cur * perPage, (cur + 1) * perPage)
  const columns = dealColumns(slice, Math.min(cols, Math.max(1, slice.length)))

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDone?.()
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') setPage((p) => Math.min(pages - 1, p + 1))
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPage((p) => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pages, onDone])

  const dot = (p) => (p.multi_project ? 'var(--info-text)' : p.running ? 'var(--ok-text, #2f9e44)' : 'var(--text-muted)')

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--app-bg)', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column' }}>
      {/* the one bar: pager + Done */}
      <div style={{ height: BAR_H, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <Icon name="broadcast" size={18} color="var(--warning-text, #e67700)" />
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{L('라이브', 'Live')} · {cards.length}</span>
        <span style={{ flex: 1 }} />
        {pages > 1 && (
          <>
            <Button variant="secondary" size="sm" disabled={cur === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} title={L('이전', 'Previous')}><Icon name="caret-left" size={15} /> {L('이전', 'Prev')}</Button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small, 12px)', color: 'var(--text-secondary)', minWidth: 48, textAlign: 'center' }}>{cur + 1} / {pages}</span>
            <Button variant="secondary" size="sm" disabled={cur >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} title={L('다음', 'Next')}>{L('다음', 'Next')} <Icon name="caret-right" size={15} /></Button>
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
              <div key={p.name} style={{ height: cardH, overflow: 'hidden', border: '1.5px solid var(--border-strong, #94a3b8)', borderRadius: 16, background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: big ? '10px 16px 4px' : '8px 12px 2px' }}>
                  <Icon name={iconFor(p.name, p.icon)} size={big ? 26 : 22} weight="fill" color={p.color || 'var(--text-primary)'} />
                  <span style={{ fontSize: big ? 'var(--fs-medium, 14px)' : 'var(--fs-body, 13px)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label || p.name}</span>
                  <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 999, background: dot(p), flexShrink: 0 }} />
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <LiveTiles service={p} big={big} pad={big ? '2px 16px 10px' : '0 12px 8px'} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
