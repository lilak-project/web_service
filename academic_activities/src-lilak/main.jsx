import { createRoot } from 'react-dom/client'
import { RackService, isManager } from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import def from './def.js'
import { GcalPanel } from './gcal.jsx'

// The whole service is its declaration. Anything it cannot say goes in
// <RackService slots={…}> or registerType() — see lilak_ui/src/racklist/service.jsx.
// A manager's settings tab also holds the Google Calendar link (gcal.jsx, backend/gcal.py).
const slots = isManager() ? { settings: () => <GcalPanel /> } : {}
createRoot(document.getElementById('root')).render(<RackService def={def} slots={slots} />)
