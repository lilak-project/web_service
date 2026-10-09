# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**asset_manager2 is asset_manager's screen, being redesigned.** Same app, same
data model, same backend — a SECOND portal service so the redesign can go as far
as it needs to without touching the one people use. `asset_manager` is the
working service and stays phone-first; this one is where the RACK look is tried.

Two things keep them apart:

- **its own data** — `data/asset_manager2/projects/<project>/`, seeded by copying
  a project's `data.json`. Editing here never reaches the live list;
- **its own browser state** — every localStorage key is under `cens2.` (`NS` in
  `App.jsx`), because both services are served from the portal's origin and
  would otherwise share My List, photos and the rest.

When the design settles, the answer is to fold it back into asset_manager and
retire this — not to keep two copies of a 4,000-line App.jsx.

CENS Assets Tracker — a phone-first PWA for laboratory asset tracking (English/Korean). It is a fully client-side app: all runtime data lives in browser `localStorage` under `cens.*` keys. There is no live backend; ports 8040 / "Backend" are reserved for future API work.

## The app: LILAK UI React (`src-lilak/`)

The React/Vite app in `src-lilak/` is the ONLY frontend, delivered through the LILAK
portal. (There used to be a second, parallel vanilla PWA in `public/app.js` +
Firebase Hosting + a standalone Firebase login; it was removed — the portal is now
the single delivery path, and identity is the portal account.)

- React 19 + Vite. Root `index.html` → `src-lilak/main.jsx` → `App.jsx`. UI is built
  from the shared **`lilak-ui`** kit (`TopBar`, `Button`, `Card`, `DataTable`, `Icon`,
  theming/`applyPreset`, fonts).
- `lilak-ui` resolves via a Vite alias to a sibling checkout `../lilak_ui/src`
  (override with `LILAK_UI_PATH`). Source-distributed, not an npm package.
- `npm run build` → `dist/`. Vite copies `public/` into the build; `public/` now
  holds only shared assets (`seed-assets.js`, `hwpx-export.js`, `template.hwpx`,
  `icons/`, `manifest.webmanifest`), not a second app.

## One layout: the rack

There is no card list and no width switch — **this app is a rack list**, the
shape author_manager and reference_manager have:

- `RackFrame` is the screen: the nameplate (the service's own colour, out of the
  manifest, plus the way out), a strip of tabs (Assets · My List · Class ·
  History · 알림, and 스캔), the body, and one status line, which is where a
  notice lands;
- **every tab is a table**, and each one's right pane holds the card that was
  already written for that record — the rack shows those components, it does not
  reimplement them:
  - Assets → `AssetRack`, pane: `AssetRow`, or `NewAssetCard` while adding;
  - My List → `MyListTable`, pane: `AssetRow`; the list's name and location sit
    on one line and its twelve actions on another, as rack buttons driven by the
    same `rowTop`/`rowBottom`/`rowAdmin` arrays as before;
  - Class → `ClassRack` (Location | Type on the command line), pane: `ClassCard`,
    or `NewClassCard` while adding;
  - History → `HistoryRack`, pane: `HistoryCard`;
  - 알림 → `NoticeRack`, a table of what was said and when.

The forms those actions open (request, settings, the hide/delete questions) keep
their own shape: they are forms, not lists.

`index.html` sets `body class="rl-page"`, so rack.css's page rules apply — this
app IS one, unlike asset_manager which only borrowed the table.

A column leaves at the TABLE's width rather than the window's: with the card
open the table has half of it. Below about 430px the table scrolls sideways;
this service is meant for a desktop, and the phone-first one is asset_manager.

The manifest says `"open": "panel"` so the portal frames it rather than throwing
it into a window (the multi-project default).

## Commands

```sh
npm run lilak:dev          # dev server, 127.0.0.1:5140
npm run lilak:dev:lan      # 0.0.0.0 (phone on same LAN)
npm run build              # vite build -> dist/
```

There is no test suite, linter, or type checker configured.

**HTTPS matters:** camera QR scanning only works over HTTPS or `localhost`. For phone
testing use `npm run lilak:dev:lan`, then open `https://<LAN-IP>:5140` (Vite serves
http; for a device-camera test behind the portal, use the portal's HTTPS entry).

## Data model

- Each **project** is one asset list. Under the portal the project IS the portal
  project (`/pp/asset_manager/<project>/`). Project data is keyed
  `cens.project.<projectId>.<assets|records|myList>`; active id `cens.currentProjectId`.
- `public/seed-assets.js` (`window.CENS_SEED_ASSETS`) is legacy seed data from the
  Google Sheets "CENS Equipment" tab. The React app does not auto-seed portal
  projects from it (new projects start empty); kept as reference data.
- **Auth is the portal account (SSO)** — the portal forwards its JWT and the app
  reads identity from it (`portalUser()`). There is no standalone/Firebase login;
  opened outside the portal the app shows a "open via the portal" notice.

## Portal integration

This service is delivered through the **LILAK Service Manager portal**
(`~/web_service/service_manager`, port 8025) — the single delivery path. The portal
serves the built React app (`dist/`) as a *managed, multi-project* service.

### How the portal runs it

The portal registers services via a manifest; this service's seed manifest lives at `service_manager/deploy/seed/asset_manager/service.json`:

```json
{ "kind": "asset", "mode": "managed",
  "start": { "cmd": "python3 -m http.server {port} --bind 0.0.0.0", "cwd": ".../asset_manager/dist" },
  "identity": { "accepts_portal_token": true, "link_by": "email" },
  "capabilities": { "multi_project": true, "import_export": false } }
```

Implications when changing the app:
- The portal runs `start.cmd` = **`sh portal-serve.sh {port}`**, which **rebuilds (`npm run build`) and then static-serves `dist/`** on the assigned port (`0.0.0.0`). So a portal **stop & start picks up source changes automatically** — no manual build needed. The rebuild is non-fatal: if npm is missing or the build fails, it falls back to serving the existing `dist/`. (`service_manager/build-all.sh` also builds it for the Docker image, where the seed manifest still serves `dist/` directly without rebuilding.)
- The dev server (`npm run lilak:dev`, port 5140) shows changes live but does **not** touch `dist/`; only a build (or a portal restart) updates what the portal serves.
- **`multi_project: true`** — each portal project is its own asset list, reached at **`/pp/asset_manager/<project>/`**. The portal injects `PORTAL_PROJECT` / `PORTAL_PROJECT_DATA` per project and, in the browser, `window.__PORTAL_BASE__ = /pp/asset_manager/<project>`.
- **`accepts_portal_token: true` (SSO)** — the portal forwards the user's portal JWT; the app reads identity from it (there is no local login).

### What the app does with that

`window.__PORTAL_BASE__` is always present in normal use: the portal project becomes the asset list and the portal SSO token (`lilak_portal_token` / `elog_token`) becomes the identity. See `PORTAL_BASE` / `portalUser()` / `ensureProjectState()` in `App.jsx`. (Opened WITHOUT a portal base, the app shows a "open via the portal" notice — `NoPortalScreen`.)

To make assets resolve under both standalone (`/`) and proxied (`/pp/<name>/<project>/`) serving, the build relies on `vite base: './'` plus a default `<base href="/">` in `index.html` that the portal overrides by injecting an earlier `<base>` tag. Don't remove either without understanding the other. (Note: per the portal's SERVICE_CONTRACT, managed services are normally API-only precisely to avoid base-path breakage; this service is a static-UI exception that works *because* of this dual-base setup.)
