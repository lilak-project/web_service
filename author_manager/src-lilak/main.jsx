import { createRoot } from 'react-dom/client'
import { RackService } from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import { AuthorCommands, EditMany } from './widgets.jsx'
import def from './def.jsx'

// The whole service is its declaration (def.jsx), its own widgets
// (widgets.jsx) and what makes an author an author (people.js). Two things go
// in as slots: the group buttons on the command line, and editing many at once
// — which, for people, is about the affiliations and groups they share.
const slots = {
  commands: (api) => <AuthorCommands api={api} />,
  editors: {
    many: (etab, api) => (
      <EditMany ids={etab.ids || []} doc={api.doc} onSave={api.commit} say={api.setNote}
        onDone={() => api.closeEdit(etab.id)} onCancel={() => api.closeEdit(etab.id)} />
    ),
  },
}

createRoot(document.getElementById('root')).render(<RackService def={def} slots={slots} />)
