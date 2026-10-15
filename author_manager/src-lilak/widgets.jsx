/**
 * author_manager's own widgets — what a list of PEOPLE needs that no other list
 * does. The components are the ones the old App.jsx drew by hand; here they are
 * registered as field types, or handed to the kit's <RackService> as slots.
 *
 *   emails   every address, and which one is THE address (repEmail)
 *   affs     the affiliation history — each entry wears an affiliation
 *   grps     group membership, with this person's core in that group
 *   ListOut  the 나열 drawer: templates, and the abstract / LaTeX author blocks
 *   EditMany editing the selection at once (affiliations and groups they share)
 *   AuthorCommands  add to group · make group · remove from group
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  registerType, RackActions, RackField as Fld, fill as fillTpl, newId,
} from 'lilak-ui/racklist'
import {
  anyName, engName, citeShort, currentAffs, isCurrent, inGrp, TOKENS, PRESETS, nameIn, recOf, choices,
} from './people.js'

const list = (v) => (Array.isArray(v) ? v : [])

// ─── My List's output: the reason the list exists ───────────────────────────
function ListOut({ list, picked, doc, say, open, setOpen }) {
  const [sep, setSep] = useState(', ')
  const [tpl, setTpl] = useState(PRESETS[0][1])
  // Two printed forms are not templates: they number the affiliations, which a
  // per-name rule cannot do. '' means the rule above is what is running.
  const [mode, setMode] = useState('')
  // Printed with the citation name (S. Ahn) or the whole one (Sunghoon Ahn) —
  // an abstract wants one, a programme or a poster credit the other.
  const [nameAs, setNameAs] = useState('abv')
  // And how the affiliations come out: just their names, their names with the
  // address a journal wants, or not at all when the poster says it elsewhere.
  const [affAs, setAffAs] = useState('addr')
  const tokens = useMemo(() => TOKENS(doc), [doc])
  const fill = (tpl, a) => fillTpl(tpl, a, tokens)

  /** The LaTeX author block: core order, then a superscript per affiliation. */
  /** The author block both printed forms are: core order, then the
   *  affiliations numbered in the order they first appear. Everyone's CURRENT
   *  affiliations count — somebody at two places carries two numbers, which is
   *  what the abstract prints. */
  const block = () => {
    // The order on screen IS the order: the table is already sorted the way
    // you asked — core and family name unless you clicked a column — and a
    // block that re-sorted it printed something you were not looking at.
    const ordered = list
    const idx = new Map()
    for (const a of ordered) {
      for (const x of currentAffs(a)) if (!idx.has(x.tag)) idx.set(x.tag, idx.size + 1)
    }
    const line = (tag) => {
      const rec = recOf(doc, 'affiliations', tag)
      if (!rec) return tag
      return affAs === 'name' ? (rec.fullName || rec.name)
        : [rec.fullName || rec.name, rec.address].filter(Boolean).join(', ')
    }
    // Without the affiliations there are no numbers to carry either.
    const nums = (a) => (affAs === 'none' ? []
      : currentAffs(a).map((x) => idx.get(x.tag)).filter(Boolean))
    const name = (a) => (nameAs === 'full'
      ? engName(a) || citeShort(a) : citeShort(a) || engName(a)) || anyName(a)
    return { ordered, idx, line, nums, name }
  }
  const paperOut = () => {
    const { ordered, idx, line, nums, name } = block()
    const names = ordered.map((a) => {
      const n = nums(a)
      return `  ${name(a)}${n.length ? `$^{${n.join(',')}}$` : ''}`
    })
    if (affAs === 'none') return `\\author{%\n${names.join(',\n')}\n}`
    const affs = [...idx.entries()].map(([tag, i]) => `$^{${i}}$ ${line(tag)}\\\\`)
    return `\\author{%\n${names.join(',\n')}\n}\n\n% affiliations\n${affs.join('\n')}`
  }
  /** The block as an abstract carries it: the name, a comma, and the plain
   *  numbers. Plain, because the superscripting is done where it is typeset —
   *  a superscript character pasted into a word processor is a character that
   *  does not match the font around it. */
  const abstractOut = (tex) => {
    const { ordered, idx, line, nums, name } = block()
    // The only difference between the two is how a number is raised: a word
    // processor does it to a plain digit, LaTeX does it to $^{…}$.
    const mark = (n) => (tex ? `$^{${n.join(',')}}$` : n.join(','))
    const one = (a) => {
      const n = nums(a)
      return `${name(a)}${n.length ? mark(n) : ''}`
    }
    // The number belongs to the NAME — J. W. Lee1 — so the comma is free to do
    // the only job a comma has in a list: divide the people.
    const people = ordered.map(one)
    const joined = people.length > 1
      ? `${people.slice(0, -1).join(', ')}, and ${people.at(-1)}`
      : people.join('')
    if (affAs === 'none') return joined
    const affs = [...idx.entries()].map(([tag, i]) =>
      (tex ? `$^{${i}}$ ${line(tag)} \\\\` : `${i} ${line(tag)}`))
    return `${joined}\n\n${affs.join('\n')}`
  }

  // Derived, not stored: editing the rule changes the text under your hands.
  const out = mode === 'paper' ? paperOut()
    : mode === 'abstract' ? abstractOut(false)
      : mode === 'abstract-tex' ? abstractOut(true)
    : list.map((a) => fill(tpl, a)).filter(Boolean).join(sep.replaceAll('⏎', '\n'))

  async function copy() {
    if (!out) { say('나열할 것이 없습니다.'); return }
    try { await navigator.clipboard.writeText(out); say('복사했습니다.') }
    catch { say('복사 실패 — 직접 선택해 복사하세요.') }
  }

  const none = list.length === 0
  return (
    <div className="rl-out">
      {/* Folded by default: the list is what you came for, the text it makes is
          what you leave with. */}
      <button type="button" className={`rl-outhead${open ? ' on' : ''}`} onClick={() => setOpen(!open)}
        aria-expanded={open}>
        <i className="rl-caret">{open ? '▾' : '▸'}</i>
        <span>나열</span>
        <span className="rl-hint">{picked ? `선택한 ${list.length}명` : `${list.length}명`}</span>
      </button>
      {open && (<>
      <div className="rl-outbar">
        {PRESETS.map(([label, t]) => (
          <button key={label} type="button" className={`rl-btn${!mode && tpl === t ? ' on' : ''}`}
            disabled={none} onClick={() => { setMode(''); setTpl(t) }}>{label}</button>
        ))}
        <button type="button" className={`rl-btn rl-go${mode === 'abstract' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('abstract')}>abstract</button>
        <button type="button" className={`rl-btn rl-go${mode === 'abstract-tex' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('abstract-tex')}>abstract (LaTeX)</button>
        <button type="button" className={`rl-btn rl-go${mode === 'paper' ? ' on' : ''}`} disabled={none}
          onClick={() => setMode('paper')}>paper authors</button>
        {/* The three printed forms all name people; which name is a choice, not
            three more buttons. */}
        {mode && (<>
          <span className="rl-gap" />
          {[['abv', '{abv-name}'], ['full', '{name}']].map(([v, label]) => (
            <button key={v} type="button" className={`rl-btn${nameAs === v ? ' on' : ''}`}
              onClick={() => setNameAs(v)}>{label}</button>
          ))}
          <span className="rl-gap" />
          {[['addr', '소속+주소'], ['name', '소속만'], ['none', '소속 없이']].map(([v, label]) => (
            <button key={v} type="button" className={`rl-btn${affAs === v ? ' on' : ''}`}
              onClick={() => setAffAs(v)}>{label}</button>
          ))}
        </>)}
        <span className="rl-sp" />
        <button type="button" className="rl-btn" disabled={!out} onClick={copy}>copy</button>
      </div>

      {/* The rule itself, editable. The tokens are the column names. */}
      <div className="rl-rule-line">
        <span className="rl-hint">나열 규칙</span>
        <input className="rl-in rl-mono" style={{ flex: 1, minWidth: 180 }} value={tpl}
          disabled={!!mode} onChange={(e) => { setMode(''); setTpl(e.target.value) }} />
        <span className="rl-hint">사이</span>
        <input className="rl-in rl-mono" style={{ width: 66 }} value={sep} disabled={!!mode}
          onChange={(e) => setSep(e.target.value)} title="구분기호" />
        <button type="button" className="rl-btn" title="줄바꿈 추가" disabled={!!mode}
          onClick={() => setSep((v) => `${v}⏎`)}>+⏎</button>
      </div>
      <div className="rl-tokens">
        {Object.keys(tokens).map((k) => (
          <button key={k} type="button" className="rl-tok" disabled={!!mode}
            onClick={() => { setMode(''); setTpl((v) => `${v}{${k}}`) }}>{`{${k}}`}</button>
        ))}
      </div>

      <textarea className="rl-outbox" value={out} readOnly
        placeholder={none ? '이 탭에 사람이 없습니다.' : ''} />
      </>)}
    </div>
  )
}

/** Editing many records at once.
 *
 * Only what the records SHARE can be edited: a name or a phone number belongs
 * to one person, but "everyone in this group has core 3" is one fact said many
 * times. So the form holds the affiliations and the groups they all have.
 *
 * The rule in every field is the same: what is already there is what everyone
 * has, and an untouched field changes nothing. Where they differ the field is
 * empty and says (여러 값) — type into it and everyone gets what you typed.
 */
function EditMany({ ids, doc, onSave, onDone, onCancel, say }) {
  const people = useMemo(
    () => (doc.authors || []).filter((a) => ids.includes(a.id)), [doc, ids])
  /** The tags every one of them has, and the groups every one of them is in. */
  const common = useCallback((key, id) => {
    if (!people.length) return []
    const sets = people.map((a) => new Set((a[key] || []).map((x) => x[id]).filter(Boolean)))
    return [...sets[0]].filter((v) => sets.every((s) => s.has(v)))
      .sort((x, y) => nameIn(doc, key, x).localeCompare(nameIn(doc, key, y), 'ko'))
  }, [people, doc])
  const affTags = useMemo(() => common('affiliations', 'tag'), [common])
  const grpNames2 = useMemo(() => common('groups', 'group'), [common])

  /** One value if they all say the same thing, '' if they do not. */
  const shared = useCallback((key, id, name, field) => {
    const vals = people.map((a) => {
      const e = (a[key] || []).find((x) => x[id] === name)
      return e == null ? '' : String(e[field] ?? '')
    })
    return vals.every((v) => v === vals[0]) ? vals[0] : ''
  }, [people])
  const base = useMemo(() => {
    const out = { aff: {}, grp: {} }
    for (const t of affTags) {
      out.aff[t] = { dept: shared('affiliations', 'tag', t, 'dept'),
        position: shared('affiliations', 'tag', t, 'position'),
        since: shared('affiliations', 'tag', t, 'since') }
    }
    for (const g of grpNames2) {
      out.grp[g] = { role: shared('groups', 'group', g, 'role'),
        core: shared('groups', 'group', g, 'core') }
    }
    return out
  }, [affTags, grpNames2, shared])
  const mixed = useCallback((key, id, name, field) => {
    const vals = people.map((a) => {
      const e = (a[key] || []).find((x) => x[id] === name)
      return e == null ? '' : String(e[field] ?? '')
    })
    return !vals.every((v) => v === vals[0])
  }, [people])

  const [f, setF] = useState(base)
  const [drop, setDrop] = useState({ aff: [], grp: [] })
  const [add2, setAdd2] = useState({ aff: [], grp: [] })
  useEffect(() => { setF(base); setDrop({ aff: [], grp: [] }); setAdd2({ aff: [], grp: [] }) },
    [base, ids.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const put = (kind, name, field, v) =>
    setF((s) => ({ ...s, [kind]: { ...s[kind], [name]: { ...s[kind][name], [field]: v } } }))
  const toggleDrop = (kind, name) => setDrop((s) => ({ ...s,
    [kind]: s[kind].includes(name) ? s[kind].filter((x) => x !== name) : [...s[kind], name] }))

  // [id, name] — what is offered to add, by what it is called.
  const affLeft = choices(doc, 'affiliations').filter(([id]) => !affTags.includes(id) && !add2.aff.includes(id))
  const grpLeft = choices(doc, 'groups').filter(([id]) => !grpNames2.includes(id) && !add2.grp.includes(id))
  const affN = (v) => nameIn(doc, 'affiliations', v)
  const grpN = (v) => nameIn(doc, 'groups', v)

  async function save() {
    const now = new Date().toISOString()
    const changed = (kind, name, field) => (f[kind][name]?.[field] ?? '') !== (base[kind][name]?.[field] ?? '')
    const authors = (doc.authors || []).map((a) => {
      if (!ids.includes(a.id)) return a
      let affiliations = (a.affiliations || [])
        .filter((x) => !drop.aff.includes(x.tag))
        .map((x) => {
          if (!base.aff[x.tag]) return x
          const out = { ...x }
          for (const k of ['dept', 'position', 'since']) {
            if (changed('aff', x.tag, k)) out[k] = f.aff[x.tag][k]
          }
          return out
        })
      for (const t of add2.aff) {
        if (!affiliations.some((x) => x.tag === t)) {
          affiliations = [...affiliations,
            { tag: t, dept: '', position: '', email: '', since: '', current: true }]
        }
      }
      let groups = (a.groups || [])
        .filter((x) => !drop.grp.includes(x.group))
        .map((x) => {
          if (!base.grp[x.group]) return x
          const out = { ...x }
          if (changed('grp', x.group, 'role')) out.role = f.grp[x.group].role
          if (changed('grp', x.group, 'core')) out.core = Number(f.grp[x.group].core) || f.grp[x.group].core
          return out
        })
      for (const g of add2.grp) {
        if (!groups.some((x) => x.group === g)) groups = [...groups, { group: g, role: '', core: 10 }]
      }
      return { ...a, affiliations, groups, updatedAt: now }
    })
    const n = ids.length
    // save saves: the selection is still the selection, and the next field you
    // want to set for all of them is in the form you are looking at.
    await onSave({ authors }, `${n}명 한번에 저장했습니다.`)
  }

  if (!people.length) return <p className="rl-msg">선택된 저자가 없습니다.</p>
  return (
    <div className="rl-tab-body">
      <RackActions onSave={save} onCancel={onCancel}
        onRevert={() => { setF(base); setDrop({ aff: [], grp: [] }); setAdd2({ aff: [], grp: [] }) }} />
      <div className="rl-rec">
        <Fld label="대상">
          <div className="rl-rows">
            <span className="rl-hint">{people.length}명</span>
            <div className="rl-rrow">
              {people.slice(0, 20).map((a) => <span key={a.id} className="rl-tag">{anyName(a)}</span>)}
              {people.length > 20 && <span className="rl-hint">… 외 {people.length - 20}명</span>}
            </div>
            <span className="rl-hint">
              이름 · 이메일 · 전화 · 링크 · 첨부는 한 사람의 것이라 여기서 고치지 않습니다.
            </span>
          </div>
        </Fld>

        <Fld label="소속 이력">
          <div className="rl-rows rl-grid">
            {affTags.length === 0 && <span className="rl-hint rl-full">모두가 함께 가진 소속이 없습니다.</span>}
            {affTags.map((t) => {
              const off = drop.aff.includes(t)
              return (
                <div key={t} className="rl-rrow" style={off ? { opacity: 0.45 } : null}>
                  <span className="rl-tag">{affN(t)}</span>
                  <input className="rl-in" style={{ width: 150 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'dept') ? '(여러 값)' : '부서'}
                    value={f.aff[t]?.dept ?? ''} onChange={(e) => put('aff', t, 'dept', e.target.value)} />
                  <input className="rl-in" style={{ width: 170 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'position') ? '(여러 값)' : 'position'}
                    value={f.aff[t]?.position ?? ''} onChange={(e) => put('aff', t, 'position', e.target.value)} />
                  <input className="rl-in" style={{ width: 90 }} disabled={off}
                    placeholder={mixed('affiliations', 'tag', t, 'since') ? '(여러 값)' : '2020-01'}
                    value={f.aff[t]?.since ?? ''} onChange={(e) => put('aff', t, 'since', e.target.value)} />
                  <button type="button" className="rl-x" title={off ? '되돌리기' : '모두에게서 빼기'}
                    onClick={() => toggleDrop('aff', t)}>{off ? '↺' : '×'}</button>
                </div>
              )
            })}
            {add2.aff.map((t) => (
              <div key={t} className="rl-rrow rl-full">
                <span className="rl-tag">{affN(t)}</span>
                <span className="rl-hint">모두에게 추가됩니다.</span>
                <button type="button" className="rl-x" title="취소"
                  onClick={() => setAdd2((s) => ({ ...s, aff: s.aff.filter((x) => x !== t) }))}>×</button>
              </div>
            ))}
            <div className="rl-rrow rl-full">
              <select className="rl-btn rl-pick" value="" disabled={!affLeft.length}
                onChange={(e) => setAdd2((s) => ({ ...s, aff: [...s.aff, e.target.value] }))}>
                <option value="">+ 소속 추가</option>
                {affLeft.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
              </select>
            </div>
          </div>
        </Fld>

        <Fld label="그룹 소속">
          <div className="rl-rows rl-grid">
            {grpNames2.length === 0 && <span className="rl-hint rl-full">모두가 함께 속한 그룹이 없습니다.</span>}
            {grpNames2.map((g) => {
              const off = drop.grp.includes(g)
              return (
                <div key={g} className="rl-rrow" style={off ? { opacity: 0.45 } : null}>
                  <span className="rl-tag">{grpN(g)}</span>
                  <input className="rl-in" style={{ width: 200 }} disabled={off}
                    placeholder={mixed('groups', 'group', g, 'role') ? '(여러 값)' : 'role'}
                    value={f.grp[g]?.role ?? ''} onChange={(e) => put('grp', g, 'role', e.target.value)} />
                  <input className="rl-in rl-mono" style={{ width: 70 }} disabled={off}
                    placeholder={mixed('groups', 'group', g, 'core') ? '(여러 값)' : 'core'}
                    value={f.grp[g]?.core ?? ''} onChange={(e) => put('grp', g, 'core', e.target.value)} />
                  <span className="rl-hint">저자 순서</span>
                  <button type="button" className="rl-x" title={off ? '되돌리기' : '모두에게서 빼기'}
                    onClick={() => toggleDrop('grp', g)}>{off ? '↺' : '×'}</button>
                </div>
              )
            })}
            {add2.grp.map((g) => (
              <div key={g} className="rl-rrow rl-full">
                <span className="rl-tag">{grpN(g)}</span>
                <span className="rl-hint">모두에게 추가됩니다 (core 10).</span>
                <button type="button" className="rl-x" title="취소"
                  onClick={() => setAdd2((s) => ({ ...s, grp: s.grp.filter((x) => x !== g) }))}>×</button>
              </div>
            ))}
            <div className="rl-rrow rl-full">
              <select className="rl-btn rl-pick" value="" disabled={!grpLeft.length}
                onChange={(e) => setAdd2((s) => ({ ...s, grp: [...s.grp, e.target.value] }))}>
                <option value="">+ 그룹 추가</option>
                {grpLeft.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
              </select>
            </div>
          </div>
        </Fld>
      </div>
    </div>
  )
}

/** Every address, and which one is THE address. The list and the
 *  representative are one field because they are one question: a 대표 that is
 *  not in the list, or a list with no 대표, is a record disagreeing with
 *  itself. Marking a row moves the mark; editing the marked row moves it with
 *  the text. */
function EmailRows({ value = [], rep, onChange }) {
  const clean = (x) => String(x || '').trim()
  const put = (i, v) => {
    const next = value.map((x, j) => (j === i ? v : x))
    // The mark follows the address it was on, even while it is being typed.
    onChange(next, clean(value[i]) === clean(rep) ? v : rep)
  }
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((v, i) => (
        <div key={i} className="rl-rrow">
          <label className="rl-hint" title="대표 주소로">
            <input type="radio" checked={!!clean(v) && clean(v) === clean(rep)}
              onChange={() => onChange(value, v)} /> 대표
          </label>
          <input className="rl-in" style={{ width: 280 }} placeholder="name@lab.kr" value={v}
            onChange={(e) => put(i, e.target.value)} />
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i),
              clean(v) === clean(rep) ? '' : rep)}>×</button>
        </div>
      ))}
      <div className="rl-rrow">
        <button type="button" className="rl-btn"
          onClick={() => onChange([...value, ''], rep)}>+ 이메일</button>
        <span className="rl-hint">
          {clean(rep) ? `대표 ${clean(rep)}` : (value.some((x) => clean(x))
            ? '대표를 고르지 않으면 맨 위가 대표가 됩니다.' : '')}
        </span>
      </div>
    </div>
  )
}
/** Which entry is the CURRENT affiliation: the last one by date. Marked rather
 *  than moved, so the order you typed them in survives. */
/** The affiliation history: every entry, in the order it is stored. */
function AffRows({ value = [], options, onChange }) {
  const put = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const nowCount = value.filter((x) => x.tag && isCurrent(x)).length
  // The order is not decoration: the list joins them in it (IRIS, UST), and the
  // first current one is the one a paper's superscript uses.
  const move = (i, d) => {
    const next = [...value]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((x, i) => (
        <div key={i} className="rl-rrow">
          <select className="rl-in" style={{ width: 120 }} value={x.tag || ''}
            onChange={(e) => put(i, 'tag', e.target.value)}>
            <option value="">(소속)</option>
            {/* An entry pointing at a class that is gone stays selectable, so
                saving does not quietly change who someone was. */}
            {withOwn(options, x.tag).map(([id, n]) => (
              <option key={id} value={id}>{n}</option>
            ))}
          </select>
          <input className="rl-in" style={{ width: 150 }} placeholder="부서"
            value={x.dept || ''} onChange={(e) => put(i, 'dept', e.target.value)} />
          <input className="rl-in" style={{ width: 170 }} placeholder="position"
            value={x.position || ''} onChange={(e) => put(i, 'position', e.target.value)} />
          <input className="rl-in" style={{ width: 190 }} placeholder="email"
            value={x.email || ''} onChange={(e) => put(i, 'email', e.target.value)} />
          <input className="rl-in" style={{ width: 84 }} placeholder="2020-01"
            value={x.since || ''} onChange={(e) => put(i, 'since', e.target.value)} />
          {/* A person can be in two places at once, so this is a box per entry,
              not a crown the latest date wears. */}
          <label className="rl-hint" title="지금도 이 소속입니다">
            <input type="checkbox" checked={isCurrent(x)}
              onChange={(e) => put(i, 'current', e.target.checked)} /> 현재
          </label>
          {value.length > 1 && (<>
            <button type="button" className="rl-x" title="위로" disabled={i === 0}
              onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="rl-x" title="아래로" disabled={i === value.length - 1}
              onClick={() => move(i, 1)}>↓</button>
          </>)}
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="rl-rrow">
        <button type="button" className="rl-btn" onClick={() =>
          onChange([...value, { tag: '', dept: '', position: '', email: '', since: '', current: true }])}>
          + 소속
        </button>
        {/* Moved away and we do not know where: the history stays, nothing is
            current, and the list says 모름 rather than going blank — a blank is
            what someone with no affiliation at all looks like. */}
        <button type="button" className="rl-btn" disabled={!nowCount}
          title="이전 소속은 남기고, 지금 소속은 모르는 상태로 둡니다"
          onClick={() => onChange(value.map((x) => ({ ...x, current: false })))}>
          지금은 모름
        </button>
        <span className="rl-hint">
          {nowCount ? `현재 ${nowCount}곳${nowCount > 1 ? ' · 위에 있는 것이 먼저 나옵니다' : ''}`
            : (value.some((x) => x.tag) ? '현재 소속 모름' : '')}
        </span>
      </div>
    </div>
  )
}

/** The [id, name] choices, plus the entry's own value when no record has it. */
const withOwn = (options, v) => (v && !options.some(([id]) => id === v) ? [...options, [v, v]] : options)

/** Group membership. `core` is this author's place in THAT group's author list. */
function GrpRows({ value = [], options, onChange }) {
  const put = (i, k, v) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  return (
    <div className="rl-rows">
      {value.length === 0 && <span className="rl-hint">없음</span>}
      {value.map((x, i) => (
        <div key={i} className="rl-rrow">
          <select className="rl-in" style={{ width: 190 }} value={x.group || ''}
            onChange={(e) => put(i, 'group', e.target.value)}>
            <option value="">(그룹)</option>
            {withOwn(options, x.group).map(([id, n]) => (
              <option key={id} value={id}>{n}</option>
            ))}
          </select>
          <input className="rl-in" style={{ width: 150 }} placeholder="role"
            value={x.role || ''} onChange={(e) => put(i, 'role', e.target.value)} />
          <input className="rl-in" style={{ width: 66 }} type="number" min="1" placeholder="core"
            value={x.core ?? ''} onChange={(e) => put(i, 'core', e.target.value === '' ? '' : Number(e.target.value))} />
          <span className="rl-hint">저자 순서</span>
          <button type="button" className="rl-x" title="이 줄 지우기"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="rl-btn" onClick={() =>
        onChange([...value, { group: '', role: '', core: 10 }])}>+ 그룹</button>
    </div>
  )
}

// ─── as field types ────────────────────────────────────────────────────────
registerType('emails', {
  empty: () => [],
  text: (v) => list(v).join(' '),
  // The list and the 대표 are one field: the mark rides on the record.
  Edit: ({ value, rec, patch }) => (
    <EmailRows value={list(value)} rep={rec?.repEmail || ''}
      onChange={(emails, rep) => patch({ emails, repEmail: rep })} />
  ),
  tidy: (v) => list(v).map((x) => String(x).trim()).filter(Boolean),
})

registerType('affs', {
  empty: () => [],
  // What an author wears in the affiliations class: every place in the history.
  keys: (v) => list(v).map((x) => x?.tag).filter(Boolean),
  text: (v, ctx) => list(v).flatMap((x) => [nameIn(ctx?.doc, 'affiliations', x.tag), x.position, x.dept])
    .filter(Boolean).join(' '),
  Edit: ({ value, onChange, ctx }) => (
    <AffRows value={list(value)} options={choices(ctx.doc, 'affiliations')} onChange={onChange} />
  ),
  // An entry that points at no affiliation was added and thought better of.
  tidy: (v) => list(v).filter((x) => String(x?.tag || '').trim()),
})
registerType('grps', {
  empty: () => [],
  keys: (v) => list(v).map((x) => x?.group).filter(Boolean),
  text: (v, ctx) => list(v).map((x) => nameIn(ctx?.doc, 'groups', x.group)).filter(Boolean).join(' '),
  Edit: ({ value, onChange, ctx }) => (
    <GrpRows value={list(value)} options={choices(ctx.doc, 'groups')} onChange={onChange} />
  ),
  tidy: (v) => list(v).filter((x) => String(x?.group || '').trim()),
})

// ─── the selection, into groups ────────────────────────────────────────────
/** The people the group buttons act on: the ones you ticked. A tab is a
 *  question (who is in CENS?); the selection is an answer you assembled, and
 *  that is what goes into a group. */
export function AuthorCommands({ api }) {
  const { doc, picked, chosen, tab, commit, setNote, setPicked } = api
  const [form, setForm] = useState(null)       // the new-group form, when open
  const groupChoices = useMemo(() => choices(doc, 'groups'), [doc])
  const onGroup = tab?.of === 'groups' ? tab.key : ''
  const gName = (id) => nameIn(doc, 'groups', id)

  // Adding people to a group that already exists is the same edit make group
  // makes, minus inventing the group: pick it and the members go in.
  function addToGroup(gid) {
    if (!gid) return
    const fresh = chosen.filter((a) => !inGrp(a, gid))
    if (!chosen.length) { setNote('선택된 저자가 없습니다.'); return }
    if (!fresh.length) { setNote(`이미 모두 '${gName(gid)}'에 있습니다.`); return }
    const ids = new Set(fresh.map((a) => a.id))
    commit({
      authors: doc.authors.map((a) => (ids.has(a.id)
        ? { ...a, groups: [...(a.groups || []), { group: gid, role: '', core: 10 }] } : a)),
    }, `'${gName(gid)}'에 ${fresh.length}명 추가`)
  }
  /** Out of the group whose tab you are on. Only this group's entry goes — the
   *  people and their other groups stay. */
  function removeFromGroup(gid) {
    const out = chosen.filter((a) => inGrp(a, gid))
    if (!out.length) { setNote('선택된 저자가 없습니다.'); return }
    const ids = new Set(out.map((a) => a.id))
    commit({
      authors: doc.authors.map((a) => (ids.has(a.id)
        ? { ...a, groups: (a.groups || []).filter((g) => g.group !== gid) } : a)),
    }, `'${gName(gid)}'에서 ${out.length}명 뺐습니다.`)
    setPicked((s2) => { const n = new Set(s2); ids.forEach((id) => n.delete(id)); return n })
  }
  /** A new group out of the ticked people. */
  function makeGroup(f) {
    const name = String(f.shortName || f.fullName || '').trim()
    if (!name) { setNote('그룹 이름이 필요합니다.'); return false }
    if ((doc.groups || []).some((g) => g.name === name)) { setNote('같은 이름의 그룹이 있습니다.'); return false }
    if (!chosen.length) { setNote('선택된 저자가 없습니다.'); return false }
    const ids = new Set(chosen.map((a) => a.id))
    const now = new Date().toISOString()
    const gid = newId()
    commit({
      groups: [...(doc.groups || []), { ...f, id: gid, name, shortName: name, createdAt: now, updatedAt: now }],
      authors: doc.authors.map((a) => (ids.has(a.id)
        ? { ...a, groups: [...(a.groups || []), { group: gid, role: '', core: 10 }] } : a)),
    }, `'${name}' 그룹 생성 · ${ids.size}명 추가`)
    return true
  }

  return (
    <>
      {/* The group list IS the menu: picking is the whole action. */}
      <select className="rl-btn rl-go rl-pick" value=""
        disabled={!picked.size || !(doc?.groups || []).length}
        onChange={(e) => addToGroup(e.target.value)}>
        <option value="">add to group</option>
        {groupChoices.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
      </select>
      <button type="button" className="rl-btn rl-go" disabled={!picked.size}
        onClick={() => setForm((g) => (g ? null : {}))}>make group</button>
      {form && (
        <>
          <input className="rl-in" style={{ width: 130 }} placeholder="short name *" autoFocus
            value={form.shortName || ''} onChange={(e) => setForm((g) => ({ ...g, shortName: e.target.value }))} />
          <input className="rl-in" style={{ width: 200 }} placeholder="full name"
            value={form.fullName || ''} onChange={(e) => setForm((g) => ({ ...g, fullName: e.target.value }))} />
          <button type="button" className="rl-btn rl-go"
            onClick={() => { if (makeGroup(form)) setForm(null) }}>save</button>
          <button type="button" className="rl-btn" onClick={() => setForm(null)}>cancel</button>
          <span className="rl-hint">선택한 {chosen.length}명 (core 10)</span>
        </>
      )}
      {/* Only on a group's own tab: it is that group you would take them out of. */}
      {onGroup && (
        <button type="button" className="rl-btn rl-tabonly" disabled={!picked.size}
          onClick={() => removeFromGroup(onGroup)}>
          remove from group{picked.size ? ` (${picked.size})` : ''}
        </button>
      )}
    </>
  )
}

export { ListOut, EditMany }
