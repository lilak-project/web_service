import { useLang } from '../../context/LangContext'
import { Panel, Field, Row, Pill, FIELD_CARD_CLASS } from './Field'
import INVENTORY from './rack.json'

/**
 * RackView — the RACK rules, read inside the portal.
 *
 * Built out of the parts it documents, so it cannot describe a rack it is not
 * standing on: change `.set-bar`'s height and this page's own nameplates move
 * with it. The screen list comes from `rack.json`, which `scripts/rack.py
 * --write` generates from the source — the page never keeps its own copy of
 * who is on the rack.
 *
 * Manager-only, in the System band: it is documentation of the portal's own
 * construction, not something a user of a service needs.
 */

const PLATES = [
  { ko: '파랑', bg: 'var(--info-bg)', fg: 'var(--text-emphasis)',
    what: ['설정', 'Settings'], where: ['내 계정 · 그룹 · 초대 · 시스템 · 로그인', 'account · groups · invites · system · sign-in'] },
  { ko: '보라', bg: '#ede9fe', fg: 'var(--text-emphasis)',
    what: ['관리', 'Manage'], where: ['서비스와 그룹을 고쳐 쓰는 화면', 'the screens that edit services and groups'] },
  { ko: '먹색', bg: 'var(--text-primary)', fg: 'var(--text-inverse, #fff)',
    what: ['도구', 'Tool'], where: ['포털 자신을 다루는 붙박이', 'the builtins that work on the portal itself'] },
  { ko: '빨강', bg: 'var(--danger-bg, #fee2e2)', fg: 'var(--danger-text, #b91c1c)',
    what: ['위험', 'Danger'], where: ['되돌릴 수 없는 것. 한 화면에 하나, 맨 아래', 'what cannot be undone: one per screen, at the foot'] },
]

export default function RackView() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const P = (pair) => L(pair[0], pair[1])

  // The parts, each row carrying a live specimen of itself.
  const parts = [
    ['모듈', '.set-panel', 'Panel', L('회색 바닥 위의 흰 상자', 'the white box on the grey ground')],
    ['명판', '.set-bar', 'Panel title', L('모듈의 제목이자 종류 표시. 화면에서 굵은 글자는 이것뿐', 'the title AND the kind: the only bold text on a screen')],
    ['표', '.set-card', 'Field', L('이름/값 두 칸 격자', 'the label/value grid')],
    ['채널', '.set-row', 'Row', L('기록 한 건', 'one record')],
    ['표시등', '.set-pill', 'Pill', L('상태', 'state')],
  ]

  const byPlate = PLATES.map((p) => [p, INVENTORY.filter((s) => s.plate === p.ko)])
  const loose = INVENTORY.filter((s) => !PLATES.some((p) => p.ko === s.plate))
  const cols = { gridTemplateColumns: '1fr 150px' }

  return (
    <>
      <Panel title={L('규칙 셋', 'Three rules')}
        hint={L('모든 화면이 지킵니다', 'every screen obeys them')}>
        <Field label="1">{L('화면은 회색 바닥입니다. 내용이 바닥에 직접 놓이지 않고 흰 모듈 위에 놓입니다.',
          'A screen is a grey ground. Content never sits on it directly — it sits on white modules.')}</Field>
        <Field label="2">{L('모듈의 제목은 위에 떠 있는 제목이 아니라 명판입니다.',
          "A module's title is its nameplate, not a heading floating above it.")}</Field>
        <Field label="3">{L('모듈 안은 전부 한 크기의 줄입니다. 세로줄은 긋지 않습니다.',
          'Inside a module everything is a row of one text size. No vertical rules.')}</Field>
      </Panel>

      <Panel title={L('부품', 'Parts')} bare
        hint={L('이 화면도 같은 부품으로 짜여 있습니다', 'this screen is built out of them too')}>
        <Row className="cols head" style={{ gridTemplateColumns: '90px 110px 110px 1fr' }}>
          <span>{L('이름', 'Name')}</span><span>CSS</span><span>JSX</span><span>{L('무엇', 'What')}</span>
        </Row>
        {parts.map(([name, cls, jsx, what]) => (
          <Row key={cls} className="cols" style={{ gridTemplateColumns: '90px 110px 110px 1fr' }}>
            <b>{name}</b>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{cls}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{jsx}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{what}</span>
          </Row>
        ))}
      </Panel>

      <Panel title={L('명판 색', 'Nameplates')} bare
        hint={L('색이 화면의 종류를 말합니다', 'the colour says what kind of screen it is')}>
        {PLATES.map((p) => (
          <Row key={p.ko} className="cols" style={{ gridTemplateColumns: '108px 90px 1fr' }}>
            {/* The swatch is a nameplate, at its real height. */}
            <span style={{ display: 'grid', placeItems: 'center', height: 34, background: p.bg,
              color: p.fg, border: '1px solid var(--border-strong)', borderRadius: 3, fontWeight: 700 }}>
              {P(p.what)}
            </span>
            <b>{p.ko}</b>
            <span style={{ color: 'var(--text-secondary)' }}>{P(p.where)}</span>
          </Row>
        ))}
      </Panel>

      <Panel title={L('치수', 'Dimensions')}>
        <Field label={L('명판', 'Nameplate')}>34px</Field>
        <Field label={L('줄', 'Row')}>{L('위아래 7px · 좌우 13px', '7px vertical · 13px horizontal')}</Field>
        <Field label={L('컨트롤', 'Controls')}>{L('버튼과 입력 28px · 모서리 5px', 'buttons and inputs 28px · radius 5px')}</Field>
        <Field label={L('모듈 사이', 'Between modules')}>8px</Field>
        <Field label={L('글자', 'Text')}>{L('한 크기', 'one size')} <span style={{ fontFamily: 'var(--font-mono)' }}>--fs-medium</span></Field>
      </Panel>

      <Panel title={L('랙에 꽂힌 화면', 'On the rack')} bare
        hint={`${INVENTORY.length}${L('장', '')}`}>
        {byPlate.map(([p, list]) => list.length > 0 && (
          <div key={p.ko}>
            <Row className="cols head" style={cols}>
              <span>{p.ko} · {P(p.what)}</span>
              <span>{L('부품', 'Parts')}</span>
            </Row>
            {list.map((s) => (
              <Row key={s.path} className="cols" style={cols}>
                <span style={{ fontFamily: 'var(--font-mono)', minWidth: 0, overflowWrap: 'anywhere' }}>
                  {s.path}
                  {s.handrolled && <> <Pill tone="warn">{L('직접 마크업', 'hand-rolled')}</Pill></>}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{s.parts.join('·')}</span>
              </Row>
            ))}
          </div>
        ))}
        {loose.length > 0 && (
          <>
            <Row className="cols head" style={cols}>
              <span>{L('명판 미정 · 어느 화면에도 안 걸림', 'unfiled — on no screen yet')}</span>
              <span>{L('부품', 'Parts')}</span>
            </Row>
            {loose.map((s) => (
              <Row key={s.path} className="cols" style={cols}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{s.path}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{s.parts.join('·')}</span>
              </Row>
            ))}
          </>
        )}
      </Panel>

      <Panel title={L('룰을 바꿀 때', 'Changing a rule')}>
        <Field label="1"><span style={{ fontFamily: 'var(--font-mono)' }}>Field.jsx</span> {L('나', 'or')} <span style={{ fontFamily: 'var(--font-mono)' }}>settings.css</span> {L('를 고칩니다', '')}</Field>
        <Field label="2">
          <span style={{ fontFamily: 'var(--font-mono)' }}>python3 scripts/rack.py --check</span>
          <span style={{ color: 'var(--text-secondary)' }}>{L('표가 어긋나면 알려줍니다', 'it fails when the table has drifted')}</span>
        </Field>
        <Field label="3">{L('위 목록의 화면을 명판 색깔별로 최소 한 장씩 열어봅니다.',
          'Open at least one screen per nameplate colour from the list above.')}</Field>
        <Field label="4">{L('화면이 늘거나 줄었으면 --write 로 표를 갱신하고 명판 칸을 채웁니다.',
          'A screen joined or left: --write the table, then fill in its nameplate.')}</Field>
        <Field label={L('원본', 'Source')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>frontend/src/pages/portal/RACK.md</span>
        </Field>
      </Panel>
    </>
  )
}
