#!/usr/bin/env node
/**
 * new-service — scaffold a LILAK Web Portal service from the shared base skeleton.
 *
 * Given a name, tabs and a main theme colour it writes a full-stack service that
 * already runs on the kit's AppShell (top bar + command bar + drawer + shortcuts),
 * is portal-integrated (base-path aware + SSO), and — with --settings — carries a
 * portal-centric Settings tab (account + manage-users link + service-local stubs).
 * Filling the tab bodies comes after.
 *
 * Usage:
 *   node scripts/new-service.mjs \
 *     --name mysvc --service "my svc" \
 *     --tabs "run:실행:run,view:뷰어:chart-line,set:설정:settings" \
 *     --color "#9333ea" --settings \
 *     [--brand 라일락] [--port 5160] [--backend-port 8160] [--out ~/web_service] [--force]
 *
 * Add --register to also create the portal DB row via /api/handshake:
 *     ... --register [--portal-url http://localhost:8025] [--register-token <admin token>]
 *   (token/URL also read from PORTAL_REGISTER_TOKEN / PORTAL_BASE_URL). Without
 *   --register it only writes the manifest — register later via the Services UI.
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) a[key] = true
      else { a[key] = next; i++ }
    } else a._.push(t)
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const NAME = args.name || args._[0]
if (!NAME || !/^[a-z][a-z0-9_]*$/.test(NAME)) {
  console.error('error: --name is required and must be a lowercase identifier (e.g. lilak_gui)')
  process.exit(1)
}
const OUT = resolve(expand(args.out) || join(homedir(), 'web_service'))
const SERVICE = args.service || 'app'                 // brand subtitle (lilak / <service>)
const BRAND = args.brand || '라일락'
const COLOR = (args.color || '#9333ea').toLowerCase()
const WITH_SETTINGS = !!args.settings
const PORT = Number(args.port) || 5160
const BPORT = Number(args['backend-port']) || 8160
const FORCE = !!args.force
// Portal-managed "live" service: everything (frontend + backend + manifest) lives
// self-contained under OUT/<name>/ — point OUT at the portal DATA_ROOT so a created
// service persists in the data volume (survives image rebuilds). Default layout
// (code under OUT/<name>, manifest under OUT/data/<name>) is used otherwise.
const DATA_SERVICE = !!args['data-service']
const BUILD = !!args.build                              // npm install + build after scaffolding
const LILAK_UI = resolve(expand(args['lilak-ui']) || process.env.LILAK_UI_PATH || join(OUT, 'lilak_ui'))
if (!/^#[0-9a-f]{6}$/.test(COLOR)) { console.error(`error: --color must be a #rrggbb hex (got ${COLOR})`); process.exit(1) }

// tabs: "id:label:icon,id:label:icon" — icon optional
const TABS = String(args.tabs || 'home:홈:home').split(',').map((s) => {
  const [id, label, icon] = s.split(':')
  return { id: id.trim(), label: (label || id).trim(), icon: (icon || 'circle').trim() }
})
if (WITH_SETTINGS && !TABS.some((t) => t.id === 'set' || t.id === 'settings')) {
  TABS.push({ id: 'set', label: '설정', icon: 'settings' })
}
const SETTINGS_TAB = TABS.find((t) => t.id === 'set' || t.id === 'settings')

// ── colour helpers (derive hover / tint / muted from the one main colour) ─────
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const rgb2hex = (r) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const mix = (h, target, amt) => rgb2hex(hex2rgb(h).map((c, i) => c + (target[i] - c) * amt))
const darken = (h, amt) => mix(h, [0, 0, 0], amt)
const tint = (h, amt) => mix(h, [255, 255, 255], amt)
const rgba = (h, a) => { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})` }

const PRESET = {
  'btn-primary-bg': COLOR, 'btn-primary-hover': darken(COLOR, 0.15), 'btn-primary-text': '#ffffff',
  'text-link': COLOR, 'text-link-hover': darken(COLOR, 0.15),
  'border-focus': COLOR, 'input-focus-border': COLOR,
  'info-bg': tint(COLOR, 0.86), 'info-text': darken(COLOR, 0.15),
  'selection-bg': rgba(COLOR, 0.28),
  'nav-bg': COLOR, 'nav-border': darken(COLOR, 0.12), 'nav-accent': darken(COLOR, 0.12),
  'nav-text': '#ffffff', 'nav-text-muted': tint(COLOR, 0.7),
}
const THEME_CONST = NAME.replace(/[^a-z0-9]/gi, '').toUpperCase()

// ── fs helpers ────────────────────────────────────────────────────────────────
const ROOT = join(OUT, NAME)
let wrote = 0, skipped = 0
function put(rel, content) {
  const p = join(ROOT, rel)
  if (existsSync(p) && !FORCE) { skipped++; return }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  wrote++
}
function putAbs(abs, content) {
  if (existsSync(abs) && !FORCE) { skipped++; return }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  wrote++
}

// ── template pieces ────────────────────────────────────────────────────────────
const dq = (s) => JSON.stringify(s)

const tabsDict = (labels) => TABS.map((t) => `    tab_${t.id}: ${dq(labels[t.id] || t.label)},`).join('\n')
const placeholderDict = (suffix) => TABS.filter((t) => t !== SETTINGS_TAB)
  .map((t) => `    placeholder_${t.id}: ${dq(t.label + suffix)},`).join('\n')

const i18n = `// i18n dictionaries for the ${NAME} shell — the kit LangProvider consumes this.
// Labels start identical for ko/en; localise as features land.
export const DICTS = {
  ko: {
    brand: ${dq(BRAND)},
    svc_name: ${dq(SERVICE)},
${tabsDict({})}
${placeholderDict(' — 준비 중')}
    status_idle: '대기',
    nav_system: '시스템', nav_account: '계정',
    notif_title: '알림', notif_empty: '알림 없음',
    set_theme: '테마', set_lang: '언어',
    cmd_help: '단축키 도움말', cmd_placeholder: '명령 입력…', shortcuts_title: '키보드 단축키',
${WITH_SETTINGS ? `    set_account: '계정', set_users: '사용자 관리', set_tabs: '탭', set_profiles: '프로필 유형',
    set_account_note: '계정과 비밀번호는 포털에서 관리합니다.', set_users_note: '사용자 관리는 포털에서 합니다.',
    set_open_portal: '포털 열기', set_service_local: '서비스 로컬 설정 (구현 예정)',\n` : ''}  },
  en: {
    brand: ${dq(BRAND === '라일락' ? 'lilak' : BRAND)},
    svc_name: ${dq(SERVICE)},
${tabsDict({})}
${placeholderDict(' — coming soon')}
    status_idle: 'idle',
    nav_system: 'System', nav_account: 'Account',
    notif_title: 'Notifications', notif_empty: 'No notifications',
    set_theme: 'Theme', set_lang: 'Language',
    cmd_help: 'Shortcuts help', cmd_placeholder: 'Type a command…', shortcuts_title: 'Keyboard shortcuts',
${WITH_SETTINGS ? `    set_account: 'Account', set_users: 'Users', set_tabs: 'Tabs', set_profiles: 'Profile types',
    set_account_note: 'Account and password are managed in the portal.', set_users_note: 'User management lives in the portal.',
    set_open_portal: 'Open portal', set_service_local: 'Service-local setting (coming soon)',\n` : ''}  },
}
`

const themePreset = `// ${SERVICE} main theme for ${NAME}. Same mechanism as the kit's Teal preset:
// one main colour drives BOTH the accent tokens (buttons / links / focus / info)
// AND the top bar + command bar (nav-* tokens). Generated by new-service.mjs.
import { setTokenOverride } from 'lilak-ui'

export const ${THEME_CONST} = {
${Object.entries(PRESET).map(([k, v]) => `  ${dq(k)}: ${dq(v)},`).join('\n')}
}

/** Apply the ${NAME} colour overrides on top of the active base theme (call after applyTheme()). */
export function applyMainColor() {
  for (const [name, value] of Object.entries(${THEME_CONST})) setTokenOverride(name, value)
}

// Only 'bright' is offered — the main colour is fixed via overrides, so
// dark/lowcontrast barely differ. Add their ids back here to offer them.
export const ENABLED_THEMES = ['bright']
`

const mainJsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyTheme, setTheme, loadFonts } from 'lilak-ui'
import App from './App.jsx'
import { applyMainColor } from './theme/main.js'
import './index.css'

applyTheme()          // inject the kit's CSS custom properties
setTheme('bright')    // pin to bright (the main colour is fixed)
loadFonts()           // Pretendard / IBM Plex Sans / D2Coding + set --font-sans
applyMainColor()      // override accent + nav tokens to the service colour

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`

const appJsx = `import { LangProvider, IdentityProvider } from 'lilak-ui'
import { DICTS } from './i18n'
import { token } from './api'
import Shell from './components/Shell'

// Portal SSO — decode the stored JWT client-side for the display name.
function portalName() {
  try {
    const t = token()
    if (!t) return 'guest'
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return p.name || p.username || p.email || 'guest'
  } catch { return 'guest' }
}

export default function App() {
  return (
    <LangProvider dicts={DICTS} defaultLang="ko">
      <IdentityProvider defaultName={portalName()}>
        <Shell />
      </IdentityProvider>
    </LangProvider>
  )
}
`

const apiJs = `// Single chokepoint for backend calls: portal base-path + SSO bearer token.
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''

export function token() {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
}
function authHeaders(extra) {
  const t = token()
  return { ...(extra || {}), ...(t ? { Authorization: \`Bearer \${t}\` } : {}) }
}
export function apiURL(path) {
  if (/^https?:\\/\\//.test(path)) return path
  if (PORTAL_BASE && path.startsWith(PORTAL_BASE + '/')) return path
  return PORTAL_BASE + path
}
export async function get(url) {
  const res = await fetch(apiURL(url), { headers: authHeaders() })
  if (!res.ok) throw new Error(\`\${res.status} \${await res.text()}\`)
  return res.json()
}
export async function post(url, body) {
  const res = await fetch(apiURL(url), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body ?? {}) })
  if (!res.ok) throw new Error(\`\${res.status} \${await res.text()}\`)
  return res.json()
}
// The portal cover UI lives one level up from this service's base.
export function portalHome() { return PORTAL_BASE ? PORTAL_BASE.replace(/\\/p\\/[^/]+$/, '/') || '/' : '/' }
`

// pages: placeholder-per-tab + optional SettingsPage
const pagesImports = TABS.map((t) => t === SETTINGS_TAB
  ? `import SettingsPage from '../pages/SettingsPage'`
  : null).filter(Boolean).join('\n')

const pagesMap = TABS.map((t) => t === SETTINGS_TAB
  ? `    ${t.id}: <SettingsPage />,`
  : `    ${t.id}: <Placeholder icon=${dq(t.icon)} title={t('tab_${t.id}')} note={t('placeholder_${t.id}')} />,`).join('\n')

const shellJsx = `/**
 * Shell — ${NAME} chrome: a thin config of the kit's AppShell (top bar, /command
 * bar, \\ drawer, ? shortcuts, tab hotkeys). Generated by new-service.mjs; edit
 * TABS / status / labels here, fill the pages under src/pages/.
 */
import { useState } from 'react'
import { AppShell, useLang } from 'lilak-ui'
import { ENABLED_THEMES } from '../theme/main'
import Placeholder from '../pages/Placeholder'
${pagesImports}

const TABS = [
${TABS.map((t) => `  { id: ${dq(t.id)}, icon: ${dq(t.icon)} },`).join('\n')}
]

export default function Shell() {
  const { t, lang } = useLang()
  const [tab, setTab] = useState(${dq(TABS[0].id)})

  const tabs = TABS.map((x) => ({ id: x.id, label: t('tab_' + x.id), icon: x.icon }))

  const status = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny, 11px)', color: 'var(--nav-text)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--nav-text-muted)' }} />
      {t('status_idle')}
    </span>
  )

  const labels = {
    help: t('cmd_help'), system: t('nav_system'), theme: t('set_theme'), language: t('set_lang'),
    account: t('nav_account'), notifications: t('notif_title'), command: t('cmd_placeholder'), shortcuts: t('shortcuts_title'),
  }

  const PAGES = {
${pagesMap}
  }

  return (
    <AppShell
      brand={lang === 'ko' ? t('brand') : 'lilak'}
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
`

const placeholderJsx = `import { Icon } from 'lilak-ui'

// Temporary tab body — shows what the tab will hold until its real page lands.
export default function Placeholder({ icon, title, note }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', maxWidth: 520 }}>
        {icon && <Icon name={icon} size={40} style={{ opacity: 0.5 }} />}
        <div style={{ fontSize: 'var(--fs-large, 16px)', color: 'var(--text-primary)', marginTop: 10, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 'var(--fs-small, 12px)', marginTop: 6 }}>{note}</div>
      </div>
    </div>
  )
}
`

const indexCss = `html, body, #root { height: 100%; margin: 0; }
body { background: var(--app-bg); color: var(--text-primary); font-family: var(--font-sans); }
`

const indexHtml = `<!DOCTYPE html>
<html lang="ko">
  <head>
    <!-- Default base = site root; the portal proxy injects its own <base> before
         this one (browsers honor the first), so relative assets resolve under
         /p/${NAME}/. Combined with Vite base:'./'. -->
    <base href="/" />
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/lilak.svg" />
    <title>${BRAND} ${SERVICE}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`

const pkgJson = JSON.stringify({
  name: `${NAME.replace(/_/g, '-')}-frontend`, version: '0.1.0', private: true, type: 'module',
  scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
  dependencies: { '@phosphor-icons/react': '^2.1.10', react: '^18.3.1', 'react-dom': '^18.3.1', 'react-markdown': '^9.0.1', 'remark-gfm': '^4.0.0' },
  devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.3.1' },
}, null, 2) + '\n'

const viteConfig = `import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Host/port from env (with defaults) so the same code runs anywhere. base:'./'
// + injected <base href> makes the build portal-proxy aware.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
  const PORT = Number(env.PORT) || ${PORT}
  const BACKEND = env.${THEME_CONST}_BACKEND || 'http://localhost:${BPORT}'
  const UI = env.LILAK_UI_PATH ? resolve(env.LILAK_UI_PATH) : resolve(__dirname, '../../lilak_ui')
  return {
    base: './',
    plugins: [react()],
    resolve: { alias: { 'lilak-ui': resolve(UI, 'src') } },
    optimizeDeps: { include: ['@phosphor-icons/react', 'react-markdown', 'remark-gfm'] },
    server: { port: PORT, host: true, fs: { allow: [resolve(__dirname), UI] }, proxy: { '/api': BACKEND } },
  }
})
`

// ── backend ─────────────────────────────────────────────────────────────────
const backendMain = `"""${NAME} backend — minimal FastAPI shell.

Identifies the portal user (SSO) and serves the built frontend. Add feature
routers under routes/ and include them here as the tabs get real content.
"""
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from portal_auth import identity

app = FastAPI(title="${NAME}")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "${NAME}"}


@app.get("/api/whoami")
def whoami(user: dict = Depends(identity)):
    """Portal identity of the caller (advisory; entry is gated by the portal)."""
    return user


# Serve the built frontend (frontend/dist) behind the portal.
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
`

const portalAuth = `"""Portal SSO — verify the portal's HS256 JWT and read the profile claims.

No local user DB: this service only *identifies* the caller. Secret precedence
matches the portal: PORTAL_SECRET_KEY, then ELOG_SECRET_KEY, then a dev default.
"""
from __future__ import annotations

import os
from typing import Optional

from jose import jwt
from fastapi import Header, Request

SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None


def _token_from_request(authorization: Optional[str], request: Request) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return request.cookies.get("lilak_portal_token") or request.cookies.get("elog_token")


def identity(request: Request, authorization: Optional[str] = Header(default=None)) -> dict:
    """Soft identity: returns a profile dict (anonymous when no valid token)."""
    token = _token_from_request(authorization, request)
    payload = decode_token(token) if token else None
    if not payload:
        return {"authenticated": False, "email": None, "username": None, "name": None, "role": None}
    return {
        "authenticated": True,
        "email": payload.get("email"),
        "username": payload.get("username") or payload.get("name"),
        "name": payload.get("name") or payload.get("username"),
        "role": payload.get("prole") or payload.get("role"),
    }
`

const requirements = `fastapi
uvicorn[standard]
python-jose[cryptography]
`

// ── manifest (written under data/<name>/) ─────────────────────────────────────
const manifest = JSON.stringify({
  kind: 'generic', mode: 'managed', health: '/api/health', entry: '/',
  identity: { accepts_portal_token: true, link_by: 'email' },
  capabilities: { multi_project: false, import_export: false },
  label: `${BRAND} ${SERVICE}`.trim(), icon: (args.icon || 'lilak'), color: COLOR,
  start: { cmd: 'uvicorn main:app', cwd: join(ROOT, 'backend'), env: {} },
}, null, 2) + '\n'

// ── write everything ──────────────────────────────────────────────────────────
put('frontend/package.json', pkgJson)
put('frontend/vite.config.js', viteConfig)
put('frontend/index.html', indexHtml)
put('frontend/src/main.jsx', mainJsx)
put('frontend/src/App.jsx', appJsx)
put('frontend/src/api.js', apiJs)
put('frontend/src/i18n.js', i18n)
put('frontend/src/index.css', indexCss)
put('frontend/src/theme/main.js', themePreset)
put('frontend/src/components/Shell.jsx', shellJsx)
put('frontend/src/pages/Placeholder.jsx', placeholderJsx)

// favicon: reuse elog's lilak.svg if present
const favSrc = join(OUT, 'lilak_elog/frontend/public/lilak.svg')
if (existsSync(favSrc)) { mkdirSync(join(ROOT, 'frontend/public'), { recursive: true }); if (FORCE || !existsSync(join(ROOT, 'frontend/public/lilak.svg'))) { copyFileSync(favSrc, join(ROOT, 'frontend/public/lilak.svg')); wrote++ } else skipped++ }

put('backend/main.py', backendMain)
put('backend/portal_auth.py', portalAuth)
put('backend/requirements.txt', requirements)

// settings tab (portal-centric)
if (WITH_SETTINGS) {
  put('frontend/src/pages/SettingsPage.jsx', `import { useEffect, useState } from 'react'
import { SideNav, useLang } from 'lilak-ui'
import { get } from '../api'
import AccountSection from './settings/AccountSection'
import ManageUsers from './settings/ManageUsers'
import ServiceLocal from './settings/ServiceLocal'

// Portal-centric Settings: account + user management come from the portal;
// tabs / profile-types are service-local stubs to fill in.
export default function SettingsPage() {
  const { t } = useLang()
  const [me, setMe] = useState(null)
  useEffect(() => { get('/api/whoami').then(setMe).catch(() => setMe({ authenticated: false })) }, [])

  const isManager = me?.role === 'manager'
  const sections = [
    { id: 'account', label: t('set_account'), icon: 'user', group: 'me' },
    { id: 'users', label: t('set_users'), icon: 'users', group: 'people' },
    ...(isManager ? [
      { id: 'tabs', label: t('set_tabs'), icon: 'browse', group: 'appearance' },
      { id: 'profiles', label: t('set_profiles'), icon: 'user', group: 'appearance' },
    ] : []),
  ]
  const [active, setActive] = useState('account')

  // Page wrapper gives the outer margin + centring (AppShell mounts pages flush);
  // SideNav supplies its own right gap, so the content column has no extra padding.
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', minHeight: 500 }}>
        <SideNav title={t('tab_${SETTINGS_TAB ? SETTINGS_TAB.id : 'set'}')} sections={sections} active={active} onSelect={setActive} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {active === 'account' && <AccountSection me={me} />}
          {active === 'users' && <ManageUsers />}
          {active === 'tabs' && <ServiceLocal title={t('set_tabs')} />}
          {active === 'profiles' && <ServiceLocal title={t('set_profiles')} />}
        </div>
      </div>
    </div>
  )
}
`)

  put('frontend/src/pages/settings/AccountSection.jsx', `import { Stack, Row, Button, useLang } from 'lilak-ui'
import { portalHome } from '../../api'

const card = { border: '1px solid var(--border-default)', backgroundColor: 'var(--surface)', borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,.04)', padding: 20 }

// Portal-centric account view: show the SSO profile; account + password are
// managed in the portal.
export default function AccountSection({ me }) {
  const { t } = useLang()
  const isManager = me?.role === 'manager'
  const row = (k, v) => (
    <div style={{ display: 'flex', gap: 12, fontSize: 'var(--fs-small, 12px)' }}>
      <span style={{ width: 84, color: 'var(--text-muted)' }}>{k}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{v || '—'}</span>
    </div>
  )
  return (
    <Stack gap={16} style={{ maxWidth: 384 }}>
      <Stack gap={14} style={card}>
        <Row gap={10} align="center">
          <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-large, 16px)', color: 'var(--text-primary)' }}>{me?.name || me?.username || 'guest'}</p>
          {me?.role && (
            <span style={{ fontSize: 'var(--fs-small, 12px)', padding: '1px 8px', borderRadius: 999, fontWeight: 500,
              ...(isManager ? { backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' } : { backgroundColor: 'var(--surface-2)', color: 'var(--text-secondary)' }) }}>{me.role}</span>
          )}
        </Row>
        <Stack gap={8} style={{ paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          {row('username', me?.username)}
          {row('email', me?.email)}
        </Stack>
        <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--text-muted)' }}>{t('set_account_note')}</div>
        <Button variant="secondary" onClick={() => { window.location.href = portalHome() }} style={{ width: '100%', padding: '8px 0' }}>{t('set_open_portal')}</Button>
      </Stack>
    </Stack>
  )
}
`)

  put('frontend/src/pages/settings/ManageUsers.jsx', `import { Stack, Button, useLang } from 'lilak-ui'
import { portalHome } from '../../api'

const card = { border: '1px solid var(--border-default)', backgroundColor: 'var(--surface)', borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,.04)', padding: 20 }

// Portal owns accounts + permissions, so user management links out to the portal.
export default function ManageUsers() {
  const { t } = useLang()
  return (
    <Stack gap={16} style={{ maxWidth: 384 }}>
      <Stack gap={12} style={card}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-body, 13px)', color: 'var(--text-primary)' }}>{t('set_users')}</p>
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{t('set_users_note')}</div>
        <Button variant="secondary" onClick={() => { window.location.href = portalHome() }} style={{ width: '100%', padding: '8px 0' }}>{t('set_open_portal')}</Button>
      </Stack>
    </Stack>
  )
}
`)

  put('frontend/src/pages/settings/ServiceLocal.jsx', `import { Stack, Callout, useLang } from 'lilak-ui'

// Placeholder for a service-local admin section (tabs / profile types). Replace
// with a real editor backed by this service's own endpoints when needed.
export default function ServiceLocal({ title }) {
  const { t } = useLang()
  return (
    <Stack gap={12} style={{ maxWidth: 520 }}>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-body, 13px)', color: 'var(--text-primary)' }}>{title}</p>
      <Callout tone="info">{t('set_service_local')}</Callout>
    </Stack>
  )
}
`)
}

// README + manifest
put('README.md', `# ${NAME}

Generated by \`new-service.mjs\` — a LILAK Web Portal service on the kit's AppShell.

- **Frontend** (\`frontend/\`): React + Vite, aliases the kit via \`LILAK_UI_PATH\`.
  Shell = thin AppShell config in \`src/components/Shell.jsx\`; theme in
  \`src/theme/main.js\` (main colour \`${COLOR}\`); tabs: ${TABS.map((t) => t.id).join(', ')}.
- **Backend** (\`backend/\`): minimal FastAPI (health + whoami + serves \`dist\`).
  Runs on the shared portal venv; SSO via \`portal_auth.py\`.
${WITH_SETTINGS ? '- **Settings tab**: portal-centric — account + manage-users link to the portal; tabs/profile-types are service-local stubs.\n' : ''}
## Run

    cd frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm install && npm run build
    # backend (shared venv):  cd backend && uvicorn main:app --port ${BPORT}

## Register with the portal

A manifest was written to \`data/${NAME}/service.json\`. Register it via the portal
admin **Services** UI or \`/api/handshake\` (see service_manager). Fix \`start.cwd\`
per host if you move the checkout.
`)

// In --data-service mode the manifest sits INSIDE the service dir (self-contained
// under the data volume); otherwise under OUT/data/<name>/ as before.
putAbs(DATA_SERVICE ? join(ROOT, 'service.json') : join(OUT, 'data', NAME, 'service.json'), manifest)

// ── optional: build the frontend so the portal can serve it immediately ───────
// --shared-modules <dir>: reuse a prebuilt node_modules (all generated services
// share identical deps) → build is offline + fast, no per-service npm install.
// Only `dist` needs to persist, so the symlink is removed after building to keep
// the data volume clean.
let built = false
if (BUILD) {
  const fe = join(ROOT, 'frontend')
  const env = { ...process.env, LILAK_UI_PATH: LILAK_UI }
  const shared = expand(args['shared-modules'])
  const nm = join(fe, 'node_modules')
  let linked = false
  if (shared && existsSync(shared) && !existsSync(nm)) {
    try { symlinkSync(shared, nm, 'dir'); linked = true } catch (e) { console.error('shared-modules link failed:', e.message) }
  }
  console.log(`\n▶ building frontend  (LILAK_UI_PATH=${LILAK_UI}${linked ? ', shared node_modules' : ''}) …`)
  let r = { status: 0 }
  if (!linked) r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: fe, env, stdio: 'inherit' })
  if (r.status === 0) r = spawnSync('npm', ['run', 'build'], { cwd: fe, env, stdio: 'inherit' })
  built = r.status === 0
  if (linked) { try { unlinkSync(nm) } catch { /* leave it */ } }
  console.log(built ? '✓ frontend built' : '✗ frontend build failed')
}

// ── optional: register the DB row via the portal handshake ────────────────────
// The manifest (with its start block) is already on disk under the portal's data
// root, so a managed handshake layers over it — preserving start — and creates
// the Service row. Token/URL from flags or PORTAL_REGISTER_TOKEN / PORTAL_BASE_URL.
let registered = false
if (args.register) {
  const portalUrl = (expand(args['portal-url']) || process.env.PORTAL_BASE_URL || 'http://localhost:8025').replace(/\/+$/, '')
  const regToken = args['register-token'] || process.env.PORTAL_REGISTER_TOKEN || 'lilak-portal-register-CHANGE'
  const body = { name: NAME, kind: 'generic', mode: 'managed', health: '/api/health', entry: '/',
    accepts_portal_token: true, multi_project: false, import_export: false, link_by: 'email' }
  try {
    const res = await fetch(`${portalUrl}/api/handshake`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regToken}` },
      body: JSON.stringify(body),
    })
    const txt = await res.text()
    if (res.ok) { const j = JSON.parse(txt); registered = true; console.log(`\n✓ registered with portal (${j.updated ? 'updated' : 'created'}) — entry: ${j.entry}`) }
    else console.error(`\n✗ handshake failed: ${res.status} ${txt}`)
  } catch (e) { console.error(`\n✗ handshake error: ${e.message}  (is the portal running at ${portalUrl}?)`) }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n✓ scaffolded ${NAME}  (${wrote} files written${skipped ? `, ${skipped} skipped — use --force to overwrite` : ''})`)
console.log(`  root:     ${ROOT}`)
console.log(`  manifest: ${DATA_SERVICE ? join(ROOT, 'service.json') : join(OUT, 'data', NAME, 'service.json')}`)
console.log(`  tabs:     ${TABS.map((t) => t.id).join(', ')}${WITH_SETTINGS ? '   (+ portal-centric Settings)' : ''}`)
console.log(`  colour:   ${COLOR}  (nav ${PRESET['nav-bg']} · hover ${PRESET['btn-primary-hover']})`)
console.log(`\nnext:`)
if (!BUILT_OR_SKIP()) console.log(`  cd ${join(ROOT, 'frontend')} && LILAK_UI_PATH=${LILAK_UI} npm install && npm run build`)
if (registered) console.log(`  registered with the portal — enter at /p/${NAME}/\n`)
else if (DATA_SERVICE) console.log(`  (portal registers this service directly — enter at /p/${NAME}/)\n`)
else console.log(`  register data/${NAME}/service.json with the portal: pass --register (admin token) or use the Services UI\n`)
function BUILT_OR_SKIP() { return built }