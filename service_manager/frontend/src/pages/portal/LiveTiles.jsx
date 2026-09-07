import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { serviceApi } from '../../api'

/**
 * LiveTiles — the compact live numbers a service shows on its Home card in
 * live mode. The service answers `GET /api/live` with
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
          if (alive) { const d = { items: r.data?.items || [], note: r.data?.note, at: Date.now() }; CACHE.set(name, { data: d }); setData(d); setErr('') }
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
  // On the wall the tiles stretch to fill the card and the numbers grow when
  // there are few of them: one figure fills the box, six share it.
  const n = Math.max(1, items.length)
  const valuePx = wall ? (n <= 1 ? 44 : n <= 2 ? 38 : n <= 4 ? 30 : 24) : null
  const tile = {
    display: 'flex', flexDirection: 'column', gap: wall ? 4 : 2, minWidth: wall ? 150 : 92,
    flex: wall ? '1 1 150px' : '0 0 auto',
    padding: wall ? '10px 14px' : big ? '8px 12px' : '6px 10px',
    borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
  }
  const labelPx = wall ? 13 : null
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
            return (
              <div key={i} style={tile} title={it.title || it.label}>
                <span style={{ fontSize: labelPx ? `${labelPx}px` : 'var(--fs-micro, 11px)', color: 'var(--text-muted)', letterSpacing: '.03em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  {tone && <span style={{ width: 7, height: 7, borderRadius: 999, background: tone, flexShrink: 0 }} />}
                  {it.label}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: valuePx ? `${valuePx}px` : big ? 'var(--fs-xlarge, 18px)' : 'var(--fs-large, 16px)', lineHeight: 1.1, fontWeight: 600, color: tone || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {it.value ?? '—'}{it.unit ? <span style={{ fontSize: wall ? 15 : 'var(--fs-small, 12px)', fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>{it.unit}</span> : null}
                </span>
                {it.sub && <span style={{ fontSize: wall ? 13 : 'var(--fs-micro, 11px)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.sub}</span>}
              </div>
            )
          })}
          {data?.note && <div style={{ flexBasis: '100%', fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{data.note}</div>}
        </div>
      )}
    </div>
  )
}
