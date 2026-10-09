# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**asset_manager2 is the asset list as a RACK service** — the shape
author_manager and reference_manager have, built from the same parts. It was
started from nothing on purpose: asset_manager is the phone-first app people
use, and dragging its screen towards a table mixed two designs in one place.
This one is the table.

Right now it is one tab, `assets`: the list, and the editor that opens in the
pane beside it when you right-click a row. Anything else the old app does
(My List, classes, history, photos, QR, requests) is NOT here yet — it comes
back a screen at a time, drawn as a rack, or not at all.

## The app

`src-lilak/App.jsx`, about 400 lines, is the whole frontend:

- the table, the tab strips, the selection, column widths, ⌘F, the remembered
  view state and the portal's version-guarded document are the kit's
  `lilak-ui/racklist` — the same parts the other two list services use;
- what is here is what makes it about ASSETS: `COLS` (the columns), `SORTERS`
  (what each one sorts by), `FIELDS` (what the editor shows), and `EditAsset`;
- `index.html` sets `body class="rl-page"`, so rack.css's page rules apply;
- the nameplate wears this service's own colour, which the portal injects
  (`__PORTAL_SERVICE__` → `brandStyle()`).

Editing: right-click a row → a tab in the editor pane; `+ 새 자산` opens a draft
in the same pane; save closes the tab, delete asks once in place and is a
manager's call. A location and a type are offered from what the other assets
already use — they are words, not records.

## Data

One document per portal project, served by `backend/main.py` at `/api/data`:
`{version, assets, records, locations, types, settings}`. A PUT sends the
`baseVersion` it edited; if someone saved first it comes back 409 and the
client reloads rather than overwriting them. This app writes `assets` only.

`data/asset_manager2/projects/<project>/data.json` — its own data dir, seeded
by copying a project's file from asset_manager. Nothing here touches the live
list.

Per-user browser state, if any is added, goes under `am2.` — both services are
served from the portal's origin.

## Commands

```sh
LILAK_UI_PATH=~/web_service/lilak_ui npm run build    # → dist/
npm run lilak:dev                                     # 127.0.0.1:5143
```

The portal runs `portal-serve.sh`, which rebuilds and then serves `dist/`, so a
stop & start in manage mode picks up source changes. The manifest
(`data/asset_manager2/service.json`) says `"open": "panel"`.
