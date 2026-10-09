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

  const cols = useMemo(() => sized(COLS, vw), [sized, vw])

  const scope = useMemo(
    () => [...assets].sort(bySome(SORTERS[sort?.k || 'assetId'], sort?.dir ?? 1)),
    [assets, sort])

  const filter = useFacetFilter(scope, SORTERS, { sel: VIEW.fsel, on: VIEW.fon })
  // Below the filter on purpose: a dependency array is evaluated where it is
  // written, and `filter` does not exist yet further up.
  useEffect(() => { saveView({ active, sort, fsel: filter.sel, fon: filter.on }) },
    [active, sort, filter.sel, filter.on])
  const rows = useMemo(() => {
    const kept = filter.on ? scope.filter(filter.passes) : scope
    const q = query.trim().toLowerCase()
    if (!q) return kept
    return kept.filter((a) => [a.assetId, a.name, a.location, a.type, a.assetClass,
      a.accountHolder, a.spec, a.memo, a.description]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [scope, query, filter.on, filter.passes])
  // An asset is known by its 자산번호 — the document has no other id for one,
  // so that is what a selection holds.
  const keys = useMemo(() => rows.map((a) => ({ id: a.assetId })), [rows])
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
    panes.keep((t) => !t.who || assets.some((a) => a.assetId === t.who))
  }, [doc])

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
                sort={sort || { k: 'assetId', dir: 1 }}
                onSort={(k) => setSort((s) => {
                  // The implicit order counts as the current one, so the first
                  // press on the column already sorted turns it over.
                  const now = s || { k: 'assetId', dir: 1 }
                  return now.k === k ? { k, dir: -now.dir } : { k, dir: 1 }
                })}
                head={filter.mode ? null : { all: allPicked, some: somePicked, onAll: toggleAll }}>
                <FacetRows f={filter} />
                {!filter.mode && rows.map((a, i) => {
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
