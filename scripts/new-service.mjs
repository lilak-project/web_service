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
import { fileURLToPath } from 'node:url'
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
const SERVICE = args.service || NAME   // brand subtitle (lilak / <service>); defaults to the service name so the portal card is identifiable
const BRAND = args.brand || '라일락'
const COLOR = (args.color || '#000000').toLowerCase()
const WITH_SETTINGS = !!args.settings
const COMMAND_BAR = !args['no-command-bar']     // collapsible bottom `/` command bar (default on)
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

// tabs: "id:label:icon[:kind]" — icon optional; kind='community' → built-in chat tab
const TABS = String(args.tabs || 'home:홈:home').split(',').map((s) => {
  const [id, label, icon, kind] = s.split(':')
  const t = { id: id.trim(), label: (label || id).trim(), icon: (icon || 'circle').trim() }
  const k = (kind || '').trim() || (t.icon === 'community' ? 'community' : '')
  if (k) t.kind = k
  return t
})
const isSettingsTab = (t) => t.kind === 'settings' || t.id === 'set' || t.id === 'settings'
if (WITH_SETTINGS && !TABS.some(isSettingsTab)) {
  TABS.push({ id: 'set', label: '설정', icon: 'settings', kind: 'settings' })
}
const SETTINGS_TAB = TABS.find(isSettingsTab)
const HAS_SETTINGS = !!SETTINGS_TAB          // a settings tab (flag or kind) → scaffold it
const COMMUNITY_TABS = TABS.filter((t) => t.kind === 'community')
const HAS_COMMUNITY = COMMUNITY_TABS.length > 0
const FILES_TAB = TABS.find((t) => t.id === 'files')

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
const placeholderDict = (suffix) => TABS.filter((t) => t !== SETTINGS_TAB && t.kind !== 'community')
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
    placeholder_menu: '이 메뉴 항목의 내용은 아직 준비 중입니다. 코드(Shell.jsx의 PANELS)에서 연결하세요.',
${HAS_SETTINGS ? `    set_account: '계정', set_users: '사용자 관리', set_tabs: '탭', set_anon: '익명 이름',
    set_account_note: '계정과 비밀번호는 포털에서 관리합니다.', set_users_note: '사용자 관리는 포털에서 합니다.',
    set_open_portal: '포털 열기',\n` : ''}  },
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
    placeholder_menu: 'This menu item has no content yet — wire it up in code (PANELS in Shell.jsx).',
${HAS_SETTINGS ? `    set_account: 'Account', set_users: 'Users', set_tabs: 'Tabs', set_anon: 'Anon names',
    set_account_note: 'Account and password are managed in the portal.', set_users_note: 'User management lives in the portal.',
    set_open_portal: 'Open portal',\n` : ''}  },
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
export async function put(url, body) {
  const res = await fetch(apiURL(url), { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body ?? {}) })
  if (!res.ok) throw new Error(\`\${res.status} \${await res.text()}\`)
  return res.json()
}
// The portal cover UI lives one level up from this service's base.
export function portalHome() { return PORTAL_BASE ? PORTAL_BASE.replace(/\\/p\\/[^/]+$/, '/') || '/' : '/' }
`

// pages: placeholder-per-tab + optional SettingsPage + built-in Community tabs
const pagesImports = [
  SETTINGS_TAB ? `import SettingsPage from '../pages/SettingsPage'` : null,
  HAS_COMMUNITY ? `import CommunityTab from '../pages/CommunityTab'` : null,
].filter(Boolean).join('\n')

const onFiles = FILES_TAB ? `() => setTab(${dq(FILES_TAB.id)})` : 'undefined'
// Keys are quoted because a tab id may start with a digit (e.g. "2d"/"3d"), which
// isn't a valid bare object-key / identifier.
const pagesMap = TABS.map((t) => t === SETTINGS_TAB
  ? `    ${dq(t.id)}: <SettingsPage menuConfig={(layout.tabs || []).find((x) => x.id === ${dq(t.id)})?.codeMenu} />,`
  : t.kind === 'community'
    ? `    ${dq(t.id)}: <CommunityTab onOpenFiles={${onFiles}} menuConfig={(layout.tabs || []).find((x) => x.id === ${dq(t.id)})?.codeMenu} />,`
    : `    ${dq(t.id)}: <Placeholder icon=${dq(t.icon)} title={t('tab_${t.id}')} note={t('placeholder_${t.id}')} />,`).join('\n')

const shellJsx = `/**
 * Shell — ${NAME} chrome: a thin config of the kit's AppShell (top bar, /command
 * bar, \\ drawer, ? shortcuts, tab hotkeys). Generated by new-service.mjs.
 *
 * The tab strip and each tab's left menu bar are CONFIG-DRIVEN: DEFAULT_LAYOUT is
 * the code-provided fallback, but the live layout comes from /api/layout — which a
 * manager edits in the Settings 탭 (and the portal Manage UI). Add / hide / remove /
 * reorder tabs and rail menu items there, no code change. Only the panel CONTENT is
 * code: PAGES maps a tab id → its single-panel body; PANELS maps a rail menu-item id
 * → its body (fill PANELS in when you give a tab rail menu items).
 */
import { useState, useEffect } from 'react'
import { AppShell, useLang, Rail } from 'lilak-ui'
import { get } from '../api'
import { ENABLED_THEMES } from '../theme/main'
import Placeholder from '../pages/Placeholder'
${pagesImports}

// Code default — single-panel tabs. A saved layout overrides this (order/labels/
// icons/hidden + per-tab rail menus). Keep the ids in sync with PAGES below.
const DEFAULT_LAYOUT = { tabs: [
${TABS.map((t) => `  { id: ${dq(t.id)}, icon: ${dq(t.icon)} },`).join('\n')}
] }

export default function Shell() {
  const { t, lang } = useLang()
  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [tab, setTab] = useState(${dq(TABS[0].id)})

  // Live layout from the backend (falls back to DEFAULT_LAYOUT on error).
  useEffect(() => {
    get('/api/layout').then((l) => { if (l && Array.isArray(l.tabs) && l.tabs.length) setLayout(l) }).catch(() => {})
  }, [])

  const visible = (layout.tabs || []).filter((tb) => !tb.hidden)
  const tabs = visible.map((tb) => ({ id: tb.id, label: tb.label || t('tab_' + tb.id), icon: tb.icon }))

  // If the active tab got hidden/removed, fall back to the first visible one.
  useEffect(() => {
    if (visible.length && !visible.some((tb) => tb.id === tab)) setTab(visible[0].id)
  }, [layout]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Single-panel content, keyed by tab id.
  const PAGES = {
${pagesMap}
  }
  // Rail menu-item content, keyed by menu-item id. Add an entry here for each rail
  // item you add to a tab in the layout editor, e.g. detector: <DetectorPanel />.
  const PANELS = {}

  return (
    <AppShell
      brand={lang === 'ko' ? t('brand') : 'lilak'}
      service={t('svc_name')}
      tabs={tabs}
      active={tab}
      onTab={setTab}
      commandBar={${COMMAND_BAR}}
      themes={ENABLED_THEMES}
      status={status}
      labels={labels}
    >
      {/* Keep every visible tab mounted (display toggle) so page state survives switches.
          A tab with rail menu items renders <Rail>; otherwise its single PAGES panel. */}
      {visible.map((tb) => (
        <div key={tb.id} style={{ height: '100%', display: tab === tb.id ? 'block' : 'none' }}>
          {tb.menu && tb.menu.length
            ? <Rail items={tb.menu} panels={PANELS}
                emptyPanel={<Placeholder icon="command" title={tb.label || t('tab_' + tb.id)} note={t('placeholder_menu')} />} />
            : (PAGES[tb.id] || <Placeholder title={tb.label || t('tab_' + tb.id)} />)}
        </div>
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

// Built-in community dock items (ids match the kit <Community> rail). Declared as
// the community tab's `codeMenu` so a manager can reorder / hide them in the layout
// editor — the items stay code-owned (features), only order + visibility are config.
const COMMUNITY_CODE_MENU = [
  { id: 'poll', label: '투표', icon: 'chart' },
  { id: 'questions', label: '질문', icon: 'question-mark' },
  { id: 'completed', label: '완료', icon: 'check' },
  { id: 'files', label: '첨부', icon: 'attach' },
  { id: 'manage', label: '관리', icon: 'gear' },
  { id: 'plaza', label: '광장', icon: 'beer-stein' },
  { id: 'broadcast', label: '방송', icon: 'megaphone' },
]
const communityCodeMenuPy = COMMUNITY_CODE_MENU
  .map((m) => `        {"id": ${JSON.stringify(m.id)}, "label": ${JSON.stringify(m.label)}, "icon": ${JSON.stringify(m.icon)}},`)
  .join('\n')

// The settings tab's SideNav sections — also code-owned, so exposed as codeMenu the
// same way (reorder / hide in the layout editor). `anon` only exists with community.
const SETTINGS_CODE_MENU = [
  { id: 'account', label: '계정', icon: 'user' },
  { id: 'users', label: '사용자 관리', icon: 'users' },
  ...(HAS_COMMUNITY ? [{ id: 'anon', label: '익명 이름', icon: 'eye' }] : []),
  { id: 'tabs', label: '탭', icon: 'browse' },
]
const settingsCodeMenuPy = SETTINGS_CODE_MENU
  .map((m) => `        {"id": ${JSON.stringify(m.id)}, "label": ${JSON.stringify(m.label)}, "icon": ${JSON.stringify(m.icon)}},`)
  .join('\n')

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
from layout import build_layout_router
${HAS_COMMUNITY ? 'from community import build_community_router\n' : ''}
app = FastAPI(title="${NAME}")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Configurable tab / menu-bar layout — the SAME source the Settings 탭 and the portal
# Manage UI edit. defaults is this service's code-provided layout (single-panel
# tabs); a tab given rail menu items in the editor renders the kit Rail.
_LAYOUT_DEFAULT = {"tabs": [
${TABS.map((t) => t.kind === 'community'
  ? `    {"id": ${JSON.stringify(t.id)}, "icon": ${JSON.stringify(t.icon)}, "codeMenu": [\n${communityCodeMenuPy}\n    ]},`
  : t === SETTINGS_TAB
    ? `    {"id": ${JSON.stringify(t.id)}, "icon": ${JSON.stringify(t.icon)}, "codeMenu": [\n${settingsCodeMenuPy}\n    ]},`
    : `    {"id": ${JSON.stringify(t.id)}, "icon": ${JSON.stringify(t.icon)}},`).join('\n')}
]}
app.include_router(build_layout_router(
    path=Path(__file__).resolve().parents[1] / "data" / "layout.json",
    identity=identity, defaults=_LAYOUT_DEFAULT))
${HAS_COMMUNITY ? `
# Built-in community/chat tab — data persists in the service's data dir.
_CM_DATA = Path(__file__).resolve().parents[1] / "community_data"
app.include_router(build_community_router(
    db_path=_CM_DATA / "community.db", uploads_dir=_CM_DATA / "uploads", identity=identity))
` : ''}

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

// Every service used to get its OWN copy of the portal-SSO glue stamped here, so a
// fix (secret handling, the introspect client, aud checks, …) had to be repeated in
// each. It now lives once in the shared `lilak_portal_auth` package (installed in the
// portal venv); a new service just re-exports it, keeping `from portal_auth import
// identity` working while sharing the single implementation.
const portalAuth = `"""Portal SSO — re-exported from the shared \`lilak_portal_auth\` package.

The token-verify / identity / introspect glue lives once in \`lilak_portal_auth\`
(installed in the shared portal venv). Keep this a thin re-export so every service
shares one implementation; add service-specific auth helpers here, not another copy.
"""
from lilak_portal_auth import (  # noqa: F401  (re-export)
    SECRET_KEY,
    ALGORITHM,
    MANAGER_COLOR,
    decode_token,
    bearer_from_request,
    introspect,
    fresh_payload,
    identity,
    list_accounts,
)
`

const requirements = `fastapi
uvicorn[standard]
python-jose[cryptography]
${HAS_COMMUNITY ? 'python-multipart\n' : ''}`

// ── built-in community tab (frontend adapter + page) ─────────────────────────
// The frontend adapter (community_api.js) is a service-agnostic file kept in sync
// with nptoy's — copied verbatim from templates/community_api.js at scaffold time
// (see the copy in the HAS_COMMUNITY block below), so it's not inlined here.

const communityTabJsx = `import { useEffect, useState } from 'react'
import { Community } from 'lilak-ui'
import { get } from '../api'
import { communityApi } from '../community_api'

// Built-in community/chat tab (kit <Community> + this service's backend module).
export default function CommunityTab({ onOpenFiles, menuConfig }) {
  const [role, setRole] = useState('user')
  useEffect(() => { get('/api/whoami').then((u) => setRole(u.role || 'user')).catch(() => {}) }, [])
  return (
    <div style={{ height: '100%', boxSizing: 'border-box', padding: 12 }}>
      <Community api={communityApi} role={role} onOpenFiles={onOpenFiles} storageKey="${NAME}" menuConfig={menuConfig}
        features={{ attachments: true, questions: true, anon: true, polls: true, mentions: true, moderation: true }} />
    </div>
  )
}
`

const anonNamesJsx = `import { useEffect, useState } from 'react'
import { Button, Callout, useLang } from 'lilak-ui'
import { communityApi } from '../../community_api'

// Manager-only: edit the anonymous name pool (surnames × given names).
export default function AnonNames() {
  const { t } = useLang()
  const [names, setNames] = useState(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { communityApi.anonNames().then(setNames).catch(() => {}) }, [])
  if (!names) return null
  const save = async () => { const r = await communityApi.saveAnonNames(names); setNames(r); setSaved(true); setTimeout(() => setSaved(false), 1500) }
  const split = (s) => s.split(/[\\s,]+/).filter(Boolean)
  const ta = { width: '100%', boxSizing: 'border-box', minHeight: 140, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 'var(--fs-small,12px)', fontFamily: 'inherit', resize: 'vertical' }
  const lbl = { fontSize: 'var(--fs-small,12px)', fontWeight: 600, marginBottom: 4, display: 'block' }
  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ fontSize: 'var(--fs-medium,14px)', fontWeight: 600, marginBottom: 8 }}>{t('set_anon')}</div>
      <Callout tone="info">익명 모드에서 배정되는 이름은 성씨 × 이름 조합입니다. 공백·쉼표·줄바꿈으로 구분해 편집하세요.</Callout>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginTop: 12 }}>
        <div><span style={lbl}>성씨 ({names.surnames.length})</span>
          <textarea style={ta} value={names.surnames.join(' ')} onChange={(e) => setNames((n) => ({ ...n, surnames: split(e.target.value) }))} /></div>
        <div><span style={lbl}>이름 ({names.given.length})</span>
          <textarea style={ta} value={names.given.join(' ')} onChange={(e) => setNames((n) => ({ ...n, given: split(e.target.value) }))} /></div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="primary" onClick={save}>저장 · {names.surnames.length}×{names.given.length} 조합</Button>
        {saved && <span style={{ color: 'var(--info-text)', fontSize: 'var(--fs-small,12px)' }}>저장됨</span>}
      </div>
    </div>
  )
}
`

// ── manifest (written under data/<name>/) ─────────────────────────────────────
const manifest = JSON.stringify({
  kind: 'generic', mode: 'managed', health: '/api/health', entry: '/',
  identity: { accepts_portal_token: true, link_by: 'email' },
  capabilities: { multi_project: false, import_export: false },
  label: (SERVICE || NAME).trim(), icon: (args.icon || 'lilak'), color: COLOR,
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

// config-driven tab/menu layout: every service gets the shared layout module (drop-in
// like community.py). Backend includes build_layout_router; Shell reads /api/layout.
{
  const tmplDir = join(dirname(fileURLToPath(import.meta.url)), 'templates')
  const lySrc = join(tmplDir, 'layout.py')
  const lyDest = join(ROOT, 'backend/layout.py')
  if (existsSync(lySrc) && (FORCE || !existsSync(lyDest))) { copyFileSync(lySrc, lyDest); wrote++ } else if (existsSync(lyDest)) skipped++
}

// built-in community tab: copy the shared backend module + write the frontend glue
if (HAS_COMMUNITY) {
  const tmplDir = join(dirname(fileURLToPath(import.meta.url)), 'templates')
  const cmSrc = join(tmplDir, 'community.py')
  const cmDest = join(ROOT, 'backend/community.py')
  if (existsSync(cmSrc) && (FORCE || !existsSync(cmDest))) { copyFileSync(cmSrc, cmDest); wrote++ } else if (existsSync(cmDest)) skipped++
  // Frontend adapter is a plain (service-agnostic) file → copy the template verbatim,
  // kept in sync with nptoy's community_api.js (the reference community). Copying
  // avoids re-escaping backticks in an inline string.
  const apiSrc = join(tmplDir, 'community_api.js')
  const apiDest = join(ROOT, 'frontend/src/community_api.js')
  if (existsSync(apiSrc) && (FORCE || !existsSync(apiDest))) { copyFileSync(apiSrc, apiDest); wrote++ } else if (existsSync(apiDest)) skipped++
  put('frontend/src/pages/CommunityTab.jsx', communityTabJsx)
  if (HAS_SETTINGS) put('frontend/src/pages/settings/AnonNames.jsx', anonNamesJsx)
}

// settings tab (portal-centric)
if (HAS_SETTINGS) {
  put('frontend/src/pages/SettingsPage.jsx', `import { useEffect, useState } from 'react'
import { SideNav, useLang } from 'lilak-ui'
import { get } from '../api'
import AccountSection from './settings/AccountSection'
import ManageUsers from './settings/ManageUsers'
import LayoutSettings from './settings/LayoutSettings'
${HAS_COMMUNITY ? "import AnonNames from './settings/AnonNames'\n" : ''}
// Reorder / hide the settings sections per the tab's codeMenu (Settings 탭 editor).
// Sections stay code-owned; the config only carries order + hidden by id.
function applyOrder(items, cfg) {
  if (!Array.isArray(cfg) || !cfg.length) return items
  const hidden = new Set(cfg.filter((m) => m.hidden).map((m) => m.id))
  const order = cfg.map((m) => m.id)
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i }
  return items.filter((s) => !hidden.has(s.id)).sort((a, b) => rank(a.id) - rank(b.id))
}

// Portal-centric Settings: account + user management come from the portal;
// tabs / profile-types are service-local stubs to fill in.
export default function SettingsPage({ menuConfig }) {
  const { t } = useLang()
  const [me, setMe] = useState(null)
  useEffect(() => { get('/api/whoami').then(setMe).catch(() => setMe({ authenticated: false })) }, [])

  const isManager = me?.role === 'manager'
  const sections = applyOrder([
    { id: 'account', label: t('set_account'), icon: 'user', group: 'me' },
    { id: 'users', label: t('set_users'), icon: 'users', group: 'people' },
    ...(isManager ? [
${HAS_COMMUNITY ? "      { id: 'anon', label: t('set_anon'), icon: 'eye', group: 'community' },\n" : ''}      { id: 'tabs', label: t('set_tabs'), icon: 'browse', group: 'appearance' },
    ] : []),
  ], menuConfig)
  const [active, setActive] = useState('account')
  const cur = sections.some((s) => s.id === active) ? active : sections[0]?.id

  // Page wrapper gives the outer margin + centring (AppShell mounts pages flush);
  // SideNav supplies its own right gap, so the content column has no extra padding.
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', minHeight: 500 }}>
        <SideNav title={t('tab_${SETTINGS_TAB ? SETTINGS_TAB.id : 'set'}')} sections={sections} active={cur} onSelect={setActive} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {cur === 'account' && <AccountSection me={me} />}
          {cur === 'users' && <ManageUsers />}
${HAS_COMMUNITY ? "          {cur === 'anon' && <AnonNames />}\n" : ''}          {cur === 'tabs' && <LayoutSettings />}
        </div>
      </div>
    </div>
  )
}
`)

  put('frontend/src/pages/settings/LayoutSettings.jsx', `import { useEffect, useState } from 'react'
import { LayoutEditor, useLang } from 'lilak-ui'
import { get, put as apiPut, post } from '../../api'

// Manager-only tab/menu editor. Edits the SAME /api/layout config the Shell reads
// (and the portal Manage UI edits) — structure only; the panel behind each id is
// code (see PAGES / PANELS in Shell.jsx).
export default function LayoutSettings() {
  const { t } = useLang()
  const [cfg, setCfg] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { get('/api/layout').then(setCfg).catch(() => setCfg({ tabs: [] })) }, [])

  const save = async () => {
    setSaving(true); setErr(null)
    try { const r = await apiPut('/api/layout', cfg); setCfg(r); setDirty(false) }
    catch (e) { setErr(String(e.message || e)) }
    finally { setSaving(false) }
  }
  const reset = async () => {
    setErr(null)
    try { const r = await post('/api/layout/reset'); setCfg(r); setDirty(false) }
    catch (e) { setErr(String(e.message || e)) }
  }

  if (!cfg) return null
  return (
    <div style={{ maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>{t('set_tabs')}</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>
        탭과 왼쪽 메뉴바 구성을 편집합니다. 변경은 모든 사용자에게 적용됩니다.
      </p>
      {err && <div style={{ color: 'var(--danger-text, #b91c1c)', fontSize: 'var(--fs-small, 12px)', marginBottom: 10 }}>{err}</div>}
      <LayoutEditor value={cfg} onChange={(c) => { setCfg(c); setDirty(true) }} onSave={save} onReset={reset} dirty={dirty} saving={saving} />
    </div>
  )
}
`)

  put('frontend/src/pages/settings/AccountSection.jsx', `import { Stack, Row, Button, Avatar, useLang } from 'lilak-ui'
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
          <Avatar icon={me?.shape} color={me?.color} seed={me?.username || me?.email || 'guest'} size={38} />
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
}

// README + manifest
put('README.md', `# ${NAME}

Generated by \`new-service.mjs\` — a LILAK Web Portal service on the kit's AppShell.

- **Frontend** (\`frontend/\`): React + Vite, aliases the kit via \`LILAK_UI_PATH\`.
  Shell = thin AppShell config in \`src/components/Shell.jsx\`; theme in
  \`src/theme/main.js\` (main colour \`${COLOR}\`); tabs: ${TABS.map((t) => t.id).join(', ')}.
- **Backend** (\`backend/\`): minimal FastAPI (health + whoami + serves \`dist\`).
  Runs on the shared portal venv; SSO via \`portal_auth.py\`.
${HAS_SETTINGS ? '- **Settings tab**: portal-centric — account + manage-users link to the portal; tabs/profile-types are service-local stubs.\n' : ''}
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
// Resolve an npm binary robustly: a portal/launchd/cron env often has a minimal
// PATH without npm, so bare spawnSync('npm') fails ENOENT (silent build failure).
// Prefer the npm that ships next to the running node, then common install dirs.
function findNpm() {
  const nodeDir = dirname(process.execPath)
  for (const c of [join(nodeDir, 'npm'), '/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']) {
    if (existsSync(c)) return c
  }
  return 'npm'
}

let built = false
if (BUILD) {
  const fe = join(ROOT, 'frontend')
  const npmBin = findNpm()
  // widen PATH so npm can find node (+ git etc.) even under a stripped env
  const PATH = [...new Set([dirname(process.execPath), dirname(npmBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean))].join(':')
  const env = { ...process.env, LILAK_UI_PATH: LILAK_UI, PATH }
  const shared = expand(args['shared-modules'])
  const nm = join(fe, 'node_modules')
  let linked = false
  if (shared && existsSync(shared) && !existsSync(nm)) {
    try { symlinkSync(shared, nm, 'dir'); linked = true } catch (e) { console.error('shared-modules link failed:', e.message) }
  }
  console.log(`\n▶ building frontend  (npm=${npmBin}, LILAK_UI_PATH=${LILAK_UI}${linked ? ', shared node_modules' : ''}) …`)
  let r = { status: 0 }
  if (!linked) r = spawnSync(npmBin, ['install', '--no-audit', '--no-fund'], { cwd: fe, env, stdio: 'inherit' })
  if (r.status === 0 && !r.error) r = spawnSync(npmBin, ['run', 'build'], { cwd: fe, env, stdio: 'inherit' })
  built = r.status === 0 && !r.error
  if (r.error) console.error(`✗ could not run npm (${npmBin}): ${r.error.message}`)
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
console.log(`  tabs:     ${TABS.map((t) => t.id).join(', ')}${HAS_SETTINGS ? '   (+ portal-centric Settings)' : ''}`)
console.log(`  colour:   ${COLOR}  (nav ${PRESET['nav-bg']} · hover ${PRESET['btn-primary-hover']})`)
console.log(`\nnext:`)
if (!BUILT_OR_SKIP()) console.log(`  cd ${join(ROOT, 'frontend')} && LILAK_UI_PATH=${LILAK_UI} npm install && npm run build`)
if (registered) console.log(`  registered with the portal — enter at /p/${NAME}/\n`)
else if (DATA_SERVICE) console.log(`  (portal registers this service directly — enter at /p/${NAME}/)\n`)
else console.log(`  register data/${NAME}/service.json with the portal: pass --register (admin token) or use the Services UI\n`)
function BUILT_OR_SKIP() { return built }