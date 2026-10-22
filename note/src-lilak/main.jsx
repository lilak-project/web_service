import React from 'react'
import { createRoot } from 'react-dom/client'
import App, { PrintView, SoloNote } from './App.jsx'

// ?print=<ids> is a page of its own, opened in a tab rather than in the
// portal's frame: the browser's printer should be handed the notes, not the
// portal around them.
const q = new URLSearchParams(window.location.search)
const ids = q.get('print')
// ?solo=<id>: that note's editor alone, for another service to show in a tab.
const solo = q.get('solo')
// A sheet of paper is taller than the window: this page scrolls, unlike the
// RACK screen the kit's body rule was written for.
if (ids) document.body.classList.add('nt-paper')
createRoot(document.getElementById('root')).render(
  ids ? <PrintView ids={ids.split(',').filter(Boolean)} /> : solo ? <SoloNote id={solo} /> : <App />,
)
