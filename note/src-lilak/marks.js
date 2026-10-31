/** What a note writes in its own text, and nothing about how it is drawn.
 *
 *  A vault's notations: a tag, an embed, the day a todo is due and the day it
 *  was done. They live in the body as characters — that is the whole design —
 *  so the editor, the preview, the print page and the todo list all read them
 *  from here rather than each keeping its own idea of the spelling.
 */

/** `#태그` — Obsidian's spelling, and markdown keeps it apart from a heading
 *  (`# ` has a space after the hash). */
export const TAG_RE = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g

/** `![[name.png]]` — Obsidian's embed, which is not markdown. */
export const EMBED_RE = /!\[\[([^\]]+)\]\]/g

/** The day a todo is due, and the day it was done. `»` and `✓` are what this
 *  app writes; `📅` and `✅` (Obsidian Tasks) are still read, because the
 *  notes that came from a vault are full of them. */
export const DUE_RE = /(?:»|📅)\s*(\d{4}-\d{2}-\d{2})/g
export const DONE_RE = /(?:✓|✅)\s*(\d{4}-\d{2}-\d{2})/g

/** A name a browser can draw. Anything else — a pdf, a sheet, a document — is
 *  a file you open, not a picture to put on the page. */
export const isImage = (name) =>
  /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(String(name || ''))

/** `name|400` — Obsidian's way of saying how wide this one picture should be.
 *  Everything else is left to the stylesheet, which keeps a picture inside the
 *  pane and under two thirds of the screen. */
export function embedSpec(spec) {
  const text = String(spec || '')
  const bar = text.lastIndexOf('|')
  if (bar < 0) return [text, null]
  const w = parseInt(text.slice(bar + 1), 10)
  return Number.isFinite(w) && w > 0 ? [text.slice(0, bar).trim(), w] : [text, null]
}

/** The tags in use — here and in every service that shares them (the rack
 *  services: lilak-ui/racklist tags.js) — offered under the caret while a `#`
 *  is being typed. The spelling already in use wins whatever the case. The
 *  choices are the page's (setTagChoices), most worn first. */
let CHOICES = []
export const setTagChoices = (names) => { CHOICES = names || [] }
const lower = (t) => String(t).toLowerCase()
export const choicesFor = (q) => {
  const k = lower(q)
  const starts = CHOICES.filter((t) => lower(t).startsWith(k))
  const inside = k ? CHOICES.filter((t) => !lower(t).startsWith(k) && lower(t).includes(k)) : []
  // A tag typed whole in its own spelling needs nothing offered.
  return [...starts, ...inside].filter((t) => t !== q).slice(0, 8)
}
