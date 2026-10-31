import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { choicesFor } from './marks.js'

/** What typing does in the source editor.
 *
 *  The three things the other editor learned and this one needed too: a tag
 *  offered while you type `#`, a date put in by `>>`, and a file dropped on
 *  the page landing in the text as `![[name]]`. Each is a small extension;
 *  none of them rewrites anything the author did not type.
 */

// ── `#태그` while you type ───────────────────────────────────────────────────
const TAG_HEAD = /(?:^|[\s(])#[^\s#.,;:!?()[\]{}'"]*$/

export const tagComplete = autocompletion({
  override: [(ctx) => {
    const before = ctx.matchBefore(TAG_HEAD)
    if (!before) return null
    const hash = before.text.indexOf('#')
    const from = before.from + hash + 1
    const typed = before.text.slice(hash + 1)
    if (!typed && !ctx.explicit) return null
    const options = choicesFor(typed).map((label) => ({ label, type: 'keyword' }))
    return options.length ? { from, options, validFor: /^[^\s#]*$/ } : null
  }],
  icons: false,
})

// ── `>>2026-12-24 ` → `» 2026-12-24 `, and `>> ` → a calendar ──────────────
const DUE_TYPED = /(^|\s)>>(\d{4}-\d{2}-\d{2})$/
const DUE_BARE = /(^|\s)>>$/

const askDate = StateEffect.define()

class Calendar extends WidgetType {
  constructor(at) { super(); this.at = at }
  eq(other) { return other.at === this.at }
  toDOM(view) {
    const input = document.createElement('input')
    input.type = 'date'
    input.className = 'nt-duepick'
    input.addEventListener('change', () => {
      if (!input.value) return
      view.dispatch({
        changes: { from: this.at, insert: `» ${input.value} ` },
        selection: { anchor: this.at + `» ${input.value} `.length },
        effects: askDate.of(null),
      })
      view.focus()
    })
    const close = () => view.dispatch({ effects: askDate.of(null) })
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); view.focus() } })
    setTimeout(() => { input.focus(); input.showPicker?.() }, 0)
    return input
  }
  ignoreEvent() { return true }
}

const calendar = StateField.define({
  create: () => null,
  update(at, tr) {
    for (const e of tr.effects) if (e.is(askDate)) return e.value
    if (at == null) return null
    return tr.docChanged ? null : at
  },
  provide: (f) => EditorView.decorations.from(f, (at) => (at == null ? Decoration.none
    : Decoration.set([Decoration.widget({ widget: new Calendar(at), side: 1 }).range(at)]))),
})

/** The rule fires on the space that ends `>>…`. The space may arrive on its
 *  own (typing) or at the end of a longer insert (a paste, or a tool that
 *  types a whole string at once), so the line is read as it WILL be. */
const dueInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (!text.endsWith(' ')) return false
  const line = view.state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from) + text.slice(0, -1)
  const typed = DUE_TYPED.exec(before)
  const bare = typed ? null : DUE_BARE.exec(before)
  const m = typed || bare
  if (!m) return false
  // Where the `>>` stands: in the document, or inside this very insert — in
  // which case what the insert wrote before it is kept.
  const head = from - line.from                 // how much of the line is already written
  const mark = m.index + m[1].length            // where `>>` begins in the line-to-be
  const inside = mark >= head
  const at = inside ? from : line.from + mark
  const keep = inside ? text.slice(0, mark - head) : ''
  // The caret goes after what was written, not in front of it: a change that
  // replaces the insert itself would otherwise map it to the start.
  if (typed) {
    const insert = `${keep}» ${typed[2]} `
    view.dispatch({ changes: { from: at, to, insert }, selection: { anchor: at + insert.length } })
  } else {
    view.dispatch({
      changes: { from: at, to, insert: keep },
      selection: { anchor: at + keep.length },
      effects: askDate.of(at + keep.length),
    })
  }
  return true
})

export const dueKeys = [calendar, dueInput]

// ── a file dropped or pasted lands in the text ──────────────────────────────
const filesOf = (dt) => (dt ? [...(dt.files || [])] : [])

/** `upload(file)` stores it and answers with the name it was given. */
export const takeFiles = (upload) => EditorView.domEventHandlers({
  drop(e, view) {
    const files = filesOf(e.dataTransfer)
    if (!upload || !files.length) return false
    e.preventDefault()
    const at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.doc.length
    stow(view, at, files, upload)
    return true
  },
  paste(e, view) {
    const files = filesOf(e.clipboardData)
    if (!upload || !files.length) return false
    e.preventDefault()
    stow(view, view.state.selection.main.from, files, upload)
    return true
  },
})

async function stow(view, at, files, upload) {
  for (const file of files) {
    const name = await upload(file)
    if (!name) continue
    const text = `![[${name}]]\n`
    view.dispatch({ changes: { from: at, insert: text } })
    at += text.length
  }
}
