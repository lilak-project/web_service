// Passkeys (WebAuthn): the browser half of app/routers/passkeys.py.
// The server sends options as JSON with base64url bytes; the browser API wants
// ArrayBuffers, and answers with ArrayBuffers that go back as base64url.
import { launcher } from './api'

const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer
const toB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const passkeySupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext

function asJSON(cred) {
  const r = cred.response
  const response = { clientDataJSON: toB64(r.clientDataJSON) }
  if (r.attestationObject) {
    response.attestationObject = toB64(r.attestationObject)
    if (r.getTransports) response.transports = r.getTransports()
  }
  if (r.authenticatorData) {
    response.authenticatorData = toB64(r.authenticatorData)
    response.signature = toB64(r.signature)
    if (r.userHandle) response.userHandle = toB64(r.userHandle)
  }
  return { id: cred.id, rawId: toB64(cred.rawId), type: cred.type, response,
    clientExtensionResults: cred.getClientExtensionResults?.() || {} }
}

/** Register this device for the signed-in account. */
export async function passkeyRegister(name) {
  const { state, options } = (await launcher.post('/auth/passkey/register/options')).data
  const o = JSON.parse(options)
  o.challenge = toBuf(o.challenge)
  o.user.id = toBuf(o.user.id)
  o.excludeCredentials = (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) }))
  const cred = await navigator.credentials.create({ publicKey: o })
  return (await launcher.post('/auth/passkey/register', { state, credential: asJSON(cred), name })).data
}

/** Sign in with whatever passkey this device holds for this host; returns the token response.
 *  `conditional`: wait quietly and answer from the username field's autofill list
 *  (the field needs autocomplete="username webauthn"); `signal` aborts the wait. */
export async function passkeyLogin({ conditional = false, signal } = {}) {
  const { state, options } = (await launcher.post('/auth/passkey/login/options')).data
  const o = JSON.parse(options)
  o.challenge = toBuf(o.challenge)
  o.allowCredentials = (o.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) }))
  const cred = await navigator.credentials.get({ publicKey: o, signal, ...(conditional ? { mediation: 'conditional' } : {}) })
  return (await launcher.post('/auth/passkey/login', { state, credential: asJSON(cred) })).data
}

/** The device's own "cancelled" is not an error worth showing. */
export const passkeyCancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError'

/** Does the signed-in account already have a passkey for this host? */
export async function hasPasskeyHere() {
  try { return (await launcher.get('/auth/passkeys')).data.some((p) => p.rp_id === window.location.hostname) }
  catch { return true }      // unknown: do not nag
}

/** Can the username field offer passkeys in its autofill list? */
export async function passkeyAutofill() {
  try { return passkeySupported() && !!(await window.PublicKeyCredential.isConditionalMediationAvailable?.()) }
  catch { return false }
}
