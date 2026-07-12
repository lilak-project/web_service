import axios from 'axios'

// Minimal API layer for the portal cover. The cover only ever talks to the
// portal's launcher API (`/launcher/api/*`); the backend strips the `/launcher`
// prefix itself, so this works both in dev (Vite proxy) and in prod (served by
// the portal). There is no elog workspace here, so no per-experiment `api`.

const EXPERIMENT_KEY = 'elog_experiment'
export function getExperiment() { return localStorage.getItem(EXPERIMENT_KEY) || '' }
export function setExperiment(name) {
  if (name) localStorage.setItem(EXPERIMENT_KEY, name)
  else localStorage.removeItem(EXPERIMENT_KEY)
}
export function apiBaseFor(name) { return name ? `/launcher/p/${name}/api` : '/api' }

// An axios instance that talks to ONE service's backend THROUGH the portal proxy
// (`/launcher/p/<svc>/api/…`), carrying the portal bearer. Used by the Manage UI to
// read/edit a service's own config (e.g. /layout) without leaving the portal. The
// proxy auto-starts the target on demand; a service that doesn't implement the
// endpoint just 404s (handled by the caller).
export function serviceApi(name) {
  const inst = axios.create({ baseURL: apiBaseFor(name), timeout: 30000 })
  const t = localStorage.getItem('lilak_portal_token')
  if (t) inst.defaults.headers.common['Authorization'] = `Bearer ${t}`
  return inst
}

// The portal's own API (accounts + service registry/lifecycle).
export const launcher = axios.create({ baseURL: '/launcher/api', timeout: 30000 })

// Restore the portal bearer synchronously at module load so the first request
// (the cover's /auth/me on mount) already carries it.
{
  const t = localStorage.getItem('lilak_portal_token')
  if (t) launcher.defaults.headers.common['Authorization'] = `Bearer ${t}`
}

export default launcher
