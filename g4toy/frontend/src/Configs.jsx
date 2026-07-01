import React, { useEffect, useState } from 'react'
import { configsList, configsSave, configsLoad, configsShare, configsDelete } from './api.js'

// Save the current setup under a name, reload it later, share it like a preset.
export default function Configs({ onLoaded, project }) {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmLoad, setConfirmLoad] = useState('')   // id pending load-confirm
  const [confirmDel, setConfirmDel] = useState('')     // id pending delete-confirm

  const refresh = () => configsList().then((d) => setList(d.configs)).catch(() => {})
  useEffect(() => { refresh() }, [])
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1600) }

  async function save() {
    if (!name.trim()) return
    try { await configsSave(name.trim(), shared); setName(''); setShared(false); flash('저장됨'); refresh() }
    catch (e) { flash(e.message || String(e)) }
  }
  async function load(c) {                       // inline 2-step confirm
    if (confirmLoad !== c.id) { setConfirmLoad(c.id); setConfirmDel(''); return }
    setConfirmLoad('')
    try { await configsLoad(c.id); flash('불러옴 — ' + c.name); onLoaded && onLoaded() }
    catch (e) { flash(e.detail || e.message || String(e)) }
  }
  async function toggleShare(c) { try { await configsShare(c.id, !c.shared); refresh() } catch {} }
  async function remove(c) {                      // inline 2-step confirm
    if (confirmDel !== c.id) { setConfirmDel(c.id); setConfirmLoad(''); return }
    setConfirmDel('')
    try { await configsDelete(c.id); refresh() } catch {}
  }

  return (
    <div className="configs">
      <div className="ssect2">
        <div className="slabel">save current setup</div>
        <div className="srow">
          <input type="text" placeholder="이름" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="sbtn go" onClick={save} disabled={!name.trim()}>save</button>
        </div>
        <label className="shareck">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          share (다른 사람도 사용)
        </label>
      </div>
      {msg && <div className="emsg">{msg}</div>}

      {list.length > 0 && <div className="slabel">saved</div>}
      <div className="conflist">
        {list.map((c) => (
          <div className={`confrow ${confirmLoad === c.id ? 'confirming' : ''}`} key={c.id}>
            <button className="confname" onClick={() => load(c)}
              title={confirmLoad === c.id ? '한 번 더 누르면 불러옴' : '불러오기'}>
              {confirmLoad === c.id ? `덮어쓰기? "${c.name}"` : c.name}
              {confirmLoad !== c.id && !c.mine && <em className="byline"> · {c.owner_name}</em>}
              {confirmLoad !== c.id && c.shared && <span className="sharetag">shared</span>}
            </button>
            {c.mine && (<>
              <button className="confbtn" title={c.shared ? '공유 해제' : '공유'}
                onClick={() => toggleShare(c)}>{c.shared ? '🔓' : '🔒'}</button>
              <button className={`confbtn ${confirmDel === c.id ? 'delconfirm' : ''}`}
                title={confirmDel === c.id ? '한 번 더 누르면 삭제' : '삭제'}
                onClick={() => remove(c)}>{confirmDel === c.id ? '삭제?' : '✕'}</button>
            </>)}
          </div>
        ))}
      </div>
      <div className="projname">project: <b>{project || '—'}</b></div>
    </div>
  )
}
