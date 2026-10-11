import { createRoot } from 'react-dom/client'
import { RackService } from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import def from './def.js'

// The whole service is its declaration. Anything it cannot say goes in
// <RackService slots={…}> or registerType() — see lilak_ui/src/racklist/service.jsx.
createRoot(document.getElementById('root')).render(<RackService def={def} />)
