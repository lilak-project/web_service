import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { ViewPlugin } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { isImage, embedSpec } from './MarkdownArea.jsx'

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
const DATE = /(📅|✅)\s*(\d{4}-\d{2}-\d{2})/g
const EMBED = /!\[\[([^\]]+)\]\]/g
const WIKI = /(?<!!)\[\[([^\]]+)\]\]/g
const TASK = /^(\s*[-*]\s+)\[([ xX])\]/

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
          marks.push(Decoration.line({ class: 'nt-cm-rule' }).range(view.state.doc.lineAt(node.from).from))
          return
        }
        if (PAINT[name]) {
          marks.push(Decoration.mark({ class: PAINT[name] }).range(node.from, node.to))
          return
        }
        if (name === 'Link') {
          marks.push(Decoration.mark({ class: 'nt-cm-link' }).range(node.from, node.to))
          return
        }
        if (MARKS.has(name) && !shown(node.from)) {
          // The URL of a link goes with its brackets; a bare autolink has none.
          if (name === 'URL' && node.node.parent?.name !== 'Link') return
          hide(node.from, node.to)
        }
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
    for (const m of text.matchAll(DATE)) {
      const start = at(m.index)
      const cls = m[1] === '📅' ? 'nt-due-in' : 'nt-done-in'
      marks.push(Decoration.mark({ class: cls }).range(start, at(m.index + m[0].length)))
      if (!shown(start)) hide(start, start + m[1].length + (m[0][m[1].length] === ' ' ? 1 : 0))
    }
  }

  // ── the checkboxes, one per line, so a line is scanned once ─────────────
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from)
    while (line.from <= to) {
      const t = TASK.exec(line.text)
      if (t) {
        const box = line.from + t[1].length
        marks.push(Decoration.replace({ widget: new Box(t[2] !== ' ') }).range(box, box + 3))
      }
      if (line.to >= view.state.doc.length) break
      line = view.state.doc.lineAt(line.to + 1)
    }
  }

  return Decoration.set(marks, true)
}

export const livePreview = (fileSrc) => ViewPlugin.fromClass(class {
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

/** Wrapped lines, because prose is read across the pane, not scrolled sideways. */
export const liveLook = [EditorView.lineWrapping]
