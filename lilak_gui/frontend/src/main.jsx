import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyTheme, setTheme, loadFonts } from 'lilak-ui'
import App from './App.jsx'
import { applyPurple } from './theme/purple.js'
import './index.css'

// Theme bootstrap, in order:
//   applyTheme() — inject the kit's CSS custom properties for the active theme
//   setTheme('bright') — pin to bright: it's the only offered theme (purple is
//     fixed, so dark/lowcontrast barely differ) and this clears any stale 'dark'
//     a returning user may have saved.
//   loadFonts()  — load Pretendard / IBM Plex Sans / D2Coding + set --font-sans
//   applyPurple()— override the accent + nav tokens to purple (lilak_gui's color)
applyTheme()
setTheme('bright')
loadFonts()
applyPurple()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
