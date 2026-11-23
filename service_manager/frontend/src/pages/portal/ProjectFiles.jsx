import { useEffect, useState } from 'react'
import { Button } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { notify } from './settingsMsg'

/**
 * ProjectFiles — a project's settings files, edited by a manager under its row
 * (like the log). Which files a service has comes from its manifest
 * (capabilities.project_files); saving restarts the project if it was running.
 */
export default function ProjectFiles({ svc, proj, files }) {
  const { lang, t } = useLang()
  const [texts, setTexts] = useState({})      // file → text as on disk
  const [edits, setEdits] = useState({})      // file → text being typed
  const [busy, setBusy] = useState('')

  useEffect(() => {
    files.forEach((f) => launcher.get(`/services/${svc}/projects/${proj}/files/${f.file}`)
      .then((r) => { setTexts((x) => ({ ...x, [f.file]: r.data.text })); setEdits((x) => ({ ...x, [f.file]: r.data.text })) })
      .catch((e) => notify(errText(e), 'bad')))
  }, [svc, proj])  // eslint-disable-line react-hooks/exhaustive-deps

  async function save(name) {
    setBusy(name)
    try {
      const r = await launcher.put(`/services/${svc}/projects/${proj}/files/${name}`, { text: edits[name] ?? '' })
      setTexts((x) => ({ ...x, [name]: edits[name] ?? '' }))
      notify(r.data.restarted ? t('p_projfile_saved_restarted') : t('p_projfile_saved'), 'ok')
    } catch (e) { notify(errText(e), 'bad') } finally { setBusy('') }
  }

  return (
    <div className="pl-log">
      {files.map((f) => {
        const dirty = (edits[f.file] ?? '') !== (texts[f.file] ?? '')
        return (
          <div key={f.file} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
            <div className="pl-logbar">
              <span className="pl-logpath">{f[lang] || f.en || f.file} <span style={{ opacity: 0.6 }}>({f.file})</span></span>
              <span className="sp" />
              <Button variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || busy === f.file} onClick={() => save(f.file)}>
                {t('p_projfile_save')}
              </Button>
            </div>
            <textarea value={edits[f.file] ?? ''} rows={Math.max(3, (edits[f.file] ?? '').split('\n').length + 1)} spellCheck={false}
              onChange={(e) => setEdits((x) => ({ ...x, [f.file]: e.target.value }))}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13, padding: 8, resize: 'vertical' }} />
          </div>
        )
      })}
    </div>
  )
}
