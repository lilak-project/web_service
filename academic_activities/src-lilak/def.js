/**
 * 학술 활동 — the declaration. Every column of the spreadsheet is here, said
 * once; the table, the editor, the tabs and the listing come out of it.
 *
 * From "Academic Activities.xlsx" (1. Academic activities, 2. Proposals):
 *   - YEAR and the unlabelled first column were formulas on 행사일정1 → YEAR is
 *     COMPUTED here (`get`), never stored, and the first column is not kept.
 *   - 이름 (Academic_20131207_HIM2013) is a naming rule — `fill` writes it for a
 *     new activity, and one typed by hand is kept as it is.
 *   - 위치 and 도시 went together, so a place is a record with its city.
 *   - 장비 and 책임자 held several names in one cell; they are lists now, and
 *     each has a tab of the names in use.
 *   - The Proposals sheet is a class of its own records, which an activity of
 *     kind 제안서 can point at.
 */

// The spreadsheet's 구분, and the word its file names use for each.
const KINDS = [
  ['학회', 'Academic'], ['워크샵', 'Academic'], ['미팅', 'Academic'],
  ['세미나', 'Seminar'], ['강연', 'Lecture'], ['학교', 'School'],
  ['실험', 'Experiment'], ['연구 출장', 'BusinessTrip'],
  ['보고서', 'Report'], ['제안서', 'Proposal'],
]
const PREFIX = Object.fromEntries(KINDS)

/** Academic_20131207_HIM2013 — the kind's word, the start date, the name. */
function nameKey(r) {
  const day = String(r.start || '').replace(/-/g, '')
  const name = String(r.name || '').trim().replace(/\s+/g, '_')
  return [PREFIX[r.kind] || 'Activity', day, name].filter(Boolean).join('_')
}

const PAPERS = { svc: 'reference_manager', proj: 'papers', item: 'references', label: 'citeKey' }

export default {
  name: 'academic_activities', title: '학술 활동', unit: '건', key: 'aa',
  item: {
    key: 'activities', noun: '활동', allLabel: 'activities', label: 'name',
    order: { k: 'start', dir: -1 },
    // A new activity is named by the rule; one already named keeps its name.
    fill: (r) => (r.key ? r : { ...r, key: nameKey(r) }),
    fields: [
      { k: 'kind', label: '구분', type: 'select', col: 64, options: KINDS.map(([k]) => k) },
      { k: 'name', label: '행사 이름', type: 'text', col: 210, required: true },
      { k: 'start', label: '행사 시작', type: 'date', col: 92 },
      { k: 'end', label: '행사 끝', type: 'date' },
      { k: 'year', label: 'YEAR', type: 'number', col: 50,
        get: (r) => (r.start ? Number(String(r.start).slice(0, 4)) : null) },
      { k: 'place', label: '위치', type: 'class', of: 'places', col: 104 },
      { k: 'online', label: '온라인', type: 'check', col: { w: 44, drop: 1280 }, hint: 'zoom 등으로 참석' },
      { k: 'role', label: '참여 형태', type: 'class', col: 92 },
      { k: 'title', label: '발표 제목', type: 'text', col: 250 },
      { k: 'talkDate', label: '발표일자', type: 'date' },
      { k: 'host', label: '주최 이름', type: 'text' },
      { k: 'equipment', label: '장비', type: 'classes', col: { w: 110, drop: 1360 } },
      { k: 'leads', label: '책임자', type: 'classes', col: { w: 120, drop: 1440 } },
      { k: 'tripStart', label: '출장 시작', type: 'date' },
      { k: 'tripEnd', label: '출장 끝', type: 'date' },
      { k: 'trip', label: '출장', type: 'number', col: { w: 40, drop: 1200 }, hint: '시트의 출장? 값 그대로 (0 · 1 · 2)' },
      { k: 'material', label: '자료', type: 'check', col: { w: 40, drop: 1200 }, hint: '자료가 있음' },
      { k: 'proposal', label: '제안서', type: 'class', of: 'proposals' },
      { k: 'papers', label: '논문', type: 'refs', to: PAPERS, col: { w: 130, drop: 1520 } },
      { k: 'link', label: 'Link', type: 'url' },
      { k: 'key', label: '이름', type: 'text', mono: true, hint: '비워두면 규칙대로 붙습니다 (구분_날짜_행사이름)' },
      { k: 'comment', label: 'Comment', type: 'longtext' },
    ],
  },
  classes: [
    { k: 'places', label: '위치', fields: [
      { k: 'name', label: '이름', type: 'text', col: 160, required: true },
      { k: 'city', label: '도시', type: 'text', col: 120 },
    ] },
    { k: 'equipment', label: '장비', field: 'equipment' },
    { k: 'leads', label: '책임자', field: 'leads' },
    { k: 'proposals', label: '제안서', fields: [
      { k: 'name', label: '이름', type: 'text', col: 260, required: true, mono: true },
      { k: 'reaction', label: 'reaction', type: 'text', col: 110 },
      { k: 'facility', label: 'facility', type: 'text', col: 70 },
      { k: 'detector', label: 'detector', type: 'text', col: 70 },
      { k: 'author', label: 'author', type: 'text', col: 110 },
      { k: 'collaboration', label: 'collaboration', type: 'text' },
      { k: 'observable', label: 'observable', type: 'text' },
      { k: 'submitted', label: 'submission', type: 'date', col: 92 },
      { k: 'accepted', label: 'accepted', type: 'date', col: 92 },
      { k: 'grade', label: 'grade', type: 'text', col: 44 },
      { k: 'title', label: 'title', type: 'longtext' },
      { k: 'papers', label: '논문', type: 'refs', to: PAPERS },
    ] },
  ],
  listing: { presets: [
    ['CV', '{start}  {name} — {발표 제목} ({참여 형태})', '⏎'],
    ['발표 목록', '{발표 제목}, {name}, {위치} ({YEAR})', '⏎'],
    ['출장 목록', '{tripStart}~{tripEnd}  {name}  {위치}', '⏎'],
  ] },
}
