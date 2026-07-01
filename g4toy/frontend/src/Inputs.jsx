import React, { useEffect, useState } from 'react'
import { inputsState, inputsGetFile, inputsSaveFile, inputsLoadExample } from './api.js'

// Editable input workspace: load an example, browse/edit the detector / reaction /
// cross-section files, save. The session/job runs against this workspace.
export default function Inputs() {
  const [data, setData] = useState(null)     // {manifest, files, examples}
  const [example, setExample] = useState('')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const d = await inputsState()
      setData(d)
      setExample(d.manifest.example || d.examples[0]?.key || '')
    } catch (e) { setMsg(e.status === 401 ? '포탈 로그인 필요' : String(e.message || e)) }
  }
  useEffect(() => { load() }, [])

  async function openFile(f) {
    try { const r = await inputsGetFile(f); setName(f); setContent(r.content); setDirty(false); setMsg('') }
    catch (e) { setMsg(String(e.message || e)) }
  }
  async function save() {
    try { await inputsSaveFile(name, content); setDirty(false); flash('saved') }
    catch (e) { setMsg(e.message || String(e)) }
  }
  async function doLoadExample() {
    if (!window.confirm(`현재 워크스페이스를 "${example}" 예제로 덮어씁니다. 계속할까요?`)) return
    try {
      const r = await inputsLoadExample(example)
      setData((d) => ({ ...d, manifest: r.manifest, files: r.files }))
      setName(''); setContent(''); flash(`loaded ${example}`)
    } catch (e) { setMsg(e.message || String(e)) }
  }
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 1600) }

  if (!data) return <div className="serr">{msg || '…'}</div>
  const man = data.manifest

  return (
    <div className="inputs">
      <div className="srow">
        <select value={example} onChange={(e) => setExample(e.target.value)}>
          {data.examples.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <button className="sbtn" onClick={doLoadExample}>load</button>
      </div>

      <div className="filelist">
        {data.files.map((f) => (
          <button key={f} className={`filerow ${f === name ? 'on' : ''}`} onClick={() => openFile(f)}>
            <span className="fname">{f}</span>
            {f === man.detector && <em className="ftag det">detector</em>}
            {f === man.reaction && <em className="ftag rea">reaction</em>}
          </button>
        ))}
      </div>

      {msg && <div className="emsg">{msg}</div>}

      {name && (
        <div className="editorpane">
          <div className="ehead">
            <span className="ename">{name}{dirty ? ' •' : ''}</span>
            <button className="sbtn go" disabled={!dirty} onClick={save}>save</button>
            <button className="eclose" title="close" onClick={() => setName('')}>×</button>
          </div>
          <textarea value={content} spellCheck={false}
            onChange={(e) => { setContent(e.target.value); setDirty(true) }} />
        </div>
      )}
    </div>
  )
}
