/**
 * MarkdownArea — the note body, written the way it will be read.
 *
 * Milkdown on ProseMirror: the text is a contenteditable, so the editing
 * habits are the system's own — triple-click takes the line, ⇧⌘→ takes the
 * rest of it, the caret and IME behave. And the markup is not on screen:
 * **bold** is bold, `## ` makes a heading as you type it, `- [ ]` is a
 * checkbox you click.
 *
 * Assembled from the kit's own pieces rather than taken ready-made (Crepe),
 * which carries a slash menu, a toolbar, block handles and a hundred
 * code-block language modes — 1.9MB of editor for a notes pane that wants a
 * page and a caret.
 *
 * It reads and writes MARKDOWN, which is the file on disk. A body that goes
 * through here comes back in Milkdown's spelling of the same markup (which
 * bullet, how many blank lines), so the file is normalised on the first save.
 */
import { useEffect, useRef } from 'react'
import {
  Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx,
  remarkStringifyOptionsCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { trailing } from '@milkdown/kit/plugin/trailing'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

/** A bar in the margin beside every line, lit on the one the caret is in —
 *  and on all of them when a selection spans several. The bar itself is CSS on
 *  every block; this only says which are current. */
const activeLine = $prose(() => new Plugin({
  key: new PluginKey('nt-active-line'),
  props: {
    decorations(state) {
      const { from, to } = state.selection
      const marks = []
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          marks.push(Decoration.node(pos, pos + node.nodeSize, { class: 'nt-at' }))
          return false
        }
        return true
      })
      return DecorationSet.create(state.doc, marks)
    },
  },
}))

/** What comes back out of the editor is markdown again, and it is the FILE.
 *  Two corrections on the way:
 *   - `-` bullets, because that is what the file was written with and a
 *     serializer's default should not restyle someone's notes.
 *   - `\#` → `#`. remark escapes a hash that starts a line in case it is a
 *     heading; CommonMark needs `# ` with a space, so `#태그` never was one —
 *     and escaped, it stops being a tag. */
const tidy = (md) => md.replace(/\\#/g, '#')

const make = (root, value, onMarkdown) => Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, value)
    ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, attributes: { class: 'nt-prose' } }))
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-', rule: '-' }))
    ctx.get(listenerCtx).markdownUpdated((_, md) => onMarkdown(tidy(md)))
  })
  .use(commonmark)      // headings, lists, emphasis, links, code
  .use(gfm)             // tables, strikethrough, and the task list checkboxes
  .use(history)         // ⌘Z, on top of the browser's own editing
  .use(clipboard)       // paste markdown as markdown
  .use(cursor)          // a caret you can place beside a table or an image
  .use(trailing)        // always a paragraph to land in at the end
  .use(listener)
  .use(activeLine)
  .create()

export default function MarkdownArea({ value, onChange }) {
  const host = useRef(null)
  const ed = useRef(null)
  const cb = useRef(onChange)
  cb.current = onChange
  // What the editor itself last produced: an update that merely came back from
  // a save must not be loaded over what is being typed.
  const mine = useRef(value)

  useEffect(() => {
    let dead = false
    make(host.current, value, (md) => { mine.current = md; cb.current(md) })
      .then((e) => { if (dead) e.destroy(); else ed.current = e })
    return () => { dead = true; ed.current?.destroy(); ed.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // A note that changed underneath (a reload, someone else's save) is a new
  // document; one that merely echoes our own typing is not.
  useEffect(() => {
    if (!ed.current || value === mine.current) return
    mine.current = value
    const e = ed.current
    ed.current = null
    e.destroy().then(() => make(host.current, value, (md) => { mine.current = md; cb.current(md) })
      .then((next) => { ed.current = next }))
  }, [value])   // eslint-disable-line react-hooks/exhaustive-deps

  /** A checkbox drawn by CSS is still a checkbox: pressing one flips the
   *  node, the serializer writes `- [x]`, and the caret stays where it was.
   *  (The alternative was a web-component list item and everything under it.) */
  function onClick(e) {
    const li = e.target.closest?.('li[data-item-type="task"]')
    if (!li) return
    const box = li.getBoundingClientRect()
    const dx = e.clientX - box.left
    // The box only: the text is to the right of it, the gutter bar to the left.
    if (dx > 2 || dx < -24) return
    e.preventDefault()
    ed.current?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const $pos = view.state.doc.resolve(view.posAtDOM(li, 0))
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth)
        if (node.type.name === 'list_item') {
          view.dispatch(view.state.tr.setNodeMarkup($pos.before(depth), undefined,
            { ...node.attrs, checked: !node.attrs.checked }))
          return
        }
      }
    })
  }

  return <div className="nt-wy" ref={host} onMouseDown={onClick} />
}

/** `#태그` — Obsidian's spelling, and markdown keeps it apart from a heading
 *  (`# ` has a space after the hash). Read out of the markdown rather than
 *  marked in the editor: the body is the only place a tag is written. */
export const TAG_RE = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g
