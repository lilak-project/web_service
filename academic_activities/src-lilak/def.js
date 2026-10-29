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
 *   - 장비 held several names in one cell; it is a list now. 책임자 links to the
 *     people in author_manager (matched by name; one 김민주 of two, the CENS
 *     one). Neither has a tab of its own.
 *   - The Proposals sheet is a class of its own records, which an activity of
 *     kind 제안서 can point at.
 */

import './strings.js'
import { PORTAL_BASE, authHeaders, serviceColor } from 'lilak-ui/racklist'
import { tr } from 'lilak-ui'

// The note service's todos (GFM checkboxes in any note) that have a due day,
// on that day in the calendar. The box ticks the line in its note (the note
// is the only copy); the rest of the bar opens the note beside the records.
const NOTE = '/pp/note/note'
// Its `#태그`s stay in the note; on the calendar the words alone.
const untagged = (s) => s.replace(/(^|[\s(])#[^\s#.,;:!?()[\]{}'"]+/g, '$1').replace(/\s+/g, ' ').trim()
const noteTodos = async () => {
  try {
    const r = await fetch(`${NOTE}/api/todos`, { headers: authHeaders() })
    if (!r.ok) return []
    const [{ todos = [] }, color] = await Promise.all([r.json(), serviceColor('note')])
    return todos.filter((t) => t.due).map((t) => ({
      id: `todo:${t.id}:${t.line}`, feed: tr('aa_todos'), color: color || '#365944',
      title: untagged(t.text), start: t.due, location: t.title, done: t.done,
      toggle: (done) => fetch(`${NOTE}/api/todos`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: t.id, line: t.line, done, text: t.text }),
      }).then((x) => x.ok),
      open: (ctx) => ctx?.openFrame?.({ id: `note:${t.id}`, label: t.title, color, src: `${NOTE}/?solo=${encodeURIComponent(t.id)}` }),
    }))
  } catch { return [] }
}

// 구분, in groups. A group is one colour on the calendar and one set of
// fields its kinds use (lit in the editor; null — all of them). Each kind
// carries the word its file names use. On the calendar the groups fill a week
// from the top in this order (학회, 실험, 제출), and those with `bottom` from
// the bottom up (1 lowest: 기타, 미팅, Talk).
// 참여 형태; each group allows some of them.
const ROLES = ['oral', 'poster', 'contribution', 'corresponding author', 'attend', 'online', 'absence', 'chair',
  'spokesperson', 'co-spokesperson', 'core', 'setup', 'shift', 'software']
const COMMON = ['kind', 'name', 'start', 'startTime', 'end', 'endTime', 'repeat', 'series', 'seriesDate', 'link', 'key', 'folder', 'note', 'comment']
const TALK = ['place', 'online', 'role', 'title', 'talkDate', 'talkTime', 'host', 'tripKind', 'tripStart', 'tripEnd']
const GROUPS = [
  { label: tr('aa_g_academic'), color: '#2f6fde', fields: [...TALK, 'papers', 'submitDate'],
    roles: ['oral', 'poster', 'contribution', 'corresponding author', 'attend', 'online', 'absence', 'chair', 'setup', 'software'],
    kinds: [['학회', 'Academic'], ['워크샵', 'Academic'], ['학술미팅', 'Academic'], ['연구출장', 'BusinessTrip']] },
  // A meeting of an hour or so; one lasting days, with talks, is a 학술미팅.
  { label: tr('aa_g_meeting'), color: '#e6b000', bottom: 2, fields: ['place', 'online', 'role'],
    roles: ['oral', 'attend', 'online', 'absence', 'chair'],
    kinds: [['미팅', 'Meeting']] },
  // A talk you are asked to give, or go to hear.
  { label: 'Talk', color: '#4cb3e6', bottom: 3, fields: [...TALK, 'myTalk'],
    roles: ['oral', 'attend', 'online'],
    kinds: [['세미나', 'Seminar'], ['강연', 'Lecture'], ['교육', 'Education']] },
  { label: tr('aa_g_experiment'), color: '#13a06e', fields: ['place', 'role', 'title', 'equipment', 'leads', 'proposal', 'tripKind', 'tripStart', 'tripEnd', 'submitDate'],
    roles: ['spokesperson', 'co-spokesperson', 'core', 'setup', 'shift', 'software', 'online'],
    kinds: [['실험', 'Experiment']] },
  // What is handed in by a day (제출 날짜) — and, for a proposal, presented
  // at a PAC afterwards, so a talk and a trip.
  { label: tr('aa_g_submission'), color: '#8b3fd9', fields: ['submitDate', 'talkDate', 'talkTime', 'proposal', 'papers', 'place', 'role', 'title', 'tripKind', 'tripStart', 'tripEnd'],
    roles: ['contribution', 'corresponding author', 'spokesperson', 'co-spokesperson', 'oral'],
    kinds: [['보고서', 'Report'], ['제안서', 'Proposal']] },
  // 행사: what came in from the 행사 Google calendar with no kind yet (to be
  // given one); it syncs with that calendar, as everything but 기타 does.
  { label: tr('aa_g_other'), color: '#9aa1ad', paper: true, bottom: 1, fields: null,
    kinds: [['기타', 'Activity'], ['행사', 'Event']] },
]
const ETC_KINDS = GROUPS.find((g) => g.paper).kinds.map(([k]) => k)   // 기타, 행사
const KINDS = GROUPS.flatMap((g) => g.kinds)
/** A kind is STORED in Korean (학회, 미팅 …) — records, file names and the
 *  Google calendars all carry that word — and SHOWN in the active language. */
const kindLabel = (k) => tr(`aa_kind_${PREFIX_KEY[k] || 'other'}`)
/** Taken part in from afar: the 온라인 box, or 참여 형태 online. */
const isOnline = (r) => !!r.online || r.role === 'online'
/** No trip to note: joined online, or not gone (absence). */
const noTrip = (r) => isOnline(r) || r.role === 'absence'
const PREFIX = Object.fromEntries(KINDS)
const PREFIX_KEY = { 학회: 'conference', 워크샵: 'workshop', 학술미팅: 'academic_meeting', 연구출장: 'research_trip',
  미팅: 'meeting', 세미나: 'seminar', 강연: 'lecture', 교육: 'education', 실험: 'experiment',
  보고서: 'report', 제안서: 'proposal', 기타: 'other', 행사: 'event' }
const groupOf = (kind) => GROUPS.find((g) => g.kinds.some(([k]) => k === kind))

/** Academic_20131207_HIM2013 — the kind's word, the start date, the name. */
function nameKey(r) {
  const day = String(r.start || '').replace(/-/g, '')
  // Letters (any script), digits and '-' stay; spaces and every other mark —
  // ( ) , . / & … — become one '_' each run, none at the ends.
  const name = String(r.name || '').trim().replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '')
  return [PREFIX[r.kind] || 'Activity', day, name].filter(Boolean).join('_')
}

const PAPERS = { svc: 'reference_manager', proj: 'papers', item: 'references', label: 'citeKey' }
const PEOPLE = { svc: 'author_manager', proj: 'authors', item: 'authors',
  label: (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
    || `${a.korFamily || ''}${a.korGiven || ''}` || a.nick || '' }

export default {
  name: 'academic_activities', title: 'activity manager', unit: tr("aa_unit"), key: 'aa',
  item: {
    key: 'activities', noun: tr("aa_activity"), allLabel: tr('aa_tab_all'), label: 'name',
    // 기타 제외: the 기타 group (기타, 행사 — everything brought in from Google) out of the list.
    quick: [{ id: 'no-etc', label: tr('aa_quick_no_etc'), title: tr('aa_quick_no_etc_hint'),
      drop: (r) => ETC_KINDS.includes(r.kind || '기타') }],
    order: { k: 'start', dir: -1 },
    // What is on today is lit, and a line marks today, while sorted by 행사 시작.
    now: { start: 'start', end: 'end' },
    columns: ['group', 'kind', 'name', 'start', 'tripKind', 'role', 'title', 'folder', 'link'],
    // The fields the record's 구분 uses, lit while you edit it.
    applies: (r) => {
      const g = groupOf(r.kind)
      return g && { color: g.color, fields: g.fields && [...COMMON, ...g.fields] }
    },
    // A new activity is named by the rule; one already named keeps its name.
    fill: (r) => (r.key ? r : { ...r, key: nameKey(r) }),
    fields: [
      // The 구분's group, for the table (and its sorting and filtering); the editor has 구분.
      { k: 'group', label: tr("aa_group"), type: 'text', col: 68, edit: false, get: (r) => groupOf(r.kind || '기타')?.label || '' },
      { k: 'kind', label: tr("aa_kind"), type: 'select', col: 64, default: '기타', options: GROUPS.map((g) => ({ group: g.label, options: g.kinds.map(([k]) => [k, kindLabel(k)]) })) },
      { k: 'name', label: tr("aa_event_name"), type: 'text', col: 320, required: true },
      // A time beside each day, when it has one (a talk at 14:30).
      { k: 'start', label: tr("aa_event_start"), type: 'date', col: 92, group: tr("aa_event_start") },
      { k: 'startTime', label: tr("aa_start_time"), type: 'time', group: tr("aa_event_start") },
      { k: 'end', label: tr("aa_event_end"), type: 'date', group: tr("aa_event_end") },
      { k: 'endTime', label: tr("aa_end_time"), type: 'time', group: tr("aa_event_end") },
      // Repeating, as Google Calendar repeats (the RRULE, and the days left out).
      // A record that is one changed occurrence of a series says which, instead.
      { k: 'repeat', label: tr("aa_repeat"), type: 'repeat', start: 'start', when: (r) => !r.series },
      { k: 'series', label: tr("aa_series"), type: 'ref', when: (r) => !!r.series, disabled: () => true },
      { k: 'seriesDate', label: tr("aa_series_date"), type: 'date', when: (r) => !!r.series, disabled: () => true },
      // The day it went in: an abstract, a proposal, a report, an application.
      { k: 'submitDate', label: tr("aa_submit_date"), type: 'date', same: ['start', 'end'] },
      { k: 'year', label: 'YEAR', type: 'number',
        get: (r) => (r.start ? Number(String(r.start).slice(0, 4)) : null) },
      { k: 'place', label: tr("aa_place"), type: 'class', of: 'places' },
      // How far the trip went. Stored in Korean, shown in the reader's language.
      { k: 'tripKind', label: tr("aa_trip_kind"), type: 'select', col: 68, disabled: noTrip,
        options: [['근거리', tr("aa_trip_near")], ['국내', tr("aa_trip_domestic")], ['국외', tr("aa_trip_abroad")]] },
      { k: 'online', label: tr("aa_online"), type: 'check', hint: tr("aa_online_hint") },
      // What its group allows (with no group — 기타, none chosen — all of them), a to z.
      { k: 'role', label: tr("aa_role"), type: 'class', col: 92, pick: true,
        options: (r) => [...(groupOf(r.kind)?.roles || ROLES)].sort() },
      // Joined online, or not gone: there was no trip.
      { k: 'tripStart', label: tr("aa_trip_start"), type: 'date', same: 'start', disabled: noTrip },
      { k: 'tripEnd', label: tr("aa_trip_end"), type: 'date', same: 'end', disabled: noTrip },
      // A seminar you gave — not one you went to hear.
      { k: 'myTalk', label: tr("aa_my_talk"), type: 'check', hint: tr("aa_my_talk_hint") },
      { k: 'title', label: tr("aa_talk_title"), type: 'text', col: 300 },
      { k: 'talkDate', label: tr("aa_talk_date"), type: 'date', same: 'start', group: tr("aa_talk_date") },
      { k: 'talkTime', label: tr("aa_talk_time"), type: 'time', group: tr("aa_talk_date") },
      { k: 'host', label: tr("aa_host"), type: 'text' },
      { k: 'equipment', label: tr("aa_equipment"), type: 'classes' },
      // People in author_manager, linked rather than typed: the name shown is
      // theirs, so it is spelled one way. Someone author_manager does not list
      // (a collaborator elsewhere) is kept as a name with nobody behind it.
      { k: 'leads', label: tr("aa_leads"), type: 'refs', to: PEOPLE, names: true },
      { k: 'proposal', label: tr('aa_proposal'), type: 'class', of: 'proposals' },
      { k: 'papers', label: tr("aa_papers"), type: 'refs', to: PAPERS },
      { k: 'link', label: 'Link', type: 'url', short: 'link', col: 44 },
      // Left empty, a new activity (a copy too) is named by the rule when saved; 생성하기 names it so now.
      { k: 'key', label: tr("aa_name"), type: 'text', mono: true, clone: false, make: (r) => (r.name ? nameKey(r) : '') },
      // 자료 is the folder of the same name under settings.folderRoots — the
      // name IS the link, so nothing is stored. A new activity shows the name it will get.
      { k: 'folder', label: tr("aa_folder"), type: 'folder', col: 40, get: (r) => r.key || (r.name ? nameKey(r) : '') },
      // Its note in the note service, "[구분] 행사 이름" — made here, or gone to.
      // A meeting comes back under one name (spirit asia, every week), so its
      // note carries the day too: "[미팅] spirit asia 2026-10-21".
      { k: 'note', label: tr("aa_note"), type: 'note', clone: false,
        title: (r) => (r.name ? `[${r.kind || '기타'}] ${r.name}${r.kind === '미팅' && r.start ? ` ${r.start}` : ''}` : '') },
      { k: 'comment', label: 'Comment', type: 'longtext' },
    ],
  },
  classes: [
    { k: 'places', label: tr("aa_place"), fields: [
      { k: 'name', label: tr("aa_name"), type: 'text', col: 160, required: true },
      { k: 'city', label: tr("aa_city"), type: 'text', col: 120 },
    ] },
    // No tab of its own: a proposal is reached from the activity that points
    // at it (its name in the 제안서 field opens it).
    { k: 'proposals', label: tr('aa_proposal'), tab: false, fields: [
      { k: 'name', label: tr("aa_name"), type: 'text', col: 260, required: true, mono: true },
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
      { k: 'papers', label: tr("aa_papers"), type: 'refs', to: PAPERS },
    ] },
  ],
  // The calendar tab: one bar per activity in its group's colour — the trip
  // light gray, 행사 시작~끝 light, 발표일자 underlined by a band.
  calendar: {
    start: 'start', end: 'end', mark: 'talkDate', submit: 'submitDate',
    repeat: 'repeat', series: 'series', seriesDate: 'seriesDate',
    // A day's records of one group in time order: the start's time, else the talk's.
    time: (r) => r.startTime || r.talkTime,
    // Google calendars shown read-only (구글 캘린더 tab → backend/gcal.py),
    // and the note service's todos that have a due day (noteTodos).
    overlay: () => Promise.all([
      fetch(`${PORTAL_BASE}/api/gcal/overlay`, { headers: authHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      noteTodos(),
    ]).then(([g, t]) => [...(Array.isArray(g) ? g : []), ...t]),
    outline: { start: 'tripStart', end: 'tripEnd' },
    // Registered, not gone: struck through.
    hatch: (r) => r.role === 'absence',
    // Joined online: no trip drawn, and the days but the talk dotted.
    online: isOnline,
    groups: GROUPS.map((g) => ({ label: g.label, color: g.color, paper: g.paper, bottom: g.bottom,
      match: (r) => g.kinds.some(([k]) => k === r.kind) })),
    // 이름 (시간) @ 위치 - 참여형태: the talk's time, else the start's; what
    // is missing is left out.
    label: (r, text) => {
      const time = r.talkTime || r.startTime
      const place = String(text('place') || '').trim(), role = String(text('role') || '').trim()
      return `${r.name || ''}${time ? ` (${time})` : ''}${place ? ` @ ${place}` : ''}${role ? ` - ${role}` : ''}`
    },
  },
  listing: { presets: [
    // Tokens by field KEY, so a rule reads the same in every language.
    ['CV', '{start}  {name} — {title} ({role})', '⏎'],
    [tr('aa_preset_talks'), '{title}, {name}, {place} ({YEAR})', '⏎'],
    [tr('aa_preset_trips'), '{tripStart}~{tripEnd}  {name}  {place}', '⏎'],
  ] },
}
