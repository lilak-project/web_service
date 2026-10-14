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
  saved from My List): tick assets and pick **리스트에 넣기… → + 새 리스트** (or an
  existing list), and the new list opens as a tab of its own — its assets, in
  the order the list holds them, with 리스트 편집 and 리스트에서 빼기 on the
  command line. Right-pressing a list on the lists tab opens its editor.

There is no My List: a working set you had to fill before you could act on it
was a second selection beside the checkboxes. The checkboxes make the list.

Not here (yet): classes as records, QR scanning, HWPX/XLSX export, the request
form's applicant fields.

## The app

The service is a DECLARATION on the kit's `<RackService>`
(`lilak-ui/racklist`), the same as author_manager, reference_manager and
academic_activities:

- `src-lilak/def.jsx` — the fields (what the table shows and the editor
  edits), the lists class (`records`, `list: { ids: 'assetIds', owner: 'user' }`)
  and `ListActions` — what a list does beyond being saved;
- `src-lilak/main.jsx` — `<RackService def={def} />`, nothing else;
- the table, tabs, selection, column widths, ⌘F, filters, the editors, 선택
  편집 (editing many at once — 위치 and Type), the lists, the photo fields and
  the version-guarded document are all the kit's, so a fix there is a fix here.

Assets are known by their 자산번호 (`item.id: 'assetId'`) — they carry no
other id, and lists hold 자산번호s.

**Photos** are two `image` fields, `photo2` (sticker) and `photo1` (whole),
the names the old app wrote. A picked file is shrunk to 1280px / jpeg 0.82
before it goes in: the document is sent whole on every save, so a 4MB phone
photo would be paid for on every keystroke after it.

**A list's editor**: its name, type and the place its assets are going, and
its assets (each opens its own editor; × takes it out). On its bar, 위치 적용
writes that place onto every asset in it and stamps the list; a manager also
gets 숨김 · 숨김 해제 and 승인 for a waiting list; someone who is not one asks
with 승인 요청 and the list waits. delete removes the LIST — the assets stay,
and only its maker or a manager may delete it.

**An asset is deleted in its own editor (or a manager's 선택 편집) and nowhere
else.** A list points at assets; pointing at them is not owning them. Deleting
an asset takes it out of every list.

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
