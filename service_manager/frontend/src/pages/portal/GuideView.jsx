import { useEffect, useState } from 'react'
import { Button, Icon, Markdown } from 'lilak-ui'
import { launcher } from '../../api'
import { useLang } from '../../context/LangContext'
import HandshakeRegister from './HandshakeRegister'
import { Panel } from './Field'

/**
 * GuideView — the AI service-integration guide as an inline screen (no popup).
 * Fetches the markdown from the backend, renders it with the kit Markdown
 * component, and copies the raw markdown to the clipboard.
 */
export default function GuideView({ onChanged }) {
  const { t } = useLang()
  const [doc, setDoc] = useState('service-guide')
  const [md, setMd] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setErr(''); setMd('')
    launcher.get(`/guide?doc=${doc}`)
      .then((r) => { if (alive) setMd(r.data.markdown || '') })
      .catch((e) => { if (alive) setErr(e?.response?.data?.detail || t('portal_guide_load_fail')) })
    return () => { alive = false }
  }, [doc])  // eslint-disable-line react-hooks/exhaustive-deps

  async function copy() {
    let ok = false
    try { await navigator.clipboard.writeText(md); ok = true }
    catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = md; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.focus(); ta.select()
        ok = document.execCommand('copy'); document.body.removeChild(ta)
      } catch { /* selectable manually */ }
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  const tab = (id, label) => (
    <Button variant={doc === id ? 'primary' : 'secondary'} onClick={() => setDoc(id)}>{label}</Button>
  )

  return (
    <>
      {/* Register an external / self-hosted service (handshake). */}
      <HandshakeRegister onChanged={onChanged} />

      <Panel bare title={t('portal_guide_docs')}
        right={
          <>
            {tab('service-guide', t('portal_guide_tab_guide'))}
            {tab('service-contract', t('portal_guide_tab_contract'))}
            <Button variant="secondary" onClick={copy} disabled={!md}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? t('portal_guide_copied') : t('portal_guide_copy')}
            </Button>
          </>}>
        {err && <div style={{ padding: '12px 16px', color: 'var(--danger-text)' }}>{err}</div>}
        <div style={{ padding: '2px 16px 10px' }}><Markdown>{md}</Markdown></div>
      </Panel>
    </>
  )
}
