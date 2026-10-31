/**
 * reference manager — the declaration. The table, the tabs, the editors, the
 * listing and the settings are the kit's <RackService>; what is here is what
 * makes it about PAPERS. The parts that are about papers rather than lists
 * live in paper.js, and the widgets no other list needs in widgets.jsx.
 *
 * The document is unchanged from before the move: references (with authors as
 * rows, cites as rows, pdf as a path), journals and authors as records,
 * settings.pdfRoots. The tab and column keys are the old ones, so a stored
 * view and dragged widths carry over.
 */
import './strings.js'
import {
  firstAuthor, jShort, refLabel, mainTag, tagsOf, abbrevName, bibOrder, handleFor,
  TOKENS, PRESETS, TYPES,
} from './paper.js'
import { citedBy, papersOf, authorStats, NameWith } from './widgets.jsx'
import { tr } from 'lilak-ui'
import { tagKey } from 'lilak-ui/racklist'

/** Every paper wearing one of `gone` wears `to` instead — once — and its main
 *  tag follows. A key is filed under the main tag, so one left naming a tag
 *  that has gone would quietly move to whichever tag happens to be first.
 *  `to` empty takes the tag off. */
function foldTag(r, gone, to) {
  // A tag is the same tag in any case: every spelling of one goes.
  const drop = { has: (t) => gone.some((g) => tagKey(g) === tagKey(t)) }
  if (!(r.tags || []).some((t) => drop.has(t))) return r
  const next = []
  for (const t of r.tags) {
    const v = drop.has(t) ? to : t
    if (v && !next.includes(v)) next.push(v)
  }
  const main = r.mainTag && drop.has(r.mainTag) ? (to || '') : r.mainTag
  return { ...r, tags: next, ...(main === r.mainTag ? {} : { mainTag: main }) }
}

/** An author's every spelling links the rows that use it: the other names are
 *  spellings too, not decoration. */
function linkSpellings(a, doc) {
  const spellings = [a.name, a.fullName, a.bibName, ...(a.aliases || [])]
    .map((x) => String(x || '').trim()).filter(Boolean)
  const link = (rows) => (rows || []).map((x) => (!x.ref && spellings.includes(x.name) ? { ...x, ref: a.id } : x))
  return { references: (doc.references || []).map((r) => ({ ...r, authors: link(r.authors) })) }
}

// Where an author stands, counted once per document for all 1,971 of them.
const roleCol = (k, label) => ({
  k, label, type: 'rolecount', role: k, col: { w: 58, min: 40, num: true },
  get: (a, ctx) => authorStats(ctx.doc).get(a.id)?.[k] || 0,
})

export default {
  name: 'reference_manager', title: tr("rm_title"), unit: tr("rm_unit"), key: 'rm',
  item: {
    key: 'references', noun: tr("rm_paper"), allLabel: 'references', tabId: 'total',
    label: refLabel,
    order: { k: 'citeKey', dir: 1 },
    findHint: tr("rm_find_hint"),
    // A half-typed line is not data, and a main tag that is not one of the
    // paper's tags is not its main tag.
    fill: (r) => ({ ...r, mainTag: tagsOf(r).includes(r.mainTag) ? r.mainTag : '' }),
    check: (r) => (String(r.citeKey || '').trim() || String(r.title || '').trim() ? '' : tr("rm_need_key_or_title")),
    // The table reads type · key · who · when · where · what; the form reads
    // the way a citation is written down.
    columns: ['type', 'citeKey', 'a1', 'year', 'jl', 'title', 'tags', 'pdf', 'cites', 'by'],
    fields: [
      { k: 'paste', label: tr("rm_paste"), type: 'paste', store: false, search: false,
        when: (r, { draft }) => draft },
      { k: 'type', label: tr("rm_type"), type: 'select', options: TYPES, default: 'paper', required: true, bulk: true,
        col: { w: 56, min: 40, drop: 1180, label: 'type' }, tone: 'dim' },
      { k: 'citeKey', label: 'cite key', type: 'citekey', col: { w: 150, min: 80, label: 'key' } },
      { k: 'title', label: tr("rm_title_field"), type: 'longtext', rows: 2, col: { w: 260, min: 120, label: 'title' }, tone: 'ink' },
      { k: 'authors', label: tr("rm_authors"), type: 'authors', of: 'authors' },
      // Worked out from the parts, so they cannot drift from what is stored.
      { k: 'a1', label: 'first author', get: (r, ctx) => firstAuthor(ctx.doc, r),
        col: { w: 134, min: 70 }, tone: 'dim', search: false },
      { k: 'jl', label: 'journal', get: (r, ctx) => jShort(ctx.doc, r), col: { w: 86, min: 40 }, tone: 'dim' },
      { k: 'inst', label: tr("rm_institution"), type: 'class', placeholder: 'RIKEN',
        when: (r) => r.type === 'proposal' },
      { k: 'pac', label: 'PAC', type: 'text', mono: true, width: 90, placeholder: '27',
        when: (r) => r.type === 'proposal',
        hint: tr("rm_pac_hint") },
      { k: 'journal', label: tr("rm_journal"), type: 'class', of: 'journals' },
      { k: 'volume', label: tr("rm_volume"), type: 'text', width: 80, placeholder: 'volume' },
      { k: 'pages', label: tr("rm_pages"), type: 'text', width: 110, placeholder: 'pages' },
      { k: 'year', label: tr("rm_year"), type: 'text', width: 70, placeholder: 'year',
        col: { w: 46, min: 38, num: true, label: 'year' }, sort: (v) => Number(v) || null },
      { k: 'doi', label: 'doi', type: 'text', mono: true, href: (v) => `https://doi.org/${v}` },
      { k: 'url', label: 'url', type: 'url' },
      // Tags are what one most often sets on many papers at once (선택 편집).
      { k: 'tags', label: tr("rm_tags"), type: 'maintags', bulk: true, col: { w: 180, min: 60, drop: 1320, label: 'tags' },
        tone: 'dim', fold: foldTag,
        hint: tr("rm_tags_hint"),
        // Merging tags moves a key when it was filed under one of them.
        moved: (users, names, to) => users.filter((r) => mainTag(r) !== to && names.includes(mainTag(r)))
          .map((r) => r.citeKey).filter(Boolean),
        movedWhy: tr("rm_main_tag_moves") },
      { k: 'cites', label: tr("rm_cites"), type: 'cites', search: false,
        col: { w: 44, min: 34, num: true, drop: 860, label: 'cites' }, when: (r, { draft }) => !draft },
      { k: 'by', label: tr("rm_cited_by"), type: 'citedby', search: false,
        get: (r, ctx) => (citedBy(ctx.doc).get(r.id) || []).length,
        col: { w: 44, min: 34, num: true, drop: 860, label: 'cited by' }, when: (r, { draft }) => !draft },
      { k: 'pdf', label: 'pdf', type: 'file', roots: 'pdfRoots', find: 'citeKey', search: false,
        col: { w: 38, min: 30, num: true } },
      { k: 'links', label: tr("rm_links"), type: 'list', link: true, placeholder: 'https://…' },
      { k: 'note', label: tr("rm_note"), type: 'longtext', rows: 2 },
      // Where a paper was presented: the activities (in Activities) that list
      // it. Theirs is the only copy of the link; each opens there.
      { k: 'talks', label: tr("rm_talks"), type: 'backlinks', search: false,
        from: { svc: 'academic_activities', proj: 'activities', item: 'activities', field: 'papers', label: 'name' } },
    ],
  },
  classSort: { k: 'name', dir: 1 },
  classes: [
    { k: 'authors', label: 'authors', keyBy: 'id', countLabel: 'papers',
      rowLabel: (a) => a.tag || a.name,
      fill: (a) => ({ ...a, name: String(a.name || '').trim(), tag: String(a.tag || '').trim() || handleFor(a.name),
        aliases: (a.aliases || []).map((x) => String(x).trim()).filter(Boolean) }),
      check: (a, doc, prev) => ((doc.authors || []).some((x) => x.tag === a.tag && x !== prev) ? tr("rm_handle_taken") : ''),
      // Saving a person links every row spelled one of their ways; deleting
      // one leaves their name on the papers as text.
      onSave: (a, prev, doc) => linkSpellings(a, doc),
      onDelete: (a, doc) => ({
        references: (doc.references || []).map((r) => ({
          ...r, authors: (r.authors || []).map((x) => (x.ref === a.id ? { ...x, ref: '', name: x.name || a.name } : x)),
        })),
      }),
      deleteWarn: (a, doc) => tr("rm_author_delete_warn", papersOf(doc, a.id).length),
      fields: [
        { k: 'name', label: tr("rm_short_name"), type: 'text', required: true, placeholder: 'W. G. Lynch', width: 240,
          hint: tr("rm_short_name_hint"),
          col: { w: 200, min: 80, label: 'name' }, cell: (a) => a.fullName || a.name },
        { k: 'fullName', label: tr("rm_full_name"), type: 'text',
          edit: (p) => <NameWith {...p} placeholder="William G Lynch"
            buttons={[[tr("rm_to_short_name"), tr("rm_short_from_full"), (r) => ({ name: abbrevName(r.fullName) })]]} /> },
        { k: 'bibName', label: tr("rm_bib_name"), type: 'text', hint: tr("rm_bib_name_hint"),
          edit: (p) => <NameWith {...p} mono placeholder="Lynch, W. G." buttons={[
            [tr("rm_to_short_name"), tr("rm_short_from_bib"), (r) => ({ name: abbrevName(r.bibName) })],
            [tr("rm_from_name"), tr("rm_bib_from_name"), (r) => ({ bibName: bibOrder(r.fullName || r.name) }),
              (r) => String(r.name || r.fullName || '').trim()],
          ]} /> },
        { k: 'tag', label: 'handle', type: 'text', mono: true, width: 150,
          col: { w: 130, min: 60 }, hint: tr("rm_handle_hint") },
        roleCol('first', '1st'), roleCol('second', '2nd'), roleCol('corr', 'corr.'), roleCol('other', tr("rm_role_other")),
        { k: 'aliases', label: tr("rm_aliases"), type: 'list', placeholder: 'W.G. Lynch',
          hint: tr("rm_aliases_hint") },
        { k: 'email', label: 'email', type: 'email' },
        { k: 'orcid', label: 'orcid', type: 'text', mono: true },
        { k: 'note', label: tr("rm_note"), type: 'longtext', rows: 2 },
        { k: 'papers', label: tr("rm_paper"), type: 'authorpapers', get: () => null, when: (a, { draft }) => !draft },
      ] },
    { k: 'journals', label: 'journals', countLabel: 'papers',
      fill: (j) => ({ ...j, name: String(j.name || '').trim(), shortName: String(j.shortName || j.name || '').trim() }),
      check: (j, doc, prev) => ((doc.journals || []).some((x) => x.name === j.name && x !== prev) ? tr("rm_journal_taken") : ''),
      deleteWarn: () => tr("rm_journal_delete_warn"),
      fields: [
        { k: 'name', label: tr("rm_name"), type: 'text', required: true, placeholder: 'The Astrophysical Journal',
          col: { w: 200, min: 80, label: 'name' } },
        { k: 'shortName', label: tr("rm_journal_short"), type: 'text', width: 120, placeholder: 'ApJ', hint: tr("rm_journal_short_hint") },
        { k: 'abbrev', label: tr("rm_journal_abbrev"), type: 'text', width: 240, placeholder: 'Astrophys. J.', hint: tr("rm_used_in_citations"),
          col: { w: 320, min: 90, label: 'full name' } },
        { k: 'publisher', label: tr("rm_publisher"), type: 'text', width: 240 },
        { k: 'issn', label: 'issn', type: 'text', mono: true, width: 140 },
        { k: 'url', label: 'url', type: 'url' },
      ] },
    { k: 'tags', label: 'tags', field: 'tags', countLabel: 'papers' },
  ],
  listing: { tokens: (doc) => TOKENS(doc), presets: PRESETS },
}
