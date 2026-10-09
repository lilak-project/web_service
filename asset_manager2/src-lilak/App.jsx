/**
 * asset manager — the asset list, at sheet density.
 *
 *   자산 ──────────────────────────────── nameplate (the module's name)
 *   + 새 자산   clear        [search]     command line
 *   assets                                tabs
 *   ☐ # 자산번호 자산명 위치 Type …        the head: sticky, draggable edges
 *   …rows…                                26px each
 *
 * The same shape author_manager and reference_manager have, out of the same
 * parts: the table, the tab strips, the selection, the remembered view state
 * and the portal's version-guarded document all come from the kit's `racklist`.
 * What is here is what makes this one about ASSETS — the columns, the accessors
 * behind them, and the editor.
 *
 * Right-click a row to edit it: the record opens in the pane beside the list,
 * which has its own tabs, because a record you are fixing is not one of the
 * lists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RackTable, RackRow, RackTabs,
  useColumnWidths, useViewportWidth, useSelection, useFindKey, useNote, useViewState,
  bySome, facetOf, passesFilter,
  PORTAL_PROJECT, projectKey, brandStyle, isManager, newId, fetchDoc, putDoc,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'

const WIDTH_KEY = projectKey('am2', 'cols')
const VIEW_KEY = projectKey('am2', 'view')
const IS_ADMIN = isManager()

const D = '·'   // a cell with nothing in it still shows its column

// ─── The columns ────────────────────────────────────────────────────────────
// One list, read by the head and by every row. `min` is as narrow as dragging
// may take it; `drop` is the width below which the column leaves rather than
// the table scrolling sideways.
const COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 44, min: 32, fix: true, label: '#' },
  { k: 'assetId', w: 118, min: 70, label: '자산번호' },
  { k: 'name', w: 250, min: 110, label: '자산명' },
  { k: 'location', w: 150, min: 70, label: '위치' },
  { k: 'type', w: 120, min: 60, label: 'Type', drop: 1180 },
  { k: 'assetClass', w: 120, min: 60, label: '자산분류', drop: 1100 },
  { k: 'accountHolder', w: 112, min: 60, label: '관리책임자', drop: 1400 },
  { k: 'lastUpdate', w: 96, min: 70, label: '최근변경', drop: 900 },
]
/** Which columns are the record's own words (ink) and which are about it. */
const TONE = { name: 'ink', location: 'dim', type: 'dim', assetClass: 'dim', accountHolder: 'dim' }

// What a column sorts by: the same accessors the cells use, so the order you
// get is the order you can see.
const SORTERS = {
  assetId: (a) => a.assetId || '',
  name: (a) => a.name || '',
  location: (a) => a.location || '',
  type: (a) => a.type || '',
  assetClass: (a) => a.assetClass || '',
  accountHolder: (a) => a.accountHolder || '',
  lastUpdate: (a) => a.lastUpdate || '',
}
const day = (v) => String(v || '').slice(0, 10)

// The fields an asset is edited by. One list, so a field added here shows up in
// the editor without anything else being touched.
const FIELDS = [
  { k: 'assetId', l: '자산번호', w: 160, mono: true },
  { k: 'name', l: '자산명', w: 320 },
  { k: 'location', l: '위치', w: 240, from: 'location' },
  { k: 'type', l: 'Type', w: 200, from: 'type' },
  { k: 'assetClass', l: '자산분류', w: 200 },
  { k: 'accountHolder', l: '관리책임자', w: 200 },
  { k: 'applicationName', l: '신청품목명', w: 320 },
  { k: 'spec', l: '규격', w: 240 },
  { k: 'manufacturerProvider', l: '제조사', w: 240 },
  { k: 'acquisitionDate', l: '취득일', w: 140 },
  { k: 'acquisitionPriceKrw', l: '취득가', w: 140 },
  { k: 'description', l: '설명', area: true },
  { k: 'memo', l: '메모', area: true },
]

const FIXED = [{ id: 'assets', kind: 'assets', label: 'assets' }]

export default function App() {
  const [VIEW, saveView] = useViewState(VIEW_KEY)
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useNote()
  const [tabs] = useState(FIXED)
  const [active, setActive] = useState('assets')
  // The editor is its OWN pane with its OWN tabs: a record you are fixing is
  // not one of the lists, and closing one should not send you somewhere else.
  const [etabs, setEtabs] = useState([])
  const [eactive, setEactive] = useState(null)
  const [query, setQuery] = useState('')
  const { drag, sized } = useColumnWidths(WIDTH_KEY, COLS)
  const vw = useViewportWidth()
  const [sort, setSort] = useState(VIEW.sort || null)
  // Filtering has a MODE. In it the labels stop sorting and start choosing
  // which column's values you are picking from; the picks pile up across
  // columns until they are applied.
  const [fmode, setFmode] = useState(false)
  const [fcol, setFcol] = useState(null)
  const [fsel, setFsel] = useState(VIEW.fsel || {})
  const [fon, setFon] = useState(!!VIEW.fon)
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])
  useEffect(() => { saveView({ active, sort, fsel, fon }) }, [active, sort, fsel, fon])

  const assets = doc?.assets || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

  const cols = useMemo(() => sized(COLS, vw), [sized, vw])

  const scope = useMemo(
    () => [...assets].sort(bySome(SORTERS[sort?.k || 'assetId'], sort?.dir ?? 1)),
    [assets, sort])

  const passes = useCallback((a) => passesFilter(a, fsel, SORTERS), [fsel])
  const rows = useMemo(() => {
    const kept = fon ? scope.filter(passes) : scope
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((a) => [a.assetId, a.name, a.location, a.type, a.assetClass,
      a.accountHolder, a.spec, a.memo, a.description]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [scope, query, fon, passes])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(rows)

  // Counted over every asset, not the filtered ones: a value that would empty
  // the list is still worth seeing.
  const facet = useMemo(() => facetOf(scope, SORTERS[fcol]), [fcol, scope])
  const picked_ = (k) => fsel[k] || []
  const facetTotal = Object.values(fsel).reduce((t, v) => t + v.length, 0)

  // The values already in use, offered when editing — a location or a type is a
  // word other assets already use, not a thing to create first.
  const options = useMemo(() => ({
    location: [...new Set(assets.map((a) => a.location).filter(Boolean))].sort(),
    type: [...new Set(assets.map((a) => a.type).filter(Boolean))].sort(),
  }), [assets])

  // The editor pane takes the right half when there is room for both; below
  // that it has the width to itself while it is open.
  const etab = etabs.find((t) => t.id === eactive) || null
  const showEdit = !!etab
  const showList = !showEdit || vw >= 1180

  function openEdit(t) {
    setEtabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]))
    setEactive(t.id)
  }
  function closeEdit(id) {
    setEtabs((ts) => {
      const left = ts.filter((t) => t.id !== id)
      if (id === eactive) setEactive(left.length ? left[left.length - 1].id : null)
      return left
    })
  }

  /** Whole-document save, version-guarded: 409 means someone else got there
   *  first, and the answer is to read again rather than overwrite them. */
  async function commit(patch, said) {
    if (!doc) return false
    try {
      const r = await putDoc(doc.version, { assets: patch.assets || doc.assets })
      if (r.conflict) { setNote('다른 사람이 먼저 저장했습니다 — 새로 읽어주세요.'); return false }
      setDoc(r.doc)
      setNote(said || '저장했습니다.')
      return true
    } catch (e) { setNote(String(e.message || e)); return false }
  }

  return (
    <div className="rl" style={brandStyle()}>
      <section className="rl-mod">
        <header className="rl-bar">
          <b>자산</b>
          <span className="rl-n">{doc ? `${assets.length}개` : ''}</span>
          <span className="rl-sp" />
          <span className="rl-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="rl-cmd">
          <button type="button" className="rl-btn rl-go"
            onClick={() => openEdit({ id: 'new', kind: 'edit', who: null, label: '새 자산' })}>
            + 새 자산
          </button>
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {picked.size > 0 && <span className="rl-n">{picked.size} 선택</span>}
          <span className="rl-gap" />
          {fmode ? (
            <>
              <button type="button" className="rl-btn rl-go"
                onClick={() => { setFmode(false); setFon(facetTotal > 0) }}>
                필터 적용{facetTotal ? ` (${facetTotal})` : ''}
              </button>
              <button type="button" className="rl-btn" onClick={() => setFmode(false)}>취소</button>
              <span className="rl-hint">레이블을 눌러 종류를 고르세요.</span>
            </>
          ) : fon ? (
            <>
              <button type="button" className="rl-btn rl-danger"
                onClick={() => { setFon(false); setFsel({}); setFcol(null) }}>필터 풀기</button>
              <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 고치기</button>
            </>
          ) : (
            <button type="button" className="rl-btn" onClick={() => setFmode(true)}>필터 선택</button>
          )}
          <span className="rl-sp" />
          <input ref={findRef} type="search" className="rl-find" value={query}
            placeholder="자산번호 · 이름 · 위치 · 메모   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane">
            <RackTabs tabs={tabs} active={active} fixed={FIXED} onPick={setActive} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !doc && <p className="rl-msg">읽는 중…</p>}

            {doc && (
              <RackTable cols={cols} onDrag={drag('')}
                facet={fmode ? { col: fcol, count: (k) => picked_(k).length, onPick: setFcol } : null}
                sort={sort || { k: 'assetId', dir: 1 }}
                onSort={(k) => setSort((s) => {
                  // The implicit order counts as the current one, so the first
                  // press on the column already sorted turns it over.
                  const now = s || { k: 'assetId', dir: 1 }
                  return now.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={fmode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                {fmode && !fcol && <p className="rl-msg">위의 레이블을 눌러 어떤 종류로 걸를지 고르세요.</p>}
                {fmode && fcol && facet.length === 0 && <p className="rl-msg">이 열에는 값이 없습니다.</p>}
                {fmode && fcol && facet.map(({ v, count }) => {
                  const on = picked_(fcol).includes(v)
                  return (
                    <button key={v} type="button" className={`rl-frow${on ? ' on' : ''}`}
                      onClick={() => setFsel((s) => {
                        const cur = s[fcol] || []
                        return { ...s, [fcol]: on ? cur.filter((x) => x !== v) : [...cur, v] }
                      })}>
                      <span className="rl-fv">{v}</span>
                      <span className="rl-fn">{count}</span>
                    </button>
                  )
                })}
                {!fmode && rows.map((a, i) => {
                  const on = picked.has(a.id || a.assetId)
                  const edited = etabs.some((t) => t.who === (a.id || a.assetId))
                  return (
                    <RackRow key={a.id || a.assetId || i} cols={cols} tone={TONE}
                      className={`rl-hit${on ? ' on' : ''}${edited ? ' rl-edited' : ''}`}
                      onClick={(e) => hit(i, e.shiftKey)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openEdit({ id: `edit:${a.assetId}`, kind: 'edit', who: a.assetId,
                          label: a.assetId || a.name || '자산' })
                      }}
                      cell={{
                        chk: <input type="checkbox" checked={on} tabIndex={-1} readOnly
                          aria-label={`${a.assetId} 선택`} />,
                        num: i + 1,
                        assetId: a.assetId || D,
                        name: a.name || D,
                        location: a.location || D,
                        type: a.type || D,
                        assetClass: a.assetClass || D,
                        accountHolder: a.accountHolder || D,
                        lastUpdate: day(a.lastUpdate) || D,
                      }} />
                  )
                })}
                {!fmode && rows.length === 0 && <p className="rl-msg">해당하는 자산이 없습니다.</p>}
              </RackTable>
            )}
          </div>)}

          {showEdit && (<div className="rl-pane rl-epane">
            <RackTabs tabs={etabs} active={eactive} opened onPick={setEactive} onClose={closeEdit} />
            <EditAsset
              asset={etab.who ? assets.find((a) => a.assetId === etab.who) : null}
              doc={doc} options={options} onSave={commit} isAdmin={IS_ADMIN}
              onCreated={(id) => {
                // One updater: closing the draft and opening the record it
                // became are a single move, and two of them raced — the draft
                // stayed and the pane kept showing the empty form.
                const next = { id: `edit:${id}`, kind: 'edit', who: id, label: id }
                setEtabs((ts) => {
                  const left = ts.filter((t) => t.id !== 'new')
                  return left.some((t) => t.id === next.id) ? left : [...left, next]
                })
                setEactive(next.id)
              }}
              onDone={(id) => closeEdit(`edit:${id}`)}
              onDeleted={(id) => {
                closeEdit(`edit:${id}`)
                setPicked((s) => { const n = new Set(s); n.delete(id); return n })
              }} />
          </div>)}
        </div>

        <footer className="rl-foot">
          <span>{note || '왼쪽 클릭으로 선택, shift로 범위, 오른쪽 클릭으로 편집.'}</span>
          <span className="rl-sp" />
          <span className="rl-mono">{rows.length ? `${rows.length}줄` : ''}</span>
        </footer>
      </section>
    </div>
  )
}

// ─── Editing ────────────────────────────────────────────────────────────────
// The record reads at the readable size, not the list's: finding is dense,
// reading and typing are not.
function Fld({ label, children }) {
  return (<><span className="rl-fl">{label}</span><div className="rl-fv">{children}</div></>)
}

function EditAsset({ asset, doc, options, onSave, isAdmin, onCreated, onDeleted, onDone }) {
  // No asset means a DRAFT: the same form, and saving puts it in the document
  // rather than over one. One form, two jobs, so a field added here is added to
  // both at once.
  const draft = !asset
  const blank = useMemo(() => Object.fromEntries(FIELDS.map((f) => [f.k, ''])), [])
  const [f, setF] = useState(asset || blank)
  const [sure, setSure] = useState(false)   // delete asks once, in place
  useEffect(() => { setF(asset || blank); setSure(false) }, [asset, blank])
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const id = String(f.assetId || '').trim()
  const taken = (doc?.assets || []).some((a) => a.assetId === id && a.assetId !== asset?.assetId)

  async function create() {
    if (!id || taken) return
    const now = new Date().toISOString()
    const a = { ...f, assetId: id, id: newId(), createdAt: now, lastUpdate: now }
    if (await onSave({ assets: [a, ...(doc.assets || [])] }, `${id} 등록됨`)) onCreated?.(id)
  }
  async function update() {
    const now = new Date().toISOString()
    const ok = await onSave({
      assets: doc.assets.map((a) => (a.assetId === asset.assetId
        ? { ...f, assetId: id, lastUpdate: now } : a)),
    })
    // The record was an errand, not a destination: a save that landed closes
    // the tab it came from. A save that lost the race keeps it, edits and all.
    if (ok) onDone?.(asset.assetId)
  }
  async function remove() {
    if (await onSave({ assets: doc.assets.filter((a) => a.assetId !== asset.assetId) },
      `${asset.assetId} 삭제됨`)) onDeleted?.(asset.assetId)
  }

  return (
    <div className="rl-edit">
      <div className="rl-rec">
        {FIELDS.map((fd) => (
          <Fld key={fd.k} label={fd.l}>
            {fd.area ? (
              <textarea className="rl-in" rows={2} style={{ width: '100%', minWidth: 240 }}
                value={f[fd.k] || ''} onChange={set(fd.k)} />
            ) : (
              <>
                <input className={`rl-in${fd.mono ? ' rl-mono' : ''}`} style={{ width: fd.w }}
                  list={fd.from ? `am2-${fd.from}` : undefined}
                  value={f[fd.k] || ''} onChange={set(fd.k)} />
                {fd.from && (
                  <datalist id={`am2-${fd.from}`}>
                    {options[fd.from].map((v) => <option key={v} value={v} />)}
                  </datalist>
                )}
                {fd.k === 'assetId' && taken && <span className="rl-warn">같은 번호가 있습니다.</span>}
              </>
            )}
          </Fld>
        ))}
        <Fld label="">
          {draft ? (
            <>
              <button type="button" className="rl-btn rl-go" disabled={!id || taken} onClick={create}>등록</button>
              <span className="rl-hint">{id ? '' : '자산번호가 있어야 합니다.'}</span>
            </>
          ) : (
            <>
              <button type="button" className="rl-btn rl-go" disabled={!id || taken} onClick={update}>save and exit</button>
              <button type="button" className="rl-btn" onClick={() => setF(asset)}>revert</button>
              {isAdmin && (
                <>
                  <span className="rl-gap" />
                  {/* Asked in place: window.confirm never appears inside the
                      portal's frame, so a dialog would delete with no question
                      asked at all. */}
                  {sure ? (
                    <>
                      <span className="rl-hint">되돌릴 수 없습니다.</span>
                      <button type="button" className="rl-btn rl-danger" onClick={remove}>정말 삭제</button>
                      <button type="button" className="rl-btn" onClick={() => setSure(false)}>취소</button>
                    </>
                  ) : (
                    <button type="button" className="rl-btn rl-danger" onClick={() => setSure(true)}>delete</button>
                  )}
                </>
              )}
            </>
          )}
        </Fld>
      </div>
    </div>
  )
}
