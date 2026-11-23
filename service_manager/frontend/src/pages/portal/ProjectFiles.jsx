import { useEffect, useState } from 'react'
import { launcher, errText } from '../../api'
import { useLang } from '../../context/LangContext'
import { notify } from './settingsMsg'
import { Row, fieldInput } from './Field'

/**
 * ProjectFiles — a project's settings files, edited by a manager under its row
 * (like the log). Which files a service has comes from its manifest
 * (capabilities.project_files). Each is a list, one entry per line (scope's
 * browse-path: folders): added from the box, removed one at a time, saved at
 * once — which restarts the project if it was running.
 */
const lines = (text) => (text || '').split('\n').map((s) => s.trim()).filter(Boolean)

export default function ProjectFiles({ svc, proj, files }) {
  const { lang, t } = useLang()
  const [items, setItems] = useState({})      // file → its lines, as on disk
  const [adds, setAdds] = useState({})        // file → what is typed in its box
  const [busy, setBusy] = useState('')

  useEffect(() => {
    files.forEach((f) => launcher.get(`/services/${svc}/projects/${proj}/files/${f.file}`)
      .then((r) => setItems((x) => ({ ...x, [f.file]: lines(r.data.text) })))
      .catch((e) => notify(errText(e), 'bad')))
  }, [svc, proj])  // eslint-disable-line react-hooks/exhaustive-deps

  async function save(name, next) {
    setBusy(name)
    try {
      const r = await launcher.put(`/services/${svc}/projects/${proj}/files/${name}`, { text: next.join('\n') })
      setItems((x) => ({ ...x, [name]: next }))
      notify(r.data.restarted ? t('p_projfile_saved_restarted') : t('p_projfile_saved'), 'ok')
      return true
    } catch (e) { notify(errText(e), 'bad'); return false } finally { setBusy('') }
  }

  async function add(name) {
    const v = (adds[name] || '').trim()
    const now = items[name] || []
    if (!v || now.includes(v)) return
    if (await save(name, [...now, v])) setAdds((x) => ({ ...x, [name]: '' }))
  }

  return (
    <div className="pl-projadm pl-files">
      {files.map((f) => {
        const list = items[f.file] || []
        const typed = (adds[f.file] || '').trim()
        return (
          <div key={f.file}>
            <div className="pl-filebar">
              <span className="pl-filelabel">{f[lang] || f.en || f.file}</span>
              <span className="pl-logpath">{f.file}</span>
            </div>
            <div className="pl-filelist">
              {list.map((v) => (
                <Row key={v}>
                  <span className="mono ell">{v}</span>
                  <span className="sp" />
                  <button type="button" disabled={busy === f.file} style={{ minWidth: 64 }}
                    onClick={() => save(f.file, list.filter((x) => x !== v))}>{t('p_projfile_remove')}</button>
                </Row>
              ))}
              {!list.length && <Row className="empty">{t('p_projfile_empty')}</Row>}
              <Row>
                <input value={adds[f.file] || ''} spellCheck={false} aria-label={f[lang] || f.en || f.file}
                  placeholder={(f.placeholder || '').split('\n')[0]}
                  onChange={(e) => setAdds((x) => ({ ...x, [f.file]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(f.file) } }}
                  style={{ ...fieldInput, flex: 1, fontFamily: 'var(--font-mono)' }} />
                <button type="button" style={{ minWidth: 64 }}
                  disabled={!typed || list.includes(typed) || busy === f.file} onClick={() => add(f.file)}>{t('p_projfile_add')}</button>
              </Row>
            </div>
          </div>
        )
      })}
    </div>
  )
}
