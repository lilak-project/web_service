/**
 * project manager — the declaration. A project is a tag (or several, matched
 * all or any) with a name, a period, a description and a folder. Its tags tab
 * lists EVERY service's tags (`shared`): a tag's editor renames or merges it
 * everywhere and shows what wears it in each service, opening here.
 */
import './strings.js'
import { tr } from 'lilak-ui'
import { isManager } from 'lilak-ui/racklist'
import { InboxActions, MakesField } from './inbox.jsx'

// The kinds an activity is stored with (Korean in the data) — as academic_activities/src-lilak/def.js GROUPS has them.
const KINDS = ['학회', '워크샵', '학술미팅', '연구출장', '미팅', '세미나', '강연', '교육', '실험', '보고서', '제안서', '기타', '행사']
const isAct = (r) => r.target === 'activity'
const isNote = (r) => r.target === 'note'
const fromMail = () => true                       // the mail's own facts: shown, not edited

export default {
  name: 'project_manager', title: tr('pm_title'), unit: tr('pm_unit'), key: 'pm',
  item: {
    key: 'projects', noun: tr('pm_project'), allLabel: tr('pm_projects'), label: 'name',
    columns: ['name', 'tags', 'match', 'start', 'end', 'folder'],
    fields: [
      { k: 'name', label: tr('pm_name'), type: 'text', col: 240, required: true },
      { k: 'tags', label: tr('pm_tags'), type: 'tags', col: 220 },
      { k: 'match', label: tr('pm_match'), type: 'select', col: 70, default: 'and', hint: tr('pm_match_hint'),
        options: [['and', tr('pm_and')], ['or', tr('pm_or')]] },
      { k: 'start', label: tr('pm_start'), type: 'date', col: 96 },
      { k: 'end', label: tr('pm_end'), type: 'date', col: 96 },
      { k: 'description', label: tr('pm_description'), type: 'longtext' },
      // The project's folder, under settings.folderRoots — named after it.
      { k: 'folder', label: tr('pm_folder'), type: 'folder', col: 40, get: (r) => r.name || '' },
    ],
  },
  classes: [
    { k: 'tags', label: tr('pm_tags'), field: 'tags', shared: true },
    // 받은편지함 — the candidates the Claude mail task proposed (backend/main.py
    // takes them in), a manager's to approve: one list, waiting first, the
    // buttons in its last column (inbox.jsx).
    { k: 'inbox', label: tr('pm_inbox'), noun: tr('pm_ib_noun'), count: false, tab: isManager() ? undefined : false,
      rowLabel: (r) => (isNote(r) ? r.title : r.name),
      actions: (f, setF, ctx) => <InboxActions r={f} ctx={ctx} after={(ch) => setF((s) => ({ ...s, ...ch }))} />,
      fields: [
        { k: 'target', label: tr('pm_ib_kind'), type: 'select', col: 56, disabled: fromMail,
          options: [['activity', tr('pm_ib_activity')], ['note', tr('pm_ib_note')]] },
        { k: 'what', label: tr('pm_ib_title'), col: 280, get: (r) => (isNote(r) ? r.title : r.name) || '' },
        { k: 'status', label: tr('pm_ib_status'), type: 'select', col: 80, disabled: fromMail,
          options: [['waiting', tr('pm_ib_waiting_s')], ['approved', tr('pm_ib_approved_s')], ['discarded', tr('pm_ib_discarded_s')]] },
        { k: 'act', label: '', col: 166, edit: false, cell: (r, ctx) => <InboxActions r={r} ctx={ctx} /> },
        { k: 'from', label: tr('pm_ib_from'), type: 'text', col: 180, tone: 'dim', disabled: fromMail },
        { k: 'date', label: tr('pm_ib_date'), type: 'text', col: 92, tone: 'dim', disabled: fromMail },
        { k: 'subject', label: tr('pm_ib_mail'), type: 'text', disabled: fromMail },
        { k: 'remark', label: tr('pm_ib_remark'), type: 'text', col: 220, tone: 'dim', disabled: fromMail },
        // an activity's
        { k: 'name', label: 'name', type: 'text', when: isAct },
        { k: 'kind', label: 'kind', type: 'select', when: isAct, options: KINDS.map((k) => [k, k]) },
        { k: 'start', label: 'start', type: 'date', when: isAct },
        { k: 'startTime', label: 'startTime', type: 'time', when: isAct },
        { k: 'end', label: 'end', type: 'date', when: isAct },
        { k: 'endTime', label: 'endTime', type: 'time', when: isAct },
        { k: 'place', label: 'place', type: 'text', when: isAct },
        { k: 'link', label: 'link', type: 'url', when: isAct },
        { k: 'comment', label: 'comment', type: 'longtext', when: isAct },
        // a note's
        { k: 'title', label: 'title', type: 'text', when: isNote },
        { k: 'noteTags', label: 'tags', type: 'text', when: isNote, placeholder: '#태그 #태그' },
        { k: 'body', label: 'body', type: 'longtext', when: isNote },
        // where it goes, and what it will be
        { k: 'project', label: tr('pm_ib_project'), type: 'ref', to: 'projects', col: 120, hint: tr('pm_ib_project_hint') },
        { k: 'makes', label: tr('pm_ib_makes'), type: 'text', when: (r) => r.status === 'waiting', edit: (p) => <MakesField {...p} /> },
      ] },
  ],
}
