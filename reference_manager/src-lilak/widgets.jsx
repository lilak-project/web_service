/**
 * reference_manager's own field types — the widgets a paper needs that no
 * other list does. Each is registered by name and used in def.js like any of
 * the kit's types; the components are the ones the old App.jsx drew by hand.
 *
 *   authors    a paper's authors, in order: a name, or a link to an author record
 *   citekey    the cite key, written by the rule until you type one
 *   maintags   tags, one of which is MAIN (what the key is filed under)
 *   cites      the paper's reference list: links, or a line of text
 *   citedby    who cites it — counted, never stored
 *   paste      a BibTeX/RIS box that fills the form (a draft's helper)
 *   rolecount  an author's papers in one role, a count you can press
 *   authorpapers  the same, in the author's own form
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { registerType, newId } from 'lilak-ui/racklist'
import {
  authorRows, autRoles, handleFor, refLabel, linkedCites, citesOf, mainTag, tagsOf,
  ruleFor, citeKeyFor, parseCitation, splitAuthors, authorList, ROLE_LABEL,
} from './paper.js'

const D = '·'
const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []))

// ─── Authors ────────────────────────────────────────────────────────────────
/** A paper's authors, in order. A row is a name; if it is someone the list
 *  knows, it is their handle instead, and the name comes from their record.
 *  Type a name or a #handle to link one, press 등록 to make a record out of a
 *  name nobody has registered yet. */
const SHOWN = 3   // an author list is long; the first three say whose paper it is

function AuthorRows({ value = [], doc, onChange, onRegister, onOpenAuthor }) {
  // 291 authors is a real paper (LIGO), and a form that shows all of them is a
  // form you cannot read past. The rest are one press away.
  const [open, setOpen] = useState(false)
  const recs = doc.authors || []
  const byKey = useMemo(() => {
    const m = new Map()
    for (const a of recs) {
      for (const k of [a.name, a.fullName, a.bibName, a.tag, `#${a.tag}`, ...(a.aliases || [])]) {
        if (k) m.set(String(k).toLowerCase(), a.id)
      }
    }
    return m
  }, [recs])
  const options = useMemo(() => recs.flatMap((a) => [`#${a.tag}`, a.name,
    ...(a.fullName ? [a.fullName] : [])]), [recs])
  const row = (i, patch) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const move = (i, d) => {
    const next = [...value]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const linked = value.filter((a) => a.ref).length

  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {(open ? value : value.slice(0, SHOWN)).map((a, i) => {
        const rec = a.ref ? recs.find((x) => x.id === a.ref) : null
        return (
          <div key={i} className="rl-rrow">
            <span className="rl-hint rl-mono" style={{ width: 22, textAlign: 'right' }}>{i + 1}</span>
            {rec ? (
              <span className="rl-tag">
                {/* The handle is the way IN to that person; unlinking is its
                    own button, and it says so rather than wearing an ×. */}
                <button type="button" className="rl-tagpick" title={`${rec.fullName || rec.name} 편집`}
                  onClick={() => onOpenAuthor?.(rec.id)}>#{rec.tag}</button>
              </span>
            ) : (
              <>
                <input className="rl-in" style={{ width: 210 }} list="rl-auts" value={a.name || ''}
                  placeholder="이름 또는 #handle"
                  onChange={(e) => {
                    const v = e.target.value
                    // Two letters at least: a record whose whole name is 'J'
                    // (import debris) would otherwise claim the first keystroke.
                    const id = v.trim().length >= 2 ? byKey.get(v.trim().toLowerCase()) : null
                    row(i, id ? { ref: id, name: '' } : { name: v })
                  }} />
                <button type="button" className="rl-btn" disabled={!String(a.name || '').trim()}
                  title="이 이름으로 저자를 등록하고 같은 이름의 줄을 모두 연결합니다"
                  onClick={() => onRegister?.(a.name)}>등록</button>
              </>
            )}
            <span className="rl-hint">{rec ? (rec.fullName || rec.name) : ''}</span>
            <label className="rl-hint" title="corresponding author">
              <input type="checkbox" checked={!!a.corr}
                onChange={(e) => row(i, { corr: e.target.checked })} /> corr.
            </label>
            {rec && (
              <button type="button" className="rl-x" title="연결 끊기 (이름만 남김)"
                onClick={() => row(i, { ref: '', name: rec.name })}>↩</button>
            )}
            <button type="button" className="rl-x" title="위로" onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="rl-x" title="아래로" onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="rl-x" title="이 줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
          </div>
        )
      })}
      <datalist id="rl-auts">{options.map((o) => <option key={o} value={o} />)}</datalist>
      <div className="rl-rrow">
        {value.length > SHOWN && (
          <button type="button" className="rl-btn" onClick={() => setOpen(!open)}>
            {open ? '접기' : `열기 (${value.length - SHOWN}명 더)`}
          </button>
        )}
        <button type="button" className="rl-btn"
          onClick={() => { setOpen(true); onChange([...value, { name: '', ref: '', corr: false }]) }}>
          + 저자
        </button>
        <span className="rl-hint">{value.length}명 · {linked}명 연결</span>
      </div>
    </div>
  )
}

// ─── Citations ──────────────────────────────────────────────────────────────
/** A paper's reference list. Entry 5 is either a paper in this list — press its
 *  number and you are reading it — or a line of text for one that is not here
 *  yet. Both are kept: a citation you cannot link is still a citation. */
function CiteRows({ value = [], refs, mine, onChange, onOpen }) {
  // citeKey → id, so the picker can be typed into and pasted into.
  const byLabel = useMemo(() => {
    const m = new Map()
    for (const r of refs) if (r.id !== mine) m.set(refLabel(r), r.id)
    return m
  }, [refs, mine])
  const labels = useMemo(() => [...byLabel.keys()].sort(), [byLabel])
  const labelOf = (id) => refLabel(refs.find((r) => r.id === id))
  const row = (i, patch) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((c, i) => {
        const linked = c.ref && refs.some((r) => r.id === c.ref)
        return (
          <div key={i} className="rl-rrow">
            <input className="rl-in rl-mono" style={{ width: 44 }} value={c.n ?? ''} placeholder="#"
              onChange={(e) => row(i, { n: e.target.value })} title="이 논문에서의 인용 번호" />
            <input className="rl-in" style={{ width: 240 }} list="rl-refs"
              value={linked ? labelOf(c.ref) : ''} placeholder="목록에서 찾기"
              onChange={(e) => {
                const id = byLabel.get(e.target.value.trim())
                // Typing over a link clears it; a name that matches makes one.
                row(i, id ? { ref: id, raw: '' } : { ref: '' })
              }} />
            {linked ? (
              <button type="button" className="rl-btn" onClick={() => onOpen?.(c.ref)}>열기</button>
            ) : (
              <input className="rl-in" style={{ width: 300 }} value={c.raw || ''}
                placeholder="J. Doe et al., PRC 99 (2019) 014601"
                onChange={(e) => row(i, { raw: e.target.value })} />
            )}
            <button type="button" className="rl-x" title="이 줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
          </div>
        )
      })}
      <datalist id="rl-refs">{labels.map((l) => <option key={l} value={l} />)}</datalist>
      <div className="rl-rrow">
        <button type="button" className="rl-btn"
          onClick={() => onChange([...value, { n: String(value.length + 1), ref: '', raw: '' }])}>
          + 참고문헌
        </button>
        <span className="rl-hint">
          {value.filter((c) => c.ref).length}개 연결 · {value.filter((c) => !c.ref && c.raw).length}개 글자만
        </span>
      </div>
    </div>
  )
}

/** Which papers cite this one. Counted, never stored: one fact in one place. */
function CitedBy({ refs, mine, onOpen }) {
  const users = refs.filter((r) => (r.cites || []).some((c) => c.ref === mine))
  if (!users.length) return <span className="rl-hint">없음</span>
  return (
    <div className="rl-rows">
      {users.map((r) => {
        const n = (r.cites || []).find((c) => c.ref === mine)?.n
        return (
          <div key={r.id} className="rl-rrow">
            <button type="button" className="rl-lnk" onClick={() => onOpen?.(r.id)}>{refLabel(r)}</button>
            {n ? <span className="rl-hint">[{n}]</span> : null}
          </div>
        )
      })}
    </div>
  )
}

/** Tags: the ones already in use are offered, a new one is just typed. A tag
 *  is a word, so the list of them is the list of words in use — there is
 *  nothing to create first. */
function TagRows({ value = [], onChange, options, main, onMain }) {
  const [add, setAdd] = useState('')
  const put = () => {
    const t = add.trim()
    if (!t) return
    if (!value.includes(t)) onChange([...value, t])
    setAdd('')
  }
  return (
    <div className="rl-rows">
      <div className="rl-rrow">
        {value.map((t) => (
          /* One tag is the MAIN one: it is what the cite key is filed under, so
             which it is has to be visible and choosable, not just first. */
          <span key={t} className={`rl-tag${onMain && t === main ? ' rl-main' : ''}`}>
            {onMain ? (
              <button type="button" className="rl-tagpick"
                title={t === main ? '메인 태그' : '메인 태그로'}
                onClick={() => onMain(t)}>{t}</button>
            ) : t}
            <button type="button" className="rl-x" title="이 태그 떼기"
              onClick={() => onChange(value.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        {value.length === 0 && <span className="rl-hint">없음</span>}
      </div>
      <div className="rl-rrow">
        {/* Leaving the box is as good as pressing the button: a tag typed and
            then saved used to vanish without a word, which is the worst way
            for a field to behave. */}
        <input className="rl-in" style={{ width: 220 }} list="rl-tags" value={add}
          placeholder="태그" onChange={(e) => setAdd(e.target.value)} onBlur={put}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); put() } }} />
        <datalist id="rl-tags">{options.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="button" className="rl-btn" onClick={put} disabled={!add.trim()}>+ 태그</button>
        {add.trim() && <span className="rl-warn">엔터를 눌러야 붙습니다</span>}
      </div>
    </div>
  )
}

/** Paste a citation, see what it read, take it or leave it. */
function PasteBox({ onTake, say }) {
  const [text, setText] = useState('')
  const got = useMemo(() => parseCitation(text), [text])
  const found = got ? Object.entries(got).filter(([, v]) => v) : []
  return (
    <div className="rl-rows">
      <textarea className="rl-in rl-mono" rows={4} style={{ width: '100%', minWidth: 260 }}
        placeholder="BibTeX 또는 RIS를 붙여넣으세요" value={text}
        onChange={(e) => setText(e.target.value)} />
      <div className="rl-rrow">
        <button type="button" className="rl-btn rl-go" disabled={found.length < 2}
          onClick={() => {
            onTake(got)
            say(`${found.length}개 항목을 읽었습니다.`)
            setText('')
          }}>읽어서 채우기</button>
        <button type="button" className="rl-btn" disabled={!text} onClick={() => setText('')}>지우기</button>
        <span className="rl-hint">
          {text ? (found.length ? found.map(([k]) => k).join(' · ') : '읽을 수 있는 항목이 없습니다.') : ''}
        </span>
      </div>
    </div>
  )
}

// ─── the types ──────────────────────────────────────────────────────────────

/** Registering the author on a row registers them everywhere: the record is
 *  created and every row in every paper that spells the name this way points
 *  at it — 44 rows saying 'W. G. Lynch' become 44 links in one press. The
 *  form's own rows are linked at once, so it does not wait for the save. */
async function registerAuthor(name, { doc, commit }, patch, rows) {
  const clean = String(name || '').trim()
  if (!clean) return
  const existing = (doc.authors || []).find((a) => a.name === clean || (a.aliases || []).includes(clean))
  const rec = existing || (() => {
    const taken = new Set((doc.authors || []).map((a) => a.tag))
    let tag = handleFor(clean), n = 2
    while (taken.has(tag)) tag = `${handleFor(clean)}${n++}`
    return { id: newId(), tag, name: clean, aliases: [], email: '', orcid: '', note: '' }
  })()
  const link = (xs) => (xs || []).map((a) => (!a.ref && (a.name === clean
    || (rec.aliases || []).includes(a.name)) ? { ...a, ref: rec.id } : a))
  patch({ authors: link(rows) })
  const hits = doc.references.reduce((n, r) => n + (r.authors || []).filter((a) => !a.ref && a.name === clean).length, 0)
  await commit({
    authors: existing ? doc.authors : [...(doc.authors || []), rec],
    references: doc.references.map((r) => ({ ...r, authors: link(r.authors) })),
  }, existing ? `${rec.tag} 로 연결 · ${hits}줄` : `${rec.tag} 등록 · ${hits}줄 연결`)
}

registerType('authors', {
  empty: () => [],
  // What a paper wears in the authors class: the people its rows point at.
  keys: (v) => list(v).filter((a) => a?.ref).map((a) => a.ref),
  text: (v, ctx) => authorList(ctx.doc, { authors: v }).join(' and '),
  Edit: ({ value, onChange, ctx, patch }) => (
    <AuthorRows value={value || []} doc={ctx.doc} onChange={onChange}
      onRegister={(name) => registerAuthor(name, ctx, patch, value)}
      onOpenAuthor={(id) => ctx.openClass?.('authors', id)} />
  ),
})

/** A key you typed is yours. One you never touched, on a NEW paper, writes
 *  itself as the fields that make it arrive — the papers already in the list
 *  keep the names their files are under. Two papers may share a key (same
 *  author, journal and year); that is said, not refused. */
function CiteKey({ value, onChange, ctx, rec, draft }) {
  const typed = useRef(false)
  const suggested = citeKeyFor(ctx.doc, rec)
  const rule = ruleFor(rec, ctx.doc?.settings)
  useEffect(() => { typed.current = false }, [rec.id])
  useEffect(() => {
    if (draft && !typed.current && suggested && value !== suggested) onChange(suggested)
  }, [draft, suggested])   // eslint-disable-line react-hooks/exhaustive-deps
  const taken = String(value || '').trim()
    && (ctx.doc?.references || []).some((r) => r.citeKey === String(value).trim() && r.id !== rec.id)
  return (
    <>
      <input className="rl-in rl-mono" style={{ width: 300 }} value={value || ''}
        onChange={(e) => { typed.current = true; onChange(e.target.value) }}
        placeholder={suggested || 'JAlmeid_ApJ_1983'} />
      <button type="button" className="rl-btn" disabled={!suggested || value === suggested}
        title={`${rule} → ${suggested || ''}`}
        onClick={() => { typed.current = true; onChange(suggested) }}>자동</button>
      <span className="rl-hint rl-mono">{rule}</span>
      {taken && <span className="rl-warn">같은 키의 논문이 있습니다.</span>}
    </>
  )
}
registerType('citekey', {
  Edit: (p) => <CiteKey {...p} />,
  tidy: (v) => String(v || '').trim(),
})

registerType('maintags', {
  empty: () => [],
  text: (v) => list(v).filter(Boolean).join(' '),
  Edit: ({ value, onChange, ctx, rec, patch }) => {
    const options = [...new Set((ctx.doc?.references || []).flatMap(tagsOf))].sort()
    return (
      <TagRows value={value || []} options={options} main={mainTag(rec)}
        onMain={(t) => patch({ mainTag: t })} onChange={onChange} />
    )
  },
  tidy: (v) => [...new Set(list(v).map((x) => String(x).trim()).filter(Boolean))],
})

/** A tab of papers in a given order — what a count you press opens. */
const idsTab = (ctx, id, label, ids) => ctx.openTab?.({ id, kind: 'items', ids, label })

registerType('cites', {
  empty: () => [],
  text: () => '',
  sort: (v) => citesOf({ cites: v }).length || null,
  // A count you can press: the number is also the way to the papers it counts,
  // in the order the citation numbers give them.
  cell(v, ctx) {
    const r = ctx.rec
    const linked = linkedCites(r)
    if (!linked.length) return citesOf(r).length || D
    const ids = [...linked].sort((x, y) => (Number(x.n) || 999) - (Number(y.n) || 999)).map((c) => c.ref)
    return (
      <button type="button" className="rl-lnk" title="이 논문이 인용한 것"
        onClick={(e) => { e.stopPropagation(); idsTab(ctx, `cites:${r.id}`, `${refLabel(r)} →`, ids) }}>{linked.length}</button>
    )
  },
  Edit: ({ value, onChange, ctx, rec }) => (
    <CiteRows value={value || []} refs={ctx.doc?.references || []} mine={rec.id}
      onChange={onChange} onOpen={(id) => ctx.openItem?.(id)} />
  ),
  // A paper other papers cite is taken out of their lists by keeping the line
  // and dropping the link — a citation you cannot link is still a citation.
  unlink: (v, id) => (list(v).some((c) => c.ref === id) ? list(v).map((c) => (c.ref === id ? { ...c, ref: '' } : c)) : v),
})

/** Who cites each paper, counted once per document rather than per row. */
const CITED = new WeakMap()
export function citedBy(doc) {
  if (!doc) return new Map()
  if (!CITED.has(doc)) {
    const m = new Map()
    for (const r of doc.references || []) {
      for (const c of linkedCites(r)) m.set(c.ref, [...(m.get(c.ref) || []), r])
    }
    CITED.set(doc, m)
  }
  return CITED.get(doc)
}
registerType('citedby', {
  text: (v) => (v ? String(v) : ''),
  sort: (v) => v || null,
  cell(v, ctx) {
    if (!v) return D
    const r = ctx.rec
    return (
      <button type="button" className="rl-lnk" title="이 논문을 인용한 것"
        onClick={(e) => {
          e.stopPropagation()
          const ids = [...(citedBy(ctx.doc).get(r.id) || [])]
            .sort((a, b) => String(a.citeKey || '').localeCompare(String(b.citeKey || ''))).map((x) => x.id)
          idsTab(ctx, `by:${r.id}`, `→ ${refLabel(r)}`, ids)
        }}>{v}</button>
    )
  },
  Show: ({ ctx, rec }) => <CitedBy refs={ctx.doc?.references || []} mine={rec.id} onOpen={(id) => ctx.openItem?.(id)} />,
})

registerType('paste', {
  Edit: ({ ctx, patch, rec }) => {
    const jrns = ctx.doc?.journals || []
    return (
      <PasteBox say={ctx.say} onTake={(got) => {
        const { author, ...rest } = got
        patch({
          ...rest,
          // The parser reads ONE string; this form keeps rows.
          authors: splitAuthors(author).map((n) => ({ name: n, ref: '', corr: false })),
          // A journal we already know is linked to its record.
          journal: jrns.find((j) => String(j.name || '').toLowerCase() === (got.journal || '').toLowerCase())?.id
            || got.journal || rec.journal,
        })
      }} />
    )
  },
})

// ─── an author ──────────────────────────────────────────────────────────────
/** The papers an author is on, by where they stand. Not exclusive: a first
 *  author can be the corresponding one, and both lists say so. */
export function papersOf(doc, id) {
  return (doc?.references || []).filter((r) => authorRows(r).some((x) => x.ref === id))
}
export const inRoleOf = (doc, id, role) => papersOf(doc, id).filter((r) => autRoles(r, id).includes(role))
/** Every author's counts — papers, 1st, 2nd, corr., the rest — in one pass. */
const STATS = new WeakMap()
export function authorStats(doc) {
  if (!doc) return new Map()
  if (!STATS.has(doc)) {
    const m = new Map()
    for (const r of doc.references || []) {
      const seen = new Set()
      for (const a of authorRows(r)) {
        if (!a.ref || seen.has(a.ref)) continue
        seen.add(a.ref)
        const s = m.get(a.ref) || { count: 0, first: 0, second: 0, corr: 0, other: 0 }
        s.count += 1
        for (const role of autRoles(r, a.ref)) s[role] += 1
        m.set(a.ref, s)
      }
    }
    STATS.set(doc, m)
  }
  return STATS.get(doc)
}

registerType('rolecount', {
  text: (v) => (v ? String(v) : ''),
  sort: (v) => v || 0,
  // On an author's row every count is a way in: press 1st and you get the
  // papers they lead, not all of them.
  cell(v, ctx) {
    if (!v) return D
    const a = ctx.rec
    const role = ctx.field.role
    // The list is worked out when pressed: 1,971 rows drawn should not each
    // go through every paper.
    return (
      <button type="button" className="rl-lnk" title={`${a.fullName || a.name} · ${ROLE_LABEL[role]}`}
        onClick={(e) => {
          e.stopPropagation()
          const ids = inRoleOf(ctx.doc, a.id, role).sort((x, y) => (Number(y.year) || 0) - (Number(x.year) || 0)).map((r) => r.id)
          idsTab(ctx, `aut:${a.id}:${role}`, `${a.tag || a.name} ${ROLE_LABEL[role]}`, ids)
        }}>{v}</button>
    )
  },
})

const ROLES = [['first', '1저자'], ['second', '2저자'], ['corr', 'corresponding'], ['other', '그 외']]
registerType('authorpapers', {
  Show: ({ ctx, rec }) => {
    const mine = papersOf(ctx.doc, rec.id)
    const open = (role) => idsTab(ctx, `aut:${rec.id}:${role}`, `${rec.tag || rec.name} ${ROLE_LABEL[role]}`,
      inRoleOf(ctx.doc, rec.id, role).map((r) => r.id))
    return (
      <div className="rl-rows">
        <div className="rl-rrow">
          {ROLES.map(([role, label]) => {
            const n = inRoleOf(ctx.doc, rec.id, role).length
            return (
              <span key={role} className="rl-hint">
                {label}{' '}
                {n ? <button type="button" className="rl-lnk" onClick={() => open(role)}>{n}</button> : '0'}
              </span>
            )
          })}
          <span className="rl-hint">· 모두 {mine.length}편</span>
        </div>
        {mine.slice(0, 14).map((r) => (
          <div key={r.id} className="rl-rrow">
            <button type="button" className="rl-lnk" onClick={() => ctx.openItem?.(r.id)}>{refLabel(r)}</button>
            <span className="rl-hint">{autRoles(r, rec.id).map((x) => ROLE_LABEL[x]).filter(Boolean).join(' · ')}</span>
          </div>
        ))}
        {mine.length > 14 && <span className="rl-hint">… 모두 {mine.length}편</span>}
      </div>
    )
  },
})

/** A text field with a button beside it that writes ANOTHER field from it —
 *  the full name gives the short one, a BibTeX name gives either. */
export function NameWith({ value, onChange, rec, patch, width = 280, mono, placeholder, buttons = [] }) {
  return (
    <>
      <input className={`rl-in${mono ? ' rl-mono' : ''}`} style={{ width }} value={value || ''}
        placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {buttons.map(([label, title, make, enabled]) => (
        <button key={label} type="button" className="rl-btn" title={title}
          disabled={!(enabled ? enabled(rec) : String(value || '').trim())}
          onClick={() => patch(make(rec))}>{label}</button>
      ))}
    </>
  )
}
