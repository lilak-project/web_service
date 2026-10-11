import { createRoot } from 'react-dom/client'
import { RackService } from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import './widgets.jsx'
import def from './def.jsx'

// The whole service is its declaration (def.jsx), its own widgets
// (widgets.jsx) and what makes a reference a reference (paper.js).
createRoot(document.getElementById('root')).render(<RackService def={def} />)
