/**
 * asset manager — the declaration. The table, the tabs, the editors, the
 * selection and the lists are the kit's <RackService>; what is here is what
 * makes it about ASSETS: the fields, the photos, and what a list does to the
 * assets in it.
 *
 * The document is unchanged from before the move: assets known by their
 * 자산번호 (assetId — they carry no other id), and lists as `records` holding
 * assetIds. The tab and column keys are the old ones where they can be, so a
 * stored view and dragged widths carry over.
 */
const D = '·'
const day = (v) => String(v || '').slice(0, 10)

// What a list was made for. 반출 · 반입 · 연장 are the same act: the place on
// the list is written onto every asset in it.
const LIST_TYPES = [
  ['save', '목록'], ['update', '위치 변경'], ['checkout', '반출'],
  ['checkin', '반입'], ['extension', '연장'], ['request', '요청'], ['hide', '숨김'],
]
const typeLabel = (t) => (LIST_TYPES.find(([k]) => k === t) || [, t || '목록'])[1]
/** The state of a list, said in one line: waiting, applied, or neither. */
const listState = (r) => (r?.pending ? '승인 대기 중'
  : (r?.appliedAt ? `적용됨 ${String(r.appliedAt).slice(0, 10)}` : ''))

/** What a list can DO, beside being saved: the place written onto its assets,
 *  a manager's approval asked for, its assets hidden or shown. Nothing here
 *  deletes an asset — a list points at assets, it does not own them. */
function ListActions({ f, setF, ctx }) {
  const { doc, commit, isAdmin, say, rec } = ctx
  if (!rec) return null
  const ids = f.assetIds || []
  const place = String(f.location || '').trim()
  const putList = (next, said) => commit({ records: doc.records.map((r) => (r.id === rec.id ? next : r)) }, said)
  async function apply() {
    if (!place) { say?.('위치를 먼저 정하세요.'); return }
    if (!ids.length) { say?.('리스트가 비어 있습니다.'); return }
    const now = new Date().toISOString()
    const seen = new Set(ids)
    await commit({
      records: doc.records.map((r) => (r.id === rec.id ? { ...f, assetIds: ids, appliedAt: now, pending: false } : r)),
      assets: doc.assets.map((a) => (seen.has(a.assetId)
        ? { ...a, location: place, lastUpdate: now, lastInOutDate: now } : a)),
    }, `${ids.length}개를 '${place}'로`)
  }
  async function setHidden(hidden) {
    const seen = new Set(ids)
    await commit({ assets: doc.assets.map((a) => (seen.has(a.assetId) ? { ...a, hidden } : a)) },
      hidden ? `${ids.length}개를 숨겼습니다.` : `${ids.length}개의 숨김을 풀었습니다.`)
  }
  return (
    <>
      <button type="button" className="rl-btn rl-go" onClick={apply}
        title="리스트의 위치를 자산들에 적용합니다">위치 적용</button>
      {/* A non-manager asks instead of doing: the list waits for a manager. */}
      {!isAdmin && (
        <button type="button" className="rl-btn" onClick={() => putList(
          { ...f, assetIds: ids, type: f.type === 'request' ? f.type : 'request', pending: true }, '승인을 요청했습니다.')}>
          승인 요청
        </button>
      )}
      {isAdmin && rec.pending && <button type="button" className="rl-btn rl-go" onClick={apply}>승인</button>}
      {isAdmin && (
        <>
          <button type="button" className="rl-btn" onClick={() => setHidden(true)}>숨김</button>
          <button type="button" className="rl-btn" onClick={() => setHidden(false)}>숨김 해제</button>
        </>
      )}
      {listState(rec) && <span className="rl-hint">{listState(rec)}</span>}
    </>
  )
}

export default {
  name: 'asset_manager2', title: '자산', unit: '개', key: 'am2',
  item: {
    key: 'assets', id: 'assetId', noun: '자산', allLabel: 'assets', tabId: 'assets',
    label: (a) => a.assetId || a.name || '자산',
    order: { k: 'assetId', dir: 1 },
    findHint: '자산번호 · 이름 · 위치 · 메모   (⌘F)',
    check: (a, doc, prev) => {
      const id = String(a.assetId || '').trim()
      if (!id) return '자산번호가 있어야 합니다.'
      return (doc.assets || []).some((x) => x.assetId === id && x !== prev) ? '같은 번호가 있습니다.' : ''
    },
    // Every save says when the asset last changed.
    fill: (a) => ({ ...a, assetId: String(a.assetId || '').trim(), lastUpdate: new Date().toISOString() }),
    fields: [
      // The sticker first, then the whole thing — photo2 and photo1, the names
      // the old app wrote and the data still uses.
      { k: 'photo2', label: '자산 스티커', type: 'image', group: '사진', bulk: false },
      { k: 'photo1', label: '자산 전체', type: 'image', group: '사진', bulk: false },
      { k: 'assetId', label: '자산번호', type: 'text', mono: true, width: 160, required: true,
        col: { w: 118, min: 70 } },
      { k: 'name', label: '자산명', type: 'text', width: 320, col: { w: 250, min: 110 }, tone: 'ink' },
      // A location and a type are words other assets already use, offered as
      // you type — and, being shared, they can be set on many at once.
      { k: 'location', label: '위치', type: 'class', col: { w: 150, min: 70 }, tone: 'dim' },
      { k: 'type', label: 'Type', type: 'class', col: { w: 120, min: 60, drop: 1180 }, tone: 'dim' },
      { k: 'assetClass', label: '자산분류', type: 'text', width: 200, col: { w: 120, min: 60, drop: 1100 }, tone: 'dim' },
      { k: 'accountHolder', label: '관리책임자', type: 'text', width: 200, col: { w: 112, min: 60, drop: 1400 }, tone: 'dim' },
      { k: 'applicationName', label: '신청품목명', type: 'text', width: 320 },
      { k: 'spec', label: '규격', type: 'text', width: 240 },
      { k: 'manufacturerProvider', label: '제조사', type: 'text', width: 240 },
      { k: 'acquisitionDate', label: '취득일', type: 'text', width: 140 },
      { k: 'acquisitionPriceKrw', label: '취득가', type: 'text', width: 140 },
      { k: 'description', label: '설명', type: 'longtext', rows: 2 },
      { k: 'memo', label: '메모', type: 'longtext', rows: 2 },
      { k: 'upd', label: '최근변경', get: (a) => day(a.lastUpdate), col: { w: 96, min: 70, drop: 900 }, tone: 'dim' },
    ],
  },
  // The lists, newest first.
  classSort: { k: 'at', dir: -1 },
  classes: [
    { k: 'records', label: 'lists', noun: '리스트', countLabel: '개수',
      list: { ids: 'assetIds', owner: 'user', show: (a) => [a.name, a.location].filter(Boolean).join(' · ') },
      rowLabel: (r) => r.name || '리스트',
      actions: (f, setF, ctx) => <ListActions f={f} setF={setF} ctx={ctx} />,
      deleteWarn: () => '리스트만 지웁니다. 자산은 그대로입니다.',
      fields: [
        { k: 'name', label: '이름', type: 'text', required: true, width: 280, col: { w: 230, min: 100 }, tone: 'ink' },
        { k: 'type', label: '종류', type: 'select', options: LIST_TYPES, default: 'save',
          col: { w: 96, min: 60 }, tone: 'dim', hint: '반출·반입·연장은 위치를 적용하는 같은 동작입니다.',
          cell: (r) => typeLabel(r.type) + (r.pending ? ' · 대기' : '') },
        { k: 'location', label: '위치', type: 'class', placeholder: '자산들이 갈 곳', col: { w: 150, min: 70 }, tone: 'dim' },
        { k: 'user', label: '만든이', type: 'text', edit: false, col: { w: 120, min: 60, drop: 1100 }, tone: 'dim',
          cell: (r) => (r.user ? String(r.user).split('@')[0] : D) },
        { k: 'at', label: '시각', get: (r) => r.createdAt || '', col: { w: 150, min: 90, drop: 900 }, tone: 'dim',
          cell: (r) => String(r.createdAt || '').slice(0, 16).replace('T', ' ') || D },
      ] },
  ],
}
