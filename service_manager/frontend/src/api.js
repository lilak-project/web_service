import axios from 'axios'

// Minimal API layer for the portal cover. The cover only ever talks to the
// portal's launcher API (`/launcher/api/*`); the backend strips the `/launcher`
// prefix itself, so this works both in dev (Vite proxy) and in prod (served by
// the portal). There is no elog workspace here, so no per-experiment `api`.

// localStorage that never throws: where storage is blocked (SecurityError) it
// reads as empty and writes are dropped, instead of blanking the page.
export const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* blocked */ } },
  remove: (k) => { try { localStorage.removeItem(k) } catch { /* blocked */ } },
}
export const PORTAL_TOKEN_KEY = 'lilak_portal_token'

const EXPERIMENT_KEY = 'elog_experiment'
export function getExperiment() { return store.get(EXPERIMENT_KEY) || '' }
export function setExperiment(name) {
  if (name) store.set(EXPERIMENT_KEY, name)
  else store.remove(EXPERIMENT_KEY)
}
export function apiBaseFor(name) { return name ? `/launcher/p/${name}/api` : '/api' }

// An axios instance that talks to ONE service's backend THROUGH the portal proxy
// (`/launcher/p/<svc>/api/…`), carrying the portal bearer. Used by the Manage UI to
// read/edit a service's own config (e.g. /layout) without leaving the portal. The
// proxy auto-starts the target on demand; a service that doesn't implement the
// endpoint just 404s (handled by the caller).
export function serviceApi(name) {
  const inst = axios.create({ baseURL: apiBaseFor(name), timeout: 30000 })
  const t = store.get(PORTAL_TOKEN_KEY)
  if (t) inst.defaults.headers.common['Authorization'] = `Bearer ${t}`
  return inst
}

// The portal's own API (accounts + service registry/lifecycle).
export const launcher = axios.create({ baseURL: '/launcher/api', timeout: 30000 })

// Restore the portal bearer synchronously at module load so the first request
// (the cover's /auth/me on mount) already carries it.
{
  const t = store.get(PORTAL_TOKEN_KEY)
  if (t) launcher.defaults.headers.common['Authorization'] = `Bearer ${t}`
}

// A request the server refused for want of a valid session (an expired or
// revoked token) means the cover is signed out — say so once, so the page drops
// to the signed-out view instead of going on showing an account it no longer
// has (its profile, manage mode, the create panel …). The sign-in calls
// themselves answer 401 for a wrong password, which is not that.
launcher.interceptors.response.use((r) => r, (e) => {
  const url = e?.config?.url || ''
  if (e?.response?.status === 401 && !/^\/?auth\/(login|setup|register|verify)/.test(url)
      && launcher.defaults.headers.common.Authorization) {
    window.dispatchEvent(new Event('portal:signed-out'))
  }
  return Promise.reject(e)
})

export default launcher

// A readable message from an axios error. FastAPI's 422 carries `detail` as a
// LIST of {loc,msg,type} objects; rendering that as a React child throws and
// blanks the page, so it is flattened to text here.
export function errText(e, fallback = 'failed') {
  const d = e?.response?.data?.detail ?? e?.response?.data?.error
  if (d == null) return e?.message || fallback
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map((x) => (typeof x === 'string' ? x : x?.msg || JSON.stringify(x))).join('; ')
  if (typeof d === 'object') return d.msg || d.error || JSON.stringify(d)
  return String(d)
}
