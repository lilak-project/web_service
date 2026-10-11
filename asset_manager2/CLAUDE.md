# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**asset_manager2 is the asset list as a RACK service** — the shape
author_manager and reference_manager have, built from the same parts. It was
started from nothing on purpose: asset_manager is the phone-first app people
use, and dragging its screen towards a table mixed two designs in one place.
This one is the table.

Two tabs, both tables:

- **assets** — every asset. Right-click a row to edit it, photos included.
- **lists** — every list. A list is a RECORD in the data (what the old app
  saved from My List), so History and My List are the same thing here: you tick
  assets, press 리스트 만들기, and the list opens for the rest.
  Pressing a list opens a tab of its own — its assets, in the order the list
  holds them, with the same columns as the assets table and 리스트 편집 on the
  command line. Right-pressing it goes straight to that editor.

There is no My List: a working set you had to fill before you could act on it
was a second selection beside the checkboxes. The checkboxes make the list.

Not here (yet): classes as records, QR scanning, HWPX/XLSX export, the request
form's applicant fields.

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
in the same pane. The pane, its tabs and columns, the split, the action bar and
the filter are the kit's (`useEditorPanes`, `RackPaneStrip`, `usePaneSplit`,
`RackActions`, `useFacetFilter`), so this service behaves like the others
because it IS the same code. A location and a type are offered from what the
other assets already use — they are words, not records.

**Photos** are two slots on the asset, `photo2` (sticker) and `photo1` (whole),
the names the old app wrote. A picked file is shrunk to 1280px / jpeg 0.82
before it goes in: the document is sent whole on every save, so a 4MB phone
photo would be paid for on every keystroke after it.

**A list's own tab carries its actions in a drawer** under the rows, the way
author_manager's 나열 panel does (`.rl-out` / `.rl-outhead`, the kit's classes):
its name, type and destination on one line, the actions on the next. The editor
pane has the same actions because both call `useListOps` — one set of
operations, two places to reach them. `CHECKLIST.md` is what is still missing
from asset_manager.

**A list's editor** is what My List could do, done to a list that exists: its
name, type and the place its assets are going; 위치 적용 writes that place onto
every asset in it and stamps the list; 선택한 자산 담기 adds what is ticked in
the table; an asset row presses through to its own editor, × takes it out. A
manager also gets 숨김 · 숨김 해제; someone who is not one asks with 승인 요청
and the list waits. delete removes the LIST — the assets stay.

**An asset is deleted in its own editor and nowhere else.** A list points at
assets; pointing at them is not owning them, and one press on a list of a
thousand used to take all thousand with it — permanently, since the backend
keeps no older copy. The lists tab ticks like the assets tab (shift for a
range) and 리스트 삭제 throws away the ticked LISTS, asking once first.

## Data

One document per portal project, served by `backend/main.py` at `/api/data`:
`{version, assets, records, locations, types, settings}`. A PUT sends the
`baseVersion` it edited; if someone saved first it comes back 409 and the
client reloads rather than overwriting them. This app writes `assets` and `records`.

`data/asset_manager2/projects/<project>/data.json` — its own data dir, seeded
by copying a project's file from asset_manager. Beside it the backend keeps
what it is about to replace: `data.prev.json` (the step back, every save) and
`backups/data-<date>.json` (the first save of each day, 30 kept). To restore
one, stop the service and move the file over `data.json`. Nothing here touches the live
list.

Per-user browser state, if any is added, goes under `am2.` — both services are
served from the portal's origin.

## Commands

```sh
LILAK_UI_PATH=~/web_service/lilak_ui npm run build    # → dist/
npm run lilak:dev                                     # 127.0.0.1:5143
```

The portal runs `portal-serve.sh`, which rebuilds and then serves `dist/`, so a
stop & start in manage mode picks up source changes. The backend serves
`index.html` with `Cache-Control: no-store` — every build renames the hashed
bundle, and a browser holding yesterday's index asks for a file that is no
longer there and shows a blank page. The manifest
(`data/asset_manager2/service.json`) says `"open": "panel"`.

`public/sw.js` is a **kill switch, not a PWA worker**. This service began as a
copy of asset_manager, which registers `sw.js`; whoever opened it then still had
that worker in scope `/pp/asset_manager2/<project>/` serving the app from its
cache, so they kept running that day's bundle no matter what was rebuilt — and
the SPA fallback answered `sw.js` with index.html, which cannot install as a
module, so the old worker could never be replaced. The file empties the caches,
unregisters itself and re-navigates the tab. Keep it.
