/**
 * Shell — lilak_gui chrome, now just a thin configuration of the kit's AppShell
 * (the shared default skeleton). AppShell provides the top bar, `/` command bar,
 * `\` settings drawer, `?` shortcuts, command-mode logo dimming and tab hotkeys;
 * here we only supply lilak_gui's brand, tabs, status, purple/bright theme lock
 * and localized labels.
 */
import { useState } from 'react'
import { AppShell, useLang } from 'lilak-ui'
import { ENABLED_THEMES } from '../theme/purple'
import Placeholder from '../pages/Placeholder'

const TABS = [
  { id: 'run', icon: 'run' },
  { id: 'par', icon: 'parameters' },
  { id: 'view', icon: 'chart-line' },
  { id: 'set', icon: 'settings' },
]

export default function Shell() {
  const { t, lang } = useLang()
  const [tab, setTab] = useState('run')

  const tabs = TABS.map((x) => ({ id: x.id, label: t('tab_' + x.id), icon: x.icon }))

  // Status (idle / run#N) — placeholder until the run backend lands.
  const status = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny, 11px)', color: 'var(--nav-text)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--nav-text-muted)' }} />
      {t('status_idle')}
    </span>
  )

  // Localize AppShell's chrome strings.
  const labels = {
    help: t('cmd_help'), system: t('nav_system'), theme: t('set_theme'), language: t('set_lang'),
    account: t('nav_account'), notifications: t('notif_title'), command: t('cmd_placeholder'), shortcuts: t('shortcuts_title'),
  }

  const PAGES = {
    run: <Placeholder icon="run" title={t('tab_run')} note={t('placeholder_run')} />,
    par: <Placeholder icon="parameters" title={t('tab_par')} note={t('placeholder_par')} />,
    view: <Placeholder icon="chart-line" title={t('tab_view')} note={t('placeholder_view')} />,
    set: <Placeholder icon="settings" title={t('tab_set')} note={t('placeholder_set')} />,
  }

  return (
    <AppShell
      brand={lang === 'ko' ? '라일락' : 'lilak'}
      service={t('svc_name')}
      tabs={tabs}
      active={tab}
      onTab={setTab}
      themes={ENABLED_THEMES}
      status={status}
      labels={labels}
    >
      {/* Keep every tab mounted (display toggle) so page state survives switches. */}
      {TABS.map(({ id }) => (
        <div key={id} style={{ height: '100%', display: tab === id ? 'block' : 'none' }}>{PAGES[id]}</div>
      ))}
    </AppShell>
  )
}
