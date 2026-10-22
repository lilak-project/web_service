# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this directory is

`~/web_service/` is **not one project** — it is a co-located *stack* of separate
repos that together form the **LILAK Web Portal**. They sit side by side so they
can share a build/deploy context and the shared UI kit:

- **`service_manager/`** — the portal itself (FastAPI). Central accounts + a
  kind-agnostic service registry + reverse proxies + a React cover UI. Start here.
- **`lilak_elog/`** — the elog service, a managed multi-project app the portal
  *spawns and proxies* (its backend runs on the shared venv).
- **`asset_manager/`** — a managed multi-project static PWA service.
- **`lilak_ui/`** — the shared React component kit. **Source-aliased** (not npm
  published) by every frontend via Vite. Editing it affects all of them.
- **`data/`** — all runtime data, kept **outside** the code repos (see below).

Each sub-repo may have its own `CLAUDE.md`; this file is the cross-cutting map.

## Common commands

Run from `service_manager/`:

```bash
./build-all.sh      # shared .venv (portal + elog deps) + builds elog, portal, asset_manager frontends
./run.sh            # start the portal on :8025 (uvicorn --reload, watches only app/)
./stop.sh           # kill whatever listens on :8025
```

Build a single frontend (all of them alias the kit via `LILAK_UI_PATH`):

```bash
cd service_manager/frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm run build
```

Sanity-check the backend after edits (there is no test suite):

```bash
service_manager/.venv/bin/python -c "from app import main"
```

Docker deploy lives in `service_manager/deploy/` (multi-stage `Dockerfile`,
`docker-compose.yml` + `.dev.yml`, `stage.sh`, `make-mac-app.sh`).

**Before running the portal officially/publicly, read `service_manager/DEPLOYMENT.md`**
(bilingual KO/EN): how passwords + personal data are handled, and the env-var
hardening checklist (`PORTAL_SECRET_KEY`, `EMAIL_VERIFY_DEV_ECHO`,
`PORTAL_ALLOWED_ORIGINS`, TLS, …). The portal prints a `[SECURITY]` startup banner
naming any dev-only setting still active.

## Architecture (the parts that span files)

**The portal is generic over services via a manifest + adapters.** Each service is
described by `data/<name>/service.json` (kind, mode, capabilities, identity, start
recipe). `app/adapters/` turns that into behavior: `managed` = run as a subprocess,
`external` = forward to a remote URL+token. The portal core only knows the adapter
interface (status/start/stop/target_base/proxy_headers) — it has no per-service code.

**Two reverse proxies are the entry points:**
- `/p/<svc>/…` — a single service (proxy.py).
- `/pp/<svc>/<proj>/…` — one project of a multi-project service (project_mgmt.py).
Both auto-start the target on demand and **inject `<base href>` + `window.__PORTAL_BASE__`**
into proxied HTML. Any service frontend must therefore be base-path aware (Vite
`base:'./'`, `<base href="/">`, React Router `basename = window.__PORTAL_BASE__`).
See `service_manager/SERVICE_CONTRACT.md` (the rulebook) and `AI_SERVICE_GUIDE.md`
(intake questionnaire for adding a service).

**One shared venv runs the portal AND spawns service backends** (elog). That's why
`build-all.sh` installs both `requirements.txt` into one `service_manager/.venv`.

**Auth / SSO:** one JWT scheme (HS256) shared via `PORTAL_SECRET_KEY` (falls back to
`ELOG_SECRET_KEY`), so a portal token is trusted by managed backends. The proxy
forwards the user's JWT only to services with `identity.accepts_portal_token`. The
portal mints tokens carrying the account profile so a service can provision a local
user by email on entry.

**Cross-portal sync (`app/sync.py` + `routers/sync.py`).** A service can mirror the
same service on another server: the source is `main` (issues a URL + token), the copy
is `sub` (pulls, on demand or on a timer). Only files whose SHA-256 differs move, and
SQLite travels as a backup-API snapshot. A sub is served read-only (the proxy refuses
non-GET), because the next pull overwrites local edits — unless it is two-way (rack
services and note only, main must `accept_push`): then the sub also pushes, and
`app/sync_merge.py` merges a file changed on both sides against the last agreed copy.
The rack store (`lilak_portal_auth/store.py`) keeps one file per record and adopts
records a sync changed underneath it. Accounts never sync — main's
grants are copied onto matching local accounts only when an admin asks. See
`DEPLOYMENT.md` §9. Pairing is a handshake: a sub asks by address, main's admin
approves (matching a pin) and the token is collected once — see
`service_manager/HANDSHAKE.md`, the one convention for every first contact
(elog ↔ device services, service → portal registration, portal ↔ portal).

**Permissions are per-project.** `ServicePermission.project` (`""` = whole-service
grant covering all projects). Helpers in `app/permissions.py`. Invite codes
(`InviteCode`) let users self-grant. Email verification expires yearly
(`email_verified_at`, `VERIFY_VALID_DAYS`) → stale accounts go view-only until they
re-verify. Because a top-level navigation carries no `Authorization` header, the
proxies read the JWT from the **`lilak_portal_token` cookie** set by the frontend.

**The cover UI is the portal's OWN frontend** (`service_manager/frontend/`),
depending on `lilak_ui` only — not on elog. `ProjectsPage.jsx` holds the session
and the card list; `portal/SidebarPortal.jsx` is the one cover (a sidebar of
service cards beside a panel that frames the chosen service). The classic card
grid and its layout/size switches were removed. The portal also serves this
build; the elog/asset frontends are served by their own backends through the proxy.

## Conventions & gotchas

- **Data lives outside the repos** at `~/web_service/data/` (config default
  `ROOT.parent/data`, override `PORTAL_DATA_ROOT`): `_portal/portal.db` (accounts +
  permissions + service registry) and `<service>/` (manifest + that service's data,
  e.g. `data/elog/projects/<exp>/`). Moving the install = copy the repos + this folder.
- **`run.sh` watches only `app/`** (`uvicorn --reload --reload-dir app`) on purpose —
  building frontends or the venv writes thousands of files that would otherwise crash
  the reloader.
- The repos are independent; `~/web_service/` is the assembly point, not a monorepo.
  A managed service's manifest `start.cwd` is an **absolute host path**; hand-cloned
  services need it fixed up per machine (e.g. elog → `lilak_elog/backend`), while the
  Service Manager re-roots it automatically on install.
- **First run sets up the `admin` superuser**: a portal with zero accounts asks for
  its password instead of offering sign-up (`/api/auth/setup`, gated on the user
  count; `needs_setup` rides along on `/api/health`). Later signups are ordinary
  users.
- **Type is decided in one place:** `lilak_ui/src/fonts/fonts.css` — the font files
  (NanumSquare Neo, IBM Plex Sans, D2 coding, kept in the kit, no CDN), `--font-sans` /
  `--font-mono`, and the `--fs-*` size scale (+ `--fs-plate` 15px, RACK's nameplate rank,
  which rack lists use as `--rk-fs`). Use the variables, not px numbers.
- **Every UI string goes through a dictionary** (kit `i18n.jsx`, elog's `t()` model):
  each module registers `{ ko, en }` with `addStrings` (portal `src/i18n/`, rack kit
  `racklist/i18n/` + `strings.js`, each rack service `src-lilak/i18n/` + `strings.js`,
  imported first by every file that shows text) and calls `tr('key', …args)` anywhere,
  `trx()` when the sentence holds markup. One choice (`lilak-ui-lang`) covers the portal
  and every service on the origin; a rack service reloads when it changes. The choice is
  the account's (Settings → My account), applied on sign-in.
- **Per-account settings live on the account** (`users.preferences_json`, `app/prefs.py`):
  `lang`, and `entry` — the project a multi-project service's card opens straight away
  ("open directly"; each account's own, falling back to the manifest's `entry_project`). Adding a
  language = one dictionary file per module. Stored values stay as stored (activity
  kinds are Korean in the data and translated only for display).
- Adding a service = write `data/<name>/service.json` + a `Service` DB row (via the
  admin Services UI, the `/api/handshake` self-registration, or directly). Set
  `capabilities.multi_project` for elog-style services.
