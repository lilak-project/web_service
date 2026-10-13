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
import {
  firstAuthor, jShort, refLabel, mainTag, tagsOf, abbrevName, bibOrder, handleFor,
  TOKENS, PRESETS, TYPES,
} from './paper.js'
import { citedBy, papersOf, authorStats, NameWith } from './widgets.jsx'

/** Every paper wearing one of `gone` wears `to` instead — once — and its main
 *  tag follows. A key is filed under the main tag, so one left naming a tag
 *  that has gone would quietly move to whichever tag happens to be first.
 *  `to` empty takes the tag off. */
function foldTag(r, gone, to) {
  const drop = new Set(gone)
  if (!(r.tags || []).some((t) => drop.has(t))) return r
  const next = []
  for (const t of r.tags) {
    const v = drop.has(t) ? to : t
    if (v && !next.includes(v)) next.push(v)
  }
  const main = drop.has(r.mainTag) ? (to || '') : r.mainTag
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
  name: 'reference_manager', title: '레퍼런스', unit: '편', key: 'rm',
  item: {
    key: 'references', noun: '논문', allLabel: 'references', tabId: 'total',
    label: refLabel,
    order: { k: 'citeKey', dir: 1 },
    findHint: '제목 · 저자 · 저널 · 태그   (⌘F)',
    // A half-typed line is not data, and a main tag that is not one of the
    // paper's tags is not its main tag.
    fill: (r) => ({ ...r, mainTag: tagsOf(r).includes(r.mainTag) ? r.mainTag : '' }),
    check: (r) => (String(r.citeKey || '').trim() || String(r.title || '').trim() ? '' : 'cite key나 제목 하나는 있어야 합니다.'),
    // The table reads type · key · who · when · where · what; the form reads
    // the way a citation is written down.
    columns: ['type', 'citeKey', 'a1', 'year', 'jl', 'title', 'tags', 'pdf', 'cites', 'by'],
    fields: [
      { k: 'paste', label: '붙여넣기', type: 'paste', store: false, search: false,
        when: (r, { draft }) => draft },
      { k: 'type', label: '종류', type: 'select', options: TYPES, default: 'paper', required: true, bulk: true,
        col: { w: 56, min: 40, drop: 1180, label: 'type' }, tone: 'dim' },
      { k: 'citeKey', label: 'cite key', type: 'citekey', col: { w: 150, min: 80, label: 'key' } },
      { k: 'title', label: '제목', type: 'longtext', rows: 2, col: { w: 260, min: 120, label: 'title' }, tone: 'ink' },
      { k: 'authors', label: '저자', type: 'authors', of: 'authors' },
      // Worked out from the parts, so they cannot drift from what is stored.
      { k: 'a1', label: 'first author', get: (r, ctx) => firstAuthor(ctx.doc, r),
        col: { w: 134, min: 70 }, tone: 'dim', search: false },
      { k: 'jl', label: 'journal', get: (r, ctx) => jShort(ctx.doc, r), col: { w: 86, min: 40 }, tone: 'dim' },
      { k: 'inst', label: '기관', type: 'class', placeholder: 'RIKEN',
        when: (r) => r.type === 'proposal' },
      { k: 'pac', label: 'PAC', type: 'text', mono: true, width: 90, placeholder: '27',
        when: (r) => r.type === 'proposal',
        hint: 'PAC 뒤에 들어갑니다 — RIKEN은 번호(27), RAON·JYFL은 해(2026).' },
      { k: 'journal', label: '저널', type: 'class', of: 'journals' },
      { k: 'volume', label: '권', type: 'text', width: 80, placeholder: 'volume' },
      { k: 'pages', label: '면', type: 'text', width: 110, placeholder: 'pages' },
      { k: 'year', label: '해', type: 'text', width: 70, placeholder: 'year',
        col: { w: 46, min: 38, num: true, label: 'year' }, sort: (v) => Number(v) || null },
      { k: 'doi', label: 'doi', type: 'text', mono: true, href: (v) => `https://doi.org/${v}` },
      { k: 'url', label: 'url', type: 'url' },
      // Tags are what one most often sets on many papers at once (선택 편집).
      { k: 'tags', label: '태그', type: 'maintags', bulk: true, col: { w: 180, min: 60, drop: 1320, label: 'tags' },
        tone: 'dim', fold: foldTag,
        hint: '태그를 누르면 메인 태그 — cite key의 {tag} 자리입니다.',
        // Merging tags moves a key when it was filed under one of them.
        moved: (users, names, to) => users.filter((r) => mainTag(r) !== to && names.includes(mainTag(r)))
          .map((r) => r.citeKey).filter(Boolean),
        movedWhy: '메인 태그가 바뀌므로 cite key도 다시 만들어야 합니다' },
      { k: 'cites', label: '참고문헌', type: 'cites', search: false,
        col: { w: 44, min: 34, num: true, drop: 860, label: 'cites' }, when: (r, { draft }) => !draft },
      { k: 'by', label: '인용한 논문', type: 'citedby', search: false,
        get: (r, ctx) => (citedBy(ctx.doc).get(r.id) || []).length,
        col: { w: 44, min: 34, num: true, drop: 860, label: 'cited by' }, when: (r, { draft }) => !draft },
      { k: 'pdf', label: 'pdf', type: 'file', roots: 'pdfRoots', find: 'citeKey', search: false,
        col: { w: 38, min: 30, num: true } },
      { k: 'links', label: '링크', type: 'list', link: true, placeholder: 'https://…' },
      { k: 'note', label: '메모', type: 'longtext', rows: 2 },
    ],
  },
  classSort: { k: 'name', dir: 1 },
  classes: [
    { k: 'authors', label: 'authors', keyBy: 'id', countLabel: 'papers',
      rowLabel: (a) => a.tag || a.name,
      fill: (a) => ({ ...a, name: String(a.name || '').trim(), tag: String(a.tag || '').trim() || handleFor(a.name),
        aliases: (a.aliases || []).map((x) => String(x).trim()).filter(Boolean) }),
      check: (a, doc, prev) => ((doc.authors || []).some((x) => x.tag === a.tag && x !== prev) ? '이미 쓰는 handle입니다.' : ''),
      // Saving a person links every row spelled one of their ways; deleting
      // one leaves their name on the papers as text.
      onSave: (a, prev, doc) => linkSpellings(a, doc),
      onDelete: (a, doc) => ({
        references: (doc.references || []).map((r) => ({
          ...r, authors: (r.authors || []).map((x) => (x.ref === a.id ? { ...x, ref: '', name: x.name || a.name } : x)),
        })),
      }),
      deleteWarn: (a, doc) => `이름은 논문 ${papersOf(doc, a.id).length}편에 글자로 남습니다. 되돌릴 수 없습니다.`,
      fields: [
        { k: 'name', label: '줄임이름', type: 'text', required: true, placeholder: 'W. G. Lynch', width: 240,
          hint: '표와 인용에 쓰입니다. 하나는 있어야 합니다.',
          col: { w: 200, min: 80, label: 'name' }, cell: (a) => a.fullName || a.name },
        { k: 'fullName', label: '풀네임', type: 'text',
          edit: (p) => <NameWith {...p} placeholder="William G Lynch"
            buttons={[['줄임이름으로', '풀네임에서 줄임이름을 만듭니다', (r) => ({ name: abbrevName(r.fullName) })]]} /> },
        { k: 'bibName', label: 'BibTeX 표기', type: 'text', hint: '성이 먼저인 형태. BibTeX 출력이 이 표기를 씁니다.',
          edit: (p) => <NameWith {...p} mono placeholder="Lynch, W. G." buttons={[
            ['줄임이름으로', 'BibTeX 표기에서 줄임이름을 만듭니다', (r) => ({ name: abbrevName(r.bibName) })],
            ['← 이름에서', '이름에서 BibTeX 순서를 만듭니다', (r) => ({ bibName: bibOrder(r.fullName || r.name) }),
              (r) => String(r.name || r.fullName || '').trim()],
          ]} /> },
        { k: 'tag', label: 'handle', type: 'text', mono: true, width: 150,
          col: { w: 130, min: 60 }, hint: '비워두면 이름에서 만듭니다. 논문의 저자 칸에 #handle 로 붙입니다.' },
        roleCol('first', '1st'), roleCol('second', '2nd'), roleCol('corr', 'corr.'), roleCol('other', '그 외'),
        { k: 'aliases', label: '다른 표기', type: 'list', placeholder: 'W.G. Lynch',
          hint: '저장하면 이렇게 적힌 줄도 연결됩니다.' },
        { k: 'email', label: 'email', type: 'email' },
        { k: 'orcid', label: 'orcid', type: 'text', mono: true },
        { k: 'note', label: '메모', type: 'longtext', rows: 2 },
        { k: 'papers', label: '논문', type: 'authorpapers', get: () => null, when: (a, { draft }) => !draft },
      ] },
    { k: 'journals', label: 'journals', countLabel: 'papers',
      fill: (j) => ({ ...j, name: String(j.name || '').trim(), shortName: String(j.shortName || j.name || '').trim() }),
      check: (j, doc, prev) => ((doc.journals || []).some((x) => x.name === j.name && x !== prev) ? '같은 이름의 저널이 있습니다.' : ''),
      deleteWarn: () => '논문의 저널 이름은 글자로 남습니다. 되돌릴 수 없습니다.',
      fields: [
        { k: 'name', label: '이름', type: 'text', required: true, placeholder: 'The Astrophysical Journal',
          col: { w: 200, min: 80, label: 'name' } },
        { k: 'shortName', label: '짧은 이름', type: 'text', width: 120, placeholder: 'ApJ', hint: '표의 journal 열에 나옵니다.' },
        { k: 'abbrev', label: '축약 이름', type: 'text', width: 240, placeholder: 'Astrophys. J.', hint: '인용에 쓰입니다.',
          col: { w: 320, min: 90, label: 'full name' } },
        { k: 'publisher', label: '발행처', type: 'text', width: 240 },
        { k: 'issn', label: 'issn', type: 'text', mono: true, width: 140 },
        { k: 'url', label: 'url', type: 'url' },
      ] },
    { k: 'tags', label: 'tags', field: 'tags', countLabel: 'papers' },
  ],
  listing: { tokens: (doc) => TOKENS(doc), presets: PRESETS },
}
