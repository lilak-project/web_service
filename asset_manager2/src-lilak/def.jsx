import './strings.js'
import { tr } from 'lilak-ui'
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
  ['save', tr("as_lt_save")], ['update', tr("as_lt_update")], ['checkout', tr("as_lt_checkout")],
  ['checkin', tr("as_lt_checkin")], ['extension', tr("as_lt_extend")], ['request', tr("as_lt_request")], ['hide', tr("as_hide")],
]
const typeLabel = (t) => (LIST_TYPES.find(([k]) => k === t) || [, t || tr("as_lt_save")])[1]
/** The state of a list, said in one line: waiting, applied, or neither. */
const listState = (r) => (r?.pending ? tr("as_pending")
  : (r?.appliedAt ? tr("as_applied_at", String(r.appliedAt).slice(0, 10)) : ''))

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
    if (!place) { say?.(tr("as_set_location_first")); return }
    if (!ids.length) { say?.(tr("as_list_empty")); return }
    const now = new Date().toISOString()
    const seen = new Set(ids)
    await commit({
      records: doc.records.map((r) => (r.id === rec.id ? { ...f, assetIds: ids, appliedAt: now, pending: false } : r)),
      assets: doc.assets.map((a) => (seen.has(a.assetId)
        ? { ...a, location: place, lastUpdate: now, lastInOutDate: now } : a)),
    }, tr("as_moved_to", ids.length, place))
  }
  async function setHidden(hidden) {
    const seen = new Set(ids)
    await commit({ assets: doc.assets.map((a) => (seen.has(a.assetId) ? { ...a, hidden } : a)) },
      hidden ? tr("as_hidden_n", ids.length) : tr("as_unhidden_n", ids.length))
  }
  return (
    <>
      <button type="button" className="rl-btn rl-go" onClick={apply}
        title={tr("as_apply_location_hint")}>{tr("as_apply_location")}</button>
      {/* A non-manager asks instead of doing: the list waits for a manager. */}
      {!isAdmin && (
        <button type="button" className="rl-btn" onClick={() => putList(
          { ...f, assetIds: ids, type: f.type === 'request' ? f.type : 'request', pending: true }, tr("as_approval_requested"))}>{tr("as_request_approval")}</button>
      )}
      {isAdmin && rec.pending && <button type="button" className="rl-btn rl-go" onClick={apply}>{tr("as_approve")}</button>}
      {isAdmin && (
        <>
          <button type="button" className="rl-btn" onClick={() => setHidden(true)}>{tr("as_hide")}</button>
          <button type="button" className="rl-btn" onClick={() => setHidden(false)}>{tr("as_unhide")}</button>
        </>
      )}
      {listState(rec) && <span className="rl-hint">{listState(rec)}</span>}
    </>
  )
}

export default {
  name: 'asset_manager2', title: tr("as_title"), unit: tr("as_unit"), key: 'am2',
  item: {
    key: 'assets', id: 'assetId', noun: tr("as_asset"), allLabel: 'assets', tabId: 'assets',
    label: (a) => a.assetId || a.name || tr("as_asset"),
    order: { k: 'assetId', dir: 1 },
    findHint: tr("as_find_hint"),
    check: (a, doc, prev) => {
      const id = String(a.assetId || '').trim()
      if (!id) return tr("as_need_number")
      return (doc.assets || []).some((x) => x.assetId === id && x !== prev) ? tr("as_number_taken") : ''
    },
    // Every save says when the asset last changed.
    fill: (a) => ({ ...a, assetId: String(a.assetId || '').trim(), lastUpdate: new Date().toISOString() }),
    fields: [
      // The sticker first, then the whole thing — photo2 and photo1, the names
      // the old app wrote and the data still uses.
      { k: 'photo2', label: tr("as_photo_sticker"), type: 'image', group: tr("as_photos"), bulk: false },
      { k: 'photo1', label: tr("as_photo_whole"), type: 'image', group: tr("as_photos"), bulk: false },
      { k: 'assetId', label: tr("as_number"), type: 'text', mono: true, width: 160, required: true,
        col: { w: 118, min: 70 } },
      { k: 'name', label: tr("as_name"), type: 'text', width: 320, col: { w: 250, min: 110 }, tone: 'ink' },
      // A location and a type are words other assets already use, offered as
      // you type — and, being shared, they can be set on many at once.
      { k: 'location', label: tr("as_location"), type: 'class', col: { w: 150, min: 70 }, tone: 'dim' },
      { k: 'type', label: 'Type', type: 'class', col: { w: 120, min: 60, drop: 1180 }, tone: 'dim' },
      { k: 'assetClass', label: tr("as_category"), type: 'text', width: 200, col: { w: 120, min: 60, drop: 1100 }, tone: 'dim' },
      { k: 'accountHolder', label: tr("as_custodian"), type: 'text', width: 200, col: { w: 112, min: 60, drop: 1400 }, tone: 'dim' },
      { k: 'applicationName', label: tr("as_requested_item"), type: 'text', width: 320 },
      { k: 'spec', label: tr("as_spec"), type: 'text', width: 240 },
      { k: 'manufacturerProvider', label: tr("as_maker"), type: 'text', width: 240 },
      { k: 'acquisitionDate', label: tr("as_acquired"), type: 'text', width: 140 },
      { k: 'acquisitionPriceKrw', label: tr("as_price"), type: 'text', width: 140 },
      { k: 'description', label: tr("as_description"), type: 'longtext', rows: 2 },
      { k: 'memo', label: tr("as_memo"), type: 'longtext', rows: 2 },
      { k: 'upd', label: tr("as_last_change"), get: (a) => day(a.lastUpdate), col: { w: 96, min: 70, drop: 900 }, tone: 'dim' },
    ],
  },
  // The lists, newest first.
  classSort: { k: 'at', dir: -1 },
  classes: [
    { k: 'records', label: 'lists', noun: tr("as_list"), countLabel: tr("as_count"),
      list: { ids: 'assetIds', owner: 'user', show: (a) => [a.name, a.location].filter(Boolean).join(' · ') },
      rowLabel: (r) => r.name || tr("as_list"),
      actions: (f, setF, ctx) => <ListActions f={f} setF={setF} ctx={ctx} />,
      deleteWarn: () => tr("as_delete_list_warn"),
      fields: [
        { k: 'name', label: tr("as_list_name"), type: 'text', required: true, width: 280, col: { w: 230, min: 100 }, tone: 'ink' },
        { k: 'type', label: tr("as_list_type"), type: 'select', options: LIST_TYPES, default: 'save',
          col: { w: 96, min: 60 }, tone: 'dim', hint: tr("as_list_type_hint"),
          cell: (r) => typeLabel(r.type) + (r.pending ? tr("as_waiting_suffix") : '') },
        { k: 'location', label: tr("as_location"), type: 'class', placeholder: tr("as_destination"), col: { w: 150, min: 70 }, tone: 'dim' },
        { k: 'user', label: tr("as_made_by"), type: 'text', edit: false, col: { w: 120, min: 60, drop: 1100 }, tone: 'dim',
          cell: (r) => (r.user ? String(r.user).split('@')[0] : D) },
        { k: 'at', label: tr("as_time"), get: (r) => r.createdAt || '', col: { w: 150, min: 90, drop: 900 }, tone: 'dim',
          cell: (r) => String(r.createdAt || '').slice(0, 16).replace('T', ' ') || D },
      ] },
  ],
}
