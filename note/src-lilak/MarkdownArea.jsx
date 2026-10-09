/**
 * MarkdownArea — the note body, styled as you type.
 *
 * CodeMirror 6 with the markdown language and a highlight style: a heading is
 * bigger WHILE you write it, bold is bold, code is mono, a #tag is a tag. The
 * markup stays visible (## is still ##) — that is source mode, which is what a
 * note you may also open in Obsidian should look like. Hiding the markers is a
 * further step (decorations that fold the syntax) and is not needed to type.
 *
 * Only the pieces that are used are imported: state, view, commands, language,
 * lang-markdown. No search, no autocomplete, no lint.
 */
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView, keymap, placeholder as cmPlaceholder, drawSelection,
  highlightActiveLine, MatchDecorator, ViewPlugin, Decoration,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** RACK's own vocabulary, applied to markdown: one family, sizes that step,
 *  nothing bold that is not bold in the text. */
const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '19px', color: 'var(--rk-ink)', lineHeight: 2 },
  { tag: t.heading2, fontSize: '16px', color: 'var(--rk-ink)', lineHeight: 2 },
  { tag: t.heading3, fontSize: '14px', color: 'var(--rk-ink)' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--rk-ink)' },
  { tag: t.strong, fontWeight: '600', color: 'var(--rk-ink)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--rk-mute)' },
  { tag: [t.monospace, t.contentSeparator], color: '#9a3412' },
  { tag: [t.link, t.url], color: 'var(--rk-cite-t)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--rk-dim)' },
  { tag: t.list, color: 'var(--rk-dim)' },
  { tag: t.processingInstruction, color: 'var(--rk-mute)' },   // the ## and ** themselves
])

/** `#태그` — a tag, the way Obsidian spells one. A heading is `# ` WITH a
 *  space after the hash, so the two cannot be confused. */
export const TAG_RE = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g
const tagMark = Decoration.mark({ class: 'cm-note-tag' })
// The match may start on the space before the #, so the decoration starts
// after that first group rather than at the match.
const tagDeco = new MatchDecorator({
  regexp: TAG_RE,
  decorate: (add, from, to, m) => add(from + m[1].length, to, tagMark),
})
const tagPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = tagDeco.createDeco(view) }
  update(u) { this.decorations = tagDeco.updateDeco(u, this.decorations) }
}, { decorations: (v) => v.decorations })

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--rk-text)', background: 'var(--rk-panel)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--rk-sans, ui-sans-serif), system-ui',
    lineHeight: '1.7',
    padding: '10px 14px',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--rk-ink)' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { background: '#fffdf4' },
  '.cm-note-tag': {
    background: 'var(--rk-cite)', color: 'var(--rk-cite-t)',
    borderRadius: '2px', padding: '0 3px',
  },
})

export default function MarkdownArea({ value, onChange, placeholder = '' }) {
  const host = useRef(null)
  const view = useRef(null)
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(style),
          tagPlugin,
          theme,
          cmPlaceholder(placeholder),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // The note was reloaded (saved, or someone else's edit came back): replace
  // the document, but never while it merely differs because you are typing.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc.toString()
    if (value !== cur && !v.hasFocus) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
    }
  }, [value])

  return <div className="nt-cm" ref={host} />
}
