/**
 * author manager — the list, and nothing else yet.
 *
 * Rebuilt from zero rather than restyled: the old screen carried a top bar, a
 * tab bar and cards, which inside the portal's panel read as a second set of
 * chrome around a service that is really one table. Everything the old app
 * could do is in git (the commit that replaced this file) and comes back one
 * feature at a time, each one judged on whether it earns a place here.
 *
 * The data contract is unchanged: one whole document, version-guarded, at
 * `${PORTAL_BASE}/api/data`, read with the portal's own token.
 */
import { useEffect, useState } from 'react'
import './rack.css'

// ─── Portal integration (same contract as the rest of the services) ─────────
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''
const PORTAL_PARTS = PORTAL_BASE.split('/').filter(Boolean)
const PORTAL_PROJECT = PORTAL_PARTS.length ? PORTAL_PARTS[PORTAL_PARTS.length - 1] : ''

function portalToken() {
  try { return localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token') || '' }
  catch { return '' }
}

async function fetchDoc() {
  const t = portalToken()
  const r = await fetch(`${PORTAL_BASE}/api/data`, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
  if (!r.ok) throw new Error(`GET /api/data → ${r.status}`)
  return r.json()
}

// ─── The fields a row shows ─────────────────────────────────────────────────
// A name is spelled in ONE place: nm./last/first/init are worked out from the
// English parts rather than stored, so they cannot drift from `name`.
const korName = (a) => `${a.korFamily || ''}${a.korGiven || ''}`.trim()
const engName = (a) => [a.engFirst, a.engMiddle, a.engLast].filter(Boolean).join(' ')
const citeLast = (a) => a.engLast || ''
const citeFirst = (a) => [a.engFirst, a.engMiddle].filter(Boolean).join(' ')
const citeInit = (a) => [a.engFirst, a.engMiddle, a.engLast]
  .filter(Boolean).map((w) => w[0].toUpperCase()).join('')
const citeShort = (a) => {
  if (a.abvName) return a.abvName
  const given = [a.engFirst, a.engMiddle].filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ')
  return a.engLast ? [given, a.engLast].filter(Boolean).join(' ') : ''
}

/** Latest affiliation entry, by its `since` date: who someone is NOW. */
function currentAff(a) {
  const list = (a.affiliations || []).filter((x) => x.tag)
  if (!list.length) return null
  return [...list].sort((x, y) => String(x.since || '').localeCompare(String(y.since || ''))).at(-1)
}
const repEmail = (a) => a.repEmail || currentAff(a)?.email || (a.emails || [])[0] || ''
/** The smallest group `core`: where the author sits in a paper's author list. */
function coreOf(a) {
  const cores = (a.groups || []).map((g) => Number(g.core)).filter((n) => Number.isFinite(n) && n >= 1)
  return cores.length ? Math.min(...cores) : null
}

const D = '·'   // a cell with nothing in it still shows its column

export default function App() {
  const [doc, setDoc] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!PORTAL_PROJECT) { setErr('이 앱은 LILAK 포털을 통해 열어야 합니다.'); return }
    fetchDoc().then(setDoc).catch((e) => setErr(String(e.message || e)))
  }, [])

  const authors = doc?.authors || []
  // Paper order: by core, then by the name a paper would print.
  const rows = [...authors].sort((a, b) => {
    const c = (coreOf(a) ?? 99) - (coreOf(b) ?? 99)
    return c !== 0 ? c : engName(a).localeCompare(engName(b))
  })

  return (
    <div className="am">
      <section className="am-mod">
        <header className="am-bar">
          <b>저자</b>
          <span className="am-n">{doc ? `${rows.length}명` : ''}</span>
          <span className="am-sp" />
          <span className="am-n">{PORTAL_PROJECT}</span>
        </header>

        <div className="am-tab">
          <div className="am-row am-head">
            <span className="am-gut">#</span>
            <span className="am-c">affil.</span>
            <span className="am-c">이름</span>
            <span className="am-c">name</span>
            <i className="am-rule" />
            <span className="am-c am-nm">nm.</span>
            <span className="am-c">email</span>
            <span className="am-c am-pos">position</span>
            <span className="am-c am-num">core</span>
            <span className="am-c am-cite">last</span>
            <span className="am-c am-cite">first</span>
            <span className="am-c am-cite">init</span>
          </div>

          {err && <p className="am-msg">{err}</p>}
          {!err && !doc && <p className="am-msg">읽는 중…</p>}
          {doc && rows.length === 0 && <p className="am-msg">저자가 없습니다.</p>}

          {rows.map((a, i) => {
            const cur = currentAff(a)
            return (
              <div className="am-row" key={a.id || i}>
                <span className="am-gut">{i + 1}</span>
                <span className="am-c am-dim">{cur?.tag || D}</span>
                <span className="am-c">{korName(a) || D}</span>
                <span className="am-c am-ink">{engName(a) || a.nick || D}</span>
                <i className="am-rule" />
                <span className="am-c am-mono am-dim am-nm">{citeShort(a) || D}</span>
                <span className="am-c am-mono">{repEmail(a) || D}</span>
                <span className="am-c am-dim am-pos">{cur?.position || D}</span>
                <span className="am-c am-num">{coreOf(a) ?? D}</span>
                <span className="am-c am-cite">{citeLast(a) || D}</span>
                <span className="am-c am-cite">{citeFirst(a) || D}</span>
                <span className="am-c am-cite am-mono">{citeInit(a) || D}</span>
              </div>
            )
          })}
        </div>

        <footer className="am-foot">
          <span>core = 논문 저자 명단에서의 순서.</span>
          <span className="am-sp" />
          <span className="am-mono">{doc ? `${authors.length}명` : ''}</span>
        </footer>
      </section>
    </div>
  )
}
