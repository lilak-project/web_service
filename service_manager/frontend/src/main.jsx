import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { loadFonts } from 'lilak-ui'
import { LangProvider } from './context/LangContext'
import ProjectsPage from './pages/ProjectsPage'
import './index.css'

// Load the kit fonts + define --font-sans/--font-mono (theme colours come from
// index.css tokens, copied from the kit's token system).
loadFonts()

// The portal is ONLY the cover: both `/` and `/projects` render ProjectsPage.
// There is deliberately no elog workspace route, so nothing can mount and try to
// reach an elog backend that the portal doesn't implement.
function App() {
  return (
    <LangProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </BrowserRouter>
    </LangProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
