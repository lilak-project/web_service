/** What `#태그` means, checked. Run: node src-lilak/tags.check.mjs
 *
 *  The rule is copied from MarkdownArea.jsx on purpose — this file must not
 *  pull in JSX to run. If the two drift, the first case fails.
 */
import assert from 'node:assert/strict'

export const TAG_RE = /(^|[\s(])#([^\s#.,;:!?()[\]{}'"]+)/g
export const renameBodyTag = (body, from, to) =>
  String(body || '').replace(TAG_RE, (m, lead, name) => (name === from ? `${lead}#${to}` : m))

const cases = [
  ['#old 입니다', 'old', 'new', '#new 입니다'],
  ['앞에 #old 뒤에', 'old', 'new', '앞에 #new 뒤에'],
  ['(#old)', 'old', 'new', '(#new)'],
  // #oldish is its own tag, and `# ` is a heading
  ['#oldish 는 다른 태그', 'old', 'new', '#oldish 는 다른 태그'],
  ['# 제목은 태그가 아니다', '제목은', 'x', '# 제목은 태그가 아니다'],
  ['a#old 는 태그가 아니다', 'old', 'new', 'a#old 는 태그가 아니다'],
  ['#old 와 #old 둘 다', 'old', 'new', '#new 와 #new 둘 다'],
  ['#old, 쉼표 앞', 'old', 'new', '#new, 쉼표 앞'],
  ['#SpiRIT_TPC 밑줄', 'SpiRIT_TPC', 'SpiRIT', '#SpiRIT 밑줄'],
  ['#old\n줄바꿈', 'old', 'new', '#new\n줄바꿈'],
  ['#한글태그 다', '한글태그', '새태그', '#새태그 다'],
]
for (const [body, from, to, want] of cases) {
  assert.equal(renameBodyTag(body, from, to), want, JSON.stringify(body))
}
console.log(`${cases.length}개 통과`)
