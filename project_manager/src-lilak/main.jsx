import './strings.js'
import { createRoot } from 'react-dom/client'
import { RackService } from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import def from './def.jsx'

// The whole service is its declaration (def.jsx; the inbox's buttons in inbox.jsx).
createRoot(document.getElementById('root')).render(<RackService def={def} />)
