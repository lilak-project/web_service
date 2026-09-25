// Profiles: the named setups this account owns, plus anything a colleague
// shared. New starts from the stock STARK layout, Copy branches off whatever is
// currently loaded, and saving overwrites only the profile you have open.
import { useEffect, useState } from 'react'
import { usePlanner } from '../../stark/store.jsx'
import { listProfiles, loadProfile, saveProfile, deleteProfile, copyName, uniqueName } from '../../stark/profiles.js'
import { defaultSetup } from '../../stark/data.js'

const when = (t) => {
  if (!t) return ''
  const d = new Date(t * 1000), now = Date.now() / 1000
  if (now - t < 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function ProfilesPanel() {
  const { S, setS, current, setCurrent, exportJSON, importJSON, reset } = usePlanner()
  const [rows, setRows] = useState([])
  const [me, setMe] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [name, setName] = useState(S.name || '')
  const [confirmDel, setConfirmDel] = useState(null)
  const [io, setIo] = useState(null)
  const [tries, setTries] = useState(0)

  useEffect(() => { setName(S.name || '') }, [S.name])

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2000) }

  const refresh = async () => {
    try {
      const d = await listProfiles()
      setRows(d.profiles); setMe(d.me); setErr(null)
      return true
    } catch (e) {
      setErr('서버 프로필을 쓸 수 없습니다 — 백엔드가 떠 있는지 확인하세요. (작업 중인 설정은 이 브라우저에 계속 저장됩니다)')
      return false
    }
  }
  useEffect(() => { refresh() }, [tries])

  // A backend restart used to strand this panel in the error state forever:
  // the list was fetched once on mount and nothing ever retried. Retry when the
  // tab regains focus (you just started the server) and on the button below.
  useEffect(() => {
    if (!err) return undefined
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [err])

  const taken = rows.filter((r) => r.mine).map((r) => r.name)

  // Save over the open profile, or create one when nothing is open.
  const save = async () => {
    setBusy(true)
    try {
      const meta = await saveProfile({ id: current?.mine ? current.id : undefined, name: (name || 'untitled').trim(), setup: S })
      setCurrent(meta)
      setS((s) => ({ ...s, name: meta.name }))
      await refresh(); flash(current?.mine ? '저장했습니다' : '새 프로필로 저장했습니다')
    } catch (e) { flash('저장 실패: ' + e.message) } finally { setBusy(false) }
  }

  const createNew = async () => {
    setBusy(true)
    try {
      const fresh = defaultSetup()
      const meta = await saveProfile({ name: uniqueName('새 프로필', taken), setup: fresh })
      setS({ ...fresh, name: meta.name }); setCurrent(meta)
      await refresh(); flash('새 프로필을 만들었습니다')
    } catch (e) { flash('실패: ' + e.message) } finally { setBusy(false) }
  }

  const duplicate = async (row) => {
    setBusy(true)
    try {
      // Copy whatever is on screen when duplicating the open profile, else the
      // stored body — so an unsaved tweak isn't silently dropped.
      const setup = row && row.id !== current?.id ? (await loadProfile(row.owner, row.id)).setup : S
      const nm = copyName(row ? row.name : S.name, taken)
      const meta = await saveProfile({ name: nm, setup: { ...setup, name: nm } })
      setS({ ...setup, name: nm }); setCurrent(meta)
      await refresh(); flash(`"${nm}" 로 복사했습니다`)
    } catch (e) { flash('복사 실패: ' + e.message) } finally { setBusy(false) }
  }

  const open = async (row) => {
    setBusy(true)
    try {
      const rec = await loadProfile(row.owner, row.id)
      importJSON(JSON.stringify({ ...rec.setup, name: rec.name }))
      setCurrent(row)
      flash(row.mine ? '불러왔습니다' : row.builtin ? '기본 제공 프로필을 불러왔습니다' : '공유 프로필 (읽기 전용 원본)')
    } catch (e) { flash('불러오기 실패: ' + e.message) } finally { setBusy(false) }
  }

  const remove = async (row) => {
    setBusy(true)
    try {
      await deleteProfile(row.id)
      if (current?.id === row.id) setCurrent(null)
      setConfirmDel(null); await refresh(); flash('삭제했습니다')
    } catch (e) { flash('삭제 실패: ' + e.message) } finally { setBusy(false) }
  }

  const toggleShare = async (row) => {
    setBusy(true)
    try {
      const rec = await loadProfile(row.owner, row.id)
      await saveProfile({ id: row.id, name: row.name, setup: rec.setup, shared: !row.shared })
      await refresh()
    } catch (e) { flash('실패: ' + e.message) } finally { setBusy(false) }
  }

  const mine = rows.filter((r) => r.mine)
  const shared = rows.filter((r) => !r.mine && !r.builtin)
  const builtin = rows.filter((r) => r.builtin)

  return (
    <div className="profpanel">
      <div className="psec">
        <div className="psechead"><span>현재 프로필</span></div>
        <div className="pfrow">
          <label>이름</label>
          <div className="pfin">
            <input value={name} placeholder="untitled"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setS((s) => ({ ...s, name: name.trim() }))} />
          </div>
        </div>
        <div className="dnote">
          {!current
            ? <>아직 프로필에 연결되지 않았습니다 — 저장하면 새로 만들어집니다.</>
            : current.mine
              ? <>저장하면 <b>{current.name}</b> 을(를) 덮어씁니다.</>
              : current.builtin
                ? <>기본 제공 <b>{current.name}</b> 에서 시작했습니다 — 저장하면 내 프로필로 새로 만들어집니다.</>
                : <>{current.owner} 의 공유 프로필에서 시작했습니다 — 저장하면 내 프로필로 새로 만들어집니다.</>}
        </div>
        <div className="psaverow">
          <button className="mini" disabled={busy || !!err} onClick={save}>저장</button>
          <button className="mini" disabled={busy || !!err} onClick={() => duplicate(null)}>현재 설정 복사</button>
          <button className="mini" disabled={busy || !!err} onClick={createNew}>새 프로필</button>
          <button className="mini" onClick={reset}>기본값으로</button>
        </div>
        {msg && <div className="pflash">{msg}</div>}
        {err && (
          <div className="dnote warn">
            {err}
            <button className="mini" style={{ marginLeft: 6 }}
              onClick={() => setTries((t) => t + 1)}>다시 시도</button>
          </div>
        )}
      </div>

      {builtin.length > 0 && (
        <div className="psec">
          <div className="psechead"><span>기본 제공</span><em>{builtin.length}</em></div>
          {builtin.map((r) => (
            <div key={r.id} className={`profrow${current?.id === r.id ? ' on' : ''}`}>
              <button className="plink" onClick={() => open(r)} title={r.note || '불러오기'}>{r.name}</button>
              <span className="proftime">기본</span>
              <button className="mini" disabled={busy} title="내 프로필로 복사" onClick={() => duplicate(r)}>복사</button>
            </div>
          ))}
        </div>
      )}

      <div className="psec">
        <div className="psechead"><span>내 프로필</span><em>{mine.length}</em></div>
        {mine.length === 0 && !err && <div className="dnote">아직 없습니다.</div>}
        {mine.map((r) => (
          <div key={r.id} className={`profrow${current?.id === r.id ? ' on' : ''}`}>
            <button className="plink" onClick={() => open(r)} title="불러오기">{r.name}</button>
            <span className="proftime">{when(r.updated)}</span>
            <button className={`profshare ${r.shared ? 'on' : ''}`} disabled={busy}
              title={r.shared ? '공유 중 — 누르면 비공개' : '다른 사람에게 읽기 전용으로 공유'}
              onClick={() => toggleShare(r)}>{r.shared ? '공유중' : '공유'}</button>
            <button className="mini" disabled={busy} title="복사본 만들기" onClick={() => duplicate(r)}>복사</button>
            {confirmDel === r.id
              ? <button className="px danger" onClick={() => remove(r)} title="정말 삭제">정말?</button>
              : <button className="px" onClick={() => setConfirmDel(r.id)} title="삭제">✕</button>}
          </div>
        ))}
      </div>

      {shared.length > 0 && (
        <div className="psec">
          <div className="psechead"><span>공유된 프로필</span><em>{shared.length}</em></div>
          {shared.map((r) => (
            <div key={r.owner + '/' + r.id} className={`profrow${current?.id === r.id ? ' on' : ''}`}>
              <button className="plink" onClick={() => open(r)} title="불러오기">{r.name}</button>
              <span className="proftime">{r.owner}</span>
              <button className="mini" disabled={busy} title="내 프로필로 복사" onClick={() => duplicate(r)}>복사</button>
            </div>
          ))}
        </div>
      )}

      <div className="psec">
        <div className="psechead"><span>파일</span></div>
        <div className="psaverow">
          <button className="mini" onClick={() => setIo(exportJSON())}>JSON 내보내기</button>
          <button className="mini" onClick={() => setIo('')}>붙여넣어 불러오기</button>
          <label className="mini filebtn">파일…
            <input type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={(e) => { const fl = e.target.files[0]; if (fl) fl.text().then(setIo) }} />
          </label>
        </div>
        {io != null && (
          <div className="piobox">
            <textarea value={io} spellCheck={false} onChange={(e) => setIo(e.target.value)} />
            <div className="psaverow">
              <button className="mini" onClick={() => navigator.clipboard?.writeText(io)
                .then(() => flash('복사됨'), () => flash('⌘C 로 복사하세요'))}>복사</button>
              <button className="mini" onClick={() => {
                try { importJSON(io); setCurrent(null); setIo(null); flash('불러왔습니다') }
                catch (e) { flash('읽을 수 없음: ' + e.message) }
              }}>불러오기</button>
              <button className="mini" onClick={() => setIo(null)}>닫기</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
