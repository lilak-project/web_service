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
import './strings.js'
import {
  korName, engName, anyName, citeLast, citeShort, currentAffs, affilText, repEmail,
  coreOf, coreIn, spanOf, byPaperOrder, foldClass, GROUP_TYPES,
} from './people.js'
import { ListOut } from './widgets.jsx'
import { tr } from 'lilak-ui'

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
  check: (r, doc, prev) => ((doc[list] || []).some((x) => x.name === r.name && x !== prev) ? tr("am_name_taken") : ''),
  // Deleting the record without taking it off the authors would leave them
  // pointing at a record that is not there.
  onDelete: (r, doc) => ({
    authors: (doc.authors || []).map((a) => ((a[key.rows] || []).some((x) => x[key.by] === r.id)
      ? { ...a, [key.rows]: a[key.rows].filter((x) => x[key.by] !== r.id) } : a)),
  }),
  deleteWarn: (r, doc) => {
    const n = (doc.authors || []).filter((a) => (a[key.rows] || []).some((x) => x[key.by] === r.id)).length
    return tr("am_cannot_undo", n ? tr("am_leaves_authors", n) : tr("am_no_author_uses"))
  },
  // Names people point at drift the way tags do, so they merge the same way.
  merge: (doc, gone, to) => foldClass(doc, what, gone, to),
})

export default {
  name: 'author_manager', title: tr("am_author"), unit: tr("am_unit"), key: 'am',
  item: {
    key: 'authors', noun: tr("am_author_noun"), allLabel: 'authors', tabId: 'total',
    label: anyName,
    findHint: tr("am_find_hint"),
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
    check: (a) => ((a.nick || '').trim() || korName(a) || engName(a) ? '' : tr("am_need_a_name")),
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
      { k: 'korFamily', label: tr("am_family_name"), type: 'text', group: tr("am_korean_name"), width: 90 },
      { k: 'korGiven', label: tr("am_given_name"), type: 'text', group: tr("am_korean_name"), width: 120 },
      { k: 'engFirst', label: 'first', type: 'text', group: 'English', width: 130 },
      { k: 'engMiddle', label: 'middle', type: 'text', group: 'English', width: 110 },
      { k: 'engLast', label: 'last', type: 'text', group: 'English', width: 140 },
      { k: 'nick', label: tr("am_nick"), type: 'text', width: 200 },
      { k: 'abvName', label: tr("am_abv_name"), type: 'text', width: 160, placeholder: 'J. W. Lee',
        hint: tr("am_abv_hint") },
      { k: 'emails', label: 'email', type: 'emails' },
      { k: 'affiliations', label: tr("am_aff_history"), type: 'affs', of: 'affiliations' },
      { k: 'groups', label: tr("am_group_member"), type: 'grps', of: 'groups' },
      { k: 'phone', label: tr("am_phone"), type: 'text', width: 190 },
      { k: 'links', label: tr("am_links"), type: 'list', link: true, placeholder: 'https://…' },
      { k: 'attachments', label: tr("am_attachments"), type: 'files' },
      // The activities (in Activities) this person leads. Theirs is the only
      // copy of the link; each opens there.
      { k: 'leads', label: tr("am_leads"), type: 'backlinks', search: false,
        from: { svc: 'academic_activities', proj: 'activities', item: 'activities', field: 'leads', label: 'name' } },

      // The table.
      { k: 'affil', label: 'affiliation', get: (a, ctx) => affilText(a, ctx.doc), col: { w: 96, min: 40 }, tone: 'dim' },
      { k: 'kor', label: tr("am_kor_name_col"), get: korName, col: { w: 86, min: 50 } },
      { k: 'name', label: 'name', get: (a) => engName(a) || a.nick || '', col: { w: 196, min: 90 }, tone: 'ink' },
      { k: 'nm', label: 'abv-name', get: citeShort, col: { w: 112, min: 60, drop: 1040 }, tone: 'dim' },
      { k: 'last', label: 'last name', get: citeLast, col: { w: 92, min: 50, drop: 1100 }, tone: 'dim' },
      { k: 'email', label: 'email', get: repEmail, col: { w: 214, min: 90 } },
      { k: 'pos', label: 'position', get: (a) => currentAffs(a).map((x) => x.position).filter(Boolean).join(', '),
        col: { w: 176, min: 70, drop: 860 }, tone: 'dim' },
      // When the record was made, and when it last changed: the only two things
      // here the document knows and nobody typed.
      { k: 'reg', label: tr("am_created"), get: (a) => (a.createdAt || '').slice(0, 10), col: { w: 84, min: 62, drop: 1180 }, tone: 'dim' },
      { k: 'upd', label: tr("am_updated"), get: (a) => (a.updatedAt || '').slice(0, 10), col: { w: 84, min: 62, drop: 1320 }, tone: 'dim' },
      // core belongs to ONE group, so it is a column only inside a group's tab.
      { k: 'core', label: 'core', type: 'number', get: (a, ctx) => coreHere(a, ctx.tab),
        col: { w: 44, min: 34, num: true, when: (tab) => !!groupOf(tab) } },
    ],
  },
  classSort: { k: 'name', dir: 1 },
  classes: [
    { k: 'groups', label: 'groups', noun: tr("am_group"), ...classHooks('groups', { rows: 'groups', by: 'group' }, 'group'),
      fields: [
        { k: 'name', label: tr("am_name"), type: 'text', required: true, width: 220, col: { w: 200, min: 80, label: 'name' },
          hint: tr("am_rename_keeps_links") },
        // The list shows the word (experiment); the form says what each means.
        { k: 'type', label: 'type', type: 'select', options: GROUP_TYPES, col: { w: 110, min: 70 }, tone: 'dim',
          cell: (r) => r.type || '·', hint: tr("am_group_type_hint") },
        { k: 'when', label: tr("am_period"), get: (r) => spanOf(r.creationDate, r.endDate), col: { w: 160, min: 70 }, tone: 'dim' },
        { k: 'fullName', label: 'full name', type: 'text', width: 360, col: { w: 280, min: 90 },
          hint: tr("am_full_name_hint") },
        { k: 'description', label: tr("am_description"), type: 'text', width: 360, placeholder: 'description' },
        { k: 'creationDate', label: tr("am_start"), type: 'text', mono: true, width: 120, placeholder: '2026-11-16', group: tr("am_period") },
        { k: 'endDate', label: tr("am_end"), type: 'text', mono: true, width: 120, placeholder: '2026-11-18', group: tr("am_period"),
          hint: tr("am_end_hint") },
        { k: 'links', label: tr("am_links"), type: 'list', link: true, placeholder: 'https://…' },
        // A group is an author list; its tags (shared with every service) say
        // which project it belongs to.
        { k: 'tags', label: tr('rk_tags'), type: 'tags', col: { w: 160, min: 60, label: 'tags' } },
      ] },
    { k: 'affiliations', label: 'affiliation', noun: tr("am_affiliation"), ...classHooks('affiliations', { rows: 'affiliations', by: 'tag' }, 'affiliation'),
      fields: [
        { k: 'name', label: tr("am_name"), type: 'text', required: true, width: 220, col: { w: 200, min: 80, label: 'name' },
          hint: tr("am_rename_keeps_links") },
        { k: 'fullName', label: 'full name', type: 'text', width: 360, col: { w: 280, min: 90 },
          hint: tr("am_full_name_hint") },
        { k: 'address', label: tr("am_address"), type: 'text', width: 360, placeholder: 'address', group: tr("am_address_phone") },
        { k: 'phone', label: tr("am_phone"), type: 'text', width: 150, placeholder: 'phone', group: tr("am_address_phone") },
        { k: 'links', label: tr("am_links"), type: 'list', link: true, placeholder: 'https://…' },
      ] },
  ],
  // The 나열 is this service's own: besides the templates, the abstract and
  // LaTeX author blocks number the affiliations, which a per-name rule cannot.
  // It prints the rows in the order the table shows them.
  listing: { render: (p) => <ListOut {...p} /> },
}
