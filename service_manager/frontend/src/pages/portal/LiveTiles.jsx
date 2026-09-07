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

export function useLive(service) {
  const [data, setData] = useState(null)        // { items, note, at } | null
  const [err, setErr] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const projectsRef = useRef(null)

  useEffect(() => {
    if (!service?.name || service.builtin) return
    let alive = true, timer = null
    const name = service.name

    async function fetchOnce() {
      try {
        if (service.multi_project) {
          if (!projectsRef.current) {
            const r = await axios.get(`/launcher/api/services/${name}/projects`, { headers: authHeaders(), timeout: 8000 })
            projectsRef.current = (r.data || []).map((p) => p.name || p).filter(Boolean)
          }
          const items = []
          for (const proj of projectsRef.current.slice(0, 6)) {
            try {
              const r = await axios.get(`/launcher/pp/${name}/${proj}/api/live`, { headers: authHeaders(), timeout: 8000 })
              for (const it of (r.data?.items || [])) items.push({ ...it, label: `${proj} · ${it.label}` })
            } catch { /* a stopped project: skip */ }
          }
          if (alive) { setData({ items, at: Date.now() }); setErr('') }
        } else {
          const r = await serviceApi(name).get('/live', { timeout: 8000 })
          if (alive) { setData({ items: r.data?.items || [], note: r.data?.note, at: Date.now() }); setErr('') }
        }
      } catch (e) {
        if (!alive) return
        if (e?.response?.status === 404) { setUnsupported(true); return }
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

export default function LiveTiles({ service, big = false, pad }) {
  const { data, err, unsupported } = useLive(service)
  const items = data?.items || []
  const tile = {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 92, padding: big ? '8px 12px' : '6px 10px',
    borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
  }
  return (
    <div style={{ padding: pad || (big ? '4px 18px 14px 58px' : '2px 14px 10px 46px') }}>
      {unsupported ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>live 정보 없음</span>
      ) : err && !items.length ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--danger-text)' }}>{err}</span>
      ) : !data ? (
        <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>…</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'stretch' }}>
          {items.length === 0 && <span style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>—</span>}
          {items.map((it, i) => {
            const tone = TONE[(it.state || '').toLowerCase()]
            return (
              <div key={i} style={tile} title={it.title || it.label}>
                <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', letterSpacing: '.03em', textTransform: 'uppercase', whiteSpace: 'nowrap', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  {tone && <span style={{ width: 7, height: 7, borderRadius: 999, background: tone, flexShrink: 0 }} />}
                  {it.label}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: big ? 'var(--fs-xlarge, 18px)' : 'var(--fs-large, 16px)', fontWeight: 600, color: tone || 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {it.value ?? '—'}{it.unit ? <span style={{ fontSize: 'var(--fs-small, 12px)', fontWeight: 400, color: 'var(--text-muted)', marginLeft: 3 }}>{it.unit}</span> : null}
                </span>
                {it.sub && <span style={{ fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{it.sub}</span>}
              </div>
            )
          })}
          {data?.note && <div style={{ flexBasis: '100%', fontSize: 'var(--fs-micro, 11px)', color: 'var(--text-muted)' }}>{data.note}</div>}
        </div>
      )}
    </div>
  )
}
