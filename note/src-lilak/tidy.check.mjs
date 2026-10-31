/** What a save does to a note body, checked. Run: node src-lilak/tidy.check.mjs
 *
 *  The editor writes a note back with remark, with this app's own `text`
 *  handler (mdtext.js — the same module the editor loads, not a copy). Each
 *  case is saved twice: the body must come back as it was written, and stay
 *  that way. A `\` in the output is a failure unless the case asks for one.
 */
import assert from 'node:assert/strict'
import { unified } from 'unified'
import parse from 'remark-parse'
import stringify from 'remark-stringify'
import gfm from 'remark-gfm'
import math from 'remark-math'

import { noteText } from './mdtext.js'

const save = async (md) => String(await unified().use(parse).use(gfm).use(math)
  .use(stringify, { bullet: '-', rule: '-', handlers: { text: noteText } }).process(md))

/** Written as it is typed, and unchanged by two saves. */
const keeps = [
  '[[2026-10-29-노트]] 링크',
  '본문 가운데 [[노트]] 와 ![[a.png|400]] 그림',
  '![[AsAd v2.3 guide.pdf]]',
  '#태그 로 시작하는 줄',
  '줄 가운데 #태그 와 #CENS-Frontier-2026',
  'AT&T, 2*3, ~/web_service, ${VAR}, a_b_c, 50%, 2^10',
  '꺾쇠 a < b, <number>, --> 와 \\*별표는 그대로\\*는 아니고',
  '달러 $5 와 수식 $x^2$',
  '문단 다음 줄\n2. 리스트가 아닌 줄\n3) 이것도',
  '| 표 | [[링크]] | a & b |\n| --- | --- | --- |\n| `코드` | 2*3 | x \\| y |',
  '- 할 일 #태그 📅 2026-12-24\n- 다음 [[노트]]',
  '1. 진짜 목록\n2. 둘째',
  '> 인용 안의 [[노트]]',
  'C:\\Users\\jungwoo 와 줄바꿈 \\n',
  // A LaTeX backslash is a character, not an escape — it has to come back.
  '수식 \\\\(^{12}\\\\mathrm C\\\\) 과 \\\\(4\\\\times10^{-4}\\\\)',
]
for (const md of keeps) {
  const once = await save(md)
  const twice = await save(once)
  assert.equal(twice, once, `not stable:\n  ${JSON.stringify(md)}\n  ${JSON.stringify(once)}`)
  // Nothing this app means literally comes back wearing a backslash.
  const hedge = once.match(/\\[#*~[\]&$_]|^[ \t]*\d+\\[.)]/m)
  assert.equal(hedge, null, `escaped: ${JSON.stringify(once)} in ${JSON.stringify(md)}`)
}

/** Written WITH a backslash, because without it the line changes shape. */
const guards = [
  ['\\* 별표로 시작하는 줄', /^\\\*/],
  ['\\- 하이픈으로 시작', /^\\-/],
  ['\\# 공백이 따라오는 해시', /^\\#/],
  ['\\> 꺾쇠로 시작', /^\\>/],
  ['1\\. 번호가 아닌 줄', /^1\\\./],
  // An entity is decoded when the file is READ (`&nbsp;` becomes the space it
  // names), so what this guards is one that was already written escaped.
  ['\\&nbsp; 는 글자가 아니라 이름', /\\&nbsp;/],
]
for (const [md, want] of guards) {
  const once = await save(md)
  assert.match(once, want, `lost its guard: ${JSON.stringify(once)}`)
  assert.equal(await save(once), once, `not stable: ${JSON.stringify(once)}`)
}

/** A real list stays a list; a real table stays a table. */
assert.equal((await save('1. a\n2. b')).trim(), '1. a\n2. b')
assert.equal((await save('- a\n- b')).trim(), '- a\n- b')
assert.match(await save('| a | b |\n| --- | --- |\n| 1 | 2 |'),
  /^\| a \| b \|\n\| -+ \| -+ \|\n\| 1 \| 2 \|$/m)

console.log('mdtext: ok —', keeps.length + guards.length + 3, 'cases')
