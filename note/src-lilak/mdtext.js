/** How a note is written back to markdown.
 *
 *  remark rewrites the file from the document on every save, and on the way out
 *  it puts a `\` in front of anything that COULD be read as syntax next time:
 *  `#태그` → `\#태그`, `[[노트]]` → `\[\[노트]]`, `AT&T` → `AT\&T`, `2*3` →
 *  `2\*3`. None of those are syntax in a vault — they are what was typed — and
 *  the next save escapes the escape, until the file is a hedge of backslashes.
 *
 *  The old cure was to strip the backslashes again after remark had written
 *  them, which is a race against a list of characters nobody can finish. This
 *  is the same decision made ONCE, where remark makes it: the serializer's own
 *  `text` handler, replaced with one that escapes what would really change the
 *  shape of the document and nothing else.
 *
 *  What is still escaped, and why:
 *    - the opener of a BLOCK at the start of a line — `# ` (heading), `> `,
 *      `- ` `* ` `+ ` (bullet), `1.` `1)` (number), a fence or a rule. Written
 *      bare, the line would stop being part of its paragraph.
 *    - `|` inside a table cell: it would end the cell.
 *    - a backtick: it would open code.
 *    - `&` only where an entity really follows (`&nbsp;`, `&#39;`), because
 *      that text would otherwise come back as the character it names. `AT&T`
 *      is left alone.
 *    - a backslash standing before punctuation, which the next read would eat:
 *      `C:\Users` is safe as it is, `\(x\)` is not.
 *
 *  What is not: `# * ~ _ $ [ ] &` in the middle of a line. A pair of them may
 *  be read as emphasis or as a tag next time — and that is what the file says.
 *  The text itself is unchanged, which is the thing a note has to keep.
 */

/** A backslash that a reader would eat: `\(` is an escaped `(`, so a LaTeX
 *  `\\(x\\)` in the file has to stay doubled or the next read loses it. */
const BACKSLASH = /\\(?=[!-/:-@[-`{-~])/g

/** A `&` that names a character — `&nbsp;`, `&#39;` — and would be read as one. */
const ENTITY = /&(?=#?[0-9A-Za-z]{1,31};)/g

/** The shapes that open a block, which only do so at the start of a line. */
const HEADING = /^#{1,6}([ \t]|$)/
const QUOTE = /^>/
const BULLET = /^[-+*]([ \t]|$)/
const NUMBER = /^(\d{1,9})([.)])([ \t]|$)/
const FENCE_OR_RULE = /^(?:`{3,}|~{3,}|={2,}|-{2,}|_{3,}|\*{3,})[ \t]*$/

/** One line of a paragraph, as it will stand in the file. A line that CARRIES
 *  ON a paragraph is read more leniently than one that starts a block: a
 *  numbered list may interrupt a paragraph only when it starts at 1, so
 *  `2. 리스트가 아닌 줄` under a line of prose is prose and needs no guard. */
export function guardLine(line, carriesOn = false) {
  const lead = /^[ \t]*/.exec(line)[0]
  const rest = line.slice(lead.length)
  const n = NUMBER.exec(rest)
  if (n && (!carriesOn || n[1] === '1')) return lead + rest.replace(NUMBER, '$1\\$2$3')
  if (HEADING.test(rest) || QUOTE.test(rest) || BULLET.test(rest) || FENCE_OR_RULE.test(rest)) {
    return `${lead}\\${rest}`
  }
  return line
}

/** Drop-in for mdast-util-to-markdown's `text` handler. */
export function noteText(node, parent, state, info) {
  // The backslashes the text already carries go first: everything below adds
  // more, and those must not be doubled in turn.
  let value = String(node.value).replace(BACKSLASH, '\\\\')
  value = value.replace(/`/g, '\\`').replace(ENTITY, '\\&')
  if (state.stack.includes('tableCell')) value = value.replace(/\|/g, '\\|')
  // A line of the value starts a line of the file when a newline precedes it —
  // either inside the value, or in what has already been written.
  const atLineStart = !info || !info.before || info.before.endsWith('\n')
  // Text that is not the first thing in its paragraph stands after a line
  // break, so its first line carries the paragraph on just as its later ones do.
  const after = !!(parent && parent.children && parent.children.indexOf(node) > 0)
  return value.split('\n')
    .map((line, i) => (i > 0 || atLineStart ? guardLine(line, i > 0 || after) : line))
    .join('\n')
}

/** An empty line the editor kept for itself.
 *
 *  Milkdown writes `<br />` into the file for a paragraph with nothing in it,
 *  so that an empty line survives a round trip through its document. Markdown
 *  has no empty paragraph — the blank line between two blocks is already the
 *  space — and the placeholder shows up as HTML in the source views and in
 *  Obsidian. A `<br />` standing alone in its own paragraph is that
 *  placeholder, and goes; one written in a line of prose is the author's.
 */
export function noteHtml(node, parent, state, info) {
  const alone = parent && parent.type === 'paragraph' && parent.children.length === 1
  if (alone && /^<br\s*\/?>$/.test(String(node.value).trim())) return ''
  return String(node.value)
}
