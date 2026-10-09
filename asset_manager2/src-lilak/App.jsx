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
  RackTable, RackRow, RackTabs, RackActions, RackField as Fld,
  useColumnWidths, useViewportWidth, useSelection, useFindKey, useToggleKey,
  useNote, useViewState, usePaneSplit, useRackKeys,
  useEditorPanes, RackPaneStrip, useFacetFilter, FilterBar, FacetRows,
  bySome,
  PORTAL_PROJECT, projectKey, brandStyle, isManager, portalUser, newId, fetchDoc, putDoc,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'

const WIDTH_KEY = projectKey('am2', 'cols')
const VIEW_KEY = projectKey('am2', 'view')
const IS_ADMIN = isManager()
const ME = portalUser()?.email || ''

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

// The two photos an asset carries. The sticker is photo2 and the whole thing
// photo1 — the names the old app wrote and the data still uses.
const SHOTS = [
  { k: 'photo2', l: '자산 스티커' },
  { k: 'photo1', l: '자산 전체' },
]
// The document holds a photo as a data URL, and the whole document is sent on
// every save: a few hundred KB each is a fair scan, a megabyte each is a list
// nobody can save any more.
const SHOT_CAP = 600 * 1024
const SHOT_MAX = 1280          // px on the long side

/** A picked file, shrunk and re-encoded — a phone photo is 4000px and 4MB. */
function shrink(file) {
  return new Promise((res, rej) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const s = Math.min(1, SHOT_MAX / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * s)
      c.height = Math.round(img.height * s)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      res(c.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('읽지 못했습니다.')) }
    img.src = url
  })
}

// A LIST is a record: a set of assets with a name, somewhere they are going,
// and what was done with them. My List used to be the one you were building
// before saving it; now the list IS the record, made from what you ticked.
const LIST_TYPES = [
  ['save', '목록'], ['update', '위치 변경'], ['checkout', '반출'],
  ['checkin', '반입'], ['extension', '연장'], ['request', '요청'],
]
const typeLabel = (t) => (LIST_TYPES.find(([k]) => k === t) || [, t || '목록'])[1]

const LIST_COLS = [
  { k: 'num', w: 44, min: 32, fix: true, label: '#' },
  { k: 'name', w: 230, min: 100, label: '이름' },
  { k: 'type', w: 96, min: 60, label: '종류' },
  { k: 'count', w: 60, min: 44, label: '개수', num: true },
  { k: 'location', w: 150, min: 70, label: '위치' },
  { k: 'user', w: 120, min: 60, label: '만든이', drop: 1100 },
  { k: 'at', w: 150, min: 90, label: '시각', drop: 900 },
]
const LIST_SORTERS = {
  name: (r) => r.name || '',
  type: (r) => typeLabel(r.type),
  count: (r) => (r.assetIds || []).length,
  location: (r) => r.location || '',
  user: (r) => r.user || '',
  at: (r) => r.createdAt || '',
}
const LIST_TONE = { name: 'ink', type: 'dim', location: 'dim', user: 'dim', at: 'dim' }

const FIXED = [
  { id: 'assets', kind: 'assets', label: 'assets' },
  { id: 'lists', kind: 'lists', label: 'lists' },
]

export default function App() {
  const [VIEW, saveView] = useViewState(VIEW_KEY)
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useNote()
  const [tabs] = useState(FIXED)
  const [active, setActive] = useState('assets')
  // The editor's panes, its tabs, the split between them and the filter are the
  // kit's — every rack-list service behaves the same way because it is the same
  // code, not the same intention.
  const panes = useEditorPanes(projectKey('am2', 'panes'))
  const split = usePaneSplit(projectKey('am2', 'split'))
  const [query, setQuery] = useState('')
  const { drag, sized } = useColumnWidths(WIDTH_KEY, COLS)
  const vw = useViewportWidth()
  const [sort, setSort] = useState(VIEW.sort || null)
  const findRef = useRef(null)
  useFindKey(findRef)

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])

  const assets = doc?.assets || []
  const tab = tabs.find((t) => t.id === active) || tabs[0]

  const lists = doc?.records || []
  const onLists = tab?.kind === 'lists'
  const cols = useMemo(() => sized(onLists ? LIST_COLS : COLS, vw), [sized, vw, onLists])
  const sorters = onLists ? LIST_SORTERS : SORTERS
  const firstCol = onLists ? 'at' : 'assetId'

  const scope = useMemo(() => (onLists
    ? [...lists].sort(bySome(LIST_SORTERS[sort?.k || 'at'], sort?.dir ?? -1))
    : [...assets].sort(bySome(SORTERS[sort?.k || 'assetId'], sort?.dir ?? 1))),
  [onLists, lists, assets, sort])

  const filter = useFacetFilter(scope, sorters, { sel: VIEW.fsel, on: VIEW.fon })
  // Below the filter on purpose: a dependency array is evaluated where it is
  // written, and `filter` does not exist yet further up.
  useEffect(() => { saveView({ active, sort, fsel: filter.sel, fon: filter.on }) },
    [active, sort, filter.sel, filter.on])
  const rows = useMemo(() => {
    const kept = filter.on ? scope.filter(filter.passes) : scope
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((r) => (onLists
      ? [r.name, r.location, r.user, typeLabel(r.type), ...(r.assetIds || [])]
      : [r.assetId, r.name, r.location, r.type, r.assetClass, r.accountHolder, r.spec, r.memo, r.description])
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [scope, query, onLists, filter.on, filter.passes])
  // An asset is known by its 자산번호 — the document has no other id for one,
  // so that is what a selection holds.
  const keys = useMemo(() => rows.map((r) => ({ id: onLists ? r.id : r.assetId })), [rows, onLists])
  const { picked, setPicked, hit, all: allPicked, some: somePicked, toggleAll, clear: clearPicked }
    = useSelection(keys)
  useToggleKey(toggleAll)

  // The values already in use, offered when editing — a location or a type is a
  // word other assets already use, not a thing to create first.
  const options = useMemo(() => ({
    location: [...new Set(assets.map((a) => a.location).filter(Boolean))].sort(),
    type: [...new Set(assets.map((a) => a.type).filter(Boolean))].sort(),
  }), [assets])

  // Two columns of records fit above 1500, one above 1180, and below that the
  // editor has the width while it is open.
  const showEdit = panes.showing && !!doc
  const showList = !showEdit || (vw >= (panes.cols.length > 1 ? 1500 : 1180) && !panes.full)
  const openEdit = (t) => panes.open(t)
  const closeEdit = (id) => panes.close(id)
  // ⌘N a new record, ⌘S save it, ⌘X leave it — the keys every rack list has.
  useRackKeys({
    onNew: () => openEdit({ id: 'new', kind: 'edit', who: null, label: '새 자산' }),
    onClose: () => { const cur = panes.current(panes.cols[0]); if (cur) panes.close(cur.id) },
  })
  // A tab for an asset the document no longer has cannot be shown.
  useEffect(() => {
    if (!doc) return
    panes.keep((t) => !t.who
      || (t.kind === 'list' ? (doc.records || []).some((r) => r.id === t.who)
        : assets.some((a) => a.assetId === t.who)))
  }, [doc])

  /** A list out of the ticked assets: the record My List used to become when
   *  you pressed Save, made in one move and opened for the rest. */
  async function makeList() {
    const ids = rows.filter((a) => picked.has(a.assetId)).map((a) => a.assetId)
    if (!ids.length) { setNote('선택된 자산이 없습니다.'); return }
    const now = new Date().toISOString()
    const stamp = now.slice(0, 10)
    const used = new Set((doc.records || []).map((r) => r.name))
    let name = stamp
    for (let n = 2; used.has(name); n += 1) name = `${stamp}-${n}`
    const rec = { id: newId(), name, type: 'save', assetIds: ids, location: '',
      user: ME, createdAt: now }
    if (await commit({ records: [rec, ...(doc.records || [])] }, `'${name}' 리스트 ${ids.length}개`)) {
      clearPicked()
      setActive('lists')
      openEdit({ id: `list:${rec.id}`, kind: 'list', who: rec.id, label: name })
    }
  }

  /** Whole-document save, version-guarded: 409 means someone else got there
   *  first, and the answer is to read again rather than overwrite them. */
  async function commit(patch, said) {
    if (!doc) return false
    try {
      const r = await putDoc(doc.version, {
        assets: patch.assets || doc.assets,
        records: patch.records || doc.records,
      })
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
          {!onLists && (
            <button type="button" className="rl-btn rl-go"
              onClick={() => openEdit({ id: 'new', kind: 'edit', who: null, label: '새 자산' })}>
              + 새 자산
            </button>
          )}
          {!onLists && (
            <button type="button" className="rl-btn rl-tabonly" disabled={!picked.size}
              onClick={makeList}>리스트 만들기</button>
          )}
          <button type="button" className="rl-btn" disabled={!picked.size}
            onClick={clearPicked}>clear</button>
          {picked.size > 0 && <span className="rl-n">{picked.size} 선택</span>}
          <span className="rl-gap" />
          <FilterBar f={filter} />
          <span className="rl-sp" />
          <input ref={findRef} type="search" className="rl-find" value={query}
            placeholder="자산번호 · 이름 · 위치 · 메모   (⌘F)"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="rl-body">
          {showList && (<div className="rl-pane" style={showEdit ? split.leftStyle : undefined}>
            <RackTabs tabs={tabs} active={active} fixed={FIXED} onPick={setActive} />

            {err && <p className="rl-msg">{err}</p>}
            {!err && !doc && <p className="rl-msg">읽는 중…</p>}

            {doc && (
              <RackTable cols={cols} onDrag={drag('')}
                facet={filter.tableFacet}
                sort={sort || { k: firstCol, dir: onLists ? -1 : 1 }}
                onSort={(k) => setSort((s) => {
                  // The implicit order counts as the current one, so the first
                  // press on the column already sorted turns it over.
                  const now = s || { k: firstCol, dir: onLists ? -1 : 1 }
                  return now.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={filter.mode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                <FacetRows f={filter} />
                {!filter.mode && onLists && rows.map((r, i) => {
                  const on = picked.has(r.id)
                  const edited = panes.tabs.some((t) => t.who === r.id)
                  return (
                    <RackRow key={r.id} cols={cols} tone={LIST_TONE}
                      className={`rl-hit${on ? ' on' : ''}${edited ? ' rl-edited' : ''}`}
                      onClick={(e) => hit(i, e.shiftKey)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openEdit({ id: `list:${r.id}`, kind: 'list', who: r.id, label: r.name || '리스트' })
                      }}
                      cell={{
                        num: i + 1,
                        name: r.name || D,
                        type: typeLabel(r.type) + (r.pending ? ' · 대기' : ''),
                        count: (r.assetIds || []).length,
                        location: r.location || D,
                        user: r.user ? String(r.user).split('@')[0] : D,
                        at: String(r.createdAt || '').slice(0, 16).replace('T', ' ') || D,
                      }} />
                  )
                })}
                {!filter.mode && !onLists && rows.map((a, i) => {
                  const on = picked.has(a.assetId)
                  const edited = panes.tabs.some((t) => t.who === a.assetId)
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
                {!filter.mode && rows.length === 0 && <p className="rl-msg">해당하는 자산이 없습니다.</p>}
              </RackTable>
            )}
          </div>)}

          {showList && showEdit && <div {...split.handleProps} />}

          {showEdit && panes.cols.map((c) => {
            const etab = panes.current(c)
            return (
              <div key={c} className="rl-pane rl-epane" onMouseDown={() => panes.setCol(c)}
                style={showList && panes.cols.length === 1 ? split.rightStyle : undefined}>
                <RackPaneStrip panes={panes} col={c} />
                {etab.kind === 'list' ? (
                  <EditList
                    key={etab.id}
                    rec={lists.find((r) => r.id === etab.who) || null}
                    doc={doc} assets={assets} options={options} me={ME}
                    onSave={commit} isAdmin={IS_ADMIN} say={setNote}
                    picked={picked} clearPicked={clearPicked}
                    onCancel={() => panes.close(etab.id)}
                    onDeleted={() => panes.close(etab.id)}
                    onOpenAsset={(id) => openEdit({ id: `edit:${id}`, kind: 'edit', who: id, label: id })}
                  />
                ) : (
                <EditAsset
                  key={etab.id}
                  asset={etab.who ? assets.find((a) => a.assetId === etab.who) : null}
                  doc={doc} options={options} onSave={commit} isAdmin={IS_ADMIN}
                  onCreated={(id) => { panes.close('new'); panes.open({ id: `edit:${id}`, kind: 'edit', who: id, label: id }) }}
                  onCancel={() => panes.close(etab.id)}
                  onDeleted={(id) => {
                    panes.close(`edit:${id}`)
                    setPicked((s) => { const n = new Set(s); n.delete(id); return n })
                  }} />
                )}
              </div>
            )
          })}
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
// reading and typing are not. The rows and the action bar are the kit's, so
// this editor is left the same way every other rack-list editor is.
function EditAsset({ asset, doc, options, onSave, isAdmin, onCreated, onDeleted, onCancel }) {
  // No asset means a DRAFT: the same form, and saving puts it in the document
  // rather than over one. One form, two jobs, so a field added here is added to
  // both at once.
  const draft = !asset
  const blank = useMemo(() => Object.fromEntries(FIELDS.map((f) => [f.k, ''])), [])
  const [f, setF] = useState(asset || blank)
  useEffect(() => { setF(asset || blank) }, [asset, blank])
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
    // save SAVES; leaving is ⌘X or the tab's own ×. The editor stays where it
    // is, so a second change does not need the record opened again.
    await onSave({
      assets: doc.assets.map((a) => (a.assetId === asset.assetId
        ? { ...f, assetId: id, lastUpdate: now } : a)),
    })
  }
  async function remove() {
    if (await onSave({ assets: doc.assets.filter((a) => a.assetId !== asset.assetId) },
      `${asset.assetId} 삭제됨`)) onDeleted?.(asset.assetId)
  }

  return (
    <div className="rl-edit">
      <RackActions key={asset?.assetId || 'new'}
        draft={draft}
        createDisabled={!id || taken}
        hint={draft && !id ? '자산번호가 있어야 합니다.' : ''}
        onCreate={create}
        saveDisabled={!id || taken}
        onSave={update}
        onCancel={onCancel}
        onRevert={() => setF(asset)}
        onDelete={isAdmin && !draft ? remove : null}
      />
      <div className="rl-rec">
        <Fld label="사진">
          <ShotRows value={f} onChange={(patch) => setF((s2) => ({ ...s2, ...patch }))} />
        </Fld>
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
      </div>
    </div>
  )
}

/** The asset's photos: two slots, each a picture or a way to add one.
 *  `capture` on the input is what hands a phone its camera; a desktop gets the
 *  file picker, which is the same thing from where this code stands. */
function ShotRows({ value, onChange }) {
  const [big, setBig] = useState('')
  const [err, setErr] = useState('')
  const pick = useRef({})

  async function take(k, file) {
    if (!file) return
    setErr('')
    try {
      const data = await shrink(file)
      if (data.length > SHOT_CAP * 1.4) { setErr('사진이 너무 큽니다.'); return }
      onChange({ [k]: data })
    } catch (e) { setErr(String(e.message || e)) }
  }

  return (
    <div className="rl-rows">
      <div className="rl-rrow">
        {SHOTS.map((sh) => (
          <span key={sh.k} className="rl-shot">
            {value[sh.k] ? (
              <button type="button" className="rl-shot-img" title="크게 보기"
                onClick={() => setBig(value[sh.k])}>
                <img src={value[sh.k]} alt={sh.l} />
              </button>
            ) : (
              <span className="rl-shot-img is-empty">없음</span>
            )}
            <span className="rl-shot-line">
              <span className="rl-hint">{sh.l}</span>
              <button type="button" className="rl-btn"
                onClick={() => pick.current[sh.k]?.click()}>{value[sh.k] ? '바꾸기' : '추가'}</button>
              {value[sh.k] && (
                <button type="button" className="rl-x" title="지우기"
                  onClick={() => onChange({ [sh.k]: '' })}>×</button>
              )}
            </span>
            <input ref={(el) => { pick.current[sh.k] = el }} type="file" accept="image/*"
              capture="environment" hidden
              onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; take(sh.k, file) }} />
          </span>
        ))}
        {err && <span className="rl-warn">{err}</span>}
      </div>
      {big && (
        <button type="button" className="rl-lightbox" onClick={() => setBig('')} title="닫기">
          <img src={big} alt="" />
        </button>
      )}
    </div>
  )
}

/** A list, open. What My List could do, done to a list that already exists:
 *  where its assets are going, what was done with them, and who may say so.
 *
 *  The assets are rows, because that is what they are everywhere else here —
 *  press one to open it, × to take it out of the list. */
function EditList({ rec, doc, assets, options, me, onSave, isAdmin, say, picked, clearPicked,
  onCancel, onDeleted, onOpenAsset }) {
  const [f, setF] = useState(rec || {})
  useEffect(() => { setF(rec || {}) }, [rec])
  if (!rec) return <p className="rl-msg">그 리스트를 찾을 수 없습니다.</p>
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const ids = f.assetIds || []
  const byId = Object.fromEntries(assets.map((a) => [a.assetId, a]))
  const mine = ids.map((id) => byId[id] || { assetId: id, name: '(목록에 없는 자산)' })
  const canModerate = isAdmin || (!!me && rec.user === me)
  const place = String(f.location || '').trim()

  const put = (next, said) => onSave({
    records: doc.records.map((r) => (r.id === rec.id ? next : r)),
  }, said)

  /** The list's own fields. */
  const save = () => put({ ...f, assetIds: ids }, '저장했습니다.')

  /** What Update / Check-in / Check-out / Extension did: the place on the list
   *  is written onto every asset in it, and the list says it happened. */
  async function apply() {
    if (!place) { say('위치를 먼저 정하세요.'); return }
    if (!ids.length) { say('리스트가 비어 있습니다.'); return }
    const now = new Date().toISOString()
    const seen = new Set(ids)
    await onSave({
      records: doc.records.map((r) => (r.id === rec.id
        ? { ...f, assetIds: ids, appliedAt: now, pending: false } : r)),
      assets: doc.assets.map((a) => (seen.has(a.assetId)
        ? { ...a, location: place, lastUpdate: now, lastInOutDate: now } : a)),
    }, `${ids.length}개를 '${place}'로`)
  }

  /** A non-manager asks instead of doing: the list waits for a manager. */
  const ask = () => put({ ...f, assetIds: ids, type: f.type === 'request' ? f.type : 'request', pending: true },
    '승인을 요청했습니다.')

  /** Admin: the assets in the list, hidden or shown again. */
  async function setHidden(hidden) {
    const seen = new Set(ids)
    await onSave({
      assets: doc.assets.map((a) => (seen.has(a.assetId) ? { ...a, hidden } : a)),
    }, hidden ? `${ids.length}개를 숨겼습니다.` : `${ids.length}개의 숨김을 풀었습니다.`)
  }

  /** Admin: the assets themselves go, and the list with them. */
  async function dropAssets() {
    const seen = new Set(ids)
    if (await onSave({
      assets: doc.assets.filter((a) => !seen.has(a.assetId)),
      records: doc.records.filter((r) => r.id !== rec.id),
    }, `자산 ${ids.length}개와 리스트를 지웠습니다.`)) onDeleted?.()
  }

  /** Just the list: the assets stay where they are. */
  async function dropList() {
    if (await onSave({ records: doc.records.filter((r) => r.id !== rec.id) },
      `'${rec.name}' 리스트를 지웠습니다.`)) onDeleted?.()
  }

  const addPicked = () => {
    const add = [...picked].filter((id) => !ids.includes(id))
    if (!add.length) { say('더 담을 자산이 없습니다.'); return }
    setF((s) => ({ ...s, assetIds: [...ids, ...add] }))
    clearPicked?.()
    say(`${add.length}개 담았습니다 — 저장하면 리스트에 들어갑니다.`)
  }

  return (
    <div className="rl-edit">
      <RackActions key={rec.id}
        onSave={save}
        onCancel={onCancel}
        onRevert={() => setF(rec)}
        onDelete={canModerate ? dropList : null}
        deleteWarn="리스트만 지웁니다. 자산은 그대로입니다."
        extra={(
          <>
            <button type="button" className="rl-btn rl-go" onClick={apply}
              title="리스트의 위치를 자산들에 적용합니다">위치 적용</button>
            {!isAdmin && (
              <button type="button" className="rl-btn" onClick={ask}>승인 요청</button>
            )}
            {isAdmin && rec.pending && (
              <button type="button" className="rl-btn rl-go" onClick={apply}>승인</button>
            )}
          </>
        )}
        hint={rec.pending ? '승인 대기 중' : (rec.appliedAt ? `적용됨 ${String(rec.appliedAt).slice(0, 10)}` : '')}
      />
      <div className="rl-rec">
        <Fld label="이름">
          <input className="rl-in" style={{ width: 280 }} value={f.name || ''} onChange={set('name')} />
        </Fld>
        <Fld label="종류">
          <select className="rl-in" value={f.type || 'save'} onChange={set('type')}>
            {LIST_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span className="rl-hint">반출·반입·연장은 위치를 적용하는 같은 동작입니다.</span>
        </Fld>
        <Fld label="위치">
          <input className="rl-in" style={{ width: 240 }} list="am2-location"
            value={f.location || ''} onChange={set('location')} placeholder="자산들이 갈 곳" />
          <datalist id="am2-location">
            {options.location.map((v) => <option key={v} value={v} />)}
          </datalist>
        </Fld>
        <Fld label="만든이">
          <span className="rl-hint rl-mono">{rec.user || '·'}</span>
          <span className="rl-hint">{String(rec.createdAt || '').slice(0, 16).replace('T', ' ')}</span>
        </Fld>
        <Fld label={`자산 ${ids.length}개`}>
          <div className="rl-rows">
            <div className="rl-rrow">
              <button type="button" className="rl-btn" disabled={!picked?.size}
                onClick={addPicked}>선택한 자산 담기{picked?.size ? ` (${picked.size})` : ''}</button>
              {isAdmin && (
                <>
                  <span className="rl-gap" />
                  <button type="button" className="rl-btn" onClick={() => setHidden(true)}>숨김</button>
                  <button type="button" className="rl-btn" onClick={() => setHidden(false)}>숨김 해제</button>
                  <button type="button" className="rl-btn rl-danger" onClick={dropAssets}>자산째 삭제</button>
                </>
              )}
            </div>
            {mine.length === 0 && <span className="rl-hint">비어 있습니다.</span>}
            {mine.map((a) => (
              <div key={a.assetId} className="rl-rrow">
                <button type="button" className="rl-lnk rl-mono"
                  onClick={() => onOpenAsset?.(a.assetId)}>{a.assetId}</button>
                <span>{a.name || '·'}</span>
                <span className="rl-hint">{a.location || ''}</span>
                <button type="button" className="rl-x" title="리스트에서 빼기"
                  onClick={() => setF((s) => ({ ...s, assetIds: ids.filter((x) => x !== a.assetId) }))}>×</button>
              </div>
            ))}
          </div>
        </Fld>
      </div>
    </div>
  )
}
