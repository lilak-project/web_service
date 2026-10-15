/**
 * author manager — the declaration. The table, the tabs, the editors and the
 * selection are the kit's <RackService>; what is here is what makes it about
 * PEOPLE. The parts about people rather than lists live in people.js, and the
 * widgets no other list needs in widgets.jsx.
 *
 * The document is unchanged from before the move: authors (names in parts,
 * emails + repEmail, affiliation and group entries), affiliations and groups as
 * records pointed at by id (the entry's `tag` / `group` holds it). The tab and column keys are the old ones, so a
 * stored view and dragged widths carry over.
 */
import {
  korName, engName, anyName, citeLast, citeShort, currentAffs, affilText, repEmail,
  coreOf, coreIn, spanOf, byPaperOrder, foldClass, GROUP_TYPES,
} from './people.js'
import { ListOut } from './widgets.jsx'

// On a group's tab, that group's core is the one that counts — it is the only
// core that means anything there.
const groupOf = (tab) => (tab?.of === 'groups' ? tab.key : '')
const coreHere = (a, tab) => (groupOf(tab) ? coreIn(a, groupOf(tab)) : coreOf(a))

/** A class pointed at by id from an entry in each author: renaming it is one
 *  record; deleting it has to travel to the entries. */
const classHooks = (list, key, what) => ({
  countLabel: 'people',
  fill: (r) => ({ ...r, name: String(r.name || '').trim(), shortName: String(r.name || '').trim(),
    links: (r.links || []).map((x) => String(x).trim()).filter(Boolean) }),
  check: (r, doc, prev) => ((doc[list] || []).some((x) => x.name === r.name && x !== prev) ? '같은 이름이 이미 있습니다.' : ''),
  // Deleting the record without taking it off the authors would leave them
  // pointing at a record that is not there.
  onDelete: (r, doc) => ({
    authors: (doc.authors || []).map((a) => ((a[key.rows] || []).some((x) => x[key.by] === r.id)
      ? { ...a, [key.rows]: a[key.rows].filter((x) => x[key.by] !== r.id) } : a)),
  }),
  deleteWarn: (r, doc) => {
    const n = (doc.authors || []).filter((a) => (a[key.rows] || []).some((x) => x[key.by] === r.id)).length
    return `${n ? `저자 ${n}명의 목록에서도 빠집니다.` : '쓰는 저자가 없습니다.'} 되돌릴 수 없습니다.`
  },
  // Names people point at drift the way tags do, so they merge the same way.
  merge: (doc, gone, to) => foldClass(doc, what, gone, to),
})

export default {
  name: 'author_manager', title: '저자', unit: '명', key: 'am',
  item: {
    key: 'authors', noun: '저자', allLabel: 'authors', tabId: 'total',
    label: anyName,
    findHint: '이름 · 이메일 · 소속 · 그룹   (⌘F · ⌘⏎ 전체선택)',
    // No column pressed: the order an author list is written in — core first,
    // then family name — and that order is also what every column sort falls
    // back on. On a group's tab, that group's core.
    order: { k: 'core', dir: 1 },
    tie: (tab) => byPaperOrder((a) => coreHere(a, tab)),
    tabbed: true,
    // The name with its spaces taken out is searched too: a transliterated name
    // is written 히로시 와타나베 and typed 히로시와타나베 as often as not.
    // (The names of their affiliations and groups are searched by the kit,
    // through the records the entries point at.)
    search: (a, q) => [korName(a), korName(a).replace(/\s+/g, ''), engName(a), a.nick, repEmail(a),
      ...(a.affiliations || []).flatMap((x) => [x.position, x.dept])]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
    check: (a) => ((a.nick || '').trim() || korName(a) || engName(a) ? '' : '별명이나 이름 하나는 있어야 합니다.'),
    // A record cannot have a 대표 that is not one of its addresses, and one with
    // addresses and no 대표 shows nothing in the list — so the first one takes it.
    fill: (a) => {
      const emails = a.emails || []
      const rep = emails.includes(String(a.repEmail || '').trim()) ? String(a.repEmail).trim() : (emails[0] || '')
      return { ...a, repEmail: rep, links: (a.links || []).map((x) => String(x).trim()).filter(Boolean) }
    },
    columns: ['affil', 'kor', 'name', 'nm', 'last', 'email', 'pos', 'reg', 'upd', 'core'],
    fields: [
      // A name is spelled in ONE place: the table's columns are worked out from
      // these parts rather than stored, so they cannot drift.
      { k: 'korFamily', label: '성', type: 'text', group: '한글 이름', width: 90 },
      { k: 'korGiven', label: '이름', type: 'text', group: '한글 이름', width: 120 },
      { k: 'engFirst', label: 'first', type: 'text', group: 'English', width: 130 },
      { k: 'engMiddle', label: 'middle', type: 'text', group: 'English', width: 110 },
      { k: 'engLast', label: 'last', type: 'text', group: 'English', width: 140 },
      { k: 'nick', label: '별명', type: 'text', width: 200 },
      { k: 'abvName', label: '줄임 이름', type: 'text', width: 160, placeholder: 'J. W. Lee',
        hint: '비우면 영문 이름에서 만듭니다.' },
      { k: 'emails', label: 'email', type: 'emails' },
      { k: 'affiliations', label: '소속 이력', type: 'affs', of: 'affiliations' },
      { k: 'groups', label: '그룹 소속', type: 'grps', of: 'groups' },
      { k: 'phone', label: '전화', type: 'text', width: 190 },
      { k: 'links', label: '링크', type: 'list', link: true, placeholder: 'https://…' },
      { k: 'attachments', label: '첨부파일', type: 'files' },
      // The activities (in Activities) this person leads. Theirs is the only
      // copy of the link; each opens there.
      { k: 'leads', label: '책임 활동', type: 'backlinks', search: false,
        from: { svc: 'academic_activities', proj: 'activities', item: 'activities', field: 'leads', label: 'name' } },

      // The table.
      { k: 'affil', label: 'affiliation', get: (a, ctx) => affilText(a, ctx.doc), col: { w: 96, min: 40 }, tone: 'dim' },
      { k: 'kor', label: '이름', get: korName, col: { w: 86, min: 50 } },
      { k: 'name', label: 'name', get: (a) => engName(a) || a.nick || '', col: { w: 196, min: 90 }, tone: 'ink' },
      { k: 'nm', label: 'abv-name', get: citeShort, col: { w: 112, min: 60, drop: 1040 }, tone: 'dim' },
      { k: 'last', label: 'last name', get: citeLast, col: { w: 92, min: 50, drop: 1100 }, tone: 'dim' },
      { k: 'email', label: 'email', get: repEmail, col: { w: 214, min: 90 } },
      { k: 'pos', label: 'position', get: (a) => currentAffs(a).map((x) => x.position).filter(Boolean).join(', '),
        col: { w: 176, min: 70, drop: 860 }, tone: 'dim' },
      // When the record was made, and when it last changed: the only two things
      // here the document knows and nobody typed.
      { k: 'reg', label: '등록일', get: (a) => (a.createdAt || '').slice(0, 10), col: { w: 84, min: 62, drop: 1180 }, tone: 'dim' },
      { k: 'upd', label: '수정일', get: (a) => (a.updatedAt || '').slice(0, 10), col: { w: 84, min: 62, drop: 1320 }, tone: 'dim' },
      // core belongs to ONE group, so it is a column only inside a group's tab.
      { k: 'core', label: 'core', type: 'number', get: (a, ctx) => coreHere(a, ctx.tab),
        col: { w: 44, min: 34, num: true, when: (tab) => !!groupOf(tab) } },
    ],
  },
  classSort: { k: 'name', dir: 1 },
  classes: [
    { k: 'groups', label: 'groups', noun: '그룹', ...classHooks('groups', { rows: 'groups', by: 'group' }, 'group'),
      fields: [
        { k: 'name', label: '이름', type: 'text', required: true, width: 220, col: { w: 200, min: 80, label: 'name' },
          hint: '고쳐도 저자들은 그대로 이 기록을 가리킵니다.' },
        // The list shows the word (experiment); the form says what each means.
        { k: 'type', label: 'type', type: 'select', options: GROUP_TYPES, col: { w: 110, min: 70 }, tone: 'dim',
          cell: (r) => r.type || '·', hint: '무엇으로 모인 사람들인지' },
        { k: 'when', label: '기간', get: (r) => spanOf(r.creationDate, r.endDate), col: { w: 160, min: 70 }, tone: 'dim' },
        { k: 'fullName', label: 'full name', type: 'text', width: 360, col: { w: 280, min: 90 },
          hint: 'paper authors의 소속 줄에 이 이름이 나갑니다.' },
        { k: 'description', label: '설명', type: 'text', width: 360, placeholder: 'description' },
        { k: 'creationDate', label: '시작', type: 'text', mono: true, width: 120, placeholder: '2026-11-16', group: '기간' },
        { k: 'endDate', label: '끝', type: 'text', mono: true, width: 120, placeholder: '2026-11-18', group: '기간',
          hint: '없어도 됩니다. 목록은 시작일로 정렬합니다.' },
        { k: 'links', label: '링크', type: 'list', link: true, placeholder: 'https://…' },
      ] },
    { k: 'affiliations', label: 'affiliation', noun: '소속', ...classHooks('affiliations', { rows: 'affiliations', by: 'tag' }, 'affiliation'),
      fields: [
        { k: 'name', label: '이름', type: 'text', required: true, width: 220, col: { w: 200, min: 80, label: 'name' },
          hint: '고쳐도 저자들은 그대로 이 기록을 가리킵니다.' },
        { k: 'fullName', label: 'full name', type: 'text', width: 360, col: { w: 280, min: 90 },
          hint: 'paper authors의 소속 줄에 이 이름이 나갑니다.' },
        { k: 'address', label: '주소', type: 'text', width: 360, placeholder: 'address', group: '주소 · 전화' },
        { k: 'phone', label: '전화', type: 'text', width: 150, placeholder: 'phone', group: '주소 · 전화' },
        { k: 'links', label: '링크', type: 'list', link: true, placeholder: 'https://…' },
      ] },
  ],
  // The 나열 is this service's own: besides the templates, the abstract and
  // LaTeX author blocks number the affiliations, which a per-name rule cannot.
  // It prints the rows in the order the table shows them.
  listing: { render: (p) => <ListOut {...p} /> },
}
