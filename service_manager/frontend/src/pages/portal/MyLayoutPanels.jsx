import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { Field, FieldActions, Panel, fieldInput, fieldMuted } from './Field'

/** Manage sidebar, own layout: one card — this account's name for it, and hiding it. */
export function MyCardPanel({ card, personal }) {
  const key = card.project_card ? `${card.name}/${card.project_card}` : card.name
  const [name, setName] = useState(card.my_label || '')
  useEffect(() => { setName(card.my_label || '') }, [key, card.my_label])
  return (
    <>
      <h1 className="pl-mgtitle">{card.label || card.name}</h1>
      <Panel title={tr('p_my_card')} hint={tr('p_my_layout_only_me')}>
        <Field label={tr('p_my_name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={card.default_label || card.name}
            style={{ ...fieldInput, flex: 1 }} maxLength={80} />
          <span style={fieldMuted}>{tr('p_my_name_hint', card.default_label || card.name)}</span>
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={name.trim() === (card.my_label || '')}
            onClick={() => personal.setLabel(key, name)}>{tr('p_update')}</Button>
          {card.my_label && <Button variant="secondary" onClick={() => { setName(''); personal.setLabel(key, '') }}>{tr('p_my_name_reset')}</Button>}
        </FieldActions>
        <Field label={tr('p_my_hidden')}>
          <Button variant="secondary" onClick={() => personal.hideCard(key, !card.hidden)}>
            {tr(card.hidden ? 'p_my_show' : 'p_my_hide')}
          </Button>
        </Field>
      </Panel>
    </>
  )
}

/** Manage sidebar, own layout: one of this account's groups. */
export function MyGroupPanel({ group, personal }) {
  const [name, setName] = useState(group.name || '')
  const [sure, setSure] = useState(false)
  useEffect(() => { setName(group.name || ''); setSure(false) }, [group.id, group.name])
  return (
    <>
      <h1 className="pl-mgtitle">{group.name || tr('p_group')}</h1>
      <Panel title={tr('p_my_group')} hint={tr('p_my_layout_only_me')}>
        <Field label={tr('p_my_name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...fieldInput, flex: 1 }} maxLength={80} />
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={!name.trim() || name.trim() === group.name}
            onClick={() => personal.renameGroup(group.id, name)}>{tr('p_update')}</Button>
        </FieldActions>
        <Field label={tr('p_my_hidden')}>
          <Button variant="secondary" onClick={() => personal.hideGroup(group.id, !group.hidden)}>
            {tr(group.hidden ? 'p_my_show' : 'p_my_hide')}
          </Button>
        </Field>
        {/* Two steps, in the page: confirm() is swallowed inside the portal frame. */}
        <Field label={tr('p_my_group_delete')}>
          {sure ? (<>
            <Button variant="dangerSoft" onClick={() => personal.deleteGroup(group.id)}>{tr('p_my_group_delete_yes')}</Button>
            <Button variant="secondary" onClick={() => setSure(false)}>{tr('p_cancel')}</Button>
          </>) : (
            <Button variant="secondary" onClick={() => setSure(true)}>{tr('p_my_group_delete')}</Button>
          )}
          <span style={fieldMuted}>{tr('p_my_group_delete_hint')}</span>
        </Field>
      </Panel>
    </>
  )
}
