import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'   // bundled (was a unpkg CDN <script>)
import {
  applyTheme,
  applyPreset,
  loadFonts,
  FONT_DEFAULTS,
  Button,
  Input,
  Badge,
  Card,
  useMediaQuery,
} from 'lilak-ui'
// The portal's dense list parts, shared with author_manager and
// reference_manager. Only the table is borrowed — this app keeps its own page,
// so rack.css's page rules stay off (they need `rl-page` on the body).
import {
  RackTable, RackRow, useColumnWidths, brandStyle,
} from 'lilak-ui/racklist'
import 'lilak-ui/racklist/rack.css'
import {
  Cube,
  Bell,
  DownloadSimple,
  ShareNetwork,
  ArrowCounterClockwise,
  List as ListIcon,
  Translate,
  Eye,
  EyeSlash,
  GearSix,
  Broom,
  ListDashes,
  UserList,
  Camera,
  CameraPlus,
  ClockCounterClockwise,
  SignOut,
  Plus,
  Minus,
  Images,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  CheckCircle,
  ArrowCircleDown,
  ArrowCircleUp,
  FloppyDisk,
  MapPin,
  Tag,
  ShieldCheck,
  CalendarPlus,
  UploadSimple,
  Unite,
  ArrowUp,
  ArrowClockwise,
  Crop,
  X,
} from '@phosphor-icons/react'

// Two-tone palette. Tone A (primary): top-bar icons, scan FAB, active tab, selection.
const BRAND = '#3D5A80'        // slate blue
// Tone B (secondary): the content actions — photo button + My List "+" circle.
const ADD_COLOR = '#C98A2E'    // amber gold
const PHOTO_COLOR = '#C98A2E'  // amber gold

// Make the Verify / Check-out / Check-in / Edit buttons large (tab-icon scale).
const ACTION_BTN = { fontSize: 16, padding: '10px 16px' }

// This is asset_manager2 — the SAME app, served by the portal from a second
// service while its screen is being redesigned. It shares an origin with
// asset_manager, so it must not share localStorage: the per-user state (My
// List, the photos waiting to be sent, which project was last open) is keyed
// under its own namespace. The server data is separate already — a service has
// its own data dir.
const NS = 'cens2'
const STORAGE_KEYS = {
  assets: `${NS}.assets`,
  records: `${NS}.records`,
  myList: `${NS}.myList`,
  language: `${NS}.language`,
  projects: `${NS}.projects`,
  currentProjectId: `${NS}.currentProjectId`,
}

const DEFAULT_PROJECT_ID = 'LIST-default'

// Portal-only: this app is delivered through the LILAK portal, which injects
// window.__PORTAL_BASE__ = /pp/asset_manager/<project>. The PROJECT (chosen in the
// portal) IS the asset list, and identity is the portal account (SSO). There is no
// standalone login any more — the old Firebase email/password path was removed.
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''
const PORTAL_PARTS = PORTAL_BASE.split('/').filter(Boolean)        // ['pp','asset_manager','<project>']
const PORTAL_PROJECT = PORTAL_PARTS.length ? PORTAL_PARTS[PORTAL_PARTS.length - 1] : ''
const PORTAL_SERVICE = PORTAL_PARTS.length >= 2 ? PORTAL_PARTS[PORTAL_PARTS.length - 2] : ''
function portalUser() {
  try {
    const t = localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
    if (!t) return null
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const email = p.email || p.username || 'portal'
    return { email, name: p.name || p.username || email, role: p.role || p.prole || '' }
  } catch { return null }
}

// PWA: offline shell. Relative 'sw.js' resolves under the portal-injected <base>,
// so the worker registers per-project (scope = /pp/asset_manager/<project>/).
if (PORTAL_BASE && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  })
}

// The portal marks admins with role "manager" (first signup).
function isAdminUser(user) {
  if (!PORTAL_BASE) return false
  return ['manager', 'admin'].includes(String(user?.role || '').toLowerCase())
}

const tabs = [
  { id: 'assets', label: 'Assets', Glyph: ListDashes },
  { id: 'mylist', label: 'My List', Glyph: UserList },
  { id: 'scan', label: 'Scan', Glyph: Camera, fab: true },
  { id: 'classification', label: 'Class', Glyph: Tag },
  { id: 'history', label: 'History', Glyph: ClockCounterClockwise },
]

// QR/barcode text → bare asset number. Accepts a raw number, a URL with an
// assetId-style query/path, or any string containing a run of digits.
function extractAssetNumber(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  const urlMatch = value.match(/[?&](?:assetId|asset|id|no|number)=([A-Za-z0-9_-]+)/i)
  if (urlMatch) return urlMatch[1]
  const pathMatch = value.match(/\/([0-9]{2,})(?:[/?#]|$)/)
  if (pathMatch) return pathMatch[1]
  const numeric = value.match(/[0-9]{2,}/)
  return numeric ? numeric[0] : value
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function seedAssets() {
  return Array.isArray(window.CENS_SEED_ASSETS) ? window.CENS_SEED_ASSETS : []
}

function defaultProjectId() {
  return DEFAULT_PROJECT_ID
}

function projectKey(projectId, key) {
  return `${NS}.project.${projectId}.${key}`
}

// Admin-set display name for a list, stored per project. Survives portal reloads
// (where ensureProjectState otherwise rebuilds the name from the portal project).
function projectDisplayName(projectId, fallback) {
  return localStorage.getItem(projectKey(projectId, 'name')) || fallback
}

// Sync the in-app list name to the portal so the portal's project list shows the
// same name (the folder/URL id is unchanged — this only sets a display label).
// ── Server storage ───────────────────────────────────────────────────────────
// The asset list is SHARED: it lives in the backend under the portal project, not
// in this browser. localStorage stays as a fast first paint + per-user state, but
// the server is the source of truth for `SERVER_KEYS`. Standalone (no portal) has
// no backend, so it keeps the old localStorage-only behaviour.
const SERVER = !!PORTAL_PROJECT
const SERVER_KEYS = ['assets', 'records', 'locations', 'types', 'settings']

// Admin service settings (shared, server-synced). Missing keys = defaults.
const SETTINGS_DEFAULTS = { allowMove: true, allowPhoto: true, allowCreate: true, fieldVis: {} }
// Asset-card fields an admin may hide from regular users. 번호·이름·사진·위치·유저
// are always visible and not listed here.
const VIS_FIELDS = [
  { k: 'accountHolder', l: 'Account holder' },
  { k: 'applicationName', l: 'Application name' },
  { k: 'spec', l: '규격' },
  { k: 'memo', l: 'Memo' },
  { k: 'manufacturerProvider', l: 'Manufacturer' },
  { k: 'acquisitionDate', l: 'Acquired' },
  { k: 'acquisitionPriceKrw', l: 'Price' },
]

function authHeaders() {
  const tok = localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
  return tok ? { Authorization: `Bearer ${tok}` } : {}
}

async function fetchServerData() {
  const r = await fetch(`${PORTAL_BASE}/api/data`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`GET /api/data → ${r.status}`)
  return r.json()
}

// Cheap poll: just the version number, so we only pull the full document (which
// carries inline photos) when someone actually saved.
async function fetchServerVersion() {
  const r = await fetch(`${PORTAL_BASE}/api/data/version`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`GET /api/data/version → ${r.status}`)
  return (await r.json()).version
}

// Returns {conflict:true, current} when someone else saved first — the caller
// reloads from `current` instead of overwriting their work.
async function putServerData(baseVersion, shared) {
  const r = await fetch(`${PORTAL_BASE}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ baseVersion, ...shared }),
  })
  if (r.status === 409) return { conflict: true, current: (await r.json()).current }
  if (!r.ok) throw new Error(`PUT /api/data → ${r.status}`)
  return { conflict: false, doc: await r.json() }
}

function pushPortalName(name) {
  if (!PORTAL_BASE || !PORTAL_SERVICE || !PORTAL_PROJECT) return
  const tok = localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
  fetch(`/api/services/${PORTAL_SERVICE}/projects/${PORTAL_PROJECT}/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ name: name || '' }),
  }).catch(() => {})
}

function ensureProjectState() {
  // Under the portal, the project IS the portal project (one list per portal
  // project); the portal manages create/switch, so don't use the in-app picker.
  if (PORTAL_PROJECT) {
    if (!localStorage.getItem(projectKey(PORTAL_PROJECT, 'assets'))) {
      // New portal projects start empty — asset data is managed per server, not
      // bundled with the app. (Seed injection here previously pre-filled every
      // new portal project with the ~1k-row CENS_SEED_ASSETS list.)
      saveProjectData(PORTAL_PROJECT, { assets: [], records: [], myList: [] })
    }
    return { projects: [{ projectId: PORTAL_PROJECT, name: PORTAL_PROJECT }], currentProjectId: PORTAL_PROJECT }
  }
  let projects = readJson(STORAGE_KEYS.projects, null)
  let currentProjectId = localStorage.getItem(STORAGE_KEYS.currentProjectId) || ''
  if (!Array.isArray(projects) || projects.length === 0) {
    const now = new Date().toISOString()
    projects = [{ projectId: defaultProjectId(), name: 'Default list', createdAt: now, updatedAt: now }]
    currentProjectId = defaultProjectId()
    writeJson(STORAGE_KEYS.projects, projects)
    localStorage.setItem(STORAGE_KEYS.currentProjectId, currentProjectId)
  }
  if (!projects.some((project) => project.projectId === currentProjectId)) {
    currentProjectId = projects[0].projectId
    localStorage.setItem(STORAGE_KEYS.currentProjectId, currentProjectId)
  }
  if (!localStorage.getItem(projectKey(currentProjectId, 'assets'))) {
    const legacyAssets = readJson(STORAGE_KEYS.assets, null)
    saveProjectData(currentProjectId, {
      assets: Array.isArray(legacyAssets) && legacyAssets.length ? legacyAssets : seedAssets(),
      records: readJson(STORAGE_KEYS.records, []),
      myList: readJson(STORAGE_KEYS.myList, []),
    })
  }
  return { projects, currentProjectId }
}

// Fill missing type / account holder from the seed (by assetId) without
// overwriting any user-entered value — so existing lists pick up sheet updates.
function mergeSeedMeta(assets) {
  const seed = seedAssets()
  if (!seed.length || !assets.length) return assets
  const m = {}
  for (const s of seed) m[s.assetId] = s
  let changed = false
  const next = assets.map((a) => {
    const s = m[a.assetId]
    if (!s) return a
    const patch = {}
    if (!a.type && s.type) patch.type = s.type
    if (!a.accountHolder && s.accountHolder) patch.accountHolder = s.accountHolder
    if (!Object.keys(patch).length) return a
    changed = true
    return { ...a, ...patch }
  })
  return changed ? next : assets
}

function loadProjectData(projectId) {
  return {
    assets: mergeSeedMeta(readJson(projectKey(projectId, 'assets'), [])),
    records: readJson(projectKey(projectId, 'records'), []),
    myList: readJson(projectKey(projectId, 'myList'), []),
    // Photos taken for My List items, pending commit to the asset on the next
    // check-out/check-in/verify. Keyed by assetId → { sticker, whole } data URLs.
    myPhotos: readJson(projectKey(projectId, 'myPhotos'), {}),
    // Location records: [{ name, photo }]. Asset locations not yet recorded are
    // merged in at render time (see locationList).
    locations: readJson(projectKey(projectId, 'locations'), []),
    // Type classification records: [{ name, photo, description, memo, ... }].
    types: readJson(projectKey(projectId, 'types'), []),
    settings: readJson(projectKey(projectId, 'settings'), {}),
    myListName: localStorage.getItem(projectKey(projectId, 'myListName')) || '',
    currentListId: localStorage.getItem(projectKey(projectId, 'currentListId')) || '',
    myLocation: localStorage.getItem(projectKey(projectId, 'myLocation')) || '',
  }
}

function saveProjectData(projectId, data) {
  writeJson(projectKey(projectId, 'assets'), data.assets || [])
  writeJson(projectKey(projectId, 'records'), data.records || [])
  writeJson(projectKey(projectId, 'myList'), data.myList || [])
  writeJson(projectKey(projectId, 'myPhotos'), data.myPhotos || {})
  writeJson(projectKey(projectId, 'locations'), data.locations || [])
  writeJson(projectKey(projectId, 'types'), data.types || [])
  writeJson(projectKey(projectId, 'settings'), data.settings || {})
  localStorage.setItem(projectKey(projectId, 'myListName'), data.myListName || '')
  localStorage.setItem(projectKey(projectId, 'currentListId'), data.currentListId || '')
  localStorage.setItem(projectKey(projectId, 'myLocation'), data.myLocation || '')
}

// Make `name` unique among existing record names by bumping its trailing -NN index.
function uniqueName(name, records, exceptId) {
  const taken = new Set((records || []).filter((r) => r.id !== exceptId).map((r) => r.name))
  if (!taken.has(name)) return name
  const m = String(name).match(/^(.+?)-(\d+)$/)
  const base = m ? m[1] : name
  let n = m ? parseInt(m[2], 10) : 1
  let candidate
  do { n += 1; candidate = `${base}-${String(n).padStart(2, '0')}` } while (taken.has(candidate))
  return candidate
}

// Default My List name = today's date with the next free index (e.g. 2026-06-28-01).
function makeListName(records) {
  const today = new Date().toISOString().slice(0, 10)
  return uniqueName(`${today}-01`, records)
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sameIdSet(a, b) {
  const x = a || []
  const y = b || []
  if (x.length !== y.length) return false
  const s = new Set(x)
  return y.every((id) => s.has(id))
}

// Application-form field sets (ported from the old manual page). Keys map to the
// HWPX/PDF export fields used in phase 2.
const REQUEST_FORMS = {
  takeout: {
    label: '반출 신청',
    placeKey: 'takeoutPlace',   // place comes from the location input above
    fields: [
      { k: 'applicantName', l: '신청자 이름', req: true },
      { k: 'applicantOrg', l: '소속', req: true },
      { k: 'takeoutPeriod', l: '반출 기간', ph: '2026.05.27.~2026.12.31', req: true },
      { k: 'takeoutReason', l: '반출 사유', area: true, req: true },
      { k: 'domesticOrInternational', l: '국외/국내 반출 여부', ph: 'O/X' },
    ],
  },
  return: {
    label: '반입 신청',
    placeKey: 'returnPlace',
    fields: [
      { k: 'applicantName', l: '신청자 이름', req: true },
      { k: 'applicantOrg', l: '소속', req: true },
      { k: 'returnDate', l: '반입 일자', req: true },
      { k: 'returnReason', l: '반입 사유', area: true, req: true },
    ],
  },
  extension: {
    label: '연장 신청',
    fields: [
      { k: 'applicantName', l: '신청자 이름', req: true },
      { k: 'applicantOrg', l: '소속', req: true },
      { k: 'extensionPeriod', l: '연장 기간', req: true },
      { k: 'extensionReason', l: '연장 사유', area: true, req: true },
    ],
  },
}

const REQUEST_TYPE_LABEL = { takeout: '반출신청', return: '반입신청', extension: '연장신청' }

function sanitizeFileName(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'asset-list'
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}

// Rasterize a gallery-picked image to JPEG. A raw readAsDataURL keeps whatever
// the file was (SVG, HEIC, …) — which the HWPX export then embeds under a
// png/jpg name, showing up broken in 한글. Falls back to the raw data URL only
// if the browser can't decode the image at all.
async function fileToJpegDataUrl(file, maxDim = 1600) {
  const raw = await fileToDataUrl(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = raw
    })
    const w = img.naturalWidth || img.width || 1000
    const h = img.naturalHeight || img.height || 1000
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'                       // JPEG has no alpha
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return raw
  }
}

// --- minimal ZIP reader for HWPX import (STORE + DEFLATE via DecompressionStream) ---
const z16 = (b, o) => b[o] | (b[o + 1] << 8)
const z32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축 해제를 지원하지 않습니다.')
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readZipEntry(bytes, targetName) {
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i -= 1) { if (z32(bytes, i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) throw new Error('올바른 HWPX(zip) 파일이 아닙니다.')
  const count = z16(bytes, eocd + 10)
  let off = z32(bytes, eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (z32(bytes, off) !== 0x02014b50) break
    const method = z16(bytes, off + 10)
    const csize = z32(bytes, off + 20)
    const nlen = z16(bytes, off + 28)
    const elen = z16(bytes, off + 30)
    const clen = z16(bytes, off + 32)
    const lo = z32(bytes, off + 42)
    const name = new TextDecoder().decode(bytes.slice(off + 46, off + 46 + nlen))
    if (name === targetName) {
      const lnlen = z16(bytes, lo + 26)
      const lelen = z16(bytes, lo + 28)
      const ds = lo + 30 + lnlen + lelen
      const data = bytes.slice(ds, ds + csize)
      return method === 0 ? data : inflateRaw(data)
    }
    off += 46 + nlen + elen + clen
  }
  throw new Error(`${targetName}를 찾을 수 없습니다.`)
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

// List every entry name in a zip (central directory).
function listZipEntries(bytes) {
  const names = []
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i -= 1) { if (z32(bytes, i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) return names
  const count = z16(bytes, eocd + 10)
  let off = z32(bytes, eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (z32(bytes, off) !== 0x02014b50) break
    const nlen = z16(bytes, off + 28), elen = z16(bytes, off + 30), clen = z16(bytes, off + 32)
    names.push(new TextDecoder().decode(bytes.slice(off + 46, off + 46 + nlen)))
    off += 46 + nlen + elen + clen
  }
  return names
}

const colToIdx = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }

// Parse an .xlsx File → { headers: [...], rows: [[...], …] } from the first sheet.
// Handles sharedStrings + inlineStr + plain values, DEFLATE or STORE zips. The
// header row is auto-detected (the first row that contains an asset-number-like
// column); everything below it is data.
async function parseXlsx(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const names = listZipEntries(bytes)
  const sheetName = names.find((n) => /^xl\/worksheets\/sheet1\.xml$/i.test(n)) || names.find((n) => /^xl\/worksheets\/.*\.xml$/i.test(n))
  if (!sheetName) throw new Error('시트를 찾을 수 없습니다. 올바른 XLSX 파일인가요?')
  const dec = new TextDecoder()
  const sheetXml = dec.decode(await readZipEntry(bytes, sheetName))
  // Shared strings (optional)
  let shared = []
  const ssName = names.find((n) => /^xl\/sharedStrings\.xml$/i.test(n))
  if (ssName) {
    const ssXml = dec.decode(await readZipEntry(bytes, ssName))
    shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
      const txt = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')
      return unescapeXml(txt)
    })
  }
  const cellText = (cell) => {
    const t = (/\bt="([^"]+)"/.exec(cell) || [])[1]
    if (t === 'inlineStr') { const m = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cell); return m ? unescapeXml(m[1]) : '' }
    const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell)
    if (!v) return ''
    if (t === 's') return shared[Number(v[1])] ?? ''
    return unescapeXml(v[1])
  }
  const rows = []
  for (const rowM of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [...rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)]
    const arr = []
    for (const c of cells) {
      const attrs = c[1] ?? c[3] ?? ''
      const body = c[0]
      const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1]
      const idx = ref ? colToIdx(ref) : arr.length
      arr[idx] = cellText(body)
    }
    for (let i = 0; i < arr.length; i += 1) if (arr[i] === undefined) arr[i] = ''
    rows.push(arr)
  }
  // Best guess for the header row: first row containing an asset-number-ish
  // header. The user confirms/adjusts it before mapping, so this is only a hint.
  // A header cell is one whose VALUE is "자산번호" (not a sentence that merely
  // mentions it — instruction rows above the table often do). Match the cell
  // itself: exact, or a short cell that contains it.
  const isIdHeader = (v) => {
    const t = String(v || '').replace(/[\s.()]/g, '')
    if (!t) return false
    if (t === '자산번호' || /^asset(no|number|id)$/i.test(t)) return true
    return t.length <= 12 && (t.includes('자산번호') || /asset(no|number|id)/i.test(t))
  }
  let hi = rows.findIndex((r) => r.some(isIdHeader))
  if (hi < 0) hi = rows.findIndex((r) => r.filter((c) => String(c || '').trim()).length >= 2)  // else first row with ≥2 cells
  if (hi < 0) hi = 0
  return { rows, headerIdx: hi }
}

// File → list of asset numbers. Supports .json (our payload) and .hwpx (zip).
async function importFileToNumbers(file) {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.json')) {
    const data = JSON.parse(await file.text())
    const rows = Array.isArray(data) ? data : (data.rows || data.assetIds || [])
    return rows.map((r) => (typeof r === 'string' ? r : (r.assetNumber || r.assetId || ''))).filter(Boolean)
  }
  if (lower.endsWith('.hwpx')) {
    const xml = new TextDecoder('utf-8').decode(await readZipEntry(new Uint8Array(await file.arrayBuffer()), 'Contents/section0.xml'))
    return [...new Set(xml.match(/[0-9]{5,}/g) || [])]
  }
  if (lower.endsWith('.pdf')) throw new Error('PDF는 불러올 수 없습니다 (출력 전용). HWPX/JSON을 사용하세요.')
  throw new Error('지원하지 않는 형식입니다 (HWPX/JSON).')
}

// Payload shape expected by the ported window.CensHwpx.build (from the old manual page).
function buildRequestPayload(type, fields, assets, photos, title) {
  return {
    version: 1,
    title: title || '자산 목록',
    savedAt: new Date().toISOString(),
    printSettings: { fontSize: 12, rowStart: 1, orientation: 'portrait', viewMode: 'wide', description: 'hide', photos: 'show' },
    request: { type, fields },
    rows: assets.map((a) => ({
      assetNumber: a.assetId,
      assetName: a.name || '',
      assetDescription: a.description || '',
      numberPhoto: (photos[a.assetId] && photos[a.assetId].sticker) || a.photo2 || '',
      wholePhoto: (photos[a.assetId] && photos[a.assetId].whole) || a.photo1 || '',
    })),
  }
}

async function buildRequestHwpxBlob(type, fields, assets, photos, title) {
  if (!window.CensHwpx) throw new Error('HWPX 모듈을 불러오지 못했습니다. 새로고침하세요.')
  const payload = buildRequestPayload(type, fields, assets, photos, title)
  return window.CensHwpx.build(payload, REQUEST_TYPE_LABEL[type] || '')
}

// Table-only HWPX (no request-form fields): just the title + the asset table
// (photos included, like the My List export). Used by Class/History export.
async function buildTableHwpxBlob(assets, title) {
  if (!window.CensHwpx) throw new Error('HWPX 모듈을 불러오지 못했습니다. 새로고침하세요.')
  const payload = buildRequestPayload('', {}, assets, {}, title)
  return window.CensHwpx.build(payload, '')
}

// Group assets by 자산분류 (empty → '미분류'): [[cls, [assets…]], …].
function groupByClass(assets) {
  const m = new Map()
  for (const a of assets) {
    const cls = String(a.assetClass || '').trim() || '미분류'
    if (!m.has(cls)) m.set(cls, [])
    m.get(cls).push(a)
  }
  return [...m.entries()]
}

// Every asset field except photos, for the XLSX export.
const XLSX_COLUMNS = [
  ['assetId', '자산번호'], ['name', '자산명'], ['type', 'Type'], ['assetClass', '자산분류'],
  ['location', '위치'], ['user', '최근변경자'], ['accountHolder', '관리책임자'],
  ['applicationName', '신청품목명'], ['spec', '규격'], ['description', '설명'], ['memo', '메모'],
  ['manufacturerProvider', '제조사'], ['acquisitionDate', '취득일'], ['acquisitionPriceKrw', '취득가'],
  ['lastInOutDate', '최근반출입일'], ['editedBy', '편집이력'], ['lastUpdate', '최근변경'],
]

// Minimal XLSX (SpreadsheetML) writer — one sheet, inline strings, no external
// library. Reuses CensHwpx.makeZip (a STORE zip is valid for .xlsx).
function buildXlsxBlob(assets, showField = () => true) {
  const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  // Regular accounts only export the fields they're allowed to see. 자산번호·자산명
  // ·위치·최근변경자 are always in (they're always visible on the card too).
  const ALWAYS = new Set(['assetId', 'name', 'location', 'user'])
  const cols = XLSX_COLUMNS.filter(([k]) => ALWAYS.has(k) || showField(k))
  const rowsXml = [cols.map(([, h]) => h), ...assets.map((a) => cols.map(([k]) => a[k] ?? ''))]
    .map((cells, r) => {
      const c = cells.map((val, ci) => {
        const col = colName(ci) + (r + 1)
        return `<c r="${col}" t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`
      }).join('')
      return `<row r="${r + 1}">${c}</row>`
    }).join('')
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Assets" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
  const enc = new TextEncoder()
  const entries = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
  ]
  return window.CensHwpx.makeZip(entries)
}

// Excel column name for a 0-based index (A..Z, AA..).
function colName(i) {
  let s = ''
  i += 1
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) }
  return s
}

function sortAssets(list, sort) {
  const dir = sort.dir === 'asc' ? 1 : -1
  const val = (a) => {
    if (sort.key === 'name') return String(a.name || '').toLowerCase()
    if (sort.key === 'lastUpdate') return a.lastUpdate || ''
    if (sort.key === 'request') return a.verifyRequested ? 0 : 1   // asc → requested first
    const n = Number(a.assetId)
    return Number.isFinite(n) ? n : a.assetId
  }
  return [...list].sort((a, b) => {
    const va = val(a)
    const vb = val(b)
    if (va < vb) return -dir
    if (va > vb) return dir
    return 0
  })
}

// Build a classification list (location or type) from its store + asset values,
// with live item counts. Field = 'location' | 'type'.
function buildClassList(field, store, assets) {
  const map = new Map()
  for (const l of store) if (l?.name) map.set(l.name, { ...l })
  for (const a of assets) { const v = a[field]; if (v && !map.has(v)) map.set(v, { name: v, photo: '' }) }
  const counts = {}
  for (const a of assets) { const v = a[field]; if (v) counts[v] = (counts[v] || 0) + 1 }
  return [...map.values()]
    .map((l) => ({ photo: '', createdBy: '', address: '', description: '', memo: '', lastUpdate: '', ...l, count: counts[l.name] || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function bumpClassDates(list, names, now) {
  const map = new Map(list.map((l) => [l.name, l]))
  for (const n of names) {
    const cur = map.get(n) || { name: n, photo: '', createdBy: '', address: '', description: '', memo: '' }
    map.set(n, { ...cur, lastUpdate: now })
  }
  return [...map.values()]
}

function matchesAsset(asset, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [asset.assetId, asset.name, asset.description, asset.location, asset.manufacturerProvider]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q))
}

function App() {
  // Portal-only: ready immediately with the portal (SSO) identity. Opened outside
  // the portal there is no login — show a "open via the portal" notice instead.
  const [authStatus] = useState(PORTAL_BASE ? 'ready' : 'no-portal')
  const [authUser, setAuthUser] = useState(PORTAL_BASE ? (portalUser() || { email: 'portal', name: 'portal' }) : null)

  // The localStorage token can be missing on a device even though the portal
  // COOKIE is what got the user through the proxy (e.g. an installed PWA has its
  // own storage partition on iOS) — then portalUser() falls back to 'portal'.
  // The backend reads the cookie too, so ask IT who we are and correct the guess.
  useEffect(() => {
    if (!SERVER) return
    fetch(`${PORTAL_BASE}/api/whoami`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me?.authenticated && (me.email || me.username)) {
          setAuthUser({
            email: me.email || me.username,
            name: me.name || me.username || me.email,
            role: me.role || '',
          })
        }
      })
      .catch(() => {})
  }, [])
  const [projectState, setProjectState] = useState(() => ensureProjectState())
  // Restore the last tab across reloads (per project, this device).
  const [tab, setTab] = useState(() => localStorage.getItem(projectKey(projectState.currentProjectId, 'tab')) || 'assets')
  useEffect(() => {
    localStorage.setItem(projectKey(projectState.currentProjectId, 'tab'), tab)
  }, [tab, projectState.currentProjectId])
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [assets, setAssets] = useState(() => loadProjectData(projectState.currentProjectId).assets)
  const [records, setRecords] = useState(() => loadProjectData(projectState.currentProjectId).records)
  const [myList, setMyList] = useState(() => loadProjectData(projectState.currentProjectId).myList)
  const [myPhotos, setMyPhotos] = useState(() => loadProjectData(projectState.currentProjectId).myPhotos)
  const [myListName, setMyListName] = useState(() => {
    const d = loadProjectData(projectState.currentProjectId)
    return d.myListName || makeListName(d.records)
  })
  const [currentListId, setCurrentListId] = useState(() => loadProjectData(projectState.currentProjectId).currentListId)
  const [locations, setLocations] = useState(() => loadProjectData(projectState.currentProjectId).locations)
  const [types, setTypes] = useState(() => loadProjectData(projectState.currentProjectId).types)
  const [settings, setSettings] = useState(() => loadProjectData(projectState.currentProjectId).settings)
  const [myLocation, setMyLocation] = useState(() => loadProjectData(projectState.currentProjectId).myLocation)
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef(null)
  // Notification history — the last 10 system messages (per user/device),
  // shown by the top-bar bell as a simple time+message card list.
  const [noticeLog, setNoticeLog] = useState(() =>
    readJson(projectKey(projectState.currentProjectId, 'notices'), []))
  useEffect(() => {
    writeJson(projectKey(projectState.currentProjectId, 'notices'), noticeLog)
  }, [noticeLog, projectState.currentProjectId])
  const prevTabRef = useRef('assets')
  // Top-bar hamburger menu (알림 / 언어변경 / 나가기)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    const away = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menuOpen])
  // Inline confirm/prompt dialog. Native window.confirm/prompt are BLOCKED when the
  // app runs inside the portal proxy frame, so all confirmations use this instead.
  const [dialog, setDialog] = useState(null)   // null | {kind, message, value?, onConfirm}
  const [scanning, setScanning] = useState(false)
  const [capture, setCapture] = useState(null)   // { kind:'asset', id } | { kind:'location', name }
  // Scanned-but-unknown asset number → prefills the "새 자산 등록" card once.
  const [assetDraft, setAssetDraft] = useState(null)
  const [myListBadge, setMyListBadge] = useState(0)   // new My List adds while on another tab
  // Assets default: most recently edited first.
  const [sort, setSort] = useState({ key: 'lastUpdate', dir: 'desc' })
  const isMobile = useMediaQuery('(max-width: 760px)')
  // Desktop: the asset list is a rack table, with the card beside it. The card
  // list is still a press away, and which one you chose is remembered.
  const wideEnough = useMediaQuery('(min-width: 1024px)')
  const [rackPref, setRackPref] = useState(() => {
    try { return localStorage.getItem(`${NS}.deskRack`) !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem(`${NS}.deskRack`, rackPref ? '1' : '0') } catch { /* private mode */ }
  }, [rackPref])
  const deskRack = wideEnough && rackPref

  // Remembered applicant name/org for request forms, per account.
  const profileKey = `${NS}.profile.${authUser?.email || 'local'}`
  const profile = useMemo(() => readJson(profileKey, {}), [profileKey])
  function saveProfile(name, org) {
    writeJson(profileKey, { name: name || '', org: org || '' })
  }
  // Badge = net NEW My List items since the last visit to the tab: adds bump it
  // up, removes bump it down (floored at 0), so it always matches reality.
  function bumpBadge(n) {
    if (n !== 0 && tab !== 'mylist') setMyListBadge((b) => Math.max(0, b + n))
  }
  // The same "new since last visit" items, as ids — My List outlines them in a
  // different border colour. Cleared when the user LEAVES the tab (they've seen
  // them by then), and kept in sync with removals.
  const [newIds, setNewIds] = useState(() => new Set())
  function markNew(ids) {
    if (tab === 'mylist' || !ids.length) return
    setNewIds((s) => { const n = new Set(s); ids.forEach((id) => n.add(id)); return n })
  }
  function unmarkNew(ids) {
    setNewIds((s) => {
      if (![...ids].some((id) => s.has(id))) return s
      const n = new Set(s); ids.forEach((id) => n.delete(id)); return n
    })
  }
  const prevTab = useRef(tab)
  useEffect(() => {
    if (prevTab.current === 'mylist' && tab !== 'mylist') setNewIds(new Set())
    prevTab.current = tab
  }, [tab])
  const pageRef = useRef(null)
  const scrollTimer = useRef(null)

  // Show the list scrollbar only while scrolling (auto-hide ~0.9s after it stops).
  function handlePageScroll() {
    const el = pageRef.current
    if (!el) return
    el.classList.add('is-scrolling')
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => el.classList.remove('is-scrolling'), 900)
  }

  useEffect(() => {
    loadFonts()
    for (const [key, value] of Object.entries(FONT_DEFAULTS)) {
      document.documentElement.style.setProperty(key, value)
    }
    applyPreset('teal')
    applyTheme()
    // White top/bottom bars; brand pink for focus/selection accents.
    const navTheme = {
      '--nav-bg': '#ffffff',
      '--nav-border': '#e7e9ee',
      '--nav-accent': '#f3f4f7',
      '--nav-text': '#1b2330',
      '--nav-text-muted': '#8a93a3',
      '--selection-bg': '#e7ecf3',
      '--border-focus': BRAND,
      '--brand': BRAND,
      // IBM Plex for text; D2Coding (loaded by the kit's loadFonts) for asset numbers.
      '--font-sans': "'IBM Plex Sans', 'IBM Plex Sans KR', ui-sans-serif, system-ui, sans-serif",
      '--font-mono': "'D2Coding', 'D2 coding', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    }
    for (const [key, value] of Object.entries(navTheme)) {
      document.documentElement.style.setProperty(key, value)
    }
  }, [])

  useEffect(() => {
    if (tab === 'mylist') setMyListBadge(0)
  }, [tab])

  // Browser tab title = the in-app list name (updates on rename).
  useEffect(() => {
    const cur = projectState.projects.find((p) => p.projectId === projectState.currentProjectId)
    const name = projectDisplayName(projectState.currentProjectId, cur?.name || '')
    if (name) document.title = name
  }, [projectState])

  // Backfill: on load under the portal, push the current list name so a name set
  // in-app before this sync existed still propagates to the portal's project list.
  useEffect(() => {
    if (PORTAL_BASE) pushPortalName(projectDisplayName(PORTAL_PROJECT, PORTAL_PROJECT))
  }, [])

  useEffect(() => {
    saveProjectData(projectState.currentProjectId, { assets, records, myList, myPhotos, locations, types, settings, myListName, currentListId, myLocation })
    writeJson(STORAGE_KEYS.assets, assets)
    writeJson(STORAGE_KEYS.records, records)
    writeJson(STORAGE_KEYS.myList, myList)
  }, [assets, records, myList, myPhotos, locations, types, settings, myListName, currentListId, myLocation, projectState.currentProjectId])

  // ── Server sync (shared data) ──────────────────────────────────────────────
  // `serverVersion` is the version this client last agreed with; `syncedRef` is the
  // exact payload the server holds. Comparing against it (rather than juggling
  // "skip the next save" flags) is self-correcting: a hydrate/conflict-reload sets
  // it, so the resulting state change can't echo straight back as a save.
  const serverVersion = useRef(null)
  const syncedRef = useRef(null)
  const [hydrated, setHydrated] = useState(!SERVER)
  // Latest shared state, readable from the poll timer without re-arming it.
  const sharedNow = useRef(null)
  sharedNow.current = { assets, records, locations, types }

  function applyServerDoc(doc) {
    serverVersion.current = doc.version
    syncedRef.current = JSON.stringify({
      assets: doc.assets || [], records: doc.records || [],
      locations: doc.locations || [], types: doc.types || [],
      settings: doc.settings || {},
    })
    setAssets(doc.assets || [])
    setRecords(doc.records || [])
    setLocations(doc.locations || [])
    setTypes(doc.types || [])
    setSettings(doc.settings || {})
  }

  useEffect(() => {
    if (!SERVER) return
    let cancelled = false
    ;(async () => {
      try {
        const doc = await fetchServerData()
        if (cancelled) return
        applyServerDoc(doc)
      } catch {
        if (!cancelled) show('서버 연결 실패 — 이 기기의 사본을 표시합니다.', 'warn')
      } finally {
        if (!cancelled) setHydrated(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Live refresh: someone else's save should appear here without a reload. Pull
  // the full document only when the (tiny) version endpoint says it moved, and
  // never apply over unsaved local edits; the save's 409 path settles those.
  // Called by the 15s poll, foreground return, and pull-to-refresh.
  const refreshBusy = useRef(false)
  async function refreshShared() {
    if (refreshBusy.current) return
    refreshBusy.current = true
    try {
      const v = await fetchServerVersion()
      const clean = () => serverVersion.current === null ||
        JSON.stringify(sharedNow.current) === syncedRef.current
      if (v !== serverVersion.current && clean()) {
        const doc = await fetchServerData()
        if (clean()) applyServerDoc(doc)   // re-check: an edit may have landed mid-fetch
      }
    } catch {} finally { refreshBusy.current = false }
  }

  useEffect(() => {
    if (!SERVER) return
    const refresh = () => { if (document.visibilityState !== 'hidden') refreshShared() }
    const timer = setInterval(refresh, 15000)
    const onWake = () => { if (document.visibilityState === 'visible') refreshShared() }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [])

  // ── Pull-to-refresh ────────────────────────────────────────────────────────
  // Standard mobile gesture: drag the list down while it's at the top, an arrow
  // rides down with the finger, release past the threshold → refresh. The list
  // itself doesn't move (overscroll is contained); only the indicator does.
  const PTR_THRESHOLD = 64
  const ptrStartY = useRef(null)
  const [ptrPull, setPtrPull] = useState(0)
  const [ptrBusy, setPtrBusy] = useState(false)

  function onPtrStart(e) {
    const el = pageRef.current
    ptrStartY.current = (el && el.scrollTop <= 0 && !ptrBusy) ? e.touches[0].clientY : null
  }
  function onPtrMove(e) {
    if (ptrStartY.current === null) return
    const el = pageRef.current
    if (!el || el.scrollTop > 0) { ptrStartY.current = null; setPtrPull(0); return }
    const dy = e.touches[0].clientY - ptrStartY.current
    setPtrPull(dy > 0 ? Math.min(dy * 0.4, 96) : 0)   // damped, like native
  }
  function onPtrCancel() {
    ptrStartY.current = null
    setPtrPull(0)
  }
  async function onPtrEnd() {
    if (ptrStartY.current === null) return
    ptrStartY.current = null
    const fired = ptrPull >= PTR_THRESHOLD
    setPtrPull(0)
    if (!fired || ptrBusy) return
    setPtrBusy(true)
    try {
      // Keep the spinner visible for a beat even when the fetch is instant,
      // so the user sees the refresh actually happened.
      await Promise.all([refreshShared(), new Promise((r) => setTimeout(r, 600))])
    } finally { setPtrBusy(false) }
  }

  useEffect(() => {
    if (!SERVER || !hydrated || serverVersion.current === null) return
    const payload = JSON.stringify({ assets, records, locations, types, settings })
    if (payload === syncedRef.current) return           // identical to the server
    const t = setTimeout(async () => {
      try {
        const res = await putServerData(serverVersion.current, JSON.parse(payload))
        if (res.conflict) {
          applyServerDoc(res.current)
          show('다른 사용자가 먼저 저장 — 최신 목록으로 갱신했습니다.', 'warn')
        } else {
          serverVersion.current = res.doc.version
          syncedRef.current = payload
        }
      } catch {
        show('서버 저장 실패 — 변경사항이 아직 반영되지 않았습니다.', 'warn')
      }
    }, 600)                                             // debounce a burst of edits
    return () => clearTimeout(t)
  }, [assets, records, locations, types, settings, hydrated])

  const isAdmin = isAdminUser(authUser)
  // Effective service settings (admin-managed, server-shared; missing keys = defaults).
  const svcSettings = useMemo(() => ({ ...SETTINGS_DEFAULTS, ...(settings || {}) }), [settings])
  const canEditPhotos = isAdmin || svcSettings.allowPhoto !== false
  const canCreate = isAdmin || svcSettings.allowCreate !== false
  // Field visibility for regular accounts (admins always see everything).
  const showField = (k) => isAdmin || svcSettings.fieldVis?.[k] !== false
  function changeSettings(patch) {
    setSettings((cur) => ({ ...SETTINGS_DEFAULTS, ...(cur || {}), ...patch }))
  }
  // What this account is allowed to SEE: hidden assets exist only for admins.
  // Every UI list/search/count derives from viewAssets, never raw assets.
  const viewAssets = useMemo(() => (isAdmin ? assets : assets.filter((a) => !a.hidden)), [assets, isAdmin])
  // Admin-only Assets filter: all → hidden-only → visible-only (rotating button).
  const [hiddenFilter, setHiddenFilter] = useState('all')   // 'all' | 'hidden' | 'visible'
  const filteredAssets = useMemo(() => {
    let base = viewAssets
    if (isAdmin && hiddenFilter === 'hidden') base = base.filter((a) => a.hidden)
    else if (isAdmin && hiddenFilter === 'visible') base = base.filter((a) => !a.hidden)
    return sortAssets(base.filter((asset) => matchesAsset(asset, query)), sort)
  }, [viewAssets, query, sort, isAdmin, hiddenFilter])
  // My List has its own sort, defaulting to the order items were added (the
  // myList array itself — newest first, since adds unshift).
  const [mySort, setMySort] = useState({ key: 'added', dir: 'asc' })
  const myAssets = useMemo(() => {
    const list = myList.map((id) => viewAssets.find((asset) => asset.assetId === id)).filter(Boolean)
    if (mySort.key === 'added') return mySort.dir === 'asc' ? list : [...list].reverse()
    return sortAssets(list, mySort)
  }, [viewAssets, myList, mySort])
  // ↑/↓ move the open asset card to the previous/next card in the current list
  // (Assets or My List). Ignored while typing in a field, or when nothing is open.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (!expandedId || (tab !== 'assets' && tab !== 'mylist')) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      const list = tab === 'mylist' ? myAssets : filteredAssets
      const i = list.findIndex((a) => a.assetId === expandedId)
      if (i < 0) return
      const next = i + (e.key === 'ArrowDown' ? 1 : -1)
      if (next < 0 || next >= list.length) return
      e.preventDefault()
      setExpandedId(list[next].assetId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedId, tab, myAssets, filteredAssets])

  // Classification lists (location / type) merged with asset values + item counts.
  const locationList = useMemo(() => buildClassList('location', locations, viewAssets), [locations, viewAssets])
  const typeList = useMemo(() => buildClassList('type', types, viewAssets), [types, viewAssets])
  // Existing class names — the asset edit form's location/type dropdowns.
  const classOptions = useMemo(() => ({
    location: locationList.map((l) => l.name),
    type: typeList.map((l) => l.name),
  }), [locationList, typeList])
  const locationPhoto = useMemo(() => {
    const m = {}
    for (const l of locations) if (l?.name && l.photo) m[l.name] = l.photo
    return (name) => m[name] || ''
  }, [locations])
  const latestRecords = records.slice(0, 80)

  // System message: takes over the whole top bar for 2s — a coloured dot
  // (info/warn/error) + short text, centered. Must never overflow the bar.
  // One timer, reset on every call: a burst of messages shows the LAST one for
  // its full 2s (a stale earlier timer must not clear it prematurely).
  function show(message, kind = 'info') {
    setNotice({ text: message, kind })
    setNoticeLog((log) => [{ text: message, kind, at: new Date().toISOString() }, ...log].slice(0, 20))
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice('')
    }, 2000)
  }

  // Portal-safe replacements for window.confirm / window.prompt.
  function askConfirm(message, onConfirm) {
    setDialog({ kind: 'confirm', message, onConfirm })
  }
  function askPrompt(message, value, onConfirm) {
    setDialog({ kind: 'prompt', message, value: value ?? '', onConfirm })
  }

  function signOut() {
    // The only session is the portal's — leaving means going back to the portal.
    window.location.assign('/projects')
  }

  function toggleMyList(assetId) {
    const target = assets.find((a) => a.assetId === assetId)
    if (target?.hidden && !isAdmin) { show('추가할 수 없는 자산입니다.', 'warn'); return }
    const label = `${assetId} ${target?.name || ''}`.trim()
    if (myList.includes(assetId)) {
      setMyList((list) => list.filter((id) => id !== assetId))
      bumpBadge(-1)
      unmarkNew([assetId])
      setMyPhotos((photos) => {
        if (!photos[assetId]) return photos
        const next = { ...photos }
        delete next[assetId]
        return next
      })
      show(`${label} 제거 · 총 ${myList.length - 1}개`)
    } else {
      setMyList((list) => [assetId, ...list])
      bumpBadge(1)
      markNew([assetId])
      show(`${label} 추가 · 총 ${myList.length + 1}개`)
    }
  }

  function saveCapturedPhotos(assetId, shots) {
    setMyPhotos((photos) => ({ ...photos, [assetId]: { sticker: shots.sticker, whole: shots.whole } }))
    setCapture(null)
    show('사진을 My List 항목에 임시 저장했습니다.')
  }

  // --- Generic classification (location / type) helpers ---
  function upsertClass(setStore, name, patch) {
    if (!name) return
    setStore((list) => {
      const map = new Map(list.map((l) => [l.name, l]))
      const cur = map.get(name) || { name, photo: '', createdBy: authUser?.email || '', address: '', description: '', memo: '', lastUpdate: '' }
      map.set(name, { ...cur, ...patch })
      return [...map.values()]
    })
  }

  function setClassPhoto(setStore, name, photo) {
    upsertClass(setStore, name, { photo })
  }

  // Register a new location/type from the "새 등록" card. Name required, no dupes.
  function createClass(field, setStore, form) {
    const name = String(form.name || '').trim()
    if (!name) { show('이름을 입력해야 등록할 수 있습니다.', 'warn'); return false }
    const list = field === 'location' ? locationList : typeList
    if (list.some((l) => l.name === name)) { show(`'${name}'은(는) 이미 있습니다.`, 'warn'); return false }
    upsertClass(setStore, name, { ...form, name, lastUpdate: new Date().toISOString() })
    show(`'${name}'을(를) 등록했습니다.`)
    return true
  }

  // Edit a class record's name + fields; renaming reassigns the asset field.
  function updateClass(field, setStore, oldName, patch) {
    const newName = String(patch.name ?? oldName).trim() || oldName
    setStore((list) => {
      const others = list.filter((l) => l.name !== oldName && l.name !== newName)
      const cur = list.find((l) => l.name === oldName) || { name: oldName, photo: '', createdBy: authUser?.email || '', address: '', description: '', memo: '', lastUpdate: '' }
      return [...others, { ...cur, ...patch, name: newName }]
    })
    if (newName !== oldName) {
      setAssets((items) => items.map((a) => (a[field] === oldName ? { ...a, [field]: newName } : a)))
      if (field === 'location' && myLocation === oldName) setMyLocation(newName)
    }
    show('정보를 저장했습니다.')
  }

  // Merge = reassign every asset of `src` to the EXISTING class `tgt` (picked in
  // the ClassPage merge UI — free-text targets caused accidental renames).
  function execMerge(field, setStore, src, tgt) {
    updateClass(field, setStore, src, { name: tgt })
    show(`'${src}' → '${tgt}' 병합 완료`)
  }

  function deleteClass(field, setStore, name) {
    askConfirm(`'${name}'을(를) 제거할까요? 해당 자산의 값이 비워집니다.`, () => {
      doDeleteClass(field, setStore, name)
    })
  }

  function doDeleteClass(field, setStore, name) {
    setAssets((items) => items.map((a) => (a[field] === name ? { ...a, [field]: '' } : a)))
    setStore((list) => list.filter((l) => l.name !== name))
    if (field === 'location' && myLocation === name) setMyLocation('')
    show('제거했습니다.')
  }

  function addClassToMyList(field, name) {
    const ids = assets.filter((a) => a[field] === name).map((a) => a.assetId)
    const added = ids.filter((id) => !myList.includes(id))
    setMyList((list) => {
      const set = new Set(list)
      return [...list, ...ids.filter((id) => !set.has(id))]
    })
    bumpBadge(added.length)
    markNew(added)
    show(`${name}: ${added.length}개 추가 · 총 ${myList.length + added.length}개`)
  }

  function onCaptureDone(shots) {
    if (!capture) return
    if (capture.kind === 'location') {
      setClassPhoto(setLocations, capture.name, shots.photo); setCapture(null); show('위치 사진을 저장했습니다.')
    } else if (capture.kind === 'type') {
      setClassPhoto(setTypes, capture.name, shots.photo); setCapture(null); show('타입 사진을 저장했습니다.')
    } else if (capture.kind === 'slot') {
      updateAsset(capture.id, { [capture.slot]: shots.photo }); setCapture(null)
    } else {
      saveCapturedPhotos(capture.id, shots)
    }
  }

  // My List location input creates a location record on demand.
  function addLocation(name) {
    const n = String(name || '').trim()
    if (n) upsertClass(setLocations, n, {})
  }

  function recordAction(type, assetIds = myList) {
    if (!assetIds.length) {
      show('먼저 자산을 My List에 추가하세요.')
      return
    }
    const now = new Date().toISOString()
    // Update / Check-in / Check-out / Extension all assign the items to the
    // currently selected location (위치 입력칸). Plain Save (saveList) does not.
    const targetLoc = String(myLocation || '').trim()
    const entry = {
      id: newId(),
      name: uniqueName(myListName || makeListName(records), records),
      type,
      assetIds,                         // store asset numbers only — reloadable from History
      location: targetLoc,              // where the items were moved TO, at record time
      user: authUser?.email || '',
      createdAt: now,
    }
    // History confirmation mode: a regular account's location-changing action is
    // HELD as a pending record — nothing touches the assets until an admin
    // approves it from the History card.
    if (svcSettings.allowMove === false && !isAdmin) {
      setRecords((items) => [{ ...entry, pending: true }, ...items])
      show(`'${entry.name}' ${typeLabel(type)} 승인 대기로 등록되었습니다.`)
      return
    }
    setRecords((items) => [entry, ...items])
    setAssets((items) => items.map((asset) => {
      if (!assetIds.includes(asset.assetId)) return asset
      // Commit any pending My List photos onto the asset (sticker→photo2, whole→photo1).
      const shots = myPhotos[asset.assetId]
      const photoPatch = shots ? { photo1: shots.whole || asset.photo1, photo2: shots.sticker || asset.photo2 } : {}
      const base = { ...asset, ...photoPatch, lastUpdate: now, user: authUser?.email || '', ...(targetLoc ? { location: targetLoc } : {}) }
      if (type === 'update') return { ...base, verifyRequested: false, lastVerifiedDate: now, lastVerifiedBy: authUser?.email || '' }
      return { ...base, lastInOutDate: now }
    }))
    touchClasses(assetIds, now)
    // Ensure the target location record exists and bump its last-update.
    if (targetLoc) upsertClass(setLocations, targetLoc, { lastUpdate: now })
    // Clear the committed pending photos.
    setMyPhotos((photos) => {
      const next = { ...photos }
      let changed = false
      for (const id of assetIds) if (next[id]) { delete next[id]; changed = true }
      return changed ? next : photos
    })
    show(`'${entry.name}' ${typeLabel(type)} 기록 저장`)
  }

  // Bump last-update on the affected assets' location AND type records.
  function touchClasses(assetIds, now) {
    const affected = assets.filter((a) => assetIds.includes(a.assetId))
    const locNames = [...new Set(affected.map((a) => a.location).filter(Boolean))]
    const typeNames = [...new Set(affected.map((a) => a.type).filter(Boolean))]
    if (locNames.length) setLocations((list) => bumpClassDates(list, locNames, now))
    if (typeNames.length) setTypes((list) => bumpClassDates(list, typeNames, now))
  }

  // Save = snapshot the current My List to History (asset numbers + name) so it can
  // be reloaded later to keep working. Updates the loaded entry in place if any.
  function saveList() {
    if (!myList.length) {
      show('먼저 자산을 My List에 추가하세요.')
      return
    }
    const now = new Date().toISOString()
    // Don't save a duplicate: same set of assets already saved today.
    const today = now.slice(0, 10)
    if (!currentListId && records.some((r) => String(r.createdAt).slice(0, 10) === today && sameIdSet(r.assetIds, myList))) {
      show('동일한 목록이 오늘 이미 저장되어 있습니다.', 'warn')
      return
    }
    // Unique name so History never shows duplicates (bumps the trailing index).
    const name = uniqueName(myListName || makeListName(records), records, currentListId)
    if (currentListId && records.some((r) => r.id === currentListId)) {
      setRecords((items) => items.map((r) => (r.id === currentListId ? { ...r, name, assetIds: myList, updatedAt: now } : r)))
    } else {
      const id = newId()
      setRecords((items) => [{ id, name, type: 'save', assetIds: myList, user: authUser?.email || '', createdAt: now, updatedAt: now }, ...items])
      setCurrentListId(id)
    }
    if (name !== myListName) setMyListName(name)
    show(`'${name}' 목록 저장 · ${myList.length}개`)
  }

  // Request verification: flag the assets so they float to the top of Assets
  // (amber name) until a Verify clears them; also log it to History.
  function requestVerification(ids = myList) {
    if (!ids.length) {
      show('먼저 자산을 My List에 추가하세요.')
      return
    }
    const set = new Set(ids)
    const who = String(authUser?.email || '').split('@')[0] || authUser?.email || 'unknown'
    const reqLoc = `verification request by ${who}`
    const now = new Date().toISOString()
    const entryName = uniqueName(myListName || makeListName(records), records)
    setAssets((items) => items.map((a) => (set.has(a.assetId) ? { ...a, verifyRequested: true, location: reqLoc, user: authUser?.email || '', lastUpdate: now } : a)))
    setRecords((items) => [{ id: newId(), name: entryName, type: 'request', assetIds: ids, user: authUser?.email || '', createdAt: now }, ...items])
    show(`'${entryName}' 확인 요청 등록`)
  }

  // Admin: hide/unhide the given assets. Hidden assets stay in the shared data
  // but are invisible to non-admin accounts (no list, no search, no My List add).
  function setHiddenBulk(ids, hidden) {
    const idSet = new Set(ids)
    if (!idSet.size) { show('먼저 자산을 My List에 추가하세요.', 'warn'); return }
    const now = new Date().toISOString()
    setAssets((items) => items.map((a) => (idSet.has(a.assetId) ? { ...a, hidden, lastUpdate: now } : a)))
    // Logged to History, but as an admin-only record type (hidden from regular
    // accounts and from every asset card's history panel).
    setRecords((items) => [{
      id: newId(),
      name: uniqueName(myListName || makeListName(records), records),
      type: hidden ? 'hide' : 'unhide',
      assetIds: [...idSet],
      user: authUser?.email || '',
      createdAt: now,
    }, ...items])
    show(`${idSet.size}개 자산을 ${hidden ? '숨김' : '숨김 해제'} 처리했습니다.`)
  }

  // Bulk-restore asset locations to a saved { assetId: location } map — the
  // My List Update → 복원 flow (one toast, not one per asset).
  function restoreLocations(prevMap) {
    const idSet = new Set(Object.keys(prevMap))
    if (!idSet.size) return
    const now = new Date().toISOString()
    setAssets((items) => items.map((a) => (
      idSet.has(a.assetId) ? { ...a, location: prevMap[a.assetId] || '', lastUpdate: now, user: authUser?.email || '' } : a
    )))
    touchClasses([...idSet], now)
    show(`${idSet.size}개 자산 위치를 이전 위치로 복원했습니다.`)
  }

  // Admin approval of a held (pending) record: apply the location change the
  // record describes, then mark it approved.
  function approveRecord(id) {
    const rec = records.find((r) => r.id === id)
    if (!rec || !rec.pending) return
    const set = new Set(rec.assetIds || [])
    const now = new Date().toISOString()
    const targetLoc = String(rec.location || '').trim()
    setAssets((items) => items.map((a) => {
      if (!set.has(a.assetId)) return a
      const base = { ...a, lastUpdate: now, user: rec.user || '', ...(targetLoc ? { location: targetLoc } : {}) }
      if (rec.type === 'update') return { ...base, verifyRequested: false, lastVerifiedDate: now, lastVerifiedBy: rec.user || '' }
      return { ...base, lastInOutDate: now }
    }))
    if (targetLoc) upsertClass(setLocations, targetLoc, { lastUpdate: now })
    touchClasses(rec.assetIds || [], now)
    setRecords((items) => items.map((r) => (r.id === id ? { ...r, pending: false, approvedBy: authUser?.email || '', approvedAt: now } : r)))
    show(`'${rec.name}' 승인 완료 — 위치 변경 적용됨`)
  }

  // Cancel a verification request (History card): clear the flag on the record's
  // assets; a location still holding the request marker goes back to empty.
  function cancelRequest(record) {
    const set = new Set(record.assetIds || [])
    const affected = assets.filter((a) => set.has(a.assetId) && a.verifyRequested)
    if (!affected.length) { show('취소할 요청이 없습니다.', 'warn'); return }
    const now = new Date().toISOString()
    setAssets((items) => items.map((a) => {
      if (!set.has(a.assetId) || !a.verifyRequested) return a
      const loc = /^verification request by /.test(String(a.location || '')) ? '' : a.location
      return { ...a, verifyRequested: false, location: loc, lastUpdate: now, user: authUser?.email || '' }
    }))
    show(`'${record.name || record.id}' 요청 ${affected.length}개 취소`)
  }

  function deleteRecord(id) {
    askConfirm('이 기록을 삭제할까요?', () => {
      setRecords((items) => items.filter((r) => r.id !== id))
      show('기록을 삭제했습니다.')
    })
  }

  function renameRecord(id) {
    const rec = records.find((r) => r.id === id)
    askPrompt('기록 이름 편집', rec?.name || '', (name) => {
      const v = String(name || '').trim()
      if (!v) return
      setRecords((items) => items.map((r) => (r.id === id ? { ...r, name: v } : r)))
      show('기록 이름을 변경했습니다.')
    })
  }

  // Import a HWPX/JSON file → add its (existing) asset numbers to My List.
  async function importToMyList(file) {
    try {
      const numbers = await importFileToNumbers(file)
      const existing = new Set(viewAssets.map((a) => a.assetId))
      const matched = numbers.filter((n) => existing.has(n))
      const added = matched.filter((n) => !myList.includes(n))
      setMyList((list) => {
        const set = new Set(list)
        return [...list, ...matched.filter((n) => !set.has(n))]
      })
      show(matched.length ? `${added.length}개 추가 · 총 ${myList.length + added.length}개` : '추가할 자산을 찾지 못했습니다.', matched.length ? 'info' : 'warn')
    } catch (e) {
      show(`불러오기 실패: ${e.message || e}`, 'warn')
    }
  }

  // Multiple QR codes (from gallery images) → add all matched assets to My List.
  function onScanMany(texts) {
    setScanning(false)
    const numbers = [...new Set(texts.map(extractAssetNumber).filter(Boolean))]
    // One code (e.g. the "촬영" still-capture path) behaves exactly like a live
    // scan — including the unknown-number → new-asset-card flow.
    if (numbers.length === 1) { handleScannedNumber(numbers[0]); return }
    const existing = new Set(viewAssets.map((a) => a.assetId))
    const matched = numbers.filter((n) => existing.has(n))
    const added = matched.filter((n) => !myList.includes(n))
    setMyList((list) => {
      const set = new Set(list)
      return [...list, ...matched.filter((n) => !set.has(n))]
    })
    bumpBadge(added.length)
    markNew(added)
    show(`QR ${added.length}개 추가 · 총 ${myList.length + added.length}개`)
  }

  // History "+": merge a saved list's assets INTO My List (keep existing items).
  function addListToMyList(record) {
    const ids = Array.isArray(record.assetIds) ? record.assetIds : []
    const added = ids.filter((id) => !myList.includes(id))
    setMyList((list) => {
      const set = new Set(list)
      return [...list, ...ids.filter((id) => !set.has(id))]
    })
    bumpBadge(added.length)
    markNew(added)
    show(`'${record.name || record.id}' ${added.length}개 추가 · 총 ${myList.length + added.length}개`)
  }

  // History "−": remove a saved list's assets from My List in one go.
  function removeListFromMyList(record) {
    const ids = new Set(Array.isArray(record.assetIds) ? record.assetIds : [])
    const removed = myList.filter((id) => ids.has(id)).length   // only those actually removed
    bumpBadge(-removed)
    unmarkNew(ids)
    setMyList((list) => list.filter((id) => !ids.has(id)))
    setMyPhotos((photos) => {
      const next = { ...photos }
      let changed = false
      for (const id of ids) if (next[id]) { delete next[id]; changed = true }
      return changed ? next : photos
    })
    show(`'${record.name || record.id}' ${removed}개 제거 · 총 ${myList.length - removed}개`)
  }

  function clearMyList() {
    if (!myList.length) return
    askConfirm('My List를 모두 비울까요?', () => {
      setMyList([])
      setNewIds(new Set())
      setMyPhotos({})
      show('My List를 비웠습니다.')
    })
  }

  // Permanently delete the listed assets from the shared inventory, logging a
  // History record (asset numbers only) so the removal is traceable.
  function deleteAssets(assetIds = myList) {
    const idSet = new Set(assetIds)
    if (!idSet.size) return
    const now = new Date().toISOString()
    setRecords((items) => [{
      id: newId(),
      name: uniqueName(myListName || makeListName(records), records),
      type: 'delete',
      assetIds: [...idSet],
      user: authUser?.email || '',
      createdAt: now,
    }, ...items])
    setAssets((items) => items.filter((a) => !idSet.has(a.assetId)))
    setMyList((list) => list.filter((id) => !idSet.has(id)))
    setMyPhotos((m) => { const n = { ...m }; let ch = false; for (const id of idSet) if (n[id]) { delete n[id]; ch = true } return ch ? n : m })
    show(`${idSet.size}개 자산을 삭제했습니다.`)
  }

  // A scan is an "add to My List" action (same for live scan / capture / gallery):
  // a known number drops straight into My List with no card opening and no tab
  // jump; an UNKNOWN number opens the "새 자산 등록" card with it filled in.
  function handleScannedNumber(number) {
    const match = assets.find((asset) => asset.assetId === number)
    if (match?.hidden && !isAdmin) { show('추가할 수 없는 자산입니다.', 'warn'); return }
    if (!match) {
      if (svcSettings.allowCreate === false && !isAdmin) { show(`미등록 번호(${number})입니다.`, 'warn'); return }
      setQuery('')                     // the new-asset card only shows when un-searched
      setExpandedId('')
      setAssetDraft({ assetId: number })
      setTab('assets')
      show(`미등록 번호(${number})입니다 — 새 자산으로 등록하세요.`)
      return
    }
    setQuery(number)                   // Assets search box shows the scanned item
    if (myList.includes(number)) {
      show(`${number} 자산은 이미 My List에 있습니다.`, 'warn')
      return
    }
    setMyList((list) => [number, ...list])
    markNew([number])
    bumpBadge(1)
    show(`${number} ${match.name || ''} 추가 · 총 ${myList.length + 1}개`.replace(/\s+/g, ' '))
  }

  function onScanResult(text) {
    setScanning(false)
    const number = extractAssetNumber(text)
    if (!number) return
    handleScannedNumber(number)
  }

  // Append-only editor trail: "kim → lee → kim". Never cleared, never editable;
  // consecutive edits by the same person are collapsed into one entry.
  function appendEditedBy(prev, me) {
    if (!me) return prev || ''
    const chain = String(prev || '').trim()
    const last = chain.split('→').map((s) => s.trim()).filter(Boolean).pop()
    return last === me ? chain : (chain ? `${chain} → ${me}` : me)
  }

  function updateAsset(assetId, patch) {
    const now = new Date().toISOString()
    const me = authUser?.email ? String(authUser.email).split('@')[0] : ''
    // The asset number itself is editable — validate + carry references along.
    if ('assetId' in patch) {
      const newId = String(patch.assetId || '').trim()
      if (!newId) { show('자산번호는 비울 수 없습니다.', 'warn'); return false }
      if ('name' in patch && !String(patch.name || '').trim()) { show('이름은 비울 수 없습니다.', 'warn'); return false }
      patch = { ...patch, assetId: newId }
      if (newId !== assetId) {
        if (assets.some((a) => a.assetId === newId)) { show(`자산번호 ${newId}는 이미 있습니다.`, 'warn'); return false }
        setMyList((list) => list.map((id) => (id === assetId ? newId : id)))
        setMyPhotos((m) => {
          if (!m[assetId]) return m
          const n = { ...m, [newId]: m[assetId] }
          delete n[assetId]
          return n
        })
        if (expandedId === assetId) setExpandedId(newId)
      }
    }
    setAssets((items) => items.map((asset) => (
      asset.assetId === assetId ? { ...asset, ...patch, editedBy: appendEditedBy(asset.editedBy, me), lastUpdate: now } : asset
    )))
    touchClasses([assetId], now)
    const cur = assets.find((a) => a.assetId === assetId)
    const finalId = 'assetId' in patch ? patch.assetId : assetId
    const finalName = ('name' in patch ? patch.name : cur?.name) || ''
    show(`${finalId} ${finalName}의 정보를 변경했습니다.`.replace(/\s+/g, ' '))
    return true
  }

  // "전체추가" — add every asset currently listed (i.e. the filtered set) to My List.
  function addAllAssets(ids) {
    const added = ids.filter((id) => !myList.includes(id))
    if (!added.length) { show('이미 모두 My List에 있습니다.', 'warn'); return }
    setMyList((list) => [...list, ...added.filter((id) => !list.includes(id))])
    bumpBadge(added.length)
    markNew(added)
    show(`${added.length}개 추가 · 총 ${myList.length + added.length}개`)
  }

  // Register a brand-new asset (the "새 자산 등록" card). Number + name required.
  function createAsset(form) {
    if (svcSettings.allowCreate === false && !isAdmin) { show('새 자산 추가가 허용되지 않았습니다.', 'warn'); return false }
    const id = String(form.assetId || '').trim()
    const name = String(form.name || '').trim()
    if (!id || !name) { show('자산번호와 이름을 입력해야 등록할 수 있습니다.', 'warn'); return false }
    if (assets.some((a) => a.assetId === id)) { show(`자산번호 ${id}는 이미 있습니다.`, 'warn'); return false }
    const now = new Date().toISOString()
    const me = authUser?.email ? String(authUser.email).split('@')[0] : ''
    const asset = { photo1: '', photo2: '', photo3: '', createdAt: now, updatedAt: now, lastUpdate: now, user: authUser?.email || '', editedBy: me }
    EDIT_FIELDS.forEach((f) => { asset[f.key] = String(form[f.key] || '').trim() })
    asset.assetId = id
    asset.name = name
    setAssets((items) => [asset, ...items])
    setExpandedId(id)
    show(`새 자산 ${id}를 등록했습니다.`)
    return true
  }

  // Bulk import from XLSX (the new-asset card): add only the NON-duplicate rows.
  // Each row is already a field→value object; assetId is required, dups skipped.
  function importAssets(newAssets) {
    if (svcSettings.allowCreate === false && !isAdmin) { show('새 자산 추가가 허용되지 않았습니다.', 'warn'); return }
    const have = new Set(assets.map((a) => a.assetId))
    const now = new Date().toISOString()
    const me = authUser?.email ? String(authUser.email).split('@')[0] : ''
    const seen = new Set()
    const toAdd = []
    for (const r of newAssets) {
      const id = String(r.assetId || '').trim()
      if (!id || have.has(id) || seen.has(id)) continue
      seen.add(id)
      const a = { photo1: '', photo2: '', photo3: '', createdAt: now, updatedAt: now, lastUpdate: now, user: authUser?.email || '', editedBy: me }
      EDIT_FIELDS.forEach((f) => { a[f.key] = String(r[f.key] || '').trim() })
      a.assetId = id
      toAdd.push(a)
    }
    if (!toAdd.length) { show('추가할 새 자산이 없습니다.', 'warn'); return }
    setAssets((items) => [...toAdd, ...items])
    show(`${toAdd.length}개 자산을 추가했습니다.`)
  }

  if (authStatus !== 'ready') {
    return <NoPortalScreen />
  }

  const currentProject = projectState.projects.find((project) => project.projectId === projectState.currentProjectId)
  const projectName = projectDisplayName(projectState.currentProjectId, currentProject?.name || '')
  const tabIconSize = isMobile ? 29 : 19
  const logoutIconSize = isMobile ? 24 : 17

  const myListSet = useMemo(() => new Set(myList), [myList])

  return (
    <div className={`app${deskRack ? ' is-rack' : ''}`}>
      <header className="topbar">
        {notice ? (
          <div
            className={`topbar-notice${notice.text.length > 28 ? ' is-long' : ''}`}
            role="button"
            onClick={() => {
              if (noticeTimer.current) { window.clearTimeout(noticeTimer.current); noticeTimer.current = null }
              setNotice('')
            }}
          >
            <span className={`notice-dot is-${notice.kind}`} />
            <span className="topbar-notice-text">{notice.text}</span>
          </div>
        ) : (
          <>
            <div className="topbar-title">
              <Cube size={isMobile ? 24 : 20} weight="fill" color={BRAND} />
              {projectName && <span className="topbar-project">{projectName}</span>}
              {authUser && <span className="topbar-user">{String(authUser.email).split('@')[0]}</span>}
            </div>
            <div className="topbar-right" ref={menuRef}>
              <button type="button" className="topbar-logout" title="메뉴" onClick={() => setMenuOpen((o) => !o)}>
                <ListIcon size={logoutIconSize} weight="bold" color={menuOpen || tab === 'notices' ? '#c98a2e' : BRAND} />
              </button>
              {menuOpen && (
                <div className="topbar-menu-pop">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      if (tab === 'notices') { setTab(prevTabRef.current) } else { prevTabRef.current = tab; setTab('notices') }
                    }}
                  >
                    <Bell size={17} weight="fill" /> 알림
                  </button>
                  <button type="button" onClick={() => { setMenuOpen(false); show('영어 번역은 준비 중입니다.', 'warn') }}>
                    <Translate size={17} weight="fill" /> 언어변경
                  </button>
                  <button type="button" onClick={signOut}>
                    <SignOut size={17} weight="fill" /> 나가기
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </header>
      {SERVER && (
        <div className="ptr-anchor" aria-hidden="true">
          <div
            className={`ptr${ptrPull > 0 || ptrBusy ? ' is-active' : ''}${ptrPull > 0 && !ptrBusy ? ' is-dragging' : ''}${ptrPull >= PTR_THRESHOLD ? ' is-ready' : ''}${ptrBusy ? ' is-spinning' : ''}`}
            style={{ transform: `translate(-50%, ${ptrBusy ? 20 : Math.round(ptrPull) - 44}px)` }}
          >
            <ArrowClockwise size={20} weight="bold" style={ptrBusy ? undefined : { transform: `rotate(${Math.round(ptrPull * 3)}deg)` }} />
          </div>
        </div>
      )}
      <main
        className={`page${deskRack ? ' is-rack' : ''}`}
        ref={pageRef}
        onScroll={handlePageScroll}
        onTouchStart={SERVER ? onPtrStart : undefined}
        onTouchMove={SERVER ? onPtrMove : undefined}
        onTouchEnd={SERVER ? onPtrEnd : undefined}
        onTouchCancel={SERVER ? onPtrCancel : undefined}
      >
        <RackFrame
          on={deskRack}
          tabs={[...tabs.filter((t) => !t.fab), { id: 'notices', label: '알림' }]}
          tab={tab}
          setTab={setTab}
          count={assets.length}
          project={PORTAL_PROJECT}
          note={notice?.text}
          onScan={() => setScanning(true)}
        >
        {tab === 'assets' && deskRack && (
          <AssetRack
            query={query}
            setQuery={setQuery}
            assets={filteredAssets}
            myListSet={myListSet}
            myPhotos={myPhotos}
            toggleMyList={toggleMyList}
            onCapture={(id) => setCapture({ kind: 'asset', id })}
            onCaptureSlot={(id, slot) => setCapture({ kind: 'slot', id, slot })}
            recordAction={recordAction}
            updateAsset={updateAsset}
            locationPhoto={locationPhoto}
            records={latestRecords}
            classOptions={classOptions}
            isAdmin={isAdmin}
            canEditPhotos={canEditPhotos}
            showField={showField}
            onAddAll={addAllAssets}
            hiddenFilter={hiddenFilter}
            onCycleHiddenFilter={() => setHiddenFilter((f) => (f === 'all' ? 'hidden' : f === 'hidden' ? 'visible' : 'all'))}
            onCards={() => setRackPref(false)}
          />
        )}
        {tab === 'assets' && !deskRack && (
          <AssetListPage
            onRack={wideEnough ? () => setRackPref(true) : null}
            query={query}
            setQuery={setQuery}
            assets={filteredAssets}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            myListSet={myListSet}
            myPhotos={myPhotos}
            toggleMyList={toggleMyList}
            onCapture={(id) => setCapture({ kind: 'asset', id })}
            onCaptureSlot={(id, slot) => setCapture({ kind: 'slot', id, slot })}
            recordAction={recordAction}
            updateAsset={updateAsset}
            locationPhoto={locationPhoto}
            records={latestRecords}
            sort={sort}
            setSort={setSort}
            onCreate={createAsset}
            onImportAssets={importAssets}
            existingIds={assets.map((a) => a.assetId)}
            draft={assetDraft}
            onDraftDone={() => setAssetDraft(null)}
            onAddAll={addAllAssets}
            classOptions={classOptions}
            isAdmin={isAdmin}
            canEditPhotos={canEditPhotos}
            showField={showField}
            canCreate={canCreate}
            hiddenFilter={hiddenFilter}
            onCycleHiddenFilter={() => setHiddenFilter((f) => (f === 'all' ? 'hidden' : f === 'hidden' ? 'visible' : 'all'))}
          />
        )}
        {tab === 'mylist' && (
          <MyListPage
            assets={myAssets}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            myPhotos={myPhotos}
            toggleMyList={toggleMyList}
            onCapture={(id) => setCapture({ kind: 'asset', id })}
            onCaptureSlot={(id, slot) => setCapture({ kind: 'slot', id, slot })}
            recordAction={recordAction}
            updateAsset={updateAsset}
            locationPhoto={locationPhoto}
            records={latestRecords}
            listName={myListName}
            setListName={setMyListName}
            onSave={saveList}
            onClear={clearMyList}
            onDeleteAssets={deleteAssets}
            onRequest={requestVerification}
            onImport={importToMyList}
            profile={profile}
            onSaveProfile={saveProfile}
            notify={show}
            locationList={locationList}
            myLocation={myLocation}
            setMyLocation={setMyLocation}
            addLocation={addLocation}
            onLocationPhoto={(name) => name && setCapture({ kind: 'location', name })}
            sort={mySort}
            setSort={setMySort}
            newIds={newIds}
            onSeenNew={(id) => unmarkNew([id])}
            classOptions={classOptions}
            onRestoreLocations={restoreLocations}
            isAdmin={isAdmin}
            onSetHidden={setHiddenBulk}
            canEditPhotos={canEditPhotos}
            showField={showField}
            svcSettings={svcSettings}
            onChangeSettings={changeSettings}
          />
        )}
        {tab === 'history' && <RecordsPage records={latestRecords} assets={viewAssets} me={authUser?.email || ''} notify={show} myListSet={myListSet} toggleMyList={toggleMyList} onAdd={addListToMyList} onRemove={removeListFromMyList} isAdmin={isAdmin} onDelete={deleteRecord} onRename={renameRecord} onCancelRequest={cancelRequest} onApprove={approveRecord} showField={showField} />}
        {tab === 'classification' && (
          <ClassificationPage
            assets={viewAssets}
            canEditPhotos={canEditPhotos}
            notify={show}
            showField={showField}
            myListSet={myListSet}
            isAdmin={isAdmin}
            toggleMyList={toggleMyList}
            locationList={locationList}
            typeList={typeList}
            onCreateLocation={(f) => createClass('location', setLocations, f)}
            onCreateType={(f) => createClass('type', setTypes, f)}
            onUpdateLocation={(o, p) => updateClass('location', setLocations, o, p)}
            onMergeLocation={(src, tgt) => execMerge('location', setLocations, src, tgt)}
            onDeleteLocation={(n) => deleteClass('location', setLocations, n)}
            onAddAllLocation={(n) => addClassToMyList('location', n)}
            onPhotoLocation={(n) => setCapture({ kind: 'location', name: n })}
            onUpdateType={(o, p) => updateClass('type', setTypes, o, p)}
            onMergeType={(src, tgt) => execMerge('type', setTypes, src, tgt)}
            onDeleteType={(n) => deleteClass('type', setTypes, n)}
            onAddAllType={(n) => addClassToMyList('type', n)}
            onPhotoType={(n) => setCapture({ kind: 'type', name: n })}
          />
        )}
        {tab === 'notices' && (
          <div className="stack">
            {noticeLog.length === 0 && <Card><p className="muted">알림이 없습니다.</p></Card>}
            {noticeLog.map((n, i) => (
              <Card key={`${n.at}-${i}`}>
                <div className="notice-item">
                  <span className={`notice-dot is-${n.kind || 'info'}`} />
                  <span className="notice-item-text">{n.text}</span>
                  <span className="notice-item-time">{formatNoticeTime(n.at)}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
        </RackFrame>
      </main>
      <nav className="tabbar">
        {tabs.map((item) =>
          item.fab ? (
            <button key={item.id} type="button" className="tabbar-fab" title={item.label} onClick={() => setScanning(true)}>
              <item.Glyph size={26} weight="fill" color="#ffffff" />
            </button>
          ) : (
            <button
              key={item.id}
              type="button"
              className={`tabbar-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => {
                if (tab === item.id) {
                  // Re-tapping the active tab: close the open card + glide to top.
                  setExpandedId('')
                  pageRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                } else setTab(item.id)
              }}
              title={item.label}
            >
              <span className="tabbar-glyph">
                <item.Glyph size={tabIconSize} weight="fill" color={tab === item.id ? BRAND : '#9aa3b2'} />
                {item.id === 'mylist' && myListBadge > 0 && <span className="tab-badge">{myListBadge}</span>}
              </span>
              <span className="tabbar-label">
                {item.label}
                {item.id === 'mylist' && myList.length > 0 && <span className="tab-total"> {myList.length}</span>}
              </span>
            </button>
          ),
        )}
      </nav>
      {scanning && <ScannerModal onResult={onScanResult} onResultMany={onScanMany} onClose={() => setScanning(false)} />}
      {dialog && <Dialog dialog={dialog} onClose={() => setDialog(null)} />}
      {capture && (
        <PhotoCaptureModal
          title={
            capture.kind === 'location' ? `위치 사진 · ${capture.name}`
              : capture.kind === 'type' ? `타입 사진 · ${capture.name}`
                : capture.kind === 'slot' ? `사진 다시 찍기 · ${capture.id}`
                  : `사진 촬영 · ${capture.id}`
          }
          steps={
            capture.kind === 'asset' ? ASSET_STEPS
              : capture.kind === 'slot'
                ? [{ key: 'photo', guide: capture.slot === 'photo2' ? '자산 스티커(자산번호)가 잘 보이도록 찍으세요.' : '자산 전체가 잘 보이도록 찍으세요.', label: '촬영' }]
                : LOCATION_STEPS
          }
          onDone={onCaptureDone}
          onClose={() => setCapture(null)}
        />
      )}
    </div>
  )
}

function ScannerModal({ onResult, onResultMany, onClose }) {
  const scannerRef = useRef(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const galleryRef = useRef(null)

  useEffect(() => {
    const Lib = Html5Qrcode
    if (!Lib) {
      setError('QR 스캐너 라이브러리를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.')
      return
    }
    const scanner = new Lib('qr-reader')
    scannerRef.current = scanner
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      // stop() THROWS synchronously while the camera is still starting up —
      // an uncaught throw in the unmount cleanup blanks the whole app.
      try { return scanner.stop().catch(() => {}) } catch { /* not running yet */ }
    }
    scanner
      .start(
        { facingMode: 'environment' },
        {
          fps: 15,
          // Ask for a high-res stream with continuous autofocus. The default stream
          // is often 640x480 and fixed-focus, which is the main reason a small
          // asset-sticker QR won't resolve. (Ignored where unsupported.)
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }],
          },
          // Scan box scaled to the viewfinder instead of a fixed 240px square, so
          // the code doesn't have to be aimed into a small centre box.
          qrbox: (vw, vh) => { const s = Math.round(Math.min(vw, vh) * 0.7); return { width: s, height: s } },
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        },
        (decodedText) => { stop(); onResult(decodedText) },
      )
      .then(() => {
        // Cancelled while the camera was still starting: the just-started
        // stream must be shut down, or the camera stays on after unmount.
        if (stopped) scanner.stop().catch(() => {})
      })
      .catch((err) => { if (!stopped) setError(`카메라를 시작할 수 없습니다: ${err?.message || err}`) })
    return () => { stop() }
  }, [])

  // Gallery: decode QR from one or more selected images, return all matches.
  async function onGallery(event) {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const Lib = Html5Qrcode
    if (!Lib) { setError('QR 라이브러리를 불러오지 못했습니다.'); return }
    setBusy(true)
    try {
      await scannerRef.current?.stop().catch(() => {})
    } catch { /* not running */ }
    const fileScanner = new Lib('qr-file-reader')
    const texts = []
    for (const f of files) {
      try { const t = await fileScanner.scanFile(f, false); if (t) texts.push(t) } catch { /* no QR in image */ }
    }
    setBusy(false)
    onResultMany(texts)
  }

  // "촬영": grab the CURRENT live viewfinder frame and decode it in place — no
  // jump to the native camera app. The live scanner keeps running, so a failed
  // shot just shows a hint and scanning continues.
  async function onShot() {
    const video = document.querySelector('#qr-reader video')
    if (!video || !video.videoWidth) { setError('카메라 화면이 아직 준비되지 않았습니다.'); return }
    setBusy(true)
    setError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92))
      const fileScanner = new Html5Qrcode('qr-file-reader')
      const text = await fileScanner.scanFile(new File([blob], 'shot.jpg', { type: 'image/jpeg' }), false)
      try { await scannerRef.current?.stop() } catch { /* already stopped */ }
      onResultMany([text])
    } catch {
      setError('촬영한 화면에서 QR을 찾지 못했습니다 — 더 가까이서 다시 시도하세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scanner-backdrop" onClick={onClose}>
      <section className="scanner-modal" onClick={(event) => event.stopPropagation()}>
        <header className="scanner-header">
          <h2>QR 코드 스캔</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>
        <div id="qr-reader" className="qr-reader" />
        <div id="qr-file-reader" style={{ display: 'none' }} />
        <div className="action-row scanner-actions">
          <button type="button" className="amber-btn" disabled={busy} onClick={() => galleryRef.current?.click()}>
            <Images size={20} weight="fill" /> {busy ? '인식 중…' : '사진 선택'}
          </button>
          <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={onGallery} />
          <button type="button" className="amber-btn" disabled={busy} onClick={onShot}>
            <Camera size={20} weight="fill" /> {busy ? '인식 중…' : '촬영'}
          </button>
        </div>
        {error
          ? <p className="muted scanner-hint">{error}</p>
          : <p className="muted scanner-hint">잘 인식되지 않으면 “촬영”으로 가까이서 또렷하게 찍어보세요.</p>}
      </section>
    </div>
  )
}

// Capture step configs. ASSET = two guided shots; LOCATION = one shot.
const ASSET_STEPS = [
  { key: 'sticker', guide: '① 자산 스티커(자산번호)가 잘 보이도록 찍으세요.', label: '스티커 촬영' },
  { key: 'whole', guide: '② 자산 전체가 잘 보이도록 찍으세요.', label: '자산 촬영' },
]
const LOCATION_STEPS = [
  { key: 'photo', guide: '위치(공간)가 잘 보이도록 찍으세요.', label: '위치 촬영' },
]

// Step-driven camera capture. Returns onDone(shots) keyed by each step's key.
function PhotoCaptureModal({ title, steps, onDone, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const galleryRef = useRef(null)
  const [step, setStep] = useState(0)
  const shotsRef = useRef({})
  const [error, setError] = useState('')

  // Pick up to steps.length images from the gallery, mapped to each step's key.
  async function onGallery(event) {
    const files = [...(event.target.files || [])].slice(0, steps.length)
    event.target.value = ''
    if (!files.length) return
    streamRef.current?.getTracks().forEach((t) => t.stop())
    const shots = {}
    for (let i = 0; i < files.length; i += 1) shots[steps[i].key] = await fileToJpegDataUrl(files[i])
    onDone(shots)
  }

  useEffect(() => {
    let cancelled = false
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
    if (!md?.getUserMedia) {
      setError('이 브라우저/연결에서는 카메라를 쓸 수 없습니다. (HTTPS 또는 localhost 필요)')
      return
    }
    md.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}) }
      })
      .catch((err) => setError(`카메라를 시작할 수 없습니다: ${err?.message || err}`))
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()) }
  }, [])

  function snap() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return ''
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.7)
  }

  function capture() {
    shotsRef.current[steps[step].key] = snap()
    if (step < steps.length - 1) {
      setStep(step + 1)
    } else {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      onDone({ ...shotsRef.current })
    }
  }

  const last = step === steps.length - 1
  const progress = steps.length > 1 ? ` (${step + 1}/${steps.length})` : ''

  return (
    <div className="scanner-backdrop" onClick={onClose}>
      <section className="scanner-modal" onClick={(event) => event.stopPropagation()}>
        <header className="scanner-header">
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>
        {error ? (
          <p className="muted scanner-hint">{error}</p>
        ) : (
          <>
            <video ref={videoRef} className="qr-reader capture-video" playsInline muted />
            <p className="capture-guide">{steps[step].guide}</p>
            <div className="action-row scanner-actions">
              <button type="button" className="amber-btn" onClick={() => galleryRef.current?.click()}>
                <Images size={20} weight="fill" /> 사진 선택{steps.length > 1 ? ` (${steps.length}장)` : ''}
              </button>
              <input ref={galleryRef} type="file" accept="image/*" multiple={steps.length > 1} hidden onChange={onGallery} />
              {/* Snaps the in-app viewfinder above — never the native camera app. */}
              <button type="button" className="amber-btn" onClick={capture}>
                <Camera size={20} weight="fill" /> {steps[step].label}{last ? ' · 완료' : ''}{progress}
              </button>
            </div>
          </>
        )}
        {error && (
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={() => galleryRef.current?.click()}>
              <Images size={16} weight="fill" /> 사진첩{steps.length > 1 ? ` (최대 ${steps.length}장)` : ''}
            </button>
            <input ref={galleryRef} type="file" accept="image/*" multiple={steps.length > 1} hidden onChange={onGallery} />
          </div>
        )}
      </section>
    </div>
  )
}

// Shown only when the app is opened OUTSIDE the LILAK portal (there is no standalone
// login any more — the list is a portal project and identity is the portal account).
// Inline confirm/prompt overlay — a portal-safe replacement for the native
// window.confirm/window.prompt dialogs (blocked inside the portal proxy frame).
function Dialog({ dialog, onClose }) {
  const [value, setValue] = useState(dialog.kind === 'prompt' ? (dialog.value ?? '') : '')
  const inputRef = useRef(null)
  useEffect(() => { if (dialog.kind === 'prompt') inputRef.current?.focus() }, [])
  function confirm() {
    const cb = dialog.onConfirm
    onClose()
    if (dialog.kind === 'prompt') cb?.(value)
    else cb?.()
  }
  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true"
         style={{ position: 'fixed', inset: 0, background: 'rgba(20,26,38,0.45)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}>
          <p style={{ margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{dialog.message}</p>
          {dialog.kind === 'prompt' && (
            <Input
              ref={inputRef}
              size="md"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
            />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="md" variant="secondary" type="button" onClick={onClose}>취소</Button>
            <Button size="md" type="button" onClick={confirm}>확인</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function NoPortalScreen() {
  return (
    <main className="login-page">
      <section className="login-shell">
        <Card style={{ width: '100%', maxWidth: 520 }}>
          <div className="login-form">
            <h1>Asset manager</h1>
            <p className="login-message">
              이 앱은 LILAK 포털을 통해 열어주세요. 목록(리스트)은 포털의 프로젝트로 선택하고,
              로그인은 포털 계정으로 대체되었습니다.
            </p>
            <Button size="md" style={loginButtonStyle} type="button" onClick={() => window.location.assign('/projects')}>
              포털로 이동
            </Button>
          </div>
        </Card>
      </section>
    </main>
  )
}

function SortBar({ sort, setSort, withAdded }) {
  const opts = [
    ...(withAdded ? [{ k: 'added', l: '추가순' }] : []),
    { k: 'assetId', l: '번호' }, { k: 'name', l: '이름' }, { k: 'lastUpdate', l: '수정일' }, { k: 'request', l: '요청' },
  ]
  return (
    <div className="sort-bar">
      <span className="sort-label">정렬</span>
      {opts.map((o) => {
        const active = sort.key === o.k
        return (
          <button
            key={o.k}
            type="button"
            className={`sort-btn${active ? ' is-active' : ''}`}
            onClick={() => setSort(active ? { key: o.k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: o.k, dir: 'asc' })}
          >
            {o.l}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        )
      })}
    </div>
  )
}

// One asset edit field — dropdown (existing locations/types only), textarea, or input.
function EditField({ field, form, setForm, classOptions }) {
  const set = (v) => setForm((c) => ({ ...c, [field.key]: v }))
  if (field.options) {
    const opts = classOptions?.[field.options] || []
    const cur = form[field.key] || ''
    // A legacy value not in the list stays selectable so it isn't silently lost.
    const withCur = cur && !opts.includes(cur) ? [cur, ...opts] : opts
    return (
      <label>
        {field.label}
        <select className="edit-select" value={cur} onChange={(e) => set(e.target.value)}>
          <option value="">(선택 안 함)</option>
          {withCur.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    )
  }
  return (
    <label>
      {field.label}
      {field.textarea ? (
        <textarea className="edit-textarea" value={form[field.key] || ''} onChange={(e) => set(e.target.value)} />
      ) : (
        <Input
          size="md"
          className={field.required && !String(form[field.key] || '').trim() ? 'is-req-empty' : undefined}
          value={form[field.key] || ''}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </label>
  )
}

// Shared search field: magnifier on the left, icon-only clear (×) on the right
// whenever there's text.
function SearchBox({ query, setQuery, placeholder }) {
  return (
    <div className="search-box">
      <span className="mylist-icon-cell"><MagnifyingGlass size={18} weight="fill" color={BRAND} /></span>
      <Input size="md" value={query} placeholder={placeholder} onChange={(event) => setQuery(event.target.value)} />
      {String(query || '') !== '' && (
        <button type="button" className="search-clear mylist-icon-cell" title="지우기" onClick={() => setQuery('')}>
          <X size={16} weight="bold" color={BRAND} />
        </button>
      )}
    </div>
  )
}

// ── Two-phase card open/close (asset / class / history cards) ─────────────────
// OPEN: glide the still-collapsed card up under the top bar FIRST, then grow the
// body downward, then re-glide once everything settles (a card growing near the
// list end only gains scroll room as it grows, so the first glide can land off).
// CLOSE: shrink in place. No scroll restore: when a low card closes and the page
// runs out of height, the browser clamps the scroll frame-by-frame ALONG the
// animated shrink, which reads as one smooth "close + settle" motion.
// SWITCH (A open → tap B): A must vanish INSTANTLY — animating A's shrink while
// B glides makes B chase a moving target and the whole thing feels wobbly. The
// close branch defers one tick and checks `_lastOpenAt`: both effects of the same
// React commit have run by then, whatever their order in the list.
let _lastOpenAt = -1
const OPEN_DELAY_MS = 30  // past the other card's 0ms instant-close + reflow
const GLIDE_MS = 160      // let the open-glide land before the body grows
const SHRINK_MS = 240     // must match .card-expando's transition duration
const SETTLE_MS = OPEN_DELAY_MS + GLIDE_MS + SHRINK_MS + 60   // everything done

function useCardGlide(open, ref) {
  const [mounted, setMounted] = useState(open)   // body kept in the DOM
  const [grown, setGrown] = useState(open)       // 0fr ↔ 1fr animation class
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (open) {
      _lastOpenAt = performance.now()
      setMounted(true)
      // Glide only AFTER the previously-open card has instant-closed (its close
      // check runs on a 0ms timer, whichever card comes first in the list):
      // computing the scroll target against the old, still-expanded layout sent
      // this card to the wrong spot. 30ms clears that unmount + reflow and is
      // invisible to the eye. Sequence: close 1 → measure → glide 2 → grow 2.
      const t0 = setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), OPEN_DELAY_MS)
      const t1 = setTimeout(() => setGrown(true), OPEN_DELAY_MS + GLIDE_MS)
      const t2 = setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), SETTLE_MS)
      return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2) }
    }
    let t1
    const t0 = setTimeout(() => {
      if (performance.now() - _lastOpenAt < 150) {   // another card just opened
        setGrown(false)
        setMounted(false)                            // instant, no shrink animation
        return
      }
      setGrown(false)
      t1 = setTimeout(() => setMounted(false), SHRINK_MS)
    }, 0)
    return () => { clearTimeout(t0); clearTimeout(t1) }
  }, [open])
  return { mounted, grown }
}

// ↑/↓ move the open card to the prev/next item in `list` (by `keyOf`). Shared by
// Class + History pages (Assets/My List handle it at the App level). Ignored while
// typing in a field, when nothing is open, or when the merge/other mode is active.
function useArrowNav(enabled, openKey, setOpenKey, list, keyOf) {
  useEffect(() => {
    if (!enabled || !openKey) return
    function onKey(e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      const i = list.findIndex((x) => keyOf(x) === openKey)
      if (i < 0) return
      const next = i + (e.key === 'ArrowDown' ? 1 : -1)
      if (next < 0 || next >= list.length) return
      e.preventDefault()
      setOpenKey(keyOf(list[next]))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, openKey, list, setOpenKey, keyOf])
}

function Expando({ grown, children }) {
  return (
    <div className={`card-expando${grown ? ' is-grown' : ''}`}>
      <div className="card-expando-inner">{children}</div>
    </div>
  )
}

// "새 자산 등록" — the first card on the Assets tab (normal, un-searched state).
// Opens inline with the same form as Edit; number + name are required to save.
function NewAssetCard({ onCreate, onImportAssets, existingIds = [], classOptions, draft, onDraftDone }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({})
  const cardRef = useRef(null)
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  // XLSX import flow: step 'header' → 'map' → 'preview'.
  const [imp, setImp] = useState(null)              // null | 'bad' | 'empty' | { rows }
  const [step, setStep] = useState('')              // '' | 'header' | 'map' | 'preview'
  const [headerRow, setHeaderRow] = useState(0)     // 0-based index of the header row
  const [mapping, setMapping] = useState({})        // appFieldKey → header string
  const [preview, setPreview] = useState(null)      // { total, dup, add, newAssets }
  const { mounted, grown } = useCardGlide(open, cardRef)
  useEffect(() => {
    if (draft) { setForm((f) => ({ ...f, ...draft })); setOpen(true); onDraftDone?.() }
  }, [draft])
  function done() {
    setForm({}); setOpen(false); setImp(null); setStep(''); setMapping({}); setPreview(null)
  }
  function save() {
    if (onCreate(form)) done()
  }

  const norm = (x) => String(x || '').toLowerCase().replace(/[\s._()·]/g, '')
  // Headers of the currently-selected row; blank cells become "(빈 열 N)".
  const headers = (imp && imp.rows ? (imp.rows[headerRow] || []) : []).map((h) => String(h || '').trim())
  const dataRows = imp && imp.rows ? imp.rows.slice(headerRow + 1).filter((r) => r.some((c) => String(c || '').trim())) : []

  async function loadFile(file) {
    if (!file || !/\.xlsx$/i.test(file.name)) { setOpen(true); setImp('bad'); return }
    try {
      const { rows, headerIdx } = await parseXlsx(file)
      if (!rows.length) { setOpen(true); setImp('empty'); return }
      setOpen(true); setImp({ rows }); setHeaderRow(headerIdx); setStep('header'); setMapping({}); setPreview(null)
    } catch (e) { setOpen(true); setImp('bad'); console.error(e) }
  }
  // Confirm the header row → auto-map columns to app fields → go to mapping.
  function confirmHeader() {
    const hs = (imp.rows[headerRow] || []).map((h) => String(h || '').trim())
    const auto = {}
    for (const f of EDIT_FIELDS) {
      const cand = [f.key, f.label, ...(FIELD_ALIASES[f.key] || [])].map(norm)
      const hit = hs.find((h) => h && cand.includes(norm(h)))
      if (hit) auto[f.key] = hit
    }
    if (!auto.assetId) { const h = hs.find((x) => /자산.*번호|asset.*(no|id|number)/i.test(x)); if (h) auto.assetId = h }
    setMapping(auto); setStep('map')
  }
  function analyze() {
    const idH = mapping.assetId
    if (!idH) return
    const cols = {}
    headers.forEach((h, i) => { if (h && cols[h] === undefined) cols[h] = i })   // header → col index
    const have = new Set(existingIds)
    const seen = new Set()
    const newAssets = []
    let total = 0, dup = 0
    for (const row of dataRows) {
      const id = String(row[cols[idH]] ?? '').trim()
      if (!id) continue
      total += 1
      if (have.has(id) || seen.has(id)) { dup += 1; continue }
      seen.add(id)
      const a = {}
      for (const f of EDIT_FIELDS) { const h = mapping[f.key]; a[f.key] = h && cols[h] != null ? String(row[cols[h]] ?? '').trim() : '' }
      a.assetId = id
      newAssets.push(a)
    }
    setPreview({ total, dup, add: newAssets.length, newAssets }); setStep('preview')
  }
  function confirmImport() { onImportAssets(preview.newAssets); done() }

  return (
    <div
      ref={cardRef}
      className={`asset-row${open ? ' is-open' : ''}${dragOver ? ' is-dropping' : ''}`}
      onDragOver={(e) => { if (open) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f) }}
    >
      <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadFile(f) }} />
      <div className="asset-row-head" role="button" tabIndex={0} onClick={() => (open ? done() : setOpen(true))}>
        <div className="asset-photo"><Plus size={24} weight="bold" color={BRAND} /></div>
        <div className="asset-row-open">
          <div className="asset-row-main"><strong>새 자산 등록</strong></div>
        </div>
      </div>
      {mounted && (
        <Expando grown={grown}>
          <div className="asset-row-body">
            {step === 'header' ? (
              <div className="asset-edit">
                <p className="import-hint">제목(헤더) 행을 확인하세요. 자동 감지: <b>{headerRow + 1}번째 행</b></p>
                <div className="header-pick">
                  <button type="button" className="hp-nav" disabled={headerRow <= 0} onClick={() => setHeaderRow((r) => Math.max(0, r - 1))}>▲ 이전 행</button>
                  <span className="hp-num">{headerRow + 1} / {imp.rows.length} 행</span>
                  <button type="button" className="hp-nav" disabled={headerRow >= imp.rows.length - 1} onClick={() => setHeaderRow((r) => Math.min(imp.rows.length - 1, r + 1))}>다음 행 ▼</button>
                </div>
                <div className="header-preview">
                  {headers.length === 0 || headers.every((h) => !h)
                    ? <span className="hp-empty">(빈 행 — 다른 행을 고르세요)</span>
                    : headers.map((h, i) => <span key={i} className="hp-cell">{h || `(빈칸 ${i + 1})`}</span>)}
                </div>
                <p className="import-hint">이 행 아래 데이터 <b>{dataRows.length}</b>행</p>
                <div className="action-row">
                  <button type="button" className="amber-btn" disabled={headers.every((h) => !h)} onClick={confirmHeader}>확인</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={done}>취소</Button>
                </div>
              </div>
            ) : step === 'map' ? (
              <div className="asset-edit">
                <p className="import-hint">XLSX 열을 자산 필드에 연결하세요. (자산번호 필수) — {dataRows.length}행</p>
                <div className="map-list">
                  {EDIT_FIELDS.map((f) => (
                    <div className="map-row" key={f.key}>
                      <select className="edit-select" value={mapping[f.key] || ''} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                        <option value="">(연결 안 함)</option>
                        {headers.map((h, i) => <option key={`${h}-${i}`} value={h}>{h || `(빈 열 ${i + 1})`}</option>)}
                      </select>
                      <span className="map-arrow">→</span>
                      <span className="map-field">{f.label}{f.required ? ' *' : ''}</span>
                    </div>
                  ))}
                </div>
                <div className="action-row">
                  <button type="button" className="amber-btn" disabled={!mapping.assetId} onClick={analyze}>분석</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setStep('header')}>← 헤더</Button>
                </div>
              </div>
            ) : step === 'preview' ? (
              <div className="asset-edit">
                <div className="import-summary">
                  <p>전체 <b>{preview.total}</b>행 · 중복 <b>{preview.dup}</b> · <b className="add-n">추가 {preview.add}</b></p>
                </div>
                <div className="action-row">
                  <button type="button" className="amber-btn" disabled={!preview.add} onClick={confirmImport}>{preview.add}개 추가</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setStep('map')}>← 다시 매핑</Button>
                </div>
              </div>
            ) : (
              <div className="asset-edit">
                <div className="action-row">
                  <button type="button" className="amber-btn" onClick={save}>Save</button>
                  <button type="button" className="amber-btn tone-xlsx" onClick={() => fileRef.current?.click()}><UploadSimple size={18} weight="bold" /> XLSX</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={done}>Cancel</Button>
                </div>
                {imp === 'bad' && <p className="import-hint is-warn">XLSX 파일을 읽지 못했습니다.</p>}
                {imp === 'empty' && <p className="import-hint is-warn">데이터가 없습니다.</p>}
                {EDIT_FIELDS.map((field) => (
                  <EditField key={field.key} field={field} form={form} setForm={setForm} classOptions={classOptions} />
                ))}
              </div>
            )}
          </div>
        </Expando>
      )}
    </div>
  )
}

// Extra header names that map to an app field during XLSX auto-mapping.
const FIELD_ALIASES = {
  assetId: ['자산번호', 'assetno', 'asset number', 'asset id', '자산 번호'],
  name: ['자산명', 'assetname', '이름', '품명'],
  location: ['위치', '동호실', '설치위치'],
  type: ['타입', '종류'],
  assetClass: ['자산분류', '분류'],
  accountHolder: ['관리책임자', '사용책임자', '책임자'],
  applicationName: ['신청품목명', '신청명'],
  spec: ['규격', 'specification'],
  description: ['설명', '자산명영문', '비고'],
  memo: ['메모', 'note'],
  manufacturerProvider: ['제조사', '거래처명', '공급처', 'maker'],
  acquisitionDate: ['취득일', '취득일자'],
  acquisitionPriceKrw: ['취득가', '취득금액', '가격'],
}

function AssetListPage({ query, setQuery, assets, expandedId, setExpandedId, myListSet, myPhotos, toggleMyList, onCapture, onCaptureSlot, recordAction, updateAsset, locationPhoto, records, sort, setSort, onCreate, onImportAssets, existingIds, onAddAll, classOptions, draft, onDraftDone, isAdmin, hiddenFilter, onCycleHiddenFilter, canEditPhotos, showField, canCreate = true, onRack = null }) {
  return (
    <div className="stack">
      <Card>
        {/* No autoFocus: opening the Assets tab must not pop the keyboard up. */}
        <SearchBox query={query} setQuery={setQuery} placeholder="asset number, name, location" />
      </Card>
      <div className="list-toolbar">
        <span className="list-count">
          총 {assets.length}개
          <button type="button" className="sort-btn add-all" onClick={() => onAddAll(assets.map((a) => a.assetId))}>전체추가</button>
        </span>
        <div className="sort-side">
          {/* Only on a window wide enough to hold the table. */}
          {onRack && <button type="button" className="sort-btn" onClick={onRack}>표로 보기</button>}
          <SortBar sort={sort} setSort={setSort} />
          {isAdmin && (
            <button
              type="button"
              className={`sort-btn hide-filter${hiddenFilter !== 'all' ? ' is-active' : ''}`}
              title="숨김 필터: 전체 → 숨김만 → 노출만"
              onClick={onCycleHiddenFilter}
            >
              {hiddenFilter === 'all' ? '전체' : hiddenFilter === 'hidden' ? '숨김만' : '노출만'}
            </button>
          )}
        </div>
      </div>
      <div className="result-list result-list-full">
        {!query.trim() && canCreate && <NewAssetCard onCreate={onCreate} onImportAssets={onImportAssets} existingIds={existingIds} classOptions={classOptions} draft={draft} onDraftDone={onDraftDone} />}
        {assets.length === 0 && <Card><p className="muted">일치하는 자산이 없습니다.</p></Card>}
        {assets.map((asset) => (
          <AssetRow
            key={asset.assetId}
            asset={asset}
            expanded={expandedId === asset.assetId}
            onToggle={() => setExpandedId(expandedId === asset.assetId ? '' : asset.assetId)}
            inMyList={myListSet.has(asset.assetId)}
            shots={myPhotos[asset.assetId]}
            onToggleMyList={() => toggleMyList(asset.assetId)}
            onCapture={() => onCapture(asset.assetId)}
            onCaptureSlot={onCaptureSlot}
            recordAction={recordAction}
            updateAsset={updateAsset}
            locationPhoto={locationPhoto}
            records={records}
            classOptions={classOptions}
            isAdmin={isAdmin}
            canEditPhotos={canEditPhotos}
            showField={showField}
          />
        ))}
      </div>
    </div>
  )
}

const EDIT_FIELDS = [
  { key: 'assetId', label: 'Asset number', required: true },
  { key: 'name', label: 'Name', required: true },
  { key: 'location', label: 'Location', options: 'location' },
  { key: 'type', label: 'Type', options: 'type' },
  { key: 'assetClass', label: '자산분류' },
  { key: 'accountHolder', label: 'Account holder' },
  { key: 'applicationName', label: 'Application name (반출·반입·연장용)' },
  { key: 'spec', label: '규격' },
  { key: 'description', label: 'Description', textarea: true },
  { key: 'memo', label: 'Memo', textarea: true },
  { key: 'manufacturerProvider', label: 'Manufacturer' },
  { key: 'acquisitionDate', label: 'Acquired' },
  { key: 'acquisitionPriceKrw', label: 'Price' },
]

function AssetThumb({ asset, inMyList, canShoot = true, shots, onCapture }) {
  // The photo is the card's whole left section (flush, like the +/- square on the
  // right). In My List it doubles as the camera hitbox for the guided photos —
  // unless the admin turned photo changes off (canShoot).
  if (inMyList && canShoot) {
    // Pending shot wins; otherwise the asset's whole-photo fills the section like
    // a profile picture. The camera icon only shows when there's no photo at all.
    const src = shots?.sticker || asset.photo1 || asset.photo2
    return (
      <button type="button" className={`asset-photo is-photo${shots ? ' has-shot' : ''}`} title="사진 촬영" onClick={(e) => { e.stopPropagation(); onCapture() }}>
        {src ? <img src={src} alt="" /> : <CameraPlus size={24} weight="fill" color={PHOTO_COLOR} />}
      </button>
    )
  }
  return (
    <div className="asset-photo">
      {(asset.photo1 || asset.photo2)
        ? <img src={asset.photo1 || asset.photo2} alt="" />
        : <Images size={22} weight="fill" color="#c2c8d2" />}
    </div>
  )
}

// Full-screen photo viewer (tap the backdrop or × to close).
function ImageViewer({ src, onClose }) {
  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <img src={src} alt="" className="viewer-img" />
      <button type="button" className="viewer-close" title="닫기" onClick={onClose}>
        <X size={22} weight="bold" color="#ffffff" />
      </button>
    </div>
  )
}

// Minimal photo editor: rotate 90° + drag-to-crop. Edits happen on a full-
// resolution offscreen canvas; the visible canvas is just a scaled view of it.
function PhotoEditModal({ src, onSave, onClose, onRetake, onDelete }) {
  const workRef = useRef(null)          // offscreen canvas — the real image state
  const viewRef = useRef(null)          // on-screen, scaled-to-fit
  const dragRef = useRef(null)
  const [rect, setRect] = useState(null)  // crop selection, in WORK pixel coords
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      workRef.current = c
      setRect(null)
      setReady(true)
    }
    img.src = src
  }, [src])

  useEffect(() => { if (ready) draw() }, [ready, rect])

  function draw() {
    const work = workRef.current
    const view = viewRef.current
    if (!work || !view) return
    const maxW = Math.min(window.innerWidth * 0.86, 680)
    const maxH = window.innerHeight * 0.52
    const s = Math.min(maxW / work.width, maxH / work.height, 1)
    view.width = Math.max(1, Math.round(work.width * s))
    view.height = Math.max(1, Math.round(work.height * s))
    const ctx = view.getContext('2d')
    ctx.drawImage(work, 0, 0, view.width, view.height)
    if (rect) {                          // darken outside the selection
      const r = { x: rect.x * s, y: rect.y * s, w: rect.w * s, h: rect.h * s }
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, view.width, r.y)
      ctx.fillRect(0, r.y, r.x, r.h)
      ctx.fillRect(r.x + r.w, r.y, view.width - r.x - r.w, r.h)
      ctx.fillRect(0, r.y + r.h, view.width, view.height - r.y - r.h)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2)
    }
  }

  function toWork(e) {
    const b = viewRef.current.getBoundingClientRect()
    const s = workRef.current.width / b.width
    return { x: (e.clientX - b.left) * s, y: (e.clientY - b.top) * s }
  }
  function onDown(e) {
    if (!ready) return
    e.preventDefault()
    viewRef.current.setPointerCapture?.(e.pointerId)
    dragRef.current = toWork(e)
    setRect(null)
  }
  function onMove(e) {
    if (!dragRef.current) return
    const a = dragRef.current
    const p = toWork(e)
    const work = workRef.current
    const x = Math.max(0, Math.min(a.x, p.x))
    const y = Math.max(0, Math.min(a.y, p.y))
    const w = Math.min(work.width, Math.max(a.x, p.x)) - x
    const h = Math.min(work.height, Math.max(a.y, p.y)) - y
    if (w > 4 && h > 4) setRect({ x, y, w, h })
  }
  function onUp() { dragRef.current = null }

  function rotate() {
    const work = workRef.current
    const c = document.createElement('canvas')
    c.width = work.height
    c.height = work.width
    const ctx = c.getContext('2d')
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate(Math.PI / 2)
    ctx.drawImage(work, -work.width / 2, -work.height / 2)
    workRef.current = c
    if (rect) setRect(null)
    else draw()                          // no state change → redraw by hand
  }

  function applyCrop() {
    if (!rect) return
    const work = workRef.current
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(rect.w))
    c.height = Math.max(1, Math.round(rect.h))
    c.getContext('2d').drawImage(work, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height)
    workRef.current = c
    setRect(null)
  }

  return (
    <div className="scanner-backdrop" onClick={onClose}>
      <section className="scanner-modal" onClick={(e) => e.stopPropagation()}>
        <header className="scanner-header">
          <h2>사진 편집</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>
        <div className="photo-edit-stage">
          <canvas
            ref={viewRef}
            className="photo-edit-canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        </div>
        <p className="muted scanner-hint">
          {rect ? '선택한 영역으로 자르려면 “자르기”를 누르세요.' : '사진 위를 드래그하면 자를 영역을 선택할 수 있습니다.'}
        </p>
        <div className="action-row scanner-actions">
          <button type="button" className="amber-btn" disabled={!ready} onClick={rotate}>
            <ArrowClockwise size={20} weight="bold" /> 회전
          </button>
          <button type="button" className="amber-btn" disabled={!rect} onClick={applyCrop}>
            <Crop size={20} weight="bold" /> 자르기
          </button>
          <button type="button" className="amber-btn" disabled={!ready}
            onClick={() => onSave(workRef.current.toDataURL('image/jpeg', 0.85))}>
            저장
          </button>
        </div>
        {(onRetake || onDelete) && (
          <div className="action-row scanner-actions">
            {onRetake && (
              <button type="button" className="amber-btn" onClick={onRetake}>
                <CameraPlus size={20} weight="fill" /> 다시 찍기
              </button>
            )}
            {onDelete && (
              <button type="button" className="amber-btn danger-btn" disabled={!ready} onClick={onDelete}>
                <Trash size={20} weight="fill" /> 삭제
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function PhotoSlot({ src, label }) {
  const [view, setView] = useState(false)
  return (
    <div className="photo-slot">
      <div className={`photo-box${src ? ' is-clickable' : ''}`} onClick={() => src && setView(true)}>
        {src ? <img src={src} alt={label} /> : <Images size={28} weight="fill" color="#c2c8d2" />}
      </div>
      <span className="photo-label">{label}</span>
      {view && <ImageViewer src={src} onClose={() => setView(false)} />}
    </div>
  )
}

function AssetRow({ asset, expanded, onToggle, inMyList, isNew, shots, onToggleMyList, onCapture, onCaptureSlot, recordAction, updateAsset, locationPhoto, records, classOptions, isAdmin, canEditPhotos = true, showField = () => true }) {
  const [editing, setEditing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [editPhoto, setEditPhoto] = useState('')   // slot key being edited ('photo1'…)
  const [form, setForm] = useState(asset)
  // Per-asset history is derived from the shared records — never stored twice.
  const history = useMemo(
    () => (records || []).filter((r) => r.type !== 'hide' && r.type !== 'unhide' && (r.assetIds || []).includes(asset.assetId)),
    [records, asset.assetId],
  )

  // Reset edit/history state whenever the row collapses or the underlying asset changes.
  useEffect(() => {
    setForm(asset)
    if (!expanded) { setEditing(false); setShowHistory(false) }
  }, [asset, expanded])

  const rowRef = useRef(null)
  // Two-phase open/close: glide up first then grow; shrink in place then glide back.
  const { mounted, grown } = useCardGlide(expanded, rowRef)

  // After leaving edit mode the row may have moved far down — glide it back
  // under the top bar (rAF: let the collapsed layout settle first).
  function scrollBack() {
    requestAnimationFrame(() => rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function save() {
    const patch = {}
    EDIT_FIELDS.forEach((f) => { patch[f.key] = form[f.key] || '' })
    if (!updateAsset(asset.assetId, patch)) return   // invalid/duplicate — stay editing
    setEditing(false)
    scrollBack()
  }

  return (
    <div ref={rowRef} className={`asset-row${expanded ? ' is-open' : ''}${isNew ? ' is-new' : ''}${asset.hidden ? ' is-hidden' : ''}`}>
      <div className="asset-row-head">
        <AssetThumb asset={asset} inMyList={inMyList} canShoot={canEditPhotos} shots={shots} onCapture={onCapture} />
        <div className="asset-row-open" role="button" tabIndex={0} onClick={onToggle}>
          <div className="asset-row-main">
            <span className="mono asset-id2">
              <span>{String(asset.assetId).slice(0, 4)}</span>
              {String(asset.assetId).length > 4 && <span>{String(asset.assetId).slice(4)}</span>}
            </span>
            <strong className={asset.verifyRequested ? 'is-requested' : ''}>{asset.name || 'Unnamed asset'}</strong>
          </div>
        </div>
        <button
          type="button"
          className={`asset-add${inMyList ? ' is-on' : ''}`}
          title={inMyList ? 'My List에서 제거' : 'My List에 추가'}
          onClick={(e) => { e.stopPropagation(); onToggleMyList() }}
        >
          {inMyList ? <Minus size={22} weight="bold" color="#ffffff" /> : <Plus size={22} weight="bold" color="#ffffff" />}
        </button>
      </div>
      {mounted && (
        <Expando grown={grown}>
        <div className="asset-row-body">
          {editing ? (
            <div className="asset-edit">
              <div className="action-row">
                <button type="button" className="amber-btn" onClick={save}>Save</button>
                <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => { setForm(asset); setEditing(false); scrollBack() }}>Cancel</Button>
              </div>
              <div className="photo-row">
                {[{ slot: 'photo2', label: '자산 스티커' }, { slot: 'photo1', label: '자산 전체' }].map((p) => (
                  <div className="photo-slot" key={p.slot}>
                    <div className="photo-box">
                      {asset[p.slot] ? <img src={asset[p.slot]} alt={p.label} /> : <Images size={28} weight="fill" color="#c2c8d2" />}
                    </div>
                    <span className="photo-label">{p.label}</span>
                    <button type="button" className="slot-edit-btn" onClick={() => setEditPhoto(p.slot)}>
                      <PencilSimple size={16} weight="fill" /> 편집
                    </button>
                  </div>
                ))}
              </div>
              {EDIT_FIELDS.map((field) => (
                <EditField key={field.key} field={field} form={form} setForm={setForm} classOptions={classOptions} />
              ))}
              <div className="action-row">
                <button type="button" className="amber-btn" onClick={scrollBack}><ArrowUp size={18} weight="bold" /> 맨 위로</button>
              </div>
            </div>
          ) : (
            <div className="detail-body">
              <div className="action-row">
                {isAdmin && (
                  <button type="button" className="amber-btn" onClick={() => setEditing(true)}><PencilSimple size={18} weight="fill" /> Edit</button>
                )}
                <button type="button" className="amber-btn" onClick={() => setShowHistory((s) => !s)}><ClockCounterClockwise size={18} weight="fill" /> History</button>
              </div>
              <div className="asset-full-id mono">{asset.assetId}</div>
              <h3 className="asset-full-name">{asset.name || 'Unnamed asset'}</h3>
              {showHistory && (
                <div className="asset-history">
                  {history.length === 0 && <p className="muted">이 자산의 기록이 없습니다.</p>}
                  {history.map((r) => (
                    <div key={r.id} className="asset-history-row">
                      <span className={`type-chip type-${r.type}`}>{typeLabelShort(r.type)}</span>
                      <span className="asset-history-meta">
                        {[r.name, r.user ? String(r.user).split('@')[0] : '', formatDateOnly(r.createdAt)].filter(Boolean).join(' · ') + (r.location ? ` → ${r.location}` : '')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="photo-row">
                <PhotoSlot src={shots?.sticker || asset.photo2} label="자산 스티커" />
                <PhotoSlot src={shots?.whole || asset.photo1} label="자산 전체" />
                <PhotoSlot src={locationPhoto ? locationPhoto(asset.location) : ''} label="위치" />
              </div>
              <p>{asset.description || 'No description'}</p>
              <dl className="kv">
                <dt>Location</dt>
                <dd>{asset.location || '-'}</dd>
                <dt>User (위치변경)</dt>
                <dd>{asset.user ? String(asset.user).split('@')[0] : '-'}</dd>
                <dt>Type</dt>
                <dd>{asset.type || '-'}</dd>
                <dt>자산분류</dt>
                <dd>{asset.assetClass || '-'}</dd>
                {showField('accountHolder') && <><dt>Account holder</dt><dd>{asset.accountHolder || '-'}</dd></>}
                {showField('applicationName') && <><dt>Application</dt><dd>{asset.applicationName || '-'}</dd></>}
                {showField('spec') && <><dt>규격</dt><dd>{asset.spec || '-'}</dd></>}
                {showField('memo') && asset.memo && <><dt>Memo</dt><dd>{asset.memo}</dd></>}
                {showField('manufacturerProvider') && <><dt>Manufacturer</dt><dd>{asset.manufacturerProvider || '-'}</dd></>}
                {showField('acquisitionDate') && <><dt>Acquired</dt><dd>{asset.acquisitionDate || '-'}</dd></>}
                <dt>Edited by</dt>
                <dd>{asset.editedBy || '-'}</dd>
                <dt>Last update</dt>
                <dd>{formatDate(asset.lastUpdate) || '-'}</dd>
              </dl>
            </div>
          )}
        </div>
        </Expando>
      )}
      {editPhoto && (
        <PhotoEditModal
          src={asset[editPhoto] || ''}
          onSave={(url) => { updateAsset(asset.assetId, { [editPhoto]: url }); setEditPhoto('') }}
          onClose={() => setEditPhoto('')}
          onRetake={() => { const slot = editPhoto; setEditPhoto(''); onCaptureSlot(asset.assetId, slot) }}
          onDelete={asset[editPhoto] ? () => { updateAsset(asset.assetId, { [editPhoto]: '' }); setEditPhoto('') } : undefined}
        />
      )}
    </div>
  )
}

function MyListPage({ assets, expandedId, setExpandedId, myPhotos, toggleMyList, onCapture, onCaptureSlot, recordAction, updateAsset, locationPhoto, records, listName, setListName, onSave, onClear, onDeleteAssets, onRequest, onImport, profile, onSaveProfile, notify, locationList, myLocation, setMyLocation, addLocation, onLocationPhoto, sort, setSort, newIds, onSeenNew, classOptions, onRestoreLocations, isAdmin, onSetHidden, canEditPhotos, showField, svcSettings, onChangeSettings }) {
  const ids = assets.map((asset) => asset.assetId)
  const empty = !assets.length
  // The open request form + its field values survive tab switches and reloads
  // (they used to reset because this component unmounts on tab change).
  const reqStore = (k) => projectKey(PORTAL_PROJECT || 'local', k)
  const [panel, setPanel] = useState(() => localStorage.getItem(reqStore('reqPanel')) || '')   // '', 'takeout', 'return', 'extension'
  const [fields, setFields] = useState(() => ({ applicantName: profile?.name || '', applicantOrg: profile?.org || '', ...readJson(reqStore('reqFields'), {}) }))
  useEffect(() => { localStorage.setItem(reqStore('reqPanel'), panel) }, [panel])
  useEffect(() => { writeJson(reqStore('reqFields'), fields) }, [fields])
  const [dragOver, setDragOver] = useState(false)
  const [locOpen, setLocOpen] = useState(false)
  const importRef = useRef(null)
  // HWPX flow: tap HWPX → spinner while the per-class files + one ZIP are built
  // → the button turns into [⬇ ZIP] + [공유], with per-class save buttons below.
  // Every download happens on its own tap (browsers allow ONE download per
  // gesture — a loop of programmatic clicks silently saves only the first file).
  const [hwpx, setHwpx] = useState({ state: 'idle' })   // idle | building | ready{files, zipBlob, zipName, zipFile}
  const hwpxSigRef = useRef('')
  const hwpxJobRef = useRef(0)
  function classGroups() {
    const m = new Map()
    for (const a of assets) {
      const cls = String(a.assetClass || '').trim() || '미분류'
      if (!m.has(cls)) m.set(cls, [])
      m.get(cls).push(a)
    }
    return [...m.entries()]
  }
  // Fingerprint of what actually PRINTS in the documents. Deliberately excludes
  // lastUpdate/location, and measures the *effective* photo source (My List shot
  // falling back to the stored photo) — so recordAction()'s own writes right
  // after preparing do NOT wipe the ready buttons.
  function hwpxSig(forPanel) {
    return JSON.stringify({
      panel: forPanel, fields, myLocation, listName,
      a: assets.map((x) => [
        x.assetId, x.name || '', x.description || '', x.assetClass || '',
        ((myPhotos[x.assetId] && myPhotos[x.assetId].sticker) || x.photo2 || '').length,
        ((myPhotos[x.assetId] && myPhotos[x.assetId].whole) || x.photo1 || '').length,
      ]),
    })
  }
  useEffect(() => {
    if (hwpx.state === 'idle') return
    if (hwpxSigRef.current !== hwpxSig(panel)) { hwpxJobRef.current += 1; setHwpx({ state: 'idle' }) }
  }, [panel, fields, myLocation, listName, assets, myPhotos])

  async function prepareHwpx() {
    const job = ++hwpxJobRef.current
    const sig = hwpxSig(panel)
    setHwpx({ state: 'building' })
    try {
      const placeKey = REQUEST_FORMS[panel].placeKey
      const exFields = placeKey ? { ...fields, [placeKey]: myLocation } : { ...fields }
      const files = []
      for (const [cls, group] of classGroups()) {
        // The class goes into the doc as a normal intro field (자산 분류: …),
        // not into the title; the FILE name still carries it apart.
        const blob = await buildRequestHwpxBlob(panel, { ...exFields, assetClass: cls }, group, myPhotos, listName)
        files.push({ cls, count: group.length, blob, name: `${sanitizeFileName(listName)}_${sanitizeFileName(cls)}.hwpx` })
      }
      const entries = []
      for (const f of files) entries.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })
      const zipBlob = window.CensHwpx?.makeZip ? window.CensHwpx.makeZip(entries) : null
      const zipName = `${sanitizeFileName(listName)}.zip`
      const zipFile = zipBlob ? new File([zipBlob], zipName, { type: 'application/zip' }) : null
      if (job !== hwpxJobRef.current) return          // inputs changed meanwhile
      hwpxSigRef.current = sig
      setHwpx({ state: 'ready', files, zipBlob, zipName, zipFile })
      onSaveProfile(fields.applicantName, fields.applicantOrg)
      // Record the action (check-in/out/extension): logs to History + assigns location.
      const actionType = { takeout: 'checkout', return: 'checkin', extension: 'extension' }[panel]
      recordAction(actionType, ids)
    } catch (e) {
      if (job === hwpxJobRef.current) { setHwpx({ state: 'idle' }); notify(`HWPX 실패: ${e.message || e}`, 'error') }
    }
  }

  async function shareHwpxZip() {
    try {
      if (hwpx.zipFile && navigator.canShare?.({ files: [hwpx.zipFile] })) {
        await navigator.share({ files: [hwpx.zipFile], title: listName })
      } else {
        notify('이 브라우저는 파일 공유를 지원하지 않습니다.', 'warn')
      }
    } catch { /* share sheet dismissed */ }
  }

  function onDrop(event) {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) onImport(file)
  }
  function commitLocation(value) {
    const v = value.trim()
    setMyLocation(v)
    if (v) setLocNudge(false)
    if (v && !locationList.some((l) => l.name === v)) addLocation(v)
  }
  // Update / Check-in / Check-out / Extension all write the selected location onto
  // the assets, so they refuse to run without one: top-bar message + open the
  // location list + mark the field.
  const [locNudge, setLocNudge] = useState(false)
  function requireLocation(fn) {
    if (!String(myLocation || '').trim()) {
      notify('위치를 먼저 선택하세요.')
      setLocNudge(true)
      setLocOpen(true)
      return
    }
    setLocNudge(false)
    fn()
  }

  // Update → 복원: an Update remembers each listed asset's location as it was
  // right before the overwrite, and the button flips to 복원 until the list
  // itself changes (add/remove/clear), which discards the undo snapshot.
  // Persisted per device so tab switches / edits / reloads don't lose the undo.
  const [restore, setRestore] = useState(() => readJson(reqStore('updateRestore'), null))   // null | { prev: {id: loc}, sig }
  const [restoreAsk, setRestoreAsk] = useState(false)
  useEffect(() => { writeJson(reqStore('updateRestore'), restore) }, [restore])
  const listSig = [...ids].sort().join(',')
  useEffect(() => {
    if (restore && restore.sig !== listSig) { setRestore(null); setRestoreAsk(false) }
  }, [listSig])
  function doUpdate() {
    requireLocation(() => {
      const prev = {}
      for (const a of assets) prev[a.assetId] = a.location || ''
      recordAction('update', ids)
      setRestore({ prev, sig: listSig })
      setRestoreAsk(false)
    })
  }
  function doRestore() {
    if (restore) onRestoreLocations(restore.prev)
    setRestore(null)
    setRestoreAsk(false)
  }
  function togglePanel(type) {
    if (panel === type) { setPanel(''); return }        // closing needs no location
    // Warm the HWPX template while the user fills the form — the first export
    // tap must not spend its user-gesture window on a network fetch (iOS drops
    // a programmatic download click that comes too late after the tap).
    window.CensHwpx?.preload?.()
    requireLocation(() => setPanel(type))
  }
  // Top row (slate) — list actions. Bottom row (amber) — application forms / import.
  // Inline confirm for Update / Request / Delete (like 복원): the button toggles
  // a question area below the rows; only the confirm button runs the action.
  const [confirm, setConfirm] = useState('')      // '' | 'update' | 'request' | 'delete'
  useEffect(() => { setConfirm('') }, [listSig])   // list changed → drop any pending question
  const rowTop = [
    { key: 'save', label: 'Save', Glyph: FloppyDisk, onClick: onSave, disabled: empty },
    restore
      ? { key: 'update', label: '복원', Glyph: ArrowCounterClockwise, onClick: () => setRestoreAsk((v) => !v), active: restoreAsk, cls: 'is-filled' }
      : { key: 'update', label: 'Update', Glyph: CheckCircle, onClick: () => setConfirm((c) => (c === 'update' ? '' : 'update')), active: confirm === 'update', disabled: empty, cls: 'is-filled' },
    { key: 'request', label: 'Request', Glyph: ShieldCheck, onClick: () => setConfirm((c) => (c === 'request' ? '' : 'request')), active: confirm === 'request', disabled: empty, cls: 'tone-green', iconColor: '#2f6b3a' },
    { key: 'clear', label: 'Clear', Glyph: Broom, onClick: onClear, disabled: empty },
  ]
  const rowBottom = [
    { key: 'checkin', label: 'Check-in', Glyph: ArrowCircleDown, onClick: () => togglePanel('return'), active: panel === 'return', disabled: empty },
    { key: 'checkout', label: 'Check-out', Glyph: ArrowCircleUp, onClick: () => togglePanel('takeout'), active: panel === 'takeout', disabled: empty },
    { key: 'extension', label: 'Extension', Glyph: CalendarPlus, onClick: () => togglePanel('extension'), active: panel === 'extension', disabled: empty },
    { key: 'import', label: 'Import', Glyph: UploadSimple, onClick: () => importRef.current?.click(), cls: 'no-bg' },
  ]
  // Admin: hide/unhide the listed assets, with a restore-style inline confirm.
  const [hideAsk, setHideAsk] = useState(null)     // null | 'hide' | 'unhide'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const rowAdmin = isAdmin ? [
    { key: 'hide', label: 'Hide', Glyph: EyeSlash, onClick: () => setHideAsk((v) => (v === 'hide' ? null : 'hide')), active: hideAsk === 'hide', disabled: empty, cls: 'tone-dark', iconColor: '#26292e' },
    { key: 'unhide', label: 'Unhide', Glyph: Eye, onClick: () => setHideAsk((v) => (v === 'unhide' ? null : 'unhide')), active: hideAsk === 'unhide', disabled: empty, cls: 'tone-dark', iconColor: '#26292e' },
    { key: 'delete', label: 'Delete', Glyph: Trash, onClick: () => setConfirm((c) => (c === 'delete' ? '' : 'delete')), active: confirm === 'delete', disabled: empty, cls: 'tone-red', iconColor: '#a32d2d' },
    { key: 'settings', label: 'Settings', Glyph: GearSix, onClick: () => setSettingsOpen((o) => !o), active: settingsOpen, cls: 'tone-dark', iconColor: '#26292e' },
  ] : []
  // One boolean per toggleable field: visible unless explicitly false.
  const fieldOn = (k) => svcSettings?.fieldVis?.[k] !== false
  const form = panel ? REQUEST_FORMS[panel] : null
  const locFiltered = locationList.filter((l) => !myLocation.trim() || String(l.name).toLowerCase().includes(myLocation.trim().toLowerCase()))
  const titleReq = panel && !String(listName || '').trim()
  const locReq = (locNudge || (panel && form?.placeKey)) && !String(myLocation || '').trim()
  return (
    <div
      className={`stack${dragOver ? ' is-dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <input ref={importRef} type="file" accept=".hwpx,.json,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f) }} />
      {dragOver && <div className="drop-hint">HWPX / JSON 파일을 놓으면 My List에 추가됩니다</div>}
      <Card>
        <div className="mylist-head-grid">
          <span className="mylist-icon-cell"><PencilSimple size={18} weight="fill" color={BRAND} /></span>
          <Input size="md" className={`span-rest${titleReq ? ' is-req-empty' : ''}`} value={listName} placeholder="목록 이름" onChange={(event) => setListName(event.target.value)} />
          <span className="mylist-icon-cell"><MapPin size={18} weight="fill" color={BRAND} /></span>
          <span className="loc-input-wrap">
            <input
              className={`loc-input${locReq ? ' is-req-empty' : ''}`}
              value={myLocation}
              placeholder="위치 검색·선택 또는 새 위치"
              onFocus={() => setLocOpen(true)}
              onChange={(event) => { setMyLocation(event.target.value); setLocOpen(true) }}
              onBlur={(event) => { commitLocation(event.target.value); setTimeout(() => setLocOpen(false), 120) }}
            />
            {String(myLocation || '') !== '' && (
              <button type="button" className="loc-clear" title="지우기"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setMyLocation(''); setLocOpen(true) }}>
                <X size={14} weight="bold" color={BRAND} />
              </button>
            )}
          </span>
          {/* Browse the location list WITHOUT focusing the text field (mousedown is
              swallowed so no keyboard pops up and the input's blur logic stays out). */}
          <button
            type="button"
            className="loc-list-btn mylist-icon-cell"
            title="위치 목록 보기"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLocOpen((o) => !o)}
          >
            <ListDashes size={18} weight="fill" color={BRAND} />
          </button>
        </div>
        {!locOpen && (
          <>
            <div className="mylist-actions">
              {rowTop.map((item) => (
                <button key={item.key} type="button" className={`mylist-btn${item.active ? ' is-active' : ''}${item.cls ? ` ${item.cls}` : ''}`} disabled={item.disabled} onClick={item.onClick}>
                  <item.Glyph size={20} weight="fill" color={item.active ? '#ffffff' : item.iconColor || '#3d5a80'} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="mylist-actions">
              {rowBottom.map((item) => (
                <button key={item.key} type="button" className={`mylist-btn tone-amber${item.active ? ' is-active' : ''}${item.cls ? ` ${item.cls}` : ''}`} disabled={item.disabled} onClick={item.onClick}>
                  <item.Glyph size={20} weight="fill" color="currentColor" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            {rowAdmin.length > 0 && (
              <div className="mylist-actions">
                {rowAdmin.map((item) => (
                  <button key={item.key} type="button" className={`mylist-btn${item.active ? ' is-active' : ''}${item.cls ? ` ${item.cls}` : ''}`} disabled={item.disabled} onClick={item.onClick}>
                    <item.Glyph size={20} weight="fill" color={item.active ? '#ffffff' : item.iconColor || '#3d5a80'} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            {hideAsk && (
              <div className="restore-confirm">
                <p>{hideAsk === 'hide'
                  ? `자산 ${ids.length}개를 숨길까요? 일반 계정에서는 보이지 않게 됩니다.`
                  : `자산 ${ids.length}개의 숨김을 해제할까요?`}</p>
                <div className="action-row">
                  <button type="button" className="amber-btn" onClick={() => { onSetHidden(ids, hideAsk === 'hide'); setHideAsk(null) }}>
                    {hideAsk === 'hide' ? <EyeSlash size={18} weight="fill" /> : <Eye size={18} weight="fill" />} {hideAsk === 'hide' ? '숨김' : '숨김 해제'}
                  </button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setHideAsk(null)}>취소</Button>
                </div>
              </div>
            )}
            {restoreAsk && restore && (
              <div className="restore-confirm">
                <p>자산 {Object.keys(restore.prev).length}개의 위치를 Update 이전 위치로 되돌릴까요?</p>
                <div className="action-row">
                  <button type="button" className="amber-btn" onClick={doRestore}><ArrowCounterClockwise size={18} weight="bold" /> 복원</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setRestoreAsk(false)}>취소</Button>
                </div>
              </div>
            )}
            {confirm === 'update' && (
              <div className="restore-confirm">
                <p>{myLocation.trim()
                  ? `지금 목록 ${ids.length}개를 '${myLocation.trim()}' 위치로 업데이트할까요?`
                  : `위치를 먼저 선택하세요. (지금 목록 ${ids.length}개의 위치를 바꿉니다)`}</p>
                <div className="action-row">
                  <button type="button" className="amber-btn" onClick={() => { setConfirm(''); doUpdate() }}><CheckCircle size={18} weight="fill" /> Update</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setConfirm('')}>취소</Button>
                </div>
              </div>
            )}
            {confirm === 'request' && (
              <div className="restore-confirm">
                <p>목록 {ids.length}개에 확인 요청을 걸까요?</p>
                <div className="action-row">
                  <button type="button" className="amber-btn green-btn" onClick={() => { setConfirm(''); onRequest(ids) }}><ShieldCheck size={18} weight="fill" /> Request</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setConfirm('')}>취소</Button>
                </div>
              </div>
            )}
            {confirm === 'delete' && (
              <div className="restore-confirm is-danger">
                <p>목록 {ids.length}개 자산을 <b>영구 삭제</b>할까요? 되돌릴 수 없습니다. (History에 기록됩니다)</p>
                <div className="action-row">
                  <button type="button" className="amber-btn danger-btn" onClick={() => { setConfirm(''); onDeleteAssets(ids) }}><Trash size={18} weight="fill" /> 삭제</button>
                  <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setConfirm('')}>취소</Button>
                </div>
              </div>
            )}
            {form && (
              <div className="request-panel">
                <h4>{form.label}</h4>
                {form.fields.map((f) => (
                  <label key={f.k} className={f.req && !String(fields[f.k] || '').trim() ? 'req-empty' : ''}>
                    <span className="field-label">{f.l}{f.req && <span className="req-mark"> *</span>}</span>
                    {f.area ? (
                      <textarea className="edit-textarea" value={fields[f.k] || ''} placeholder={f.ph || ''} onChange={(e) => setFields((c) => ({ ...c, [f.k]: e.target.value }))} />
                    ) : (
                      <Input size="md" value={fields[f.k] || ''} placeholder={f.ph || ''} onChange={(e) => setFields((c) => ({ ...c, [f.k]: e.target.value }))} />
                    )}
                  </label>
                ))}
                {form.placeKey && <p className="muted">장소는 위 위치 입력칸 값으로 들어갑니다: {myLocation || '(미입력)'}</p>}
                <div className="action-row">
                  {hwpx.state === 'idle' && (
                    <button type="button" className="amber-btn" onClick={prepareHwpx}>Confirm and get HWPX</button>
                  )}
                  {hwpx.state === 'building' && (
                    <button type="button" className="amber-btn is-loading" disabled>
                      <span className="spin-ring" /> HWPX
                    </button>
                  )}
                  {hwpx.state === 'ready' && (
                    <>
                      <button type="button" className="amber-btn" onClick={() => downloadBlob(hwpx.zipBlob, hwpx.zipName)}>
                        <DownloadSimple size={18} weight="bold" /> ZIP
                      </button>
                      <button type="button" className="amber-btn" onClick={shareHwpxZip}>
                        <ShareNetwork size={18} weight="fill" /> 공유
                      </button>
                    </>
                  )}
                </div>
                {hwpx.state === 'ready' && (
                  <div className="hwpx-files">
                    {hwpx.files.map((f) => (
                      <button
                        key={f.cls}
                        type="button"
                        className="hwpx-file-btn"
                        onClick={() => downloadBlob(f.blob, f.name)}
                      >
                        <FloppyDisk size={16} weight="fill" /> {f.cls} ({f.count}개) 저장
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Card>
      {settingsOpen && isAdmin ? (
        <>
          <Card>
            <div className="settings-row">
              <div className="settings-info">
                <strong>위치 변경 허용</strong>
                <span className="settings-desc">켜면 일반 계정도 위치 변경(Update·Check-in/out·Extension)이 바로 적용됩니다. 끄면 그 액션이 보류되어 관리자가 History에서 승인해야 적용됩니다.</span>
              </div>
              <button
                type="button"
                className={`setting-toggle${svcSettings.allowMove !== false ? ' is-on' : ''}`}
                onClick={() => onChangeSettings({ allowMove: !(svcSettings.allowMove !== false) })}
              >
                {svcSettings.allowMove !== false ? 'ON' : 'OFF'}
              </button>
            </div>
          </Card>
          <Card>
            <div className="settings-row">
              <div className="settings-info">
                <strong>새 자산 추가 허용</strong>
                <span className="settings-desc">끄면 일반 계정은 Assets 탭 맨 위의 '새 자산 등록' 카드로 자산을 추가할 수 없습니다.</span>
              </div>
              <button
                type="button"
                className={`setting-toggle${svcSettings.allowCreate !== false ? ' is-on' : ''}`}
                onClick={() => onChangeSettings({ allowCreate: !(svcSettings.allowCreate !== false) })}
              >
                {svcSettings.allowCreate !== false ? 'ON' : 'OFF'}
              </button>
            </div>
          </Card>
          <Card>
            <div className="settings-row">
              <div className="settings-info">
                <strong>사진 변경 허용</strong>
                <span className="settings-desc">끄면 일반 계정은 자산·위치 카드의 왼쪽 사진 버튼으로 사진을 추가·변경할 수 없습니다.</span>
              </div>
              <button
                type="button"
                className={`setting-toggle${svcSettings.allowPhoto !== false ? ' is-on' : ''}`}
                onClick={() => onChangeSettings({ allowPhoto: !(svcSettings.allowPhoto !== false) })}
              >
                {svcSettings.allowPhoto !== false ? 'ON' : 'OFF'}
              </button>
            </div>
          </Card>
          <Card>
            <div className="settings-info" style={{ marginBottom: 10 }}>
              <strong>자산 카드 필드 표시 (일반 계정)</strong>
              <span className="settings-desc">번호·이름·사진·위치·유저·Type·자산분류·Description·Last update·Edited by는 항상 표시됩니다.</span>
            </div>
            {VIS_FIELDS.map((f) => (
              <div key={f.k} className="settings-row">
                <span className="settings-field-label">{f.l}</span>
                <button
                  type="button"
                  className={`setting-toggle${fieldOn(f.k) ? ' is-on' : ''}`}
                  onClick={() => onChangeSettings({ fieldVis: { ...(svcSettings.fieldVis || {}), [f.k]: !fieldOn(f.k) } })}
                >
                  {fieldOn(f.k) ? 'ON' : 'OFF'}
                </button>
              </div>
            ))}
          </Card>
        </>
      ) : locOpen ? (
        <div className="result-list result-list-full">
          {locFiltered.length === 0 && (
            <Card><p className="muted">{locationList.length ? '일치하는 위치가 없습니다.' : '등록된 위치가 없습니다.'}{String(myLocation).trim() ? ` 입력한 "${String(myLocation).trim()}" 이름으로 새 위치가 등록됩니다.` : ''}</p></Card>
          )}
          {locFiltered.map((l) => (
            <Card key={l.name}>
              <button
                type="button"
                className={`loc-row loc-pick-row${String(myLocation).trim() === l.name ? ' is-sel' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setMyLocation(l.name); commitLocation(l.name); setLocOpen(false) }}
              >
                <span className="asset-thumb is-photo loc-thumb">
                  {l.photo ? <img src={l.photo} alt="" /> : <CameraPlus size={22} weight="fill" color={PHOTO_COLOR} />}
                </span>
                <span className="loc-main">
                  <strong>{l.name}</strong>
                  <span className="history-meta">{l.count}개 물품{l.lastUpdate ? ` · 최근변경 ${formatDate(l.lastUpdate)}` : ''}</span>
                </span>
              </button>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="list-toolbar">
            <span className="list-count">총 {assets.length}개</span>
            <SortBar sort={sort} setSort={setSort} withAdded />
          </div>
          <div className="result-list result-list-full">
            {empty && <Card><p className="muted">My List가 비어 있습니다.</p></Card>}
            {assets.map((asset) => (
              <AssetRow
                key={asset.assetId}
                asset={asset}
                expanded={expandedId === asset.assetId}
                onToggle={() => { onSeenNew?.(asset.assetId); setExpandedId(expandedId === asset.assetId ? '' : asset.assetId) }}
                inMyList
                isNew={newIds?.has(asset.assetId)}
                shots={myPhotos[asset.assetId]}
                onToggleMyList={() => toggleMyList(asset.assetId)}
                onCapture={() => onCapture(asset.assetId)}
                onCaptureSlot={onCaptureSlot}
                recordAction={recordAction}
                updateAsset={updateAsset}
                locationPhoto={locationPhoto}
                records={records}
                classOptions={classOptions}
                isAdmin={isAdmin}
                canEditPhotos={canEditPhotos}
                showField={showField}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function RecordsPage({ records, assets, me, myListSet, toggleMyList, onAdd, onRemove, isAdmin, onDelete, onRename, onCancelRequest, onApprove, notify, showField }) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState('')
  const assetMap = useMemo(() => {
    const m = {}
    for (const a of assets) m[a.assetId] = a
    return m
  }, [assets])
  const visible = useMemo(
    () => records.filter((r) => isAdmin || (r.type !== 'hide' && r.type !== 'unhide')),
    [records, isAdmin],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter((r) =>
      String(r.name || '').toLowerCase().includes(q) ||
      String(r.user || '').toLowerCase().includes(q) ||
      (r.assetIds || []).some((id) => String(id).toLowerCase().includes(q)),
    )
  }, [visible, query])
  useArrowNav(true, openId, setOpenId, filtered, (r) => r.id)
  return (
    <div className="stack">
      <Card>
        <SearchBox query={query} setQuery={setQuery} placeholder="제목 · 작성자 · 자산번호 검색" />
      </Card>
      {filtered.length === 0 && <Card><p className="muted">{visible.length ? '검색 결과가 없습니다.' : '저장된 기록이 없습니다.'}</p></Card>}
      {filtered.map((record) => (
        <HistoryCard
          key={record.id}
          record={record}
          assetMap={assetMap}
          myListSet={myListSet}
          isAdmin={isAdmin}
          me={me}
          open={openId === record.id}
          onToggle={() => setOpenId(openId === record.id ? '' : record.id)}
          onAdd={onAdd}
          onRemove={onRemove}
          onDelete={onDelete}
          onRename={onRename}
          onCancelRequest={onCancelRequest}
          onApprove={onApprove}
          toggleMyList={toggleMyList}
          notify={notify}
          showField={showField}
        />
      ))}
    </div>
  )
}

function HistoryCard({ record, assetMap, myListSet, isAdmin, me, open, onToggle, onAdd, onRemove, onDelete, onRename, onCancelRequest, onApprove, toggleMyList, notify, showField }) {
  // 삭제/요청 취소 is for the record's creator or an admin.
  const canModerate = isAdmin || (!!me && record.user === me)
  const cardRef = useRef(null)
  // Two-phase open/close: glide up first then grow; shrink in place then glide back.
  const { mounted, grown } = useCardGlide(open, cardRef)
  return (
    <div ref={cardRef}>
      <Card>
        <div className="history-row">
          <button type="button" className="history-info" onClick={onToggle}>
            <strong>{record.name || record.id}</strong>
            <span className="history-meta">
              <span className={`type-chip type-${record.type}`}>{typeLabel(record.type)}</span>
              {record.pending && <span className="type-chip type-pending">승인 대기</span>}
              <span>
                {[`${(record.assetIds || []).length}개`, record.user ? String(record.user).split('@')[0] : '', formatDate(record.createdAt)]
                  .filter(Boolean)
                  .join(' · ') + (record.location ? ` → ${record.location}` : '')}
              </span>
            </span>
          </button>
        </div>
        {mounted && (
          <Expando grown={grown}>
          <div className="loc-detail">
            {record.pending && isAdmin && (
              <button type="button" className="amber-btn green-btn hcard-full" onClick={() => onApprove(record.id)}><CheckCircle size={18} weight="fill" /> 승인 — 위치 변경 적용</button>
            )}
            <div className="hcard-actions">
              <button type="button" className="amber-btn" onClick={() => onAdd(record)}><Plus size={18} weight="bold" /> My List</button>
              <button type="button" className="amber-btn" onClick={() => onRemove(record)}><Minus size={18} weight="bold" /> My List</button>
              {(isAdmin || canModerate) && (
                <button type="button" className="amber-btn danger-btn" onClick={() => onDelete(record.id)}><Trash size={18} weight="fill" /> Delete</button>
              )}
              {record.type === 'request' && canModerate && (
                <button type="button" className="amber-btn danger-btn" onClick={() => onCancelRequest(record)}><X size={18} weight="bold" /> 요청 취소</button>
              )}
            </div>
            {(() => {
              const rows = (record.assetIds || []).map((id) => assetMap[id]).filter(Boolean)
              return rows.length > 0 ? <ExportButtons assets={rows} title={record.name || record.id} notify={notify} showField={showField} /> : null
            })()}
            <div className="loc-items">
              {(record.assetIds || []).length === 0 && <p className="muted">항목이 없습니다.</p>}
              {(record.assetIds || []).map((id) => (
                <div key={id} className="loc-item">
                  <span className="mono">{id}</span>
                  <strong>{assetMap[id]?.name || '(목록에 없는 자산)'}</strong>
                  <button
                    type="button"
                    className={`asset-circle${myListSet.has(id) ? ' is-on' : ''}`}
                    title={myListSet.has(id) ? 'My List에서 제거' : 'My List에 추가'}
                    onClick={() => toggleMyList(id)}
                  >
                    {myListSet.has(id) ? <Minus size={15} weight="bold" color="#fff" /> : <Plus size={15} weight="bold" color="#fff" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
          </Expando>
        )}
      </Card>
    </div>
  )
}

// Field config per classification kind.
const CLASS_CONFIG = {
  location: {
    field: 'location',
    createLabel: '새 위치 등록',
    searchPlaceholder: '위치 이름 · 자산번호 검색',
    emptyText: '위치가 없습니다. 자산에 위치를 지정하거나 My List에서 위치를 추가하세요.',
    editFields: [
      { k: 'name', l: '이름' },
      { k: 'address', l: '정확한 주소', ph: '상세 주소 (선택)' },
      { k: 'memo', l: '메모', area: true },
    ],
    detailFields: [{ k: 'address', l: '주소' }, { k: 'memo', l: '메모' }],
  },
  type: {
    field: 'type',
    hasPhoto: false,          // types are text-only categories — no photo UI
    createLabel: '새 타입 등록',
    searchPlaceholder: '타입 이름 · 자산번호 검색',
    emptyText: '타입이 없습니다. 자산에 타입을 지정하세요.',
    editFields: [
      { k: 'name', l: '이름' },
      { k: 'description', l: '설명', area: true },
      { k: 'memo', l: '메모', area: true },
    ],
    detailFields: [{ k: 'description', l: '설명' }, { k: 'memo', l: '메모' }],
  },
}

function ClassificationPage(props) {
  const [sub, setSub] = useState('location')
  // While a merge is underway the Location/Type subtabs are hidden — switching
  // sub-lists mid-merge would silently drop the flow.
  const [merging, setMerging] = useState(false)
  return (
    <div className="stack">
      {!merging && (
        <div className="subtabs">
          <button type="button" className={`subtab${sub === 'location' ? ' is-active' : ''}`} onClick={() => setSub('location')}>Location</button>
          <button type="button" className={`subtab${sub === 'type' ? ' is-active' : ''}`} onClick={() => setSub('type')}>Type</button>
        </div>
      )}
      {sub === 'location' ? (
        <ClassPage
          cfg={CLASS_CONFIG.location}
          classList={props.locationList}
          assets={props.assets}
          myListSet={props.myListSet}
          isAdmin={props.isAdmin}
          toggleMyList={props.toggleMyList}
          onUpdate={props.onUpdateLocation}
          onMerge={props.onMergeLocation}
          onDelete={props.onDeleteLocation}
          onAddAll={props.onAddAllLocation}
          onPhoto={props.onPhotoLocation}
          onCreate={props.onCreateLocation}
          onMergeMode={setMerging}
          canEditPhotos={props.canEditPhotos}
          notify={props.notify}
          showField={props.showField}
        />
      ) : (
        <ClassPage
          cfg={CLASS_CONFIG.type}
          classList={props.typeList}
          assets={props.assets}
          myListSet={props.myListSet}
          isAdmin={props.isAdmin}
          toggleMyList={props.toggleMyList}
          onUpdate={props.onUpdateType}
          onMerge={props.onMergeType}
          onDelete={props.onDeleteType}
          onAddAll={props.onAddAllType}
          onPhoto={props.onPhotoType}
          onCreate={props.onCreateType}
          onMergeMode={setMerging}
          canEditPhotos={props.canEditPhotos}
          notify={props.notify}
          showField={props.showField}
        />
      )}
    </div>
  )
}

// "새 위치/타입 등록" — same pattern as the new-asset card; name is required.
function NewClassCard({ cfg, onCreate }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({})
  const photoRef = useRef(null)
  function save() {
    if (onCreate(form)) { setForm({}); setOpen(false) }
  }
  // Photo can be attached right at creation — camera or gallery via the native
  // picker, rasterized to JPEG like every other photo intake.
  async function onPickPhoto(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const url = await fileToJpegDataUrl(f)
    setForm((c) => ({ ...c, photo: url }))
  }
  return (
    <div className={`asset-row${open ? ' is-open' : ''}`}>
      <div className="asset-row-head" role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}>
        <div className="asset-photo"><Plus size={24} weight="bold" color={BRAND} /></div>
        <div className="asset-row-open">
          <div className="asset-row-main"><strong>{cfg.createLabel}</strong></div>
        </div>
      </div>
      {open && (
        <div className="asset-row-body loc-body loc-edit">
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={save}>Save</button>
            <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => { setForm({}); setOpen(false) }}>Cancel</Button>
          </div>
          {cfg.hasPhoto !== false && (
            <>
              <div className="photo-row">
                <div className="photo-stack">
                  <PhotoSlot src={form.photo} label={cfg.field === 'location' ? '위치 사진' : '사진'} />
                  <button type="button" className="slot-edit-btn" onClick={() => photoRef.current?.click()}>
                    <CameraPlus size={16} weight="fill" /> {form.photo ? '사진 변경' : '사진 추가'}
                  </button>
                </div>
              </div>
              <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPickPhoto} />
            </>
          )}
          {cfg.editFields.map((x) => (
            <label key={x.k}>
              {x.l}
              {x.area ? (
                <textarea className="edit-textarea" value={form[x.k] || ''} onChange={(e) => setForm((c) => ({ ...c, [x.k]: e.target.value }))} />
              ) : (
                <Input
                  size="md"
                  className={x.k === 'name' && !String(form.name || '').trim() ? 'is-req-empty' : undefined}
                  value={form[x.k] || ''}
                  placeholder={x.ph || ''}
                  onChange={(e) => setForm((c) => ({ ...c, [x.k]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// A non-editing class card used by the merge flow (pick list + confirmation).
function ClassPickCard({ rec, onSelect }) {
  const body = (
    <span className="loc-main">
      <strong>{rec.name}</strong>
      <span className="history-meta">{rec.count}개 물품{rec.lastUpdate ? ` · 최근변경 ${formatDate(rec.lastUpdate)}` : ''}</span>
    </span>
  )
  return (
    <div className="asset-row">
      <div className="asset-row-head">
        <span className="asset-photo">
          {rec.photo ? <img src={rec.photo} alt="" /> : <Tag size={22} weight="fill" color="#9aa3b2" />}
        </span>
        {onSelect ? (
          <button type="button" className="asset-row-open" onClick={onSelect}>{body}</button>
        ) : (
          <div className="asset-row-open">{body}</div>
        )}
      </div>
    </div>
  )
}

function ClassPage({ cfg, classList, assets, myListSet, isAdmin, onUpdate, onMerge, onDelete, onPhoto, onAddAll, toggleMyList, onCreate, onMergeMode, canEditPhotos = true, notify, showField }) {
  const [openName, setOpenName] = useState('')
  const [query, setQuery] = useState('')
  // Merge flow: null | { source, target: null } (picking) | { source, target } (confirming)
  const [merge, setMerge] = useState(null)
  const [mergeQuery, setMergeQuery] = useState('')
  const mergeTopRef = useRef(null)
  // Merge mode: tell the parent (it hides the Location/Type subtabs) and jump to
  // the top on every step (enter picking / move to confirmation).
  useEffect(() => {
    onMergeMode?.(!!merge)
    if (merge) mergeTopRef.current?.scrollIntoView({ block: 'start' })
    return () => onMergeMode?.(false)
  }, [merge])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return classList
    return classList.filter((c) =>
      String(c.name).toLowerCase().includes(q) ||
      assets.some((a) => a[cfg.field] === c.name && String(a.assetId).toLowerCase().includes(q)),
    )
  }, [classList, assets, query, cfg.field])
  useArrowNav(!merge, openName, setOpenName, filtered, (c) => c.name)

  if (merge) {
    const source = classList.find((c) => c.name === merge.source) || { name: merge.source, count: 0 }
    const target = merge.target ? classList.find((c) => c.name === merge.target) : null
    if (target) {
      // Final confirmation: source ↓ target, then 확인/취소.
      return (
        <>
          <div ref={mergeTopRef}><Card><p className="merge-title">아래와 같이 병합할까요? 되돌릴 수 없습니다.</p></Card></div>
          <ClassPickCard rec={source} />
          <div className="merge-arrow"><ArrowCircleDown size={28} weight="fill" color="#c98a2e" /></div>
          <ClassPickCard rec={target} />
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={() => { onMerge(merge.source, merge.target); setMerge(null) }}>확인</button>
            <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setMerge({ source: merge.source, target: null })}>취소</Button>
          </div>
        </>
      )
    }
    // Pick mode: instruction + cancel, search, and every card except the source.
    const q = mergeQuery.trim().toLowerCase()
    const candidates = classList
      .filter((c) => c.name !== merge.source)
      .filter((c) => !q || String(c.name).toLowerCase().includes(q))
    return (
      <>
        <div ref={mergeTopRef}>
        <Card>
          <div className="merge-head">
            <p className="merge-title">'{merge.source}'을(를) 병합할 대상을 선택하세요</p>
            <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setMerge(null)}>취소</Button>
          </div>
          <SearchBox query={mergeQuery} setQuery={setMergeQuery} placeholder={cfg.searchPlaceholder} />
        </Card>
        </div>
        {candidates.length === 0 && <Card><p className="muted">선택할 수 있는 대상이 없습니다.</p></Card>}
        {candidates.map((c) => (
          <ClassPickCard key={c.name} rec={c} onSelect={() => setMerge({ source: merge.source, target: c.name })} />
        ))}
      </>
    )
  }

  return (
    <>
      <Card>
        <SearchBox query={query} setQuery={setQuery} placeholder={cfg.searchPlaceholder} />
      </Card>
      {!query.trim() && <NewClassCard cfg={cfg} onCreate={onCreate} />}
      {filtered.length === 0 && <Card><p className="muted">{classList.length ? '검색 결과가 없습니다.' : cfg.emptyText}</p></Card>}
      {filtered.map((c) => (
        <ClassCard
          key={c.name}
          cfg={cfg}
          rec={c}
          assets={assets}
          myListSet={myListSet}
          isAdmin={isAdmin}
          open={openName === c.name}
          onToggle={() => setOpenName(openName === c.name ? '' : c.name)}
          onUpdate={onUpdate}
          onMerge={(name) => { setMerge({ source: name, target: null }); setMergeQuery(''); setOpenName('') }}
          onDelete={onDelete}
          onPhoto={onPhoto}
          onAddAll={onAddAll}
          toggleMyList={toggleMyList}
          canEditPhotos={canEditPhotos}
          notify={notify}
          showField={showField}
        />
      ))}
    </>
  )
}

function ClassCard({ cfg, rec, assets, myListSet, isAdmin, open, onToggle, onUpdate, onMerge, onDelete, onPhoto, onAddAll, toggleMyList, canEditPhotos = true, notify, showField }) {
  const items = useMemo(() => assets.filter((a) => a[cfg.field] === rec.name), [assets, rec.name, cfg.field])
  const [editing, setEditing] = useState(false)
  const [editPhoto, setEditPhoto] = useState(false)
  const initForm = () => { const f = {}; cfg.editFields.forEach((x) => { f[x.k] = x.k === 'name' ? rec.name : (rec[x.k] || '') }); return f }
  const [form, setForm] = useState(initForm)
  const cardRef = useRef(null)
  useEffect(() => { setForm(initForm()) }, [rec.name, rec.address, rec.description, rec.memo])
  useEffect(() => { if (!open) { setEditing(false); setEditPhoto(false) } }, [open])
  // Two-phase open/close: glide up first then grow; shrink in place then glide back.
  const { mounted, grown } = useCardGlide(open, cardRef)
  function saveEdit() {
    const patch = { ...form, name: (form.name || '').trim() || rec.name }
    onUpdate(rec.name, patch)
    setEditing(false)
  }
  return (
    <div ref={cardRef} className={`asset-row${open ? ' is-open' : ''}`}>
      <div className="asset-row-head">
        {cfg.hasPhoto !== false && canEditPhotos ? (
          <button type="button" className="asset-photo is-photo" title="사진 촬영" onClick={() => onPhoto(rec.name)}>
            {rec.photo ? <img src={rec.photo} alt="" /> : <CameraPlus size={24} weight="fill" color={PHOTO_COLOR} />}
          </button>
        ) : cfg.hasPhoto !== false ? (
          <div className="asset-photo">
            {rec.photo ? <img src={rec.photo} alt="" /> : <Images size={22} weight="fill" color="#c2c8d2" />}
          </div>
        ) : (
          <div className="asset-photo"><Tag size={22} weight="fill" color="#9aa3b2" /></div>
        )}
        <button type="button" className="asset-row-open" onClick={onToggle}>
          <span className="loc-main">
            <strong>{rec.name}</strong>
            <span className="history-meta">{rec.count}개 물품{rec.lastUpdate ? ` · 최근변경 ${formatDate(rec.lastUpdate)}` : ''}</span>
          </span>
        </button>
      </div>
      {mounted && editing && isAdmin && (
        <Expando grown={grown}>
        <div className="asset-row-body loc-body loc-edit">
          {cfg.hasPhoto !== false && (
            <div className="photo-row">
              <div className="photo-stack">
                <PhotoSlot src={rec.photo} label={cfg.field === 'location' ? '위치 사진' : '사진'} />
                <button type="button" className="slot-edit-btn" onClick={() => setEditPhoto(true)}>
                  <PencilSimple size={16} weight="fill" /> 편집
                </button>
              </div>
            </div>
          )}
          {cfg.editFields.map((x) => (
            <label key={x.k}>
              {x.l}
              {x.area ? (
                <textarea className="edit-textarea" value={form[x.k] || ''} onChange={(e) => setForm((c) => ({ ...c, [x.k]: e.target.value }))} />
              ) : (
                <Input size="md" value={form[x.k] || ''} placeholder={x.ph || ''} onChange={(e) => setForm((c) => ({ ...c, [x.k]: e.target.value }))} />
              )}
            </label>
          ))}
          <div className="action-row">
            <button type="button" className="amber-btn" onClick={saveEdit}>저장</button>
            <Button variant="secondary" size="md" style={ACTION_BTN} onClick={() => setEditing(false)}>취소</Button>
          </div>
        </div>
        </Expando>
      )}
      {mounted && !editing && (
        <Expando grown={grown}>
        <div className="asset-row-body loc-body">
          <div className="hcard-actions">
            <button type="button" className="amber-btn" onClick={() => setEditing(true)}><PencilSimple size={18} weight="fill" /> 편집</button>
            <button type="button" className="amber-btn tone-hwpx" onClick={() => onMerge(rec.name)}><Unite size={18} weight="fill" /> 병합</button>
            {isAdmin && (
              <button type="button" className="amber-btn danger-btn" onClick={() => onDelete(rec.name)}><Trash size={18} weight="fill" /> 제거</button>
            )}
          </div>
          {cfg.hasPhoto !== false && (
            <div className="photo-row">
              <PhotoSlot src={rec.photo} label={cfg.field === 'location' ? '위치 사진' : '사진'} />
            </div>
          )}
          <dl className="kv">
            {rec.createdBy && <><dt>만든 사람</dt><dd>{String(rec.createdBy).split('@')[0]}</dd></>}
            {cfg.detailFields.map((x) => (rec[x.k] ? <React.Fragment key={x.k}><dt>{x.l}</dt><dd>{rec[x.k]}</dd></React.Fragment> : null))}
            <dt>최근 변경</dt><dd>{formatDate(rec.lastUpdate) || '-'}</dd>
          </dl>
          <div className="hcard-actions">
            <button type="button" className="amber-btn" onClick={() => onAddAll(rec.name)}><Plus size={18} weight="bold" /> My List</button>
          </div>
          {items.length > 0 && <ExportButtons assets={items} title={rec.name} notify={notify} showField={showField} />}
          <div className="loc-items">
            {items.length === 0 && <p className="muted">물품이 없습니다.</p>}
            {items.map((a) => (
              <div key={a.assetId} className="loc-item">
                <span className="mono">{a.assetId}</span>
                <strong>{a.name || 'Unnamed asset'}</strong>
                <button
                  type="button"
                  className={`asset-circle${myListSet.has(a.assetId) ? ' is-on' : ''}`}
                  title={myListSet.has(a.assetId) ? 'My List에서 제거' : 'My List에 추가'}
                  onClick={() => toggleMyList(a.assetId)}
                >
                  {myListSet.has(a.assetId) ? <Minus size={15} weight="bold" color="#fff" /> : <Plus size={15} weight="bold" color="#fff" />}
                </button>
              </div>
            ))}
          </div>
        </div>
        </Expando>
      )}
      {editPhoto && (
        <PhotoEditModal
          src={rec.photo || ''}
          onSave={(url) => { onUpdate(rec.name, { photo: url }); setEditPhoto(false) }}
          onClose={() => setEditPhoto(false)}
          onRetake={() => { setEditPhoto(false); onPhoto(rec.name) }}
          onDelete={rec.photo ? () => { onUpdate(rec.name, { photo: '' }); setEditPhoto(false) } : undefined}
        />
      )}
    </div>
  )
}

// Short chip labels — used only in the asset card's compact history rows.
// Reusable export block for a list of assets (Class card / History card).
//  • HWPX: table-only doc per 자산분류 → spinner → [ZIP][공유] + per-class buttons.
//  • XLSX: one sheet, all fields but photos → [다운로드][공유].
// Each download is its own tap (browsers allow one download per gesture).
function ExportButtons({ assets, title, notify, showField }) {
  const [hwpx, setHwpx] = useState({ state: 'idle' })   // idle | building | ready
  const [xlsx, setXlsx] = useState({ state: 'idle' })
  const jobRef = useRef(0)
  const safe = sanitizeFileName(title || '목록')

  async function prepareHwpx() {
    const job = ++jobRef.current
    setHwpx({ state: 'building' })
    try {
      const files = []
      for (const [cls, group] of groupByClass(assets)) {
        const blob = await buildTableHwpxBlob(group, `${title} - ${cls}`)
        files.push({ cls, count: group.length, blob, name: `${safe}_${sanitizeFileName(cls)}.hwpx` })
      }
      const entries = []
      for (const f of files) entries.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })
      const zipBlob = window.CensHwpx?.makeZip ? window.CensHwpx.makeZip(entries) : null
      const zipName = `${safe}.zip`
      const zipFile = zipBlob ? new File([zipBlob], zipName, { type: 'application/zip' }) : null
      if (job !== jobRef.current) return
      setHwpx({ state: 'ready', files, zipBlob, zipName, zipFile })
    } catch (e) { if (job === jobRef.current) { setHwpx({ state: 'idle' }); notify?.(`HWPX 실패: ${e.message || e}`, 'error') } }
  }

  function prepareXlsx() {
    try {
      const blob = buildXlsxBlob(assets, showField)
      const name = `${safe}.xlsx`
      const file = new File([blob], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      setXlsx({ state: 'ready', blob, name, file })
    } catch (e) { notify?.(`XLSX 실패: ${e.message || e}`, 'error') }
  }

  async function shareFile(file, name) {
    try {
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title })
      else notify?.('이 브라우저는 파일 공유를 지원하지 않습니다.', 'warn')
    } catch { /* dismissed */ }
  }

  return (
    <>
      <div className="hcard-actions">
        {hwpx.state === 'idle' && <button type="button" className="amber-btn tone-hwpx" onClick={prepareHwpx}>HWPX</button>}
        {hwpx.state === 'building' && <button type="button" className="amber-btn tone-hwpx is-loading" disabled><span className="spin-ring" /> HWPX</button>}
        {hwpx.state === 'ready' && (
          <>
            <button type="button" className="amber-btn tone-hwpx" onClick={() => downloadBlob(hwpx.zipBlob, hwpx.zipName)}><DownloadSimple size={18} weight="bold" /> ZIP</button>
            <button type="button" className="amber-btn tone-hwpx" onClick={() => shareFile(hwpx.zipFile, hwpx.zipName)}><ShareNetwork size={18} weight="fill" /> 공유</button>
          </>
        )}
      </div>
      {hwpx.state === 'ready' && (
        <div className="hcard-actions">
          {hwpx.files.map((f) => (
            <button key={f.cls} type="button" className="amber-btn tone-hwpx" onClick={() => downloadBlob(f.blob, f.name)}>
              <FloppyDisk size={16} weight="fill" /> {f.cls} ({f.count})
            </button>
          ))}
        </div>
      )}
      <div className="hcard-actions">
        {xlsx.state !== 'ready' ? (
          <button type="button" className="amber-btn tone-xlsx" onClick={prepareXlsx}>XLSX</button>
        ) : (
          <>
            <button type="button" className="amber-btn tone-xlsx" onClick={() => downloadBlob(xlsx.blob, xlsx.name)}><DownloadSimple size={18} weight="bold" /> 다운로드</button>
            <button type="button" className="amber-btn tone-xlsx" onClick={() => shareFile(xlsx.file, xlsx.name)}><ShareNetwork size={18} weight="fill" /> 공유</button>
          </>
        )}
      </div>
    </>
  )
}

function typeLabelShort(type) {
  if (type === 'checkout') return 'co'
  if (type === 'checkin') return 'ci'
  if (type === 'extension') return 'ex'
  if (type === 'update' || type === 'verify') return 'up'
  if (type === 'request') return 'rq'
  if (type === 'save') return 'sv'
  if (type === 'delete') return 'dl'
  return typeLabel(type)
}

function typeLabel(type) {
  if (type === 'checkout') return 'Check-out'
  if (type === 'checkin') return 'Check-in'
  if (type === 'extension') return 'Extension'
  if (type === 'update') return 'Update'
  if (type === 'verify') return 'Update'
  if (type === 'request') return 'Request'
  if (type === 'save') return 'Saved'
  if (type === 'hide') return 'Hide'
  if (type === 'unhide') return 'Unhide'
  if (type === 'delete') return 'Delete'
  return type
}

// Notification time: HH:MM for today, date+time otherwise.
function formatNoticeTime(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Date only, no clock time (asset-card history rows).
function formatDateOnly(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

const loginButtonStyle = {
  height: 37,
  minHeight: 37,
  fontSize: 17,
}

const loginNewListButtonStyle = {
  ...loginButtonStyle,
}


export default App

// ─── Desktop: the asset list as a RACK table ────────────────────────────────
// The card list is phone-first and reads well with a thumb; on a desktop it is
// a column of cards in a window three times as wide. The same records at sheet
// density, with the card itself beside the table — so everything the card can
// do (edit, photos, history, requests) still happens in the card, and nothing
// here is a second implementation of it.
const RACK_COLS = [
  { k: 'chk', w: 26, min: 26, fix: true },
  { k: 'num', w: 42, min: 32, fix: true, label: '#' },
  { k: 'assetId', w: 118, min: 70, label: '자산번호' },
  { k: 'name', w: 250, min: 110, label: '자산명' },
  { k: 'location', w: 140, min: 70, label: '위치' },
  { k: 'type', w: 110, min: 60, label: 'Type', drop: 1240 },
  { k: 'assetClass', w: 120, min: 60, label: '자산분류', drop: 1180 },
  { k: 'accountHolder', w: 112, min: 60, label: '관리책임자', drop: 1440 },
  { k: 'lastUpdate', w: 96, min: 70, label: '최근변경' },
]
const RACK_TONE = { name: 'ink', location: 'dim', type: 'dim', assetClass: 'dim', accountHolder: 'dim' }
const rackDate = (v) => String(v || '').slice(0, 10)

function AssetRack({
  query, setQuery, assets, myListSet, myPhotos, toggleMyList, onCapture, onCaptureSlot,
  recordAction, updateAsset, locationPhoto, records, classOptions, isAdmin, canEditPhotos,
  showField, onAddAll, hiddenFilter, onCycleHiddenFilter, onCards,
}) {
  const [sel, setSel] = useState('')
  const [sort, setSort] = useState({ k: 'assetId', dir: 1 })
  const { drag, sized } = useColumnWidths(`${NS}.rack.cols`, RACK_COLS)
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setVw(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // A column the admin has hidden is not a column here either. The width a
  // column leaves at is the TABLE's, not the window's — with the card open the
  // table has half of it.
  const sel_ = sel
  const cols = useMemo(
    () => sized(RACK_COLS.filter((c) => c.fix || c.k === 'assetId' || showField(c.k)),
      sel_ ? Math.round(vw / 2) : vw),
    [sized, vw, showField, sel_])

  const rows = useMemo(() => {
    const get = (a) => (sort.k === 'lastUpdate' ? a.lastUpdate || '' : String(a[sort.k] ?? ''))
    return [...assets].sort((a, b) => {
      const x = get(a), y = get(b)
      if (!x || !y) return x === y ? 0 : (x ? -1 : 1)
      return String(x).localeCompare(String(y), 'ko', { numeric: true }) * sort.dir
    })
  }, [assets, sort])

  const chosen = rows.find((a) => a.assetId === sel) || null

  return (
    <>
        <div className="rl-cmd">
          <button type="button" className="rl-btn rl-go"
            onClick={() => onAddAll(rows.map((a) => a.assetId))}>전체추가</button>
          {isAdmin && (
            <button type="button" className={`rl-btn${hiddenFilter !== 'all' ? ' on' : ''}`}
              title="숨김 필터: 전체 → 숨김만 → 노출만" onClick={onCycleHiddenFilter}>
              {hiddenFilter === 'all' ? '전체' : hiddenFilter === 'hidden' ? '숨김만' : '노출만'}
            </button>
          )}
          <span className="rl-gap" />
          <button type="button" className="rl-btn" onClick={onCards}>카드로 보기</button>
          <span className="rl-sp" />
          <input type="search" className="rl-find" value={query}
            placeholder="자산번호 · 이름 · 위치"
            onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="rl-body">
          <div className="rl-pane">
            <RackTable cols={cols} onDrag={drag('')} sort={sort}
              onSort={(k) => setSort((s) => (s.k === k ? { k, dir: -s.dir } : { k, dir: 1 }))}>
              {rows.map((a, i) => {
                const on = myListSet.has(a.assetId)
                return (
                  <RackRow key={a.assetId} cols={cols} tone={RACK_TONE}
                    className={`rl-hit${a.assetId === sel ? ' on' : ''}`}
                    onClick={() => setSel(a.assetId)}
                    cell={{
                      // The checkbox is My List, which is what a selection is
                      // for in this app — it does not need a second meaning.
                      chk: (
                        <input type="checkbox" checked={on} aria-label={`${a.assetId} My List`}
                          onChange={() => toggleMyList(a.assetId)}
                          onClick={(e) => e.stopPropagation()} />
                      ),
                      num: i + 1,
                      assetId: a.assetId,
                      name: a.name || '·',
                      location: a.location || '·',
                      type: a.type || '·',
                      assetClass: a.assetClass || '·',
                      accountHolder: a.accountHolder || '·',
                      lastUpdate: rackDate(a.lastUpdate) || '·',
                    }} />
                )
              })}
              {rows.length === 0 && <p className="rl-msg">일치하는 자산이 없습니다.</p>}
            </RackTable>
          </div>

          {chosen && (
            <div className="rl-pane rl-epane am-rack-card">
              {/* The card itself, open: every action it has works here. */}
              <AssetRow
                key={chosen.assetId}
                asset={chosen}
                expanded
                onToggle={() => setSel('')}
                inMyList={myListSet.has(chosen.assetId)}
                shots={myPhotos[chosen.assetId]}
                onToggleMyList={() => toggleMyList(chosen.assetId)}
                onCapture={() => onCapture(chosen.assetId)}
                onCaptureSlot={onCaptureSlot}
                recordAction={recordAction}
                updateAsset={updateAsset}
                locationPhoto={locationPhoto}
                records={records}
                classOptions={classOptions}
                isAdmin={isAdmin}
                canEditPhotos={canEditPhotos}
                showField={showField}
              />
            </div>
          )}
        </div>

    </>
  )
}

/** The desktop frame: a RACK module around whatever tab you are on.
 *
 * On a desktop the app's own top bar and bottom tab bar are a second set of
 * chrome inside the portal's panel — the portal already says which service and
 * project you are in. So at this width they go, and what is left is the shape
 * the portal's other list services have: a nameplate, a strip of tabs, the
 * screen, and one line of status (which is where a notice now lands, since the
 * top bar used to carry it).
 */
function RackFrame({ on, children, tabs, tab, setTab, count, project, note, onScan }) {
  if (!on) return children
  const loose = tab !== 'assets'
  return (
    <div className="rl am-rack" style={brandStyle()}>
      <section className="rl-mod">
        <header className="rl-bar">
          <b>자산</b>
          <span className="rl-n">{count}개</span>
          <span className="rl-sp" />
          <span className="rl-n">{project}</span>
        </header>
        <div className="rl-tabs">
          {tabs.map((t) => (
            <span key={t.id} className={`rl-tab${t.id === tab ? ' on' : ''}`}>
              <button type="button" className="rl-tabname" onClick={() => setTab(t.id)}>{t.label}</button>
            </span>
          ))}
          <span className="rl-sp" />
          {onScan && <button type="button" className="rl-tabname am-rack-scan" onClick={onScan}>스캔</button>}
        </div>
        {loose ? <div className="rl-pane am-rack-loose">{children}</div> : children}
        <footer className="rl-foot">
          <span>{note || '줄을 누르면 오른쪽에 카드가 열립니다. 체크는 My List.'}</span>
        </footer>
      </section>
    </div>
  )
}
