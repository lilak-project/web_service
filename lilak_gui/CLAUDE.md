# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**lilak_gui** — a web GUI for the existing **LILAK** analysis framework, delivered
as a LILAK Web Portal service.

**Built from scratch (2026-06-30), do NOT reuse `~/Research/lilak/ui/`.** The user
rejected that old UI's design. The new frontend runs on the kit's **`AppShell`**
(the shared default skeleton, promoted from `lilak_elog`'s chrome into `lilak_ui`),
with a purple main theme: top bar (two-line brand "라일락"/"gui" + command-mode-
dimming lilak mark + tabs + status/account), `/` command bar, `\` settings drawer,
`?` shortcuts modal. Tabs are 실행 / 파라미터 / 뷰어 / 설정 (placeholders); real
per-tab features get added incrementally. lilak_gui has no projects, so the brand
project chip is omitted by design. The existing UI is a *reference only* for what
LILAK exposes (`lilak par` parser, ROOT Range serving, `run_web` invocation).

**Stack:** `backend/` FastAPI (Python) + `frontend/` React/Vite + `lilak_ui` kit.
Portal-integrated and verified end-to-end: base-path (`api.js` prefixes
`window.__PORTAL_BASE__`), SSO (`backend/portal_auth.py`, python-jose, shared
secret, `/api/whoami`), LILAK via `$LILAK_PATH`; manifest runs `uvicorn main:app`
and `/p/lilak_gui/` works (auto-start → base injection → authenticated whoami).

**Build/run:** `cd frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm run build`.
Purple theme = a token override preset in `frontend/src/theme/purple.js` (same
mechanism as the kit's Teal preset). `public/` is the old, now-unused placeholder.

## START HERE

Read **[PLAN.md](PLAN.md)** first. Key facts:

- **Build fresh — do not reuse `~/Research/lilak/ui/`.** That UI (FastAPI :8110 +
  React/Vite/Tailwind/JSROOT, lilak-ui kit, 6 tabs) is a *reference only* for what
  LILAK exposes; the user rejected its design. The new build runs on the kit's
  `AppShell` (purple theme, tabs) — see "What this is" above.
- Locate LILAK via **`$LILAK_PATH`** (inject as `start.env.LILAK_PATH` in the manifest).
  LILAK runs via `bash -c 'source $LILAK_PATH/macros/command_lilak.sh && lilak run_web <config>'`.
- See memory `lilak-web-ui` for LILAK's interface details (the `lilak par` parser,
  ROOT HTTP-Range serving, run_web batch-mode gotcha) — useful when designing the
  new backend, independent of the old frontend.

## Portal facts

- Portal: `~/web_service/service_manager` (:8025). Rules: `SERVICE_CONTRACT.md` +
  `AI_SERVICE_GUIDE.md`.
- Registered at `~/web_service/data/lilak_gui/service.json` (single, managed,
  `accepts_portal_token: true`). Entered at `/p/lilak_gui/`. Currently a placeholder
  `http.server` on `public/` — replace `start` with the real backend (or switch to
  `mode=external` for a ROOT+LILAK container). Make the frontend base-path aware
  (Vite `base:'./'`, router basename, `window.__PORTAL_BASE__`).
- References: `~/web_service/asset_manager` (single SSO + base-path), and g4toy
  (`~/web_service/g4toy/PLAN.md`) for the heavy-compute / job-queue pattern.

## Layout

- `backend/` — FastAPI: `main.py` (`/api/health`, `/api/whoami`, serves
  `frontend/dist`), `config.py` (`$LILAK_PATH`), `portal_auth.py` (jose SSO).
- `frontend/` — React/Vite + `lilak_ui` kit. `src/App.jsx` = providers
  (Lang/Identity) → `src/components/Shell.jsx`, a **thin config of the kit's
  `AppShell`** (the shared default skeleton — top bar, `/` command bar, `\`
  settings drawer, `?` shortcuts, command-mode logo dimming, tab hotkeys). Shell
  only supplies brand/tabs/status/labels + the bright-only theme lock; AppShell
  provides its own command registry and the drawer's settings panel. `src/theme/
  purple.js` = purple preset + `ENABLED_THEMES` (bright only), `src/api.js` =
  base-path + SSO call chokepoint, `src/pages/` = tab bodies (placeholders for now),
  `src/i18n.js` = ko/en dicts. (The bespoke `SystemPanel.jsx` was dropped —
  AppShell's built-in drawer replaces it.)
- `public/` — old placeholder (unused now that the backend serves the build).
