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

// The portal's own API (accounts + service registry/lifecycle).
export const launcher = axios.create({ baseURL: '/launcher/api', timeout: 30000 })

// Restore the portal bearer synchronously at module load so the first request
// (the cover's /auth/me on mount) already carries it.
{
  const t = localStorage.getItem('lilak_portal_token')
  if (t) launcher.defaults.headers.common['Authorization'] = `Bearer ${t}`
}

export default launcher
