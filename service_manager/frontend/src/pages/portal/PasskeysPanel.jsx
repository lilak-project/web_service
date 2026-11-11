import { useEffect, useState } from 'react'
import { Button, Icon, tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { passkeyRegister, passkeySupported, passkeyCancelled } from '../../passkey'
import { Field, FieldActions, Panel, fieldMuted } from './Field'
import { notify } from './settingsMsg'

/** My account → passkeys: this account's Touch ID / Face ID sign-ins, per host. */
export default function PasskeysPanel() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(false)
  const load = () => launcher.get('/auth/passkeys').then((r) => setList(r.data)).catch(() => {})
  useEffect(() => { load() }, [])
  const here = window.location.hostname

  async function add() {
    setBusy(true)
    try { await passkeyRegister(navigator.platform || 'this device'); notify(tr('passkey_added'), 'ok'); load() }
    catch (e) { if (!passkeyCancelled(e)) notify(errText(e, tr('passkey_add_fail')), 'bad') }
    finally { setBusy(false) }
  }
  async function remove(p) {
    try { await launcher.delete(`/auth/passkeys/${p.id}`); load() }
    catch (e) { notify(errText(e, tr('p_failed')), 'bad') }
  }

  return (
    <Panel title={tr('passkey_title')} hint={tr('passkey_hint')}>
      {list.length === 0 && (
        <Field label={tr('passkey_title')}><span style={fieldMuted}>{tr('passkey_none')}</span></Field>
      )}
      {list.map((p) => (
        <Field key={p.id} label={<><Icon name="fingerprint" size={14} /> {p.name}</>}>
          <span style={fieldMuted}>
            {p.rp_id}{p.rp_id === here ? ` · ${tr('passkey_this_host')}` : ''}
            {' · '}{(p.last_used_at || p.created_at || '').slice(0, 10)}
          </span>
          <Button variant="dangerSoft" onClick={() => remove(p)}>{tr('passkey_remove')}</Button>
        </Field>
      ))}
      <FieldActions>
        {passkeySupported()
          ? <Button variant="secondary" disabled={busy} onClick={add}><Icon name="fingerprint" size={14} /> {tr('passkey_add')}</Button>
          : <span style={fieldMuted}>{tr('passkey_unsupported')}</span>}
      </FieldActions>
    </Panel>
  )
}
