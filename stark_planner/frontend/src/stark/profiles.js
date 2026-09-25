// Profiles = named planner setups kept on the backend, one folder per portal
// account. The panel degrades to "offline" if the backend isn't up — the working
// setup still autosaves to localStorage either way, so nothing is lost.
import { get, post, del } from '../api.js'

export async function listProfiles() {
  const d = await get('/api/profiles')
  return { profiles: d.profiles || [], me: d.me || '' }
}

export const loadProfile = (owner, id) => get(`/api/profiles/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`)

/** Omit `id` to create a new profile; pass one to overwrite it. */
export const saveProfile = ({ id, name, setup, shared, note }) =>
  post('/api/profiles', { id, name, setup, shared, note })

export const deleteProfile = (id) => del(`/api/profiles/${encodeURIComponent(id)}`)

/** First free name of the form base, "base 2", "base 3", … */
export function uniqueName(base, taken) {
  let candidate = base
  for (let n = 2; taken.includes(candidate); n++) candidate = `${base} ${n}`
  return candidate
}

/** "Ring 16" -> "Ring 16 copy", "… copy" -> "… copy 2", so repeated copies don't collide. */
export const copyName = (name, taken) =>
  uniqueName(String(name || 'untitled').replace(/\s+copy(\s+\d+)?$/, '') + ' copy', taken)
