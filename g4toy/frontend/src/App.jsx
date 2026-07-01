import React, { useEffect, useState } from 'react'
import { LegoSmiley, SignOut } from '@phosphor-icons/react'
import SimulationTab from './SimulationTab.jsx'
import InputsTab from './InputsTab.jsx'
import AnalysisTab from './AnalysisTab.jsx'
import { fetchMe } from './api.js'

const TABS = [
  { key: 'inputs', label: 'Setup' },
  { key: 'simulation', label: 'Simulation' },
  { key: 'analysis', label: 'Analysis' },
]

function logout() {
  localStorage.removeItem('elog_token')
  localStorage.removeItem('lilak_portal_token')
  // Behind the portal, leave to the portal cover; standalone, just reload.
  location.href = window.__PORTAL_BASE__ || './'
}

export default function App() {
  const [tab, setTab] = useState('simulation')
  const [me, setMe] = useState(null)

  useEffect(() => { fetchMe().then(setMe).catch(() => setMe(null)) }, [])

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <LegoSmiley size={22} weight="duotone" />
          <span className="logo">g4toy</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`}
              onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
        <div className="account">
          {me && <span className="who">{me.name || me.username}</span>}
          <button className="signout" onClick={logout} title="나가기">
            <SignOut size={16} />
          </button>
        </div>
      </header>

      {/* keep SimulationTab mounted so its live session/scene polling survives tab
          switches; just hide it when another tab is active. */}
      <main className={tab === 'simulation' ? '' : 'hidden'}><SimulationTab /></main>
      {tab === 'inputs' && <main><InputsTab /></main>}
      {tab === 'analysis' && <main><AnalysisTab /></main>}
    </div>
  )
}
