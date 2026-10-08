import React from 'react'
import { createRoot } from 'react-dom/client'
import App, { PrintView } from './App.jsx'

// ?print=<ids> is a page of its own, opened in a tab rather than in the
// portal's frame: the browser's printer should be handed the notes, not the
// portal around them.
const ids = new URLSearchParams(window.location.search).get('print')
createRoot(document.getElementById('root')).render(
  ids ? <PrintView ids={ids.split(',').filter(Boolean)} /> : <App />,
)
