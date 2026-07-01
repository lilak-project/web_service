// Single chokepoint for every backend call. Two portal concerns live here so the
// pages never have to think about them:
//   • base-path — behind the portal proxy the app is served under /p/lilak_gui/,
//     injected as window.__PORTAL_BASE__ (no trailing slash). Server-absolute
//     paths like "/api/..." ignore <base href>, so we prepend the base ourselves.
//   • SSO — the portal token (set by the cover frontend) is attached as a Bearer
//     header so the backend can identify the user.
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''

export function token() {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
}

function authHeaders(extra) {
  const t = token()
  return { ...(extra || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }
}

// Resolve an app path ("/api/...") to a portal-prefixed URL.
export function apiURL(path) {
  if (/^https?:\/\//.test(path)) return path
  if (PORTAL_BASE && path.startsWith(PORTAL_BASE + '/')) return path
  return PORTAL_BASE + path
}

export async function get(url) {
  const res = await fetch(apiURL(url), { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

export async function post(url, body) {
  const res = await fetch(apiURL(url), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

export function wsURL(path) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${PORTAL_BASE}${path}`
}
