/**
 * What makes an author an AUTHOR — the parts of author_manager that are about
 * people rather than lists: a name in three scripts, where someone is now, the
 * order an author list is written in, and folding two groups into one.
 *
 * Moved here unchanged from the old App.jsx when the service became a
 * declaration (def.jsx); the screen around it is the kit's <RackService>.
 */
// ─── The fields a row shows ─────────────────────────────────────────────────
// A name is spelled in ONE place: nm./last/first/init are worked out from the
// English parts rather than stored, so they cannot drift from `name`.
// 성 and 이름 are stored apart and written together, the way a Korean name is
// written: 한인식.
export const korName = (a) => `${(a.korFamily || '').trim()}${(a.korGiven || '').trim()}`
export const engName = (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
export const anyName = (a) => a.nick || korName(a) || engName(a) || '(이름 없음)'
export const citeLast = (a) => a.engLast || ''
export const citeFirst = (a) => [a.engFirst, a.engMiddle].filter(Boolean).join(' ')
export const citeInit = (a) => [a.engFirst, a.engMiddle, a.engLast]
  .filter(Boolean).map((w) => w[0].toUpperCase()).join('')
export const citeShort = (a) => {
  if (a.abvName) return a.abvName
  const given = [a.engFirst, a.engMiddle].filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ')
  return a.engLast ? [given, a.engLast].filter(Boolean).join(' ') : ''
}

// Where someone is NOW. A person can be in two places at once (곽민식 is at
// IRIS and at UST), so "current" is a FLAG on the entry, not the latest date —
// a date can only name one winner. An entry written before the flag existed is
// current: that is what it meant.
export const isCurrent = (x) => x.current !== false
export const currentAffs = (a) => (a.affiliations || []).filter((x) => x.tag && isCurrent(x))
/** The first of them, for the places that can only say one — a paper's
 *  superscript, the email a row falls back to. */
export function currentAff(a) {
  return currentAffs(a)[0] || null
}
/** What the affiliation cell says. Two current places read as both; a person
 *  with a history but nothing current reads 모름, which is not the same as the
 *  blank of someone who never had one. */
export const AFF_UNKNOWN = '모름'
export function affilText(a) {
  const now = currentAffs(a)
  if (now.length) return now.map((x) => x.tag).join(', ')
  return (a.affiliations || []).some((x) => x.tag) ? AFF_UNKNOWN : ''
}
/** The email a row shows: the one typed as the representative, and nothing
 *  else. It used to fall back to the current affiliation's address, which meant
 *  changing where someone works silently changed the address on screen — a
 *  mail going somewhere nobody chose. A blank here means nobody has said. */
export const repEmail = (a) => a.repEmail || ''
/** The smallest group `core`: where the author sits in a paper's author list
 *  when no one group is being looked at. */
export function coreOf(a) {
  const cores = (a.groups || []).map((g) => Number(g.core)).filter((n) => Number.isFinite(n) && n >= 1)
  return cores.length ? Math.min(...cores) : null
}
/** That ONE group's core. A core is assigned per group: outside a group's tab
 *  there is no single number to show. */
export function coreIn(a, group) {
  const n = Number((a.groups || []).find((g) => g.group === group)?.core)
  return Number.isFinite(n) && n >= 1 ? n : null
}
// An author's affiliation entry keys its affiliation as `tag`; its group entry
// keys the group as `group`. The class records carry `name` (and `shortName`).
export const inAff = (a, tag) => (a.affiliations || []).some((x) => x.tag === tag)
export const inGrp = (a, name) => (a.groups || []).some((g) => g.group === name)

/** Names in name order, Korean collation — the lists are in both scripts. */
export const byName = (list) => [...list].sort((a, b) => String(a).localeCompare(String(b), 'ko'))
// ─── The listing rule ───────────────────────────────────────────────────────
// A "나열" button does not produce text: it fills in a TEMPLATE, and the
// template is what produces the text. So a preset is a starting point you can
// then edit — `"{이름}" <{email}>` is a rule, not a button somebody has to
// come and add. The tokens are the column names, which is what the reader
// already has in front of them.
export const TOKENS = {
  affiliation: (a) => affilText(a),
  이름: (a) => korName(a),
  name: (a) => engName(a),
  'abv-name': (a) => citeShort(a),
  email: (a) => repEmail(a),
  position: (a) => currentAffs(a).map((x) => x.position).filter(Boolean).join(', '),
  core: (a) => coreOf(a) ?? '',
  last: (a) => citeLast(a),
  first: (a) => citeFirst(a),
  init: (a) => citeInit(a),
  nick: (a) => a.nick || '',
}
/** '2026-11-16 ~ 11-18' — the year is said once when both days share it. */
export const spanOf = (from, to) => {
  const a = String(from || '').trim(), b = String(to || '').trim()
  if (!a && !b) return ''
  if (!b) return a
  if (!a) return `~ ${b}`
  return `${a} ~ ${b.slice(0, 4) === a.slice(0, 4) ? b.slice(5) : b}`
}
/** What a group IS. A paper's author list is assembled for different reasons,
 *  and a list of fifteen groups is unreadable without saying which is which. */
export const GROUP_TYPES = [
  ['organization', '조직 · 팀 (CENS, IRIS 실험장치팀)'],
  ['experiment', '실험 (STARK, PKU, RAON, KO-25-20)'],
  ['presentation', '발표 · 포스터 (ICABU, INPC)'],
  ['project', '과제'],
  ['other', '그 밖'],
]

export const PRESETS = [
  ['이름 나열', '{이름}'],
  ['full names', '{name}'],
  ['abv. names', '{abv-name}'],
  ['email list', '"{name}" <{email}>'],
]

/** Several groups (or affiliations) into one.
 *
 *  A person points at one by NAME, so the fold is two things: every row that
 *  names one of the old ones names the new one instead — once, a person is not
 *  in a group twice — and the class records themselves go, all but the one
 *  that survives. Merging into a name nobody has yet renames the first of them
 *  rather than inventing an empty record. */
export function foldClass(doc, of, gone, to) {
  const aff = of === 'affiliation'
  const key = aff ? 'tag' : 'group'
  const list = aff ? 'affiliations' : 'groups'
  const drop = new Set(gone)
  const authors = (doc.authors || []).map((a) => {
    const rows = a[list] || []
    if (!rows.some((x) => drop.has(x[key]))) return a
    const next = []
    for (const x of rows) {
      const v = drop.has(x[key]) ? to : x[key]
      if (next.some((y) => y[key] === v)) continue
      next.push({ ...x, [key]: v })
    }
    return { ...a, [list]: next }
  })
  const recs = doc[list] || []
  let kept = recs.filter((r) => !drop.has(r.name))
  if (!kept.some((r) => r.name === to)) {
    const src = recs.find((r) => drop.has(r.name))
    kept = [...kept, { ...(src || {}), name: to }]
  }
  return { authors, [list]: kept }
}
/** Core first, then by FAMILY name — which is how an author list is ordered.
 *  Sorting the abbreviated name instead sorts by the first initial, and
 *  A. Chekhovska lands where S. Ahn belongs. */
export const byPaperOrder = (core = coreOf) => (a, b) => {
  const c = (core(a) ?? 99) - (core(b) ?? 99)
  if (c !== 0) return c
  const last = (x) => (x.engLast || citeShort(x).split(' ').at(-1) || anyName(x)).toLowerCase()
  const l = last(a).localeCompare(last(b))
  return l !== 0 ? l : citeShort(a).localeCompare(citeShort(b))
}
