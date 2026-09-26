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
  { ko: '파랑', plate: 'var(--info-bg)', fg: 'var(--text-emphasis)', border: 'var(--border-strong)',
    what: ['설정', 'Settings'], where: ['내 계정 · 그룹 · 초대 · 시스템 · 로그인', 'account · groups · invites · system · sign-in'] },
  { ko: '보라', plate: 'var(--plate-manage)', fg: 'var(--text-emphasis)', border: 'var(--border-strong)',
    what: ['관리', 'Manage'], where: ['서비스와 그룹을 고쳐 쓰는 화면', 'the screens that edit services and groups'] },
  { ko: '먹색', plate: 'var(--plate-tool)', fg: 'var(--text-inverse, #fff)', border: 'var(--plate-tool)',
    what: ['도구', 'Tool'], where: ['포털 자신을 다루는 붙박이 — 이 화면도 그중 하나', 'the builtins that work on the portal itself — this screen is one'] },
  { ko: '빨강', plate: 'var(--danger-bg, #fee2e2)', fg: 'var(--danger-text, #b91c1c)', border: 'var(--danger-border, #fca5a5)',
    what: ['위험', 'Danger'], where: ['되돌릴 수 없는 것. 한 화면에 하나, 맨 아래', 'what cannot be undone: one per screen, at the foot'] },
]

export default function RackView() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const P = (pair) => L(pair[0], pair[1])

  // The parts, each row carrying a live specimen of itself.
  const parts = [
    ['모듈', '.set-panel', 'Panel', L('회색 바닥 위의 흰 상자', 'the white box on the grey ground')],
    ['명판', '.set-bar', 'Panel title', L('모듈의 제목이자 종류. 줄과 같은 높이', 'the title and the kind, at the height of a row')],
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
        <Field label="2">{L('모듈의 제목은 위에 떠 있는 제목이 아니라 명판입니다. 띠 색이 종류를 말하므로 굵게 쓰지 않습니다.',
          "A module's title is its nameplate, not a heading floating above it. The strip's colour says the kind, so the text is not bold.")}</Field>
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
            <span>{name}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{cls}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{jsx}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{what}</span>
          </Row>
        ))}
      </Panel>

      {/* Not a table of colour chips: four real panels, each wearing its own
          plate. The colour is a thing you can point at, and the specimen is
          made the same way every screen makes one. */}
      <h2>{L('명판 색 — 색이 화면의 종류를 말합니다', 'Nameplates — the colour says what kind of screen it is')}</h2>
      {PLATES.map((p) => (
        <Panel key={p.ko} title={`${p.ko} · ${P(p.what)}`} hint={P(p.where)}
          bare style={{ '--plate': p.plate, '--plate-fg': p.fg, '--plate-border': p.border }} />
      ))}

      <Panel title={L('치수', 'Dimensions')}>
        <Field label={L('한 줄', 'One line')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-row</span> = 36px
          <span style={{ color: 'var(--text-secondary)' }}>{L('명판 · 머리줄 · 기록줄이 모두 같은 높이', 'nameplate, column head and record are all this height')}</span>
        </Field>
        <Field label={L('줄의 규칙', 'How a line behaves')}>
          <span style={{ color: 'var(--text-secondary)' }}>{L('채널에는 바닥(늘어날 수 있음), 표 줄에는 고정 — 넘치면 말줄임', 'a floor for record rows, fixed for table rows, ellipsised when it overruns')}</span>
        </Field>
        <Field label={L('칸', 'Column')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-col</span> = 760px
          <span style={{ color: 'var(--text-secondary)' }}>{L('모든 랙 화면이 이 칸으로 가운데 정렬됩니다', 'every rack screen is this column, centred')}</span>
        </Field>
        <Field label={L('컨트롤', 'Controls')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-ctl</span> = 28px
          <span style={{ color: 'var(--text-secondary)' }}>{L('줄에서 한 단계 안쪽 — 줄 높이를 바꾸면 같이 움직입니다', 'one step inside the line, so it moves when the line does')}</span>
        </Field>
        <Field label={L('모서리', 'Corners')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-radius</span> = 0
          <span style={{ color: 'var(--text-secondary)' }}>{L('포털 전체가 직각입니다. 둥근 물건을 그리는 것만 예외 — 표시등의 둥근 끝, 아바타, 아이콘 미리보기.', 'the whole portal is square. The exceptions draw a rounded object rather than being chrome: the pill, avatars, icon previews.')}</span>
        </Field>
        <Field label={L('모듈 사이', 'Between modules')}>8px</Field>
        <Field label={L('글자', 'Text')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--fs-medium</span>
          <span style={{ color: 'var(--text-secondary)' }}>{L('한 크기. 버튼과 태그도 예외가 아닙니다', 'one size — buttons and tags included')}</span>
        </Field>
        <Field label={L('굵기', 'Weight')}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-weight</span> = 400
          <span style={{ color: 'var(--text-secondary)' }}>{L('굵게 쓰지 않습니다. 서체가 400과 700만 실어서, 500은 브라우저가 700으로 그립니다', 'no bold: the face ships 400 and 700 only, so 500 was being rendered as 700')}</span>
        </Field>
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
