import { useEffect, useState } from 'react'
import { Button, tr } from 'lilak-ui'
import { launcher, errText } from '../../api'
import { notify } from './settingsMsg'
import { Field, FieldActions, Panel, fieldInput, fieldMuted } from './Field'

/** Manage sidebar, own layout: one card — this account's name for it, and hiding it. */
/** A project card's name is its project's display name: the same in the sidebar,
 *  the service's project list, MCP and record addresses' labels. Renamed here by
 *  whoever may manage the project; anyone else sees it. */
function ProjectName({ card, onChanged }) {
  const svc = card.name, proj = card.project_card
  const [p, setP] = useState(null)
  const [name, setName] = useState('')
  const load = () => launcher.get(`/services/${svc}/projects`)
    .then((r) => { const x = (r.data || []).find((q) => q.name === proj); setP(x || {}); setName(x?.label || '') })
    .catch(() => setP({}))
  useEffect(() => { load() }, [svc, proj])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Field label={tr('p_proj_name')}><span style={fieldMuted}>…</span></Field>
  if (!p.can_manage) return <Field label={tr('p_proj_name')}>{p.label || proj}</Field>
  const save = async () => {
    try {
      await launcher.put(`/services/${svc}/projects/${proj}/name`, { name: name.trim() })
      notify(tr('p_proj_name_saved'), 'ok'); await load(); onChanged?.()
    } catch (e) { notify(errText(e), 'bad') }
  }
  return (
    <>
      <Field label={tr('p_proj_name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={proj}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() !== (p.label || '')) save() }}
          style={{ ...fieldInput, flex: 1 }} maxLength={80} />
        <span style={fieldMuted}>{tr('p_proj_name_hint', proj)}</span>
      </Field>
      <FieldActions>
        <Button variant="primary" disabled={name.trim() === (p.label || '')} onClick={save}>{tr('p_update')}</Button>
      </FieldActions>
    </>
  )
}

export function MyCardPanel({ card, personal, onChanged }) {
  const key = card.project_card ? `${card.name}/${card.project_card}` : card.name
  // The name this card shows by default: for a project card that is the project's
  // name, not the service's (card.name is the service id).
  const def = card.default_label || card.label || card.name
  const [name, setName] = useState(card.my_label || '')
  useEffect(() => { setName(card.my_label || '') }, [key, card.my_label])
  return (
    <>
      <h1 className="pl-mgtitle">{card.label || card.name}</h1>
      {card.project_card && (
        <Panel title={tr('p_proj_name_title')} hint={tr('p_proj_name_everyone')}>
          <ProjectName card={card} onChanged={onChanged} />
        </Panel>
      )}
      <Panel title={tr('p_my_card')} hint={tr('p_my_layout_only_me')}>
        {!card.project_card && <>
        <Field label={tr('p_my_name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={def}
            style={{ ...fieldInput, flex: 1 }} maxLength={80} />
          <span style={fieldMuted}>{tr('p_my_name_hint', def)}</span>
        </Field>
        <FieldActions>
          <Button variant="primary" disabled={name.trim() === (card.my_label || '')}
            onClick={() => personal.setLabel(key, name)}>{tr('p_update')}</Button>
          {card.my_label && <Button variant="secondary" onClick={() => { setName(''); personal.setLabel(key, '') }}>{tr('p_my_name_reset')}</Button>}
        </FieldActions>
        </>}
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
