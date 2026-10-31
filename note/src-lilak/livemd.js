import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { ViewPlugin } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { isImage, embedSpec } from './marks.js'

/** Markdown drawn on top of the text that IS the file.
 *
 *  Nothing here changes a character: the document stays exactly what the note
 *  says, and these are decorations over it — a heading is bigger, `**굵게**`
 *  loses its stars, `#태그` wears its chip. The line the caret is on shows its
 *  marks again, so what you edit is always the real text (the way Obsidian's
 *  live preview does it).
 *
 *  That is the whole point of the source editor: the picture is paint, and the
 *  file underneath is never rewritten.
 */

/** Marks that are hidden while the caret is elsewhere, and the node they wear. */
const PAINT = {
  StrongEmphasis: 'nt-cm-strong',
  Emphasis: 'nt-cm-em',
  Strikethrough: 'nt-cm-del',
  InlineCode: 'nt-code',
}
const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark',
  'QuoteMark', 'LinkMark', 'URL'])

const TAG = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g
const DATE = /(»|📅|✓|✅)\s*(\d{4}-\d{2}-\d{2})/g
const EMBED = /!\[\[([^\]]+)\]\]/g
const WIKI = /(?<!!)\[\[([^\]]+)\]\]/g
const TASK = /^(\s*[-*]\s+)\[([ xX])\]/
/** A list item, and how far in it sits. */
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s/
/** A row of a table: its pipes only line up in a fixed-width face. */
const ROW = /^\s*\|/

class Embed extends WidgetType {
  constructor(spec, src) { super(); this.spec = spec; this.src = src }
  eq(other) { return other.spec === this.spec }
  toDOM() {
    const [name, w] = embedSpec(this.spec)
    if (!isImage(name)) {
      const a = document.createElement('a')
      a.className = 'nt-file'
      a.href = this.src(name)
      a.textContent = name
      a.addEventListener('mousedown', (e) => {
        e.preventDefault()
        window.open(a.href, '_blank', 'noopener')
      })
      return a
    }
    const img = document.createElement('img')
    img.className = 'nt-embed'
    img.src = this.src(name)
    img.alt = name
    if (w) img.style.width = `${w}px`
    return img
  }
  ignoreEvent() { return false }
}

/** A table, drawn as one. The lines underneath are untouched — press into it
 *  and the pipes come back, which is how everything else here works. */
class Table extends WidgetType {
  constructor(text, first) { super(); this.text = text; this.first = first }
  eq(other) { return other.text === this.text && other.first === this.first }
  toDOM(view) {
    const rows = this.text.split('\n')
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/).map((c) => c.trim())
    const align = (cells(rows[1] || '') || []).map((c) => (
      /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : 'left'))
    const table = document.createElement('table')
    table.className = 'nt-cm-table'
    const body = document.createElement('tbody')
    rows.forEach((line, i) => {
      if (i === 1) return                         // the row of dashes is the ruling
      const tr = document.createElement('tr')
      tr.dataset.line = String(this.first + i)
      cells(line).forEach((text, c) => {
        const td = document.createElement(i === 0 ? 'th' : 'td')
        td.textContent = text
        td.style.textAlign = align[c] || 'left'
        tr.append(td)
      })
      body.append(tr)
    })
    table.append(body)
    // Pressing a row puts the caret in that line of the file.
    table.addEventListener('mousedown', (e) => {
      const tr = e.target.closest?.('tr')
      if (!tr) return
      e.preventDefault()
      const line = view.state.doc.line(Number(tr.dataset.line))
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      view.focus()
    })
    return table
  }
  ignoreEvent() { return false }
}

class Box extends WidgetType {
  constructor(done) { super(); this.done = done }
  eq(other) { return other.done === this.done }
  toDOM() {
    const b = document.createElement('span')
    b.className = `nt-cm-box${this.done ? ' on' : ''}`
    b.dataset.box = '1'
    return b
  }
  ignoreEvent() { return false }
}

/** A new tab for an address. `window.open` can be refused (a frame, a popup
 *  blocker), and then a link clicked in the page's own name is not. */
function open(url) {
  const w = window.open(url, '_blank', 'noopener')
  if (w) return
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noreferrer noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

/** The address a position stands in: `[말](주소)` or a bare one. */
function linkAt(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node && node.name !== 'Link' && node.name !== 'URL') node = node.parent
  if (!node) return null
  const text = state.doc.sliceString(node.from, node.to)
  if (node.name === 'URL') return /^https?:\/\//.test(text) ? text : null
  const close = text.lastIndexOf('](')
  const url = close > 0 ? text.slice(close + 2, -1).split(/\s/)[0] : ''
  return /^https?:\/\//.test(url) ? url : null
}

/** The lines any caret or selection sits in: there the text shows itself. */
const openLines = (state) => {
  const open = new Set()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n += 1) open.add(n)
  }
  return open
}

function build(view, fileSrc) {
  const marks = []
  const tables = []
  const open = openLines(view.state)
  const shown = (pos) => open.has(view.state.doc.lineAt(pos).number)
  const hide = (from, to) => { if (to > from) marks.push(Decoration.replace({}).range(from, to)) }

  for (const { from, to } of view.visibleRanges) {
    // ── what markdown says ────────────────────────────────────────────────
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name
        if (name === 'Table') {
          const head = view.state.doc.lineAt(node.from)
          const foot = view.state.doc.lineAt(node.to)
          // Inside it, the text is the text; outside, it is a table.
          const inside = view.state.selection.ranges.some(
            (r) => r.to >= head.from && r.from <= foot.to)
          if (!inside) {
            tables.push({ from: head.from, to: foot.to, first: head.number })
          }
          return
        }
        if (/^ATXHeading(\d)$/.test(name)) {
          const line = view.state.doc.lineAt(node.from)
          marks.push(Decoration.line({ class: `nt-cm-h${name.slice(-1)}` }).range(line.from))
          return
        }
        if (name === 'Blockquote') {
          for (let n = view.state.doc.lineAt(node.from).number;
            n <= view.state.doc.lineAt(node.to).number; n += 1) {
            marks.push(Decoration.line({ class: 'nt-cm-quote' }).range(view.state.doc.line(n).from))
          }
          return
        }
        if (name === 'HorizontalRule') {
          // Drawn as a line — but not while the caret is on it, or the dashes
          // someone is typing (the start of a table's ruling, say) vanish
          // under their hands.
          if (!shown(node.from)) {
            marks.push(Decoration.line({ class: 'nt-cm-rule' }).range(view.state.doc.lineAt(node.from).from))
          }
          return
        }
        if (PAINT[name]) {
          marks.push(Decoration.mark({ class: PAINT[name] }).range(node.from, node.to))
          return
        }
        if (name === 'Link') {
          // The address rides along as the tooltip, so a link drawn as words
          // still says where it goes.
          const url = linkAt(view.state, node.from + 1)
          marks.push(Decoration.mark({
            class: 'nt-cm-link',
            attributes: url ? { title: url } : undefined,
          }).range(node.from, node.to))
          if (!shown(node.from)) {
            // `[말](주소)`: the brackets and the address go, the words stay.
            // Done here rather than by hiding every URL inside, because a link
            // whose WORDS are a url has two of them and only one is the
            // address — `[https://x/](https://x/)` showed as nothing at all.
            const text = view.state.doc.sliceString(node.from, node.to)
            const close = text.lastIndexOf('](')
            if (text.startsWith('[') && close > 0) {
              hide(node.from, node.from + 1)
              hide(node.from + close, node.to)
            }
          }
          return false
        }
        if (name === 'URL') {
          // A bare address is a link as much as `[말](주소)` is — and the one
          // people actually write. Its brackets are nobody's, so nothing hides.
          const text = view.state.doc.sliceString(node.from, node.to)
          marks.push(Decoration.mark({
            class: 'nt-cm-link', attributes: { title: text },
          }).range(node.from, node.to))
          return false
        }
        if (MARKS.has(name) && !shown(node.from)) hide(node.from, node.to)
      },
    })

    // ── and what this app says on top of it ───────────────────────────────
    const text = view.state.doc.sliceString(from, to)
    const at = (i) => from + i

    for (const m of text.matchAll(EMBED)) {
      const start = at(m.index)
      marks.push(Decoration.widget({ widget: new Embed(m[1], fileSrc), side: 1 })
        .range(start + m[0].length))
      if (!shown(start)) hide(start, start + m[0].length)
    }
    for (const m of text.matchAll(WIKI)) {
      marks.push(Decoration.mark({ class: 'nt-cm-wiki' }).range(at(m.index), at(m.index + m[0].length)))
    }
    for (const m of text.matchAll(TAG)) {
      const start = at(m.index + m[1].length)
      marks.push(Decoration.mark({ class: 'nt-tag-in' }).range(start, start + 1 + m[2].length))
      if (!shown(start)) hide(start, start + 1)
    }
    const today = new Date().toISOString().slice(0, 10)
    for (const m of text.matchAll(DATE)) {
      const start = at(m.index)
      const due = '»📅'.includes(m[1])
      // A day that has passed on a line still open: the one date worth a colour.
      const late = due && m[2] < today && !/^\s*[-*+]\s+\[[xX]\]/.test(view.state.doc.lineAt(start).text)
      const cls = `${due ? 'nt-due-in' : 'nt-done-in'}${late ? ' nt-due-late' : ''}`
      marks.push(Decoration.mark({ class: cls }).range(start, at(m.index + m[0].length)))
      if (!shown(start)) hide(start, start + m[1].length + (m[0][m[1].length] === ' ' ? 1 : 0))
    }
  }

  // ── and what a whole line is: a box, a step in, a row of a table ───────
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from)
    while (line.from <= to) {
      const t = TASK.exec(line.text)
      if (t) {
        const box = line.from + t[1].length
        marks.push(Decoration.replace({ widget: new Box(t[2] !== ' ') }).range(box, box + 3))
      }
      if (tables.some((t) => line.from >= t.from && line.to <= t.to)) {
        // a table drawn as one: its lines are not there to be styled
      } else if (ROW.test(line.text)) {
        marks.push(Decoration.line({ class: 'nt-cm-row' }).range(line.from))
      } else {
        const item = ITEM.exec(line.text)
        // An item under another one steps further in than its spaces alone say,
        // and its text drops ONE size — once, however deep it goes after that.
        const depth = item ? Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 6) : 0
        if (depth > 0) {
          marks.push(Decoration.line({
            class: 'nt-cm-sub',
            attributes: { style: `padding-left:${14 + depth * 12}px` },
          }).range(line.from))
        }
      }
      if (line.to >= view.state.doc.length) break
      line = view.state.doc.lineAt(line.to + 1)
    }
  }

  return Decoration.set(marks, true)
}

/** Where the tables are, as decorations. A block decoration may not come from
 *  a plugin (it changes how much room a line takes, which the editor has to
 *  know before it measures), so these live in a field of their own. */
function tableDecorations(state) {
  const marks = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return
      const head = state.doc.lineAt(node.from)
      const foot = state.doc.lineAt(node.to)
      const inside = state.selection.ranges.some((r) => r.to >= head.from && r.from <= foot.to)
      if (inside) return
      marks.push(Decoration.replace({
        widget: new Table(state.doc.sliceString(head.from, foot.to), head.number),
        block: true,
      }).range(head.from, foot.to))
    },
  })
  return Decoration.set(marks, true)
}

const tableBlocks = StateField.define({
  create: (state) => tableDecorations(state),
  update(deco, tr) {
    return tr.docChanged || tr.selection ? tableDecorations(tr.state) : deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

const paint = (fileSrc, onOpenNote) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view, fileSrc) }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.decorations = build(u.view, fileSrc)
    }
  }
}, {
  decorations: (v) => v.decorations,
  eventHandlers: {
    mousedown(e, view) {
      // A link that is drawn as a link opens when pressed — but on the line
      // the caret is in, the text is showing itself and a press is a press.
      const where = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (where != null && e.target.closest?.('.nt-cm-link')) {
        const line = view.state.doc.lineAt(where)
        // On the line being edited the text shows itself, so a press is a
        // press — unless it is held with ⌘ or ctrl, which always opens.
        const editing = view.state.selection.ranges.some(
          (r) => r.to >= line.from && r.from <= line.to)
        const url = (!editing || e.metaKey || e.ctrlKey) ? linkAt(view.state, where) : null
        if (url) {
          e.preventDefault()
          open(url)
          return true
        }
      }
      // `[[노트]]` — the other note, opened in a tab of its own.
      if (where != null && onOpenNote && e.target.closest?.('.nt-cm-wiki')) {
        const line = view.state.doc.lineAt(where)
        const editing = view.state.selection.ranges.some(
          (r) => r.to >= line.from && r.from <= line.to)
        if (editing && !e.metaKey && !e.ctrlKey) return false
        for (const m of line.text.matchAll(WIKI)) {
          const at = line.from + m.index
          if (where >= at && where <= at + m[0].length) {
            e.preventDefault()
            onOpenNote(m[1].split('|')[0].trim())
            return true
          }
        }
      }
      const box = e.target.closest?.('[data-box]')
      if (!box) return false
      e.preventDefault()
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const t = TASK.exec(line.text)
      if (!t) return false
      const at = line.from + t[1].length + 1
      view.dispatch({ changes: { from: at, to: at + 1, insert: t[2] === ' ' ? 'x' : ' ' } })
      return true
    },
  },
})

export const livePreview = (fileSrc, onOpenNote) => [tableBlocks, paint(fileSrc, onOpenNote)]

/** Wrapped lines, because prose is read across the pane, not scrolled sideways. */
export const liveLook = [EditorView.lineWrapping]
