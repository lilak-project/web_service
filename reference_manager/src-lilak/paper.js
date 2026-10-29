import './strings.js'
import { tr } from 'lilak-ui'
import { FAV } from 'lilak-ui/racklist'
/**
 * What makes a reference a REFERENCE — the parts of reference_manager that are
 * about papers rather than about lists: how a name is spelled three ways, the
 * cite key rule, where an author stands on a paper, what a publisher's BibTeX
 * or RIS says, and the listing's citation tokens.
 *
 * Moved here unchanged from the old App.jsx when the service became a
 * declaration (def.js); the screen around it is the kit's <RackService>.
 */
// ─── The fields a row shows ─────────────────────────────────────────────────
// A paper is spelled in ONE place: the short reference, the first author and
// the journal's abbreviation are worked out from the parts, so they cannot
// drift from what is stored. (The spreadsheet kept all three in columns of
// their own, and they did.)
// A paper's authors are ROWS, in order, each of which may point at an author
// record. BibTeX writes them as one string because a .bib field is one string;
// that string is these names joined, and is never stored — otherwise 'which
// papers is W. G. Lynch on' has two answers that can disagree.
export const AUTHOR_SPLIT = /\s+and\s+/i
export const splitAuthors = (text) => String(text || '')
  .split(AUTHOR_SPLIT).map((x) => x.trim().replace(/,$/, '')).filter(Boolean)
export const authorRows = (r) => (r.authors || []).filter((a) => a && (a.name || a.ref))
/** A registered author is spelled by their record, so fixing a name fixes it
 *  on every paper at once — and by the fullest spelling it has, because
 *  'Jung Woo Lee' tells you who it is and 'J. W. Lee' makes you work it out.
 *  The short one is still what a citation uses; see {abv author}. */
export const autRec = (doc, a) => (a?.ref ? (doc?.authors || []).find((x) => x.id === a.ref) : null)
export const autName = (doc, a) => {
  const rec = autRec(doc, a)
  return (rec && (rec.fullName || rec.name)) || a?.name || ''
}
/** The citation spelling, whatever the row shows. */
export const autShort = (doc, a) => {
  const rec = autRec(doc, a)
  return (rec && (rec.name || rec.fullName)) || a?.name || ''
}
export const authorList = (doc, r) => authorRows(r).map((a) => autName(doc, a)).filter(Boolean)
export const authorString = (doc, r) => authorList(doc, r).join(' and ')
export const firstAuthor = (doc, r) => authorList(doc, r)[0] || ''
export const etAl = (doc, r) => {
  const list = authorList(doc, r)
  return list.length > 1 ? `${list[0]} et al.` : (list[0] || '')
}
/** Where an author stands on a paper. Not exclusive: a first author can be the
 *  corresponding one, and both lists should say so. */
export const autRoles = (r, id) => {
  const i = authorRows(r).findIndex((a) => a.ref === id)
  if (i < 0) return []
  const out = []
  if (i === 0) out.push('first')
  if (i === 1) out.push('second')
  if (authorRows(r)[i].corr) out.push('corr')
  if (i >= 2 && !authorRows(r)[i].corr) out.push('other')
  return out
}
export const inRole = (r, id, role) => (role === 'all'
  ? authorRows(r).some((a) => a.ref === id) : autRoles(r, id).includes(role))
// An author carries three spellings of the same person, because a paper needs
// different ones in different places:
//   name      what a citation prints — W. G. Lynch
//   fullName  spelled out — William G Lynch
//   bibName   BibTeX's own order — Lynch, W. G.
// Only `name` is required; the other two are filled when they are known, and
// either can produce `name` mechanically.
/** given words and the family word, reading BibTeX's comma the right way. */
export const nameParts = (name) => {
  const t = String(name || '').trim()
  if (t.includes(',')) {
    const [family, given] = [t.slice(0, t.indexOf(',')).trim(), t.slice(t.indexOf(',') + 1).trim()]
    return [given.replace(/[.]/g, ' ').split(/\s+/).filter(Boolean), family]
  }
  const w = t.replace(/[.]/g, ' ').split(/\s+/).filter(Boolean)
  return [w.slice(0, -1), w[w.length - 1] || '']
}
/** The citation form. A hyphenated given name keeps both initials — Ying-Xun →
 *  Y.-X. — which is how it is cited and the only thing that tells it from
 *  Y. Zhang. */
export const abbrevName = (name) => {
  const [given, family] = nameParts(name)
  const ini = given.map((w) => w.split('-').filter((b) => /[A-Za-z]/.test(b))
    .map((b) => `${b.replace(/[^A-Za-z]/g, '')[0].toUpperCase()}.`).join('-'))
  return [...ini, family].filter(Boolean).join(' ')
}
/** BibTeX's order, out of a name written the usual way. */
export const bibOrder = (name) => {
  const [given, family] = nameParts(name)
  if (!family) return String(name || '')
  return given.length ? `${family}, ${given.map((w) => (w.length <= 2 ? `${w}.` : w)).join(' ')}` : family
}
/** A handle for an author: initials and the family name, the way the
 *  spreadsheet's a1 column was written (J. Almeid → JAlmeid). */
/** Accents are for reading; a handle and a file name are for typing.
 *  Łukasik → Lukasik, Schießl → Schiessl, Pârlog → Parlog. */
export const LETTER = { 'ß': 'ss', 'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D',
  'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'þ': 'th', 'ð': 'd', '\u2019': "'" }
export const deburr = (s) => String(s || '').replace(/[^\u0000-\u007f]/g, (c) => LETTER[c] || c)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
export const handleFor = (name) => {
  const [given, family] = nameParts(deburr(name))
  return `${given.map((w) => w.replace(/[^A-Za-z]/g, '')[0] || '').join('')}${family}`
    .replace(/[^\w-]/g, '') || 'author'
}
/** A journal is referenced by its record's id (a name typed before it had a
 *  record stays text); the table shows the short one. */
export const journalRec = (doc, r) => (r.journal && (doc?.journals || []).find((j) => j.id === r.journal || j.name === r.journal)) || null
/** Where it went: the journal for a paper, the institution for a proposal. */
export const jShort = (doc, r) => journalRec(doc, r)?.shortName || journalRec(doc, r)?.name || r.journal || r.inst || ''
// A journal carries three names: what it is called, the short one a table can
// hold (ApJ) and the one a citation uses (Astrophys. J.).
export const jAbbrev = (doc, r) => journalRec(doc, r)?.abbrev || journalRec(doc, r)?.name || r.journal || ''
export const shortRefName = (doc, r) => {
  const rows = authorRows(r)
  const one = autShort(doc, rows[0] || {})
  return rows.length > 1 ? `${one} et al.` : one
}
export const shortRef = (doc, r) => [
  shortRefName(doc, r), [jAbbrev(doc, r), r.volume, r.pages].filter(Boolean).join(' '),
].filter(Boolean).join(', ') + (r.year ? ` (${r.year})` : '')

// A paper points at ONE journal and carries any number of tags. A topic set
// (tpc, 12c) and a collaboration (SpiRIT, LIGO_Virgo) were classes of their own
// at first, but nothing distinguished them from a tag: same many-to-many, no
// fields of their own, nothing to edit. They are tags.
export const tagsOf = (r) => (r.tags || []).filter(Boolean)
export const inTag = (r, t) => tagsOf(r).includes(t)

/** Papers this one lists, and papers that list it — one is stored, the other
 *  is counted, because storing both is two places to disagree. */
export const citesOf = (r) => (r.cites || []).filter((c) => c && (c.ref || c.raw))
export const linkedCites = (r) => citesOf(r).filter((c) => c.ref)

/** How a paper is named when it is not the row you are reading: its cite key,
 *  or the start of its title when it has none. */
export const refLabel = (r) => (r?.citeKey || '').trim() || (r?.title || '').slice(0, 32) || tr("rm_paper")

// ─── The cite key ───────────────────────────────────────────────────────────
// The key is also a file name — the PDFs on disk are named after it — so every
// part of it is squeezed to what a file name can hold. Punctuation becomes an
// underscore rather than vanishing, which is how the spreadsheet already spelled
// a reaction: 12C(p,p)12C → 12C_p_p_12C, X-ray burst → X-ray_burst.
export const slug = (v) => deburr(v).replace(/[^A-Za-z0-9-]+/g, '_').replace(/_+/g, '_')
  .replace(/^_|_$/g, '')
/** The tag this paper is filed under. One of its own, chosen; the first one
 *  when nobody has chosen. */
// Never the favorite tag (the kit's ★): a key filed under it would move each
// time a paper is starred.
export const mainTag = (r) => (tagsOf(r).includes(r.mainTag) ? r.mainTag : tagsOf(r).find((t) => t !== FAV) || '')
/** Every paper wearing one of `from` wears `to` instead — once, and its main
 *  tag follows. A key is filed under the main tag, so one left naming a tag
 *  that has gone would quietly move to whichever tag happens to be first. */
export const foldTags = (doc, from, to) => {
  const drop = new Set(from)
  return (doc.references || []).map((r) => {
    if (!(r.tags || []).some((t) => drop.has(t))) return r
    const next = []
    for (const t of r.tags) {
      const v = drop.has(t) ? to : t
      if (!next.includes(v)) next.push(v)
    }
    const main = drop.has(r.mainTag) ? to : r.mainTag
    return { ...r, tags: next, ...(main === r.mainTag ? {} : { mainTag: main }) }
  })
}
// A key says what the thing IS, and a proposal is not a paper: it goes to an
// institution's committee, not to a journal. RIKEN numbers its PACs (PAC27),
// RAON and JYFL use the year — so what follows PAC is a field, not a guess.
export const KEY_RULES = {
  paper: '{a1}_{jl}_{year}_{tag}',
  // The year earns its place only when the PAC number is not already it.
  proposal: '{inst}_PAC{pac}_{year unless pac}_{a1}_{tag}',
}
export const ruleFor = (r, settings) => (settings?.keyRules || {})[r?.type]
  || KEY_RULES[r?.type] || KEY_RULES.paper
/** The key a record would be given. Parts nobody filled in leave no gap. */
export const citeKeyFor = (doc, r, rule = ruleFor(r, doc?.settings)) => rule
  .replace(/\{([^{}]+)\}/g, (m, k) => {
    const v = {
      // From the CITATION spelling, not the full name: a key is a citation,
      // and 'Amanda I. Karakas' must not quietly turn AKarakas into AIKarakas.
      a1: handleFor(autShort(doc, authorRows(r)[0] || {})),
      jl: jShort(doc, r),
      year: r.year,
      // RIKEN counts PACs and RAON uses the year: say the year once, not twice.
      'year unless pac': String(r.pac || '') === String(r.year || '') ? '' : r.year,
      tag: mainTag(r),
      inst: r.inst,
      pac: r.pac,
    }[k.trim()]
    return v === undefined ? m : slug(v)
  })
  .replace(/_+/g, '_').replace(/^_|_$/g, '')

// ─── The listing rule ───────────────────────────────────────────────────────
// A preset fills in a TEMPLATE and the template makes the text, so a shape
// nobody thought of is an edit rather than a feature request. The tokens are
// the column names plus the parts a citation needs.
// BibTeX composes without help: the outer braces are literal and only the
// inner {token} is a token — `author = {{author}}` → `author = {J. Almeid …}`.
export const TOKENS = (doc) => ({
  'cite key': (r) => r.citeKey || '',
  type: (r) => r.type || '',
  title: (r) => r.title || '',
  author: (r) => authorString(doc, r),
  // What a .bib file wants: Family, Given — the record's own bibName when it
  // has one, and that order worked out from the name when it does not.
  'author (bib)': (r) => authorRows(r).map((a) => {
    const rec = a.ref ? (doc?.authors || []).find((x) => x.id === a.ref) : null
    return rec?.bibName || bibOrder(autName(doc, a))
  }).filter(Boolean).join(' and '),
  'first author': (r) => firstAuthor(doc, r),
  'abv author': (r) => autShort(doc, authorRows(r)[0] || {}),
  'et al.': (r) => etAl(doc, r),
  jl: (r) => jShort(doc, r),
  journal: (r) => jAbbrev(doc, r),
  volume: (r) => r.volume || '',
  pages: (r) => r.pages || '',
  year: (r) => r.year || '',
  doi: (r) => r.doi || '',
  url: (r) => r.url || '',
  'short ref': (r) => shortRef(doc, r),
  inst: (r) => r.inst || '',
  pac: (r) => r.pac || '',
  'year unless pac': (r) => (String(r.pac || '') === String(r.year || '') ? '' : (r.year || '')),
  tags: (r) => tagsOf(r).join(' '),
})
export const PRESETS = [
  ['short ref.', '{short ref}', ',⏎'],
  ['cite keys', '{cite key}', ', '],
  ['\\bibitem', '\\bibitem{{cite key}} {author}, {journal} {volume} {pages} ({year}).', '⏎'],
  ['BibTeX', '@article{{cite key},\n  author = {{author (bib)}},\n  title = {{title}},'
    + '\n  journal = {{journal}},\n  year = {{year}},\n  volume = {{volume}},'
    + '\n  pages = {{pages}},\n  doi = {{doi}},\n  url = {{url}},\n}', '⏎⏎'],
]

export const ROLE_LABEL = { all: '', first: tr("rm_role_first"), second: tr("rm_role_second"), corr: 'corr.', other: tr("rm_role_other") }

// ─── Pasting a citation ─────────────────────────────────────────────────────
/** What a publisher's site hands you is a BibTeX entry or a RIS block, so
 *  typing the fields again is work a parser can do. Anything it cannot read is
 *  left for the fields you already filled — a partial read beats a refusal. */
export function parseCitation(text) {
  const t = String(text || '').trim()
  if (!t) return null
  return /^TY\s{2}-|\nTY\s{2}-/.test(t) ? parseRis(t) : parseBib(t)
}
/** The value of one BibTeX field, brace-balanced: a title with {$^{12}$C} in it
 *  ends at ITS closing brace, not at the first one. */
export function bibField(src, key) {
  const m = new RegExp(`[,{]\\s*${key}\\s*=\\s*`, 'i').exec(src)
  if (!m) return ''
  let i = m.index + m[0].length
  const open = src[i]
  if (open === '{' || open === '"') {
    const close = open === '{' ? '}' : '"'
    let depth = 0, out = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{' || (c === '"' && open === '"' && depth === 0)) { depth++; if (depth === 1) continue }
      if (c === close) { depth--; if (depth === 0) break }
      out += c
    }
    return out.replace(/\s+/g, ' ').trim()
  }
  return (src.slice(i).match(/^[^,}\n]+/) || [''])[0].trim()
}
export function parseBib(src) {
  const head = /@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(src)
  const got = {
    type: head && /thesis/i.test(head[1]) ? 'thesis' : 'paper',
    citeKey: head ? head[2] : '',
    title: bibField(src, 'title'),
    author: bibField(src, 'author'),
    journal: bibField(src, 'journal') || bibField(src, 'journaltitle') || bibField(src, 'booktitle'),
    volume: bibField(src, 'volume'),
    pages: bibField(src, 'pages'),
    year: bibField(src, 'year') || (bibField(src, 'date').match(/\d{4}/) || [''])[0],
    doi: bibField(src, 'doi'),
    url: bibField(src, 'url'),
  }
  const eprint = bibField(src, 'eprint')
  if (eprint && !got.journal) { got.journal = 'arXiv'; got.volume = got.volume || eprint }
  return got
}
export const RIS = { TI: 'title', T1: 'title', JO: 'journal', JF: 'journal', T2: 'journal',
  VL: 'volume', PY: 'year', Y1: 'year', DO: 'doi', UR: 'url', SP: 'pages', EP: 'end' }
export function parseRis(src) {
  const got = { type: 'paper', citeKey: '', author: '', title: '', journal: '',
    volume: '', pages: '', year: '', doi: '', url: '' }
  const authors = []
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{2}-\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const [, tag, val] = m
    if (tag === 'AU' || tag === 'A1') { if (val) authors.push(val) }
    else if (RIS[tag] && val) {
      if (RIS[tag] === 'year') got.year = (val.match(/\d{4}/) || [val])[0]
      else if (RIS[tag] === 'end') got.pages = got.pages ? `${got.pages}-${val}` : val
      else if (!got[RIS[tag]]) got[RIS[tag]] = val
    } else if (tag === 'TY' && /THES/i.test(val)) got.type = 'thesis'
  }
  got.author = authors.join(' and ')
  return got
}

export const TYPES = ['paper', 'proposal', 'thesis', 'report', 'writing']
