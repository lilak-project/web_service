import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { serviceApi } from '../../api'

/**
 * LiveTiles — the compact live numbers a service shows on its Home card in
 * live mode. An item may also carry `spark`: a short series (oldest first)
 * drawn behind the number as a filled sparkline, with `spark_log` for
 * quantities that span decades (a vacuum gauge) and `spark_window` for the
 * label. The service answers `GET /api/live` with
 *
 *   { "ok": true, "items": [ { "label": "Run", "value": "570", "unit": "",
 *                              "state": "running" | "idle" | "warn" | "alarm" | "" } ],
 *     "note": "optional one-liner" }
 *
 * through the portal proxy (`/p/<svc>/api/live`; a multi-project service is
 * asked per project at `/pp/<svc>/<project>/api/live`). Polled every few
 * seconds while the card is on screen; a 404 means the service has no live
 * view yet and polling stops.
 */
const POLL_MS = 4000
const TONE = {
  running: 'var(--ok-text, #2f9e44)', on: 'var(--ok-text, #2f9e44)', ok: 'var(--ok-text, #2f9e44)',
  idle: 'var(--info-text, #1c7ed6)', stopped: 'var(--text-muted)', off: 'var(--text-muted)',
  warn: 'var(--warning-text, #e67700)', trip: 'var(--danger-text, #e03131)', alarm: 'var(--danger-text, #e03131)',
  error: 'var(--danger-text, #e03131)', down: 'var(--danger-text, #e03131)',
}

function authHeaders() {
  const t = localStorage.getItem('lilak_portal_token')
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// Last answer per service, kept across mounts. The live wall re-packs its
// columns as cards report their heights, and a card that moves to another
// column is remounted by React: without this cache it would come back empty
// ("…", minimum height), be re-measured small, be re-packed, grow again when
// its poll returned — and never settle. Starting from the cached answer keeps
// the height the same across the move, so the layout converges.
const CACHE = new Map()

export function useLive(service) {
  const [data, setData] = useState(() => (service?.name && CACHE.get(service.name)?.data) || null)
  const [err, setErr] = useState('')
  const [unsupported, setUnsupported] = useState(() => !!(service?.name && CACHE.get(service.name)?.unsupported))
  const projectsRef = useRef(null)

  useEffect(() => {
    if (!service?.name || service.builtin) return
    let alive = true, timer = null
    const name = service.name

    async function fetchOnce() {
      try {
        if (service.multi_project) {
          // Only projects that are RUNNING: asking a stopped one through the proxy
          // would start it, and a stopped logbook has nothing live to say anyway.
          // The list is re-read every poll so a project started meanwhile appears.
          const r0 = await axios.get(`/launcher/api/services/${name}/projects`, { headers: authHeaders(), timeout: 8000 })
          projectsRef.current = (r0.data || []).filter((p) => p && p.running).map((p) => p.name).filter(Boolean)
          const items = []
          for (const proj of projectsRef.current) {
            try {
              const r = await axios.get(`/launcher/pp/${name}/${proj}/api/live`, { headers: authHeaders(), timeout: 8000 })
              for (const it of (r.data?.items || [])) items.push({ ...it, label: `${proj} · ${it.label}` })
            } catch { /* a stopped project: skip */ }
          }
          if (alive) { const d = { items, at: Date.now() }; CACHE.set(name, { data: d }); setData(d); setErr('') }
        } else {
          const r = await serviceApi(name).get('/live', { timeout: 8000 })
          if (alive) { const d = { items: r.data?.items || [], note: r.data?.note, layout: r.data?.layout, at: Date.now() }; CACHE.set(name, { data: d }); setData(d); setErr('') }
        }
      } catch (e) {
        if (!alive) return
        if (e?.response?.status === 404) { CACHE.set(name, { unsupported: true }); setUnsupported(true); return }
        setErr(e?.response?.data?.detail || e.message || 'error')
      }
      if (alive && !unsupported) timer = setTimeout(fetchOnce, POLL_MS)
    }
    fetchOnce()
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.name, service?.multi_project, service?.builtin])

  return { data, err, unsupported }
}

export default function LiveTiles({ service, big = false, pad, wall = false }) {
  const { data, err, unsupported } = useLive(service)
  const items = data?.items || []
  const stack = data?.layout === 'stack' || data?.layout === 'rows'   // name / figure / big second line per item (e.g. one actuator each)
  // On the wall the tiles stretch to fill the card and the numbers grow when
  // there are few of them: one figure fills the box, six share it. The figures
  // are set in the bold SANS with tabular digits — a monospace face at wall
  // distance reads thin; a heavy sans reads at a glance.
  const n = Math.max(1, items.length)
  const valuePx = wall ? (n <= 1 ? 48 : n <= 2 ? 42 : n <= 4 ? 34 : 28) : null
  const valueFont = { fontFamily: 'var(--font-sans)', fontWeight: 500, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums lining-nums' }
  const tile = {
    display: 'flex', flexDirection: 'column', gap: wall ? 4 : 2,
    flex: wall ? (stack ? '1 1 170px' : '1 1 150px') : '0 0 auto',
    padding: wall ? '10px 14px' : big ? '8px 12px' : '6px 10px',
    borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', minWidth: 0,
  }
  const labelPx = wall ? 14 : null
  return (
    <div style={{ padding: pad || (big ? '4px 18px 14px 58px' : '2px 14px 10px 46px') }}>
      {unsupported ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>live 정보 없음</span>
      ) : err && !items.length ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</span>
      ) : !data ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>…</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: wall ? 10 : 8, alignItems: 'stretch' }}>
          {items.length === 0 && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>—</span>}
          {items.map((it, i) => {
            const tone = TONE[(it.state || '').toLowerCase()]
            const label = (
              <span style={{ fontSize: labelPx ? `${labelPx}px` : 'var(--fs-micro, 11px)', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', gap: 6, alignItems: 'center', }}>
                {tone && <span style={{ width: 9, height: 9, borderRadius: 999, background: tone, flexShrink: 0 }} />}
                {it.label}
              </span>
            )
            const value = (
              <span style={{ ...valueFont, fontSize: valuePx ? `${valuePx}px` : big ? 'var(--fs-xlarge, 18px)' : 'var(--fs-large, 16px)', lineHeight: 1.1, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {it.value ?? '—'}{it.unit ? <span style={{ fontSize: wall ? 16 : 'var(--fs-small, 12px)', fontWeight: 500, color: 'var(--text-muted)', marginLeft: 4 }}>{it.unit}</span> : null}
              </span>
            )
            const spark = Array.isArray(it.spark) && it.spark.length > 1 ? it.spark : null
            return (
              <div key={i} style={{ ...tile, position: 'relative', overflow: 'hidden' }} title={it.title || it.label}>
                {spark && <Spark values={spark} log={!!it.spark_log} color={tone || 'var(--text-secondary)'} />}
                <span style={{ position: 'relative' }}>{label}</span>
                <span style={{ position: 'relative' }}>{value}</span>
                {(it.sub || it.spark_window) && (stack
                  ? <span style={{ ...valueFont, fontSize: valuePx ? `${Math.round(valuePx * 0.72)}px` : 'var(--fs-medium, 14px)', lineHeight: 1.2, color: 'var(--text-secondary)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{it.sub}</span>
                  : <span style={{ position: 'relative', fontSize: wall ? 14 : 'var(--fs-micro, 11px)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sub || (spark ? `${it.spark_window || ''} ↗` : '')}</span>)}
              </div>
            )
          })}
          {data?.note && <div style={{ flexBasis: '100%', fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{data.note}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * Spark — the item's recent history, filled, behind the number.
 *
 * It is a BACKGROUND: no axes, no labels, and a low opacity, because the tile
 * is read for its number and the shape is only there to say "steady", "rising"
 * or "it moved". A log scale is used when the service asks for one — a vacuum
 * that went from 1e-3 to 2e-4 is a big change that a linear scale would draw
 * as a flat line on the floor.
 */
function Spark({ values, log, color }) {
  const W = 100, H = 32
  const scaled = log ? values.map((v) => Math.log10(Math.max(v, Number.MIN_VALUE))) : values
  const lo = Math.min(...scaled), hi = Math.max(...scaled)
  const span = hi - lo || 1
  const step = scaled.length > 1 ? W / (scaled.length - 1) : W
  const points = scaled.map((v, i) => `${(i * step).toFixed(2)},${(H - ((v - lo) / span) * (H - 3) - 1.5).toFixed(2)}`)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '58%', opacity: 0.3, pointerEvents: 'none' }}>
      <polygon points={`0,${H} ${points.join(' ')} ${W},${H}`} fill={color} opacity="0.35" />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
