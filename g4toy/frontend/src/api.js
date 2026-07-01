// Base-path aware API access. Relative URLs (no leading slash) resolve against
// document.baseURI, which is `/` standalone and `/p/g4toy/` behind the portal.
// The portal token (when present) is read the same way the other LILAK services
// read it, so authed endpoints work once entered through the portal.

function token() {
  return (
    window.__PORTAL_TOKEN__ ||
    localStorage.getItem('elog_token') ||
    localStorage.getItem('lilak_portal_token') ||
    null
  )
}

async function req(path, method = 'GET', body = null) {
  const headers = {}
  const t = token()
  if (t) headers['Authorization'] = `Bearer ${t}`
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null })
  if (!res.ok) {
    let detail = `${res.status}`
    try { detail = (await res.json()).detail || detail } catch {}
    const e = new Error(detail); e.status = res.status; throw e
  }
  return res.json()
}

// ── identity ──────────────────────────────────────────────────────────────────
export const fetchMe = () => req('api/me')

// ── viewer scenes ─────────────────────────────────────────────────────────────
export const fetchJobScene = (id) => req(`api/jobs/${id}/viewer`)

// ── input workspace (3 editable slots: physics / detector / reaction) ─────────
export const inputsState = () => req('api/inputs')
export const inputsGetFile = (slot) => req(`api/inputs/file?slot=${encodeURIComponent(slot)}`)
export const inputsSaveFile = (slot, content) => req('api/inputs/file', 'PUT', { slot, content })
export const inputsLoadExample = (example) => req('api/inputs/load-example', 'POST', { example })
export const csCandidates = () => req('api/inputs/crosssections')
export const csGet = (name) => req('api/inputs/crosssection' + (name ? `?name=${encodeURIComponent(name)}` : ''))
export const csSave = (content, name) =>
  req('api/inputs/crosssection', 'PUT', name ? { content, name } : { content })

// ── named / shareable configs ─────────────────────────────────────────────────
export const configsList = () => req('api/configs')
export const configsSave = (name, shared) => req('api/configs', 'POST', { name, shared })
export const configsLoad = (id) => req(`api/configs/${id}/load`, 'POST')
export const configsShare = (id, shared) => req(`api/configs/${id}/share`, 'POST', { shared })
export const configsDelete = (id) => req(`api/configs/${id}`, 'DELETE')

// ── interactive nptool session ────────────────────────────────────────────────
export const sessionStatus = () => req('api/session')
export const sessionStart = () => req('api/session/start', 'POST')
export const sessionRun = (n) => req('api/session/run', 'POST', { n })
export const sessionLog = (since) => req(`api/session/log?since=${since}`)
export const sessionScene = () => req('api/session/scene')
export const sessionStop = () => req('api/session/stop', 'POST')
