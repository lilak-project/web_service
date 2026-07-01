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
- **`scattering_simulation_2d/`** — a single static service (Vite + vanilla TS), a
  Monte Carlo 2D scattering sim; build to `dist/`, served statically.
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

**Permissions are per-project.** `ServicePermission.project` (`""` = whole-service
grant covering all projects). Helpers in `app/permissions.py`. Invite codes
(`InviteCode`) let users self-grant. Email verification expires yearly
(`email_verified_at`, `VERIFY_VALID_DAYS`) → stale accounts go view-only until they
re-verify. Because a top-level navigation carries no `Authorization` header, the
proxies read the JWT from the **`lilak_portal_token` cookie** set by the frontend.

**The cover UI is the portal's OWN frontend** (`service_manager/frontend/`),
depending on `lilak_ui` only — not on elog. `ProjectsPage.jsx` is a single page with
a `view` switcher (home / account / services / guide) and inline expanding service
boxes (no modals). The portal also serves this build; the elog/asset frontends are
served by their own backends through the proxy.

## Conventions & gotchas

- **Data lives outside the repos** at `~/web_service/data/` (config default
  `ROOT.parent/data`, override `PORTAL_DATA_ROOT`): `_portal/portal.db` (accounts +
  permissions + service registry) and `<service>/` (manifest + that service's data,
  e.g. `data/elog/projects/<exp>/`). Moving the install = copy the repos + this folder.
- **`run.sh` watches only `app/`** (`uvicorn --reload --reload-dir app`) on purpose —
  building frontends or the venv writes thousands of files that would otherwise crash
  the reloader.
- The repos are independent; `~/web_service/` is the assembly point, not a monorepo.
  A managed service's manifest `start.cwd` is an **absolute host path** that must be
  fixed up per machine (e.g. elog → `lilak_elog/backend`).
- **First signup becomes the admin** (`role = "manager"`).
- Adding a service = write `data/<name>/service.json` + a `Service` DB row (via the
  admin Services UI, the `/api/handshake` self-registration, or directly). Set
  `capabilities.multi_project` for elog-style services.
