import React, { useEffect, useState } from 'react'
import DetectorForm from './DetectorForm.jsx'
import ReactionForm from './ReactionForm.jsx'
import PhysicsForm from './PhysicsForm.jsx'
import CrossSectionEditor from './CrossSectionEditor.jsx'
import Configs from './Configs.jsx'
import {
  inputsState, inputsGetFile, inputsSaveFile, inputsLoadExample, csGet, csSave, csCandidates,
} from './api.js'

const FORM_SLOTS = { detector: DetectorForm, reaction: ReactionForm, physics: PhysicsForm }
const CS = 'crosssection'

// Setup tab: edit the three input files (Physics list / Detector / Reaction) that
// the simulation runs against. project.config + unused macros are managed/hidden.
export default function InputsTab() {
  const [data, setData] = useState(null)     // {slots, examples, project}
  const [example, setExample] = useState('')
  const [slot, setSlot] = useState('')
  const [label, setLabel] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState('text')     // 'form' | 'text' (detector/reaction)
  const [fileKey, setFileKey] = useState(0)     // remounts the form on (re)parse
  const [csPath, setCsPath] = useState('')
  const [csFiles, setCsFiles] = useState([])    // available cross-section files

  async function load() {
    try {
      const d = await inputsState()
      setData(d); setExample(d.examples[0]?.key || '')
    } catch (e) { setMsg(e.status === 401 ? '포탈 로그인 필요' : String(e.message || e)) }
  }
  useEffect(() => { load(); csCandidates().then((d) => setCsFiles(d.files)).catch(() => {}) }, [])

  async function openSlot(s) {
    try {
      const r = await inputsGetFile(s.key)
      setSlot(s.key); setLabel(s.label); setContent(r.content); setDirty(false); setMsg('')
      setMode(FORM_SLOTS[s.key] ? 'form' : 'text')
      setFileKey((k) => k + 1)
    } catch (e) { setMsg(String(e.message || e)) }
  }
  function switchMode(m) { setMode(m); setFileKey((k) => k + 1) }   // re-parse on switch
  async function afterConfigLoad() {                                // reload state + open detector
    const fresh = await inputsState(); setData(fresh)
    const det = fresh.slots.find((s) => s.key === 'detector'); if (det) openSlot(det)
  }
  async function openCS() {
    try {
      const r = await csGet()
      setSlot(CS); setLabel('Cross-section'); setContent(r.content); setCsPath(r.path)
      setDirty(false); setMsg('')
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function csPick(name) {                       // load a different CS file
    try {
      const r = await csGet(name)
      setContent(r.content); setCsPath(name); setDirty(false); setMsg('')
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function csSaveAs(name) {                      // save current content under a name
    try {
      const r = await csSave(content, name)
      setCsPath(r.path || name); setDirty(false)
      csCandidates().then((d) => setCsFiles(d.files)).catch(() => {})
      flash('저장됨 — ' + (r.path || name))
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function save() {
    try {
      if (slot === CS) await csSave(content)
      else await inputsSaveFile(slot, content)
      setDirty(false); flash('저장됨 — ' + label)
    } catch (e) { setMsg(e.message || String(e)) }
  }
  async function doLoadExample() {                 // single click, applies immediately
    const ex = data.examples.find((x) => x.key === example)
    try {
      await inputsLoadExample(example)
      const fresh = await inputsState()
      setData(fresh)
      flash('프리셋 불러옴 — ' + (ex?.label || example))
      const det = fresh.slots.find((s) => s.key === 'detector')   // auto-open the detector
      if (det) openSlot(det)
    } catch (e) { setMsg(e.detail || e.message || String(e)) }
  }
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 1800) }

  if (!data) return <div className="placeholder">{msg || '…'}</div>

  return (
    <div className="inputstab">
      <aside className="filesidebar">
        <div className="slabel">files</div>
        <div className="filelist big">
          {data.slots.map((s) => (
            <button key={s.key} className={`filerow ${s.key === slot ? 'on' : ''}`} onClick={() => openSlot(s)}>
              <span className="fname">{s.label}</span>
            </button>
          ))}
          <button className={`filerow ${slot === CS ? 'on' : ''}`} onClick={openCS}>
            <span className="fname">Cross-section</span>
          </button>
        </div>

        <div className="sidefoot">
          <div className="ssect2">
            <div className="slabel" title="비어있는 시작점을 채워주는 검출기·반응 기본 설정">preset (시작 설정)</div>
            <div className="srow">
              <select value={example} onChange={(e) => setExample(e.target.value)}>
                {data.examples.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
              <button className="sbtn go" onClick={doLoadExample}>load</button>
            </div>
          </div>
          <Configs onLoaded={afterConfigLoad} project={data.project} />
        </div>
      </aside>

      <main className="editorarea">
        {slot ? (
          <>
            <div className="ehead">
              <span className="ename">{label}{dirty ? ' •' : ''}</span>
              {FORM_SLOTS[slot] && (
                <div className="modetoggle">
                  <button className={mode === 'form' ? 'on' : ''} onClick={() => switchMode('form')}>form</button>
                  <button className={mode === 'text' ? 'on' : ''} onClick={() => switchMode('text')}>text</button>
                </div>
              )}
              {msg && <span className="emsg">{msg}</span>}
              <button className="sbtn go" disabled={!dirty} onClick={save}>save</button>
            </div>
            {slot === CS ? (
              <CrossSectionEditor path={csPath} value={content} files={csFiles}
                onPick={csPick} onSaveAs={csSaveAs}
                onChange={(t) => { setContent(t); setDirty(true) }} />
            ) : FORM_SLOTS[slot] && mode === 'form' ? (
              <div className="formscroll">
                {React.createElement(FORM_SLOTS[slot], {
                  key: fileKey, initialText: content, csFiles,
                  onChange: (t) => { setContent(t); setDirty(true) },
                })}
              </div>
            ) : (
              <textarea value={content} spellCheck={false}
                onChange={(e) => { setContent(e.target.value); setDirty(true) }} />
            )}
          </>
        ) : (
          <div className="placeholder">왼쪽에서 편집할 파일을 선택하세요 (Physics list / Detector / Reaction).</div>
        )}
      </main>
    </div>
  )
}
