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
 *   - 장비 held several names in one cell; it is a list now, with a tab of the
 *     names in use. 책임자 links to the people in author_manager (matched by
 *     name; one 김민주 of two, the CENS one), and its tab lists them.
 *   - The Proposals sheet is a class of its own records, which an activity of
 *     kind 제안서 can point at.
 */

// The spreadsheet's 구분, and the word its file names use for each.
const KINDS = [
  ['학회', 'Academic'], ['워크샵', 'Academic'], ['미팅', 'Academic'],
  ['세미나', 'Seminar'], ['강연', 'Lecture'], ['학교', 'School'],
  ['실험', 'Experiment'], ['연구 출장', 'BusinessTrip'],
  ['보고서', 'Report'], ['제안서', 'Proposal'], ['PAC', 'PAC'],
]
const PREFIX = Object.fromEntries(KINDS)

/** Academic_20131207_HIM2013 — the kind's word, the start date, the name. */
function nameKey(r) {
  const day = String(r.start || '').replace(/-/g, '')
  const name = String(r.name || '').trim().replace(/\s+/g, '_')
  return [PREFIX[r.kind] || 'Activity', day, name].filter(Boolean).join('_')
}

const PAPERS = { svc: 'reference_manager', proj: 'papers', item: 'references', label: 'citeKey' }
const PEOPLE = { svc: 'author_manager', proj: 'authors', item: 'authors',
  label: (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
    || `${a.korFamily || ''}${a.korGiven || ''}` || a.nick || '' }

export default {
  name: 'academic_activities', title: 'A', unit: '건', key: 'aa',
  item: {
    key: 'activities', noun: '활동', allLabel: 'activities', label: 'name',
    order: { k: 'start', dir: -1 },
    // What is on today is lit, and a line marks today, while sorted by 행사 시작.
    now: { start: 'start', end: 'end' },
    columns: ['kind', 'name', 'start', 'role', 'title', 'folder', 'link'],
    // A new activity is named by the rule; one already named keeps its name.
    fill: (r) => (r.key ? r : { ...r, key: nameKey(r) }),
    fields: [
      { k: 'kind', label: '구분', type: 'select', col: 64, options: KINDS.map(([k]) => k) },
      { k: 'name', label: '행사 이름', type: 'text', col: 320, required: true },
      { k: 'start', label: '행사 시작', type: 'date', col: 92 },
      { k: 'end', label: '행사 끝', type: 'date' },
      { k: 'year', label: 'YEAR', type: 'number',
        get: (r) => (r.start ? Number(String(r.start).slice(0, 4)) : null) },
      { k: 'place', label: '위치', type: 'class', of: 'places' },
      { k: 'online', label: '온라인', type: 'check', hint: 'zoom 등으로 참석' },
      { k: 'role', label: '참여 형태', type: 'class', col: 92 },
      { k: 'title', label: '발표 제목', type: 'text', col: 460 },
      { k: 'talkDate', label: '발표일자', type: 'date', same: 'start' },
      { k: 'host', label: '주최 이름', type: 'text' },
      { k: 'equipment', label: '장비', type: 'classes' },
      // People in author_manager, linked rather than typed: the name shown is
      // theirs, so it is spelled one way. Someone author_manager does not list
      // (a collaborator elsewhere) is kept as a name with nobody behind it.
      { k: 'leads', label: '책임자', type: 'refs', to: PEOPLE, names: true },
      { k: 'tripStart', label: '출장 시작', type: 'date', same: 'start' },
      { k: 'tripEnd', label: '출장 끝', type: 'date', same: 'end' },
      { k: 'proposal', label: '제안서', type: 'class', of: 'proposals' },
      { k: 'papers', label: '논문', type: 'refs', to: PAPERS },
      { k: 'link', label: 'Link', type: 'url', short: 'link', col: 44 },
      { k: 'key', label: '이름', type: 'text', mono: true, hint: '비워두면 규칙대로 붙습니다 (구분_날짜_행사이름)' },
      // 자료 is the folder of the same name under settings.folderRoots — the
      // name IS the link, so nothing is stored. A new activity shows the name it will get.
      { k: 'folder', label: '자료', type: 'folder', col: 40, get: (r) => r.key || (r.name ? nameKey(r) : '') },
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
    // No tab of its own: a proposal is reached from the activity that points
    // at it (its name in the 제안서 field opens it).
    { k: 'proposals', label: '제안서', tab: false, fields: [
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
