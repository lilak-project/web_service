import { tr } from 'lilak-ui'
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
  { key: '설정', plate: 'var(--plate-settings)', fg: 'var(--text-emphasis)', border: 'var(--border-strong)',
    colour: ['회색', 'grey'], what: ['설정', 'Settings'],
    where: ['내 계정 · 그룹 · 초대 · 시스템 · 로그인', 'account · groups · invites · system · sign-in'] },
  { key: '관리', plate: 'var(--plate-manage)', fg: 'var(--text-emphasis)', border: 'var(--border-strong)',
    colour: ['연한 겨자', 'mustard'], what: ['관리', 'Manage'],
    where: ['서비스와 그룹을 고쳐 쓰는 화면', 'the screens that edit services and groups'] },
  { key: '도구', plate: 'var(--plate-tool)', fg: 'var(--text-emphasis)', border: 'var(--border-strong)',
    colour: ['파랑', 'blue'], what: ['도구', 'Tool'],
    where: ['포털 자신을 다루는 붙박이 — 이 화면도 그중 하나', 'the builtins that work on the portal itself — this screen is one'] },
  { key: '위험', plate: 'var(--danger-bg, #fee2e2)', fg: 'var(--danger-text, #b91c1c)', border: 'var(--danger-border, #fca5a5)',
    colour: ['빨강', 'red'], what: ['위험', 'Danger'],
    where: ['되돌릴 수 없는 것. 계정 삭제 · 서비스 보관 · 그룹 삭제', 'what cannot be undone: delete account, archive service, delete group'] },
]

export default function RackView() {
  const { lang } = useLang()
  const L = (ko, en) => (lang === 'ko' ? ko : en)
  const P = (pair) => L(pair[0], pair[1])

  // The parts, each row carrying a live specimen of itself.
  const parts = [
    ['모듈', '.set-panel', 'Panel', tr("p_the_white_box_on_the")],
    ['명판', '.set-bar', 'Panel title', tr("p_the_title_and_the_kind")],
    ['표', '.set-card', 'Field', tr("p_the_label_value_grid")],
    ['채널', '.set-row', 'Row', tr("p_one_record")],
    ['표시등', '.set-pill', 'Pill', tr("p_state")],
  ]

  const byPlate = PLATES.map((p) => [p, INVENTORY.filter((s) => s.plate === p.key)])
  const loose = INVENTORY.filter((s) => !PLATES.some((p) => p.key === s.plate))
  const cols = { gridTemplateColumns: '1fr 150px' }

  return (
    <>
      <Panel title={tr("p_three_rules")}
        hint={tr("p_every_screen_obeys_them")}>
        <Field label="1">{tr("p_a_screen_is_a_grey")}</Field>
        <Field label="2">{tr("p_a_module_s_title_is")}</Field>
        <Field label="3">{tr("p_inside_a_module_everything_is")}</Field>
      </Panel>

      <Panel title={tr("p_parts")} bare
        hint={tr("p_this_screen_is_built_out")}>
        <Row className="cols head" style={{ gridTemplateColumns: '90px 110px 110px 1fr' }}>
          <span>{tr("p_name")}</span><span>CSS</span><span>JSX</span><span>{tr("p_what")}</span>
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
      <h2>{tr("p_nameplates_the_colour_says_what")}</h2>
      {PLATES.map((p) => (
        <Panel key={p.key} title={`${P(p.what)} · ${P(p.colour)}`} hint={P(p.where)}
          bare style={{ '--plate': p.plate, '--plate-fg': p.fg, '--plate-border': p.border }} />
      ))}

      <Panel title={tr("p_dimensions")}>
        <Field label={tr("p_one_line")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-row</span> = 36px
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_nameplate_column_head_and_record")}</span>
        </Field>
        <Field label={tr("p_how_a_line_behaves")}>
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_a_floor_for_record_rows")}</span>
        </Field>
        <Field label={tr("p_column")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-col</span> = 760px
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_every_rack_screen_is_this")}</span>
        </Field>
        <Field label={tr("p_controls")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-ctl</span> = 28px
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_one_step_inside_the_line")}</span>
        </Field>
        <Field label={tr("p_corners")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-radius</span> = 0
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_the_whole_portal_is_square")}</span>
        </Field>
        <Field label={tr("p_between_modules")}>8px</Field>
        <Field label={tr("p_glyph")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--fs-medium</span>
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_one_size_buttons_and_tags")}</span>
        </Field>
        <Field label={tr("p_weight")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>--rack-weight</span> = 400
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_no_bold_the_face_ships")}</span>
        </Field>
      </Panel>

      <Panel title={tr("p_on_the_rack")} bare
        hint={`${INVENTORY.length}${tr("p_unit_sheets")}`}>
        {byPlate.map(([p, list]) => list.length > 0 && (
          <div key={p.key}>
            <Row className="cols head" style={cols}>
              <span>{P(p.what)} · {P(p.colour)}</span>
              <span>{tr("p_parts")}</span>
            </Row>
            {list.map((s) => (
              <Row key={s.path} className="cols" style={cols}>
                <span style={{ fontFamily: 'var(--font-mono)', minWidth: 0, overflowWrap: 'anywhere' }}>
                  {s.path}
                  {s.handrolled && <> <Pill tone="warn">{tr("p_hand_rolled")}</Pill></>}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{s.parts.join('·')}</span>
              </Row>
            ))}
          </div>
        ))}
        {loose.length > 0 && (
          <>
            <Row className="cols head" style={cols}>
              <span>{tr("p_unfiled_on_no_screen_yet")}</span>
              <span>{tr("p_parts")}</span>
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

      <Panel title={tr("p_changing_a_rule")}>
        <Field label="1"><span style={{ fontFamily: 'var(--font-mono)' }}>Field.jsx</span> {tr("p_or")} <span style={{ fontFamily: 'var(--font-mono)' }}>settings.css</span> {tr("p_edit_suffix")}</Field>
        <Field label="2">
          <span style={{ fontFamily: 'var(--font-mono)' }}>python3 scripts/rack.py --check</span>
          <span style={{ color: 'var(--text-secondary)' }}>{tr("p_it_fails_when_the_table")}</span>
        </Field>
        <Field label="3">{tr("p_open_at_least_one_screen")}</Field>
        <Field label="4">{tr("p_a_screen_joined_or_left")}</Field>
        <Field label={tr("p_source")}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>frontend/src/pages/portal/RACK.md</span>
        </Field>
      </Panel>
    </>
  )
}
