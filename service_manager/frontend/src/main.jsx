import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
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
// Normalising the path must not throw the query away: the sidebar cover keeps the
// selected service in `?s=&p=`, so a link to /?s=elog&p=KO2421 has to survive the
// redirect to /projects.
function ToProjects() {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: '/projects', search, hash }} replace />
}

function App() {
  return (
    <LangProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="*" element={<ToProjects />} />
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
