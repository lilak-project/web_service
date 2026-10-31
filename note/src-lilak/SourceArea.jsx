import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import { livePreview, liveLook } from './livemd.js'
import { tagComplete, dueKeys, takeFiles, tableKeys, tableInput } from './liveedit.js'

/** The note as the file has it, in a real text editor — plain (`원문`) or with
 *  the markdown drawn over it (`라이브`).
 *
 *  The editor beside this one reads the file into a document and writes the
 *  file back from it, which is why it argues with the file about backslashes.
 *  This one holds the TEXT: what is typed is what is saved, character for
 *  character — the only thing on top of it is colour.
 *
 *  It is also the first piece of the editor the notes are headed for (see the
 *  upgrade plan, §5): the same CodeMirror, with the markdown drawn rather than
 *  spelled out, and with LaTeX for a tex note.
 *
 *  Lines do not wrap, so a line is a line and the numbers beside them are true.
 */
const look = EditorView.theme({
  '&': {
    flex: '1',
    minHeight: '0',
    fontFamily: 'var(--rk-mono)',
    fontSize: 'var(--rk-fs)',
    color: 'var(--rk-text)',
    background: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '10px 26px 24px 14px', caretColor: 'var(--rk-ink)' },
  '.cm-gutters': {
    background: 'var(--rk-gut)',
    color: 'var(--rk-mute)',
    border: '0',
    borderRight: '1px solid var(--rk-line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px' },
  '.cm-activeLine': { background: 'var(--rk-gut)' },
  '.cm-activeLineGutter': { background: 'var(--rk-line)', color: 'var(--rk-dim)' },
  '.cm-selectionBackground, ::selection': { background: 'var(--rk-cite) !important' },
})

export default function RawArea({ value, onChange, live = false, fileSrc, onFiles, onOpenNote }) {
  const host = useRef(null)
  const view = useRef(null)
  const cb = useRef(onChange)
  cb.current = onChange
  // What this editor itself last produced: a value coming back from a save
  // must not be laid over what is being typed.
  const mine = useRef(value)

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          ...(live ? [livePreview(fileSrc, onOpenNote), ...liveLook] : []),
          highlightActiveLine(),
          drawSelection(),
          history(),
          // A table's own Tab and Enter go first: the general keymap's Tab
          // indents the line, which is not what a cell wants.
          tableKeys,
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage }),
          tagComplete,
          ...dueKeys,
          tableInput,
          ...(onFiles ? [takeFiles(onFiles)] : []),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          look,
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const next = u.state.doc.toString()
            mine.current = next
            cb.current(next)
          }),
        ],
      }),
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // A note that changed underneath (a reload, another tab's save) is laid in;
  // one that merely echoes this editor's own typing is not.
  useEffect(() => {
    const v = view.current
    if (!v || value === mine.current || value === v.state.doc.toString()) return
    mine.current = value
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div className={live ? 'nt-raw nt-live' : 'nt-raw'} ref={host} />
}
