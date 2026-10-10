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
import { useEffect, useRef, useState } from 'react'
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
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { math, mathBlockSchema, mathInlineSchema } from '@milkdown/plugin-math'
import katex from 'katex'
import { bulletListSchema, listItemSchema } from '@milkdown/kit/preset/commonmark'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { findWrapping } from '@milkdown/kit/prose/transform'
import { $inputRule, $remark, $view } from '@milkdown/kit/utils'
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

/** `[] ` starts a checklist, from anywhere.
 *
 *  GFM's own rule is `[ ] ` or `[x] ` and only works INSIDE a list item, so a
 *  check list cost `- [ ] ` — a bullet first, then the box. This one takes
 *  `[] `, `[ ] ` and `[x] `, and when there is no list around it, makes one. */
const checkRule = $inputRule((ctx) => new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
  const li = listItemSchema.type(ctx)
  const ul = bulletListSchema.type(ctx)
  const checked = /[xX]/.test(match[1])
  const $start = state.doc.resolve(start)
  // Already an item: this only ticks it, which is what GFM's rule does.
  for (let d = $start.depth; d > 0; d -= 1) {
    const node = $start.node(d)
    if (node.type === li) {
      return state.tr.deleteRange(start, end)
        .setNodeMarkup($start.before(d), undefined, { ...node.attrs, checked })
    }
  }
  // A bare paragraph: wrap it in a list and make that item a task.
  const tr = state.tr.delete(start, end)
  const range = tr.doc.resolve(tr.mapping.map(start)).blockRange()
  const wrapping = range && findWrapping(range, ul)
  if (!wrapping) return null
  tr.wrap(range, wrapping)
  // The wrappers open AT range.start in the new document — mapping that
  // position would carry it past them, which is how the first try wrapped the
  // paragraph in a plain list and left the box off.
  for (let at = range.start; at <= range.start + 2; at += 1) {
    const item = tr.doc.nodeAt(at)
    if (item?.type === li) { tr.setNodeMarkup(at, undefined, { ...item.attrs, checked }); break }
  }
  return tr
}))

/** What comes back out of the editor is markdown again, and it is the FILE.
 *  Two corrections on the way:
 *   - `-` bullets, because that is what the file was written with and a
 *     serializer's default should not restyle someone's notes.
 *   - `\#` → `#`. remark escapes a hash that starts a line in case it is a
 *     heading; CommonMark needs `# ` with a space, so `#태그` never was one —
 *     and escaped, it stops being a tag. */
/** What remark escapes on the way out and this app means literally: a `#tag`
 *  at the start of a line, and the `![[file]]` embeds, whose brackets remark
 *  would hand back as `!\[\[file]]` — unreadable to Obsidian and to us. Only
 *  those two shapes, so an escape someone wrote stays an escape. */
const tidy = (md) => md
  .replace(/\\#/g, '#')
  .replace(/!\\\[\\\[([^\]]+)\]\]/g, '![[$1]]')

const make = (root, value, onMarkdown, fileSrc, onFiles) => Editor.make()
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
  .use(math)         // `$x$` and `$$…$$` as nodes, so the backslashes survive
  .use(mathView(mathBlockSchema, true))
  .use(mathView(mathInlineSchema, false))
  .use(imageView)
  .use(takeFiles(onFiles))
  .use(linkOpen)
  .use(imageAttrs)   // plain markdown `![alt](url)`, which milkdown drops
  .use(activeLine)
  .use(checkRule)
  .use(tagInDoc)
  .use(embedInDoc(fileSrc))
  .create()

export default function MarkdownArea({ value, onChange, fileSrc, onFiles }) {
  // A file over the pane says so, so a drop that goes nowhere is visibly a
  // drop that landed somewhere else.
  const [over, setOver] = useState(false)
  const host = useRef(null)
  const ed = useRef(null)
  const cb = useRef(onChange)
  cb.current = onChange
  // What the editor itself last produced: an update that merely came back from
  // a save must not be loaded over what is being typed.
  const mine = useRef(value)

  useEffect(() => {
    let dead = false
    make(host.current, value, (md) => { mine.current = md; cb.current(md) }, fileSrc, onFiles)
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
    e.destroy().then(() => make(host.current, value,
      (md) => { mine.current = md; cb.current(md) }, fileSrc, onFiles)
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

  /** The pane takes the drag, not only the text inside it: a picture dropped
   *  on the margin is a picture meant for the note. ProseMirror's own handler
   *  gets it first and puts it where the cursor fell; what reaches here
   *  unclaimed fell outside the text and goes at the end. */
  const dragging = (e) => {
    if (!onFiles || !hasFiles(e.dataTransfer)) return false
    e.preventDefault()
    setOver(true)
    return true
  }
  const dropped = (e) => {
    setOver(false)
    if (e.defaultPrevented || !onFiles || !hasFiles(e.dataTransfer)) return
    e.preventDefault()
    const files = [...e.dataTransfer.files]
    ed.current?.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      stow(view, view.state.doc.content.size, files, onFiles)
    })
  }
  return (
    <div className={`nt-wy${over ? ' nt-over' : ''}`} ref={host} onMouseDown={onClick}
      onDragEnter={dragging} onDragOver={dragging} onDrop={dropped}
      onDragLeave={(e) => { if (!host.current?.contains(e.relatedTarget)) setOver(false) }} />
  )
}

/** `![[name.png]]` — Obsidian's embed, which is not markdown and so is not
 *  anybody's engine's job. It is shown as a WIDGET beside the text rather than
 *  parsed into an image node: the text stays exactly what the file says, and
 *  the file stays something Obsidian can still read. */
/** A markdown picture, with `![alt|400](url)` taken as a width — the same
 *  spelling the `![[file|400]]` embeds use. */
const imageView = $view(imageSchema.node, () => (node) => {
  const img = document.createElement('img')
  const paint = () => {
    const [alt, w] = embedSpec(node.attrs.alt || '')
    img.src = node.attrs.src
    img.alt = alt
    img.title = node.attrs.title || ''
    img.style.width = w ? `${w}px` : ''
  }
  paint()
  return {
    dom: img,
    update: (next) => {
      if (next.type !== node.type) return false
      node = next
      paint()
      return true
    },
  }
})

/** A link you can follow without leaving the text.
 *
 *  A link inside a contenteditable is text, not a link: the browser gives the
 *  click to the caret. ⌘-click (or ctrl-click) opens it the way it does
 *  everywhere else, and a plain click hangs a 열기 beside it — because the
 *  other thing you may have meant was to edit the words. */
const linkOpen = $prose(() => {
  const key = new PluginKey('nt-link')
  return new Plugin({
    key,
    state: {
      init: () => null,
      apply(tr, prev) {
        const set = tr.getMeta(key)
        if (set !== undefined) return set
        return tr.docChanged ? null : prev
      },
    },
    props: {
      handleDOMEvents: {
        mousedown: (view, e) => {
          const a = e.target?.closest?.('a[href]')
          const had = key.getState(view.state)
          if (!a || a.classList.contains('nt-open')) {
            if (had) view.dispatch(view.state.tr.setMeta(key, null))
            return false
          }
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            window.open(a.href, '_blank', 'noopener')
            return true
          }
          const at = view.posAtDOM(a, a.childNodes.length)
          view.dispatch(view.state.tr.setMeta(key, { at, href: a.href }))
          return false
        },
      },
      decorations(state) {
        const s = key.getState(state)
        if (!s) return null
        return DecorationSet.create(state.doc, [Decoration.widget(s.at, () => {
          const go = document.createElement('a')
          go.className = 'nt-open'
          go.href = s.href
          go.target = '_blank'
          go.rel = 'noreferrer'
          go.textContent = '열기 ↗'
          go.contentEditable = 'false'
          return go
        }, { side: 1, key: `open:${s.href}` })])
      },
    },
  })
})

/** A file dropped (or pasted) into a note is stored beside the notes and named
 *  where it fell, which is the whole of "putting a picture in". */
const takeFiles = (upload) => $prose(() => new Plugin({
  key: new PluginKey('nt-drop'),
  props: {
    handleDOMEvents: {
      // Without this the browser refuses the drop and opens the file in the
      // tab instead: a drop only happens where dragover said it could.
      dragover: (_view, e) => {
        if (!upload || !hasFiles(e.dataTransfer)) return false
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        return true
      },
      dragenter: (_view, e) => {
        if (!upload || !hasFiles(e.dataTransfer)) return false
        e.preventDefault()
        return true
      },
      drop: (view, e) => {
        const files = [...(e.dataTransfer?.files || [])]
        if (!files.length || !upload) return false
        e.preventDefault()
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
        stow(view, at ?? view.state.selection.from, files, upload)
        return true
      },
      paste: (view, e) => {
        const files = [...(e.clipboardData?.files || [])]
        if (!files.length || !upload) return false
        e.preventDefault()
        stow(view, view.state.selection.from, files, upload)
        return true
      },
    },
  },
}))

/** A drag carrying files, as against one carrying text out of the note. */
const hasFiles = (dt) => !!dt && (
  [...(dt.types || [])].includes('Files') || (dt.files && dt.files.length > 0))

/** What a dropped picture comes in at. Not the stylesheet's cap, which is
 *  what a picture may grow to: a photo is 480px wide until someone says
 *  otherwise, and saying otherwise is deleting the number. */
const DROPPED_W = 480

async function stow(view, at, files, upload) {
  for (const file of files) {
    // One at a time: the names come back in the order they were dropped, and
    // the second insert has to know where the first one ended.
    const name = await upload(file)
    if (!name) continue
    const text = `![[${name}${file.type?.startsWith('image/') ? `|${DROPPED_W}` : ''}]]`
    view.dispatch(view.state.tr.insertText(text, at))
    at += text.length
  }
}

/** A formula you can go back into.
 *
 *  plugin-math draws `$x$` and `$$…$$` with KaTeX and makes them atoms, which
 *  means a typo in one can only be deleted, not fixed. Selecting a formula —
 *  one click — hands back the LaTeX in a field; leaving it draws it again.
 */
const mathView = (schema, block) => $view(schema.node, () => (node, view, getPos) => {
  const dom = document.createElement(block ? 'div' : 'span')
  dom.className = block ? 'nt-math' : 'nt-math-in'
  dom.dataset.type = block ? 'math_block' : 'math_inline'
  const latex = () => (block ? node.attrs.value : node.textContent) || ''
  const draw = () => {
    dom.textContent = ''
    const out = document.createElement(block ? 'div' : 'span')
    try { katex.render(latex(), out, { displayMode: block, throwOnError: false }) }
    catch { out.textContent = latex() }
    dom.appendChild(out)
  }
  const edit = () => {
    const was = latex()
    dom.textContent = ''
    const ta = document.createElement('textarea')
    ta.className = 'nt-math-src'
    ta.value = was
    ta.rows = block ? Math.max(1, was.split('\n').length) : 1
    const commit = () => {
      const pos = getPos()
      if (pos == null || ta.value === was) { draw(); return }
      const tr = view.state.tr
      if (block) tr.setNodeMarkup(pos, undefined, { value: ta.value })
      else if (ta.value) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, view.state.schema.text(ta.value))
      else tr.delete(pos, pos + node.nodeSize)
      view.dispatch(tr)
      // The node may still be the selected one, so nothing else will ask for
      // the formula back: draw it.
      draw()
    }
    ta.addEventListener('blur', commit)
    ta.addEventListener('keydown', (e) => {
      // Escape always leaves; Enter leaves an inline formula, where there is
      // only ever one line to write.
      if (e.key === 'Escape' || (e.key === 'Enter' && !block)) {
        e.preventDefault()
        commit()
        view.focus()
      }
    })
    dom.appendChild(ta)
    requestAnimationFrame(() => { ta.focus(); ta.select() })
  }
  draw()
  return {
    dom,
    selectNode: edit,
    deselectNode: draw,
    stopEvent: (e) => e.target?.tagName === 'TEXTAREA',
    ignoreMutation: () => true,
    update: (next) => {
      if (next.type !== node.type) return false
      node = next
      if (!dom.querySelector('textarea')) draw()
      return true
    },
  }
})

/** remark reads an image with no title as `title: null`, and the image node
 *  declares `validate: 'string'` — ProseMirror then refuses the node and the
 *  picture is dropped on the way in (milkdown 7.22). Give it the empty
 *  strings it asked for. */
const imageAttrs = $remark('nt-image-attrs', () => () => (tree) => {
  const walk = (n) => {
    if (n.type === 'image') { n.title = n.title || ''; n.alt = n.alt || '' }
    n.children?.forEach(walk)
  }
  walk(tree)
})

export const EMBED_RE = /!\[\[([^\]]+)\]\]/g

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
const embedInDoc = (src) => $prose(() => new Plugin({
  key: new PluginKey('nt-embed'),
  props: {
    decorations(state) {
      const marks = []
      state.doc.descendants((node, pos) => {
        if (!node.isText) return true
        for (const m of node.text.matchAll(EMBED_RE)) {
          const at = pos + m.index + m[0].length
          marks.push(Decoration.widget(at, () => {
            const [name, w] = embedSpec(m[1])
            const img = document.createElement('img')
            img.className = 'nt-embed'
            img.src = src(name)
            img.alt = name
            if (w) img.style.width = `${w}px`
            return img
          }, { side: 1, key: `embed:${m[1]}` }))
          // The `![[…]]` itself only shows on the line the caret is in, the way
          // Obsidian does it — the text and the file keep Obsidian's spelling.
          marks.push(Decoration.inline(at - m[0].length, at, { class: 'nt-embed-src' }))
        }
        return true
      })
      return DecorationSet.create(state.doc, marks)
    },
  },
}))

/** `#태그` — Obsidian's spelling, and markdown keeps it apart from a heading
 *  (`# ` has a space after the hash). */
export const TAG_RE = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g

/** A tag drawn as a tag. Only a DECORATION: the text in the document is still
 *  `#태그` and so is the file — nothing is turned into a node that the
 *  serializer would have to turn back. */
const tagInDoc = $prose(() => new Plugin({
  key: new PluginKey('nt-tag-chip'),
  props: {
    decorations(state) {
      const marks = []
      state.doc.descendants((node, pos) => {
        if (!node.isText) return true
        for (const m of node.text.matchAll(TAG_RE)) {
          const from = pos + m.index + m[1].length
          marks.push(Decoration.inline(from, from + 1 + m[2].length, { class: 'nt-tag-in' }))
        }
        return true
      })
      return DecorationSet.create(state.doc, marks)
    },
  },
}))
