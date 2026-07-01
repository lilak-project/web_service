# LILAK Service Manager

A standalone, service-agnostic generalization of the LILAK portal (origin:
`~/ai_projects/lilak_elog` launcher). One central account system gates and proxies
**any** kind of service — `managed` (a local subprocess the portal runs) or
`external` (a service running on another host) — behind a single entry point.

This is the Phase A build of `PORTAL_PLAN.md`: the elog-specific assumptions
(ports, `uvicorn main:app`, `/api/auth/*`) are now **per-service manifests + kind
adapters**, so a new service type plugs in without touching the launcher.

## Run

```bash
./run.sh                 # → http://localhost:8025  (reuses the lilak_elog venv)
./stop.sh
```

Override with env: `PORTAL_PORT`, `PORTAL_DATA_ROOT`, `PORTAL_PYTHON`,
`SERVICE_PORT_START/END`, `PORTAL_BASE_URL`, `PORTAL_REGISTER_TOKEN`, and
`PORTAL_SECRET_KEY` (falls back to `ELOG_SECRET_KEY` — **must match** a managed
service's secret for token trust).

**Data lives OUTSIDE the repo** — default `PORTAL_DATA_ROOT` is the sibling
`../data` (i.e. `web_service/data/`), so code and data stay separate. The single
backup/move unit is that whole folder (`_portal/portal.db` = accounts + registry;
`<service>/` = each service's manifest + its data). Point `PORTAL_DATA_ROOT` at a
dedicated/large volume in production. Managed-service data lands here; `external`
services keep their own data on their own host.

The **first account to sign up becomes the admin** (`manager`); everyone after is
a normal `user`. Reset everything by deleting `<data-root>/_portal/portal.db`.

**The service contract** (how a service plugs in: required functions, rules,
connection) is specified in [SERVICE_CONTRACT.md](SERVICE_CONTRACT.md). To have an
**AI build/adapt a service** for the portal, give it
[AI_SERVICE_GUIDE.md](AI_SERVICE_GUIDE.md) — an intake questionnaire (login/SSO,
single vs multi-project, security/visibility, managed vs external, UI ownership …)
that maps human answers to a manifest + registration plan.

## Build & move to another server

Three repos stay **separate but coupled**: this portal, `lilak_elog` (a service
the portal runs), and `lilak_ui` (the shared kit both frontends source-alias).
Build them together with one script:

```bash
./build-all.sh          # shared venv (portal + elog deps) + both frontends
# locations are env-overridable:
LILAK_UI_DIR=/path/lilak_ui LILAK_ELOG_DIR=/path/lilak_elog ./build-all.sh
```

It creates `./.venv` (used by `run.sh` automatically) and builds each frontend's
`dist` (the portal serves its own; the elog backend serves elog's). The kit path
is passed as `LILAK_UI_PATH` so the layout is portable.

To move to another host: copy the three source repos (any layout — point
`LILAK_UI_DIR`/`LILAK_ELOG_DIR` at them), copy the **data folder**
(`PORTAL_DATA_ROOT`) which is the state, run `./build-all.sh`, then `./run.sh`.
The elog service manifest's `start.cwd` must point at that host's elog `backend/`.

**Docker:** [`deploy/`](deploy/README.md) bakes all three repos into one image
(code + pre-registered services) with the live data on a persistent volume —
`STACK_DIR=… docker compose -f deploy/docker-compose.yml up -d --build` (run
`deploy/stage.sh` first on a split checkout). A dev override bind-mounts the
source for backend hot-reload.

## Architecture

```
app/
  config.py        env-driven settings (ports, data root, secret)
  security.py      password hashing + JWT  (elog-compatible: same HS256 + claims)
  models.py        User (superset of an elog user) + Service/Permission/AccessRequest
  db.py            single SQLite portal DB under data/_portal/
  schemas.py       auth request/response shapes (mirror elog's)
  deps.py          require_portal_user / require_portal_admin + token minting
  registry.py      service.json manifest discovery (kind defaults layered on read)
  adapters/        the kind/mode contract — launcher knows ONLY this interface
    base.py          Adapter: status/start/stop/target_base/proxy_headers
    managed.py       subprocess lifecycle (port window + data/<name>/.port)
    external.py      remote URL + bearer token; health-probe only
  routers/
    auth.py          /api/auth/*           central accounts
    services.py      /api/services, /api/access-requests, /api/admin/*  (visibility + perms)
    projects.py      /api/projects*        lifecycle (create/start/stop/delete/export/import)
    proxy.py         /p/{name}/...         stable reverse-proxy entry point
  main.py          assembles the app; serves the React cover (see below)
  static/index.html  fallback minimal cover (used only if no React build found)
frontend/          its OWN React app — depends on lilak_ui ONLY, not lilak_elog
  src/pages/ProjectsPage.jsx + portal/AdminPanel.jsx   the cover (forked once)
  src/api.js  context/LangContext.jsx  i18n/  index.css(tokens)              minimal glue
  vite.config.js   alias lilak-ui → ../../lilak_ui/src; proxies to the backend
data/
  <name>/service.json   per-service manifest (see registry.py for the schema)
  _portal/portal.db     accounts + registry + permissions
```

### Service manifest (`data/<name>/service.json`)

```jsonc
{
  "kind":   "elog",                 // adapter family / list badge
  "mode":   "managed",              // managed (subprocess) | external (remote URL)
  "start":  { "cmd": "uvicorn main:app", "cwd": null, "env": {} },  // managed
  "health": "/api/projects",
  "entry":  "/",
  "url":    null,                   // external: where the service lives
  "token":  null,                   // external: bearer attached on proxy
  "identity": { "accepts_portal_token": true, "link_by": "email" }
}
```

Missing keys are filled from `registry.KIND_DEFAULTS[kind]` on read, so an empty
service dir + `kind` is enough.

### Cover UI — own frontend, lilak_ui-only

`frontend/` is the portal's **own** Vite app. Its only external app dependency is
the **lilak_ui kit** (Vite alias `lilak-ui` → `../../lilak_ui/src`) — it does NOT
depend on lilak_elog. It contains just the portal cover: `ProjectsPage` +
`AdminPanel` (forked once from elog), a minimal `api.js` (the launcher axios), a
small `LangContext`/i18n, and the kit's token CSS. Routing is deliberately only
`/` and `/projects` → the cover, so there is no elog workspace to mount (that was
the source of the earlier `Home` crash).

```bash
cd frontend && npm install && npm run build      # → frontend/dist
npm run dev                                       # dev server, proxies to :8025
```

The backend serves `config.FRONTEND_DIST` (default `frontend/dist`; override with
`PORTAL_FRONTEND_DIST`), falling back to the bundled `app/static/index.html` if no
build exists. The cover calls `/launcher/api/*` (prefix stripped in `main.py`),
all implemented here.

### Signup + email verification (local stub)

`POST /api/auth/register` requires a unique `username` + `email` + `password`.
The **first** account becomes `manager` (admin); the rest are `user`.

Email verification is a **pluggable stub**: a new signup is created *unverified*
with a one-time `verify_token`, and login is blocked (403) until the address is
confirmed. The "deliver the link" step is the only part to swap for production:

- **dev** (`EMAIL_VERIFY_DEV_ECHO=1`, default): register returns `verify_url` and
  logs it — no email provider needed. `GET /api/auth/verify?token=…` confirms.
- **prod**: hand `email` + `url` to Firebase / an email sender in `register()`
  and turn the echo off. Gating logic + the verify endpoint stay the same.
- `EMAIL_VERIFY_REQUIRED=0` disables the gate entirely (register logs in directly).

### Visibility tiers (per service, in the portal DB)

| tier | name | who sees | who enters |
|------|------|----------|------------|
| 1 | private | permitted only | permitted |
| 2 | protected *(default)* | everyone | permitted; others can **request** |
| 3 | admin | admins only | admins |

Admins (`manager`) see and enter everything.

## Verified (smoke test)

register→first=admin · service create writes manifest · vis-2 gating
(`can_request` vs `can_enter`) · access-request → admin approve → `can_enter`
flips · external adapter health probe · `/p/<name>` proxy forwards to the target.

## Next steps (from PORTAL_PLAN.md)

- **Entry handoff**: "Enter" hands the portal token to a managed elog service and
  loads it through `/p/<name>/...`. Wire up + verify against a real managed elog.
- ~~**Phase B**: register external services (URL + token).~~ **Done** — admin
  endpoints `POST /api/admin/external-services[/test]`, `DELETE
  /api/admin/services/{name}`, and an AdminPanel form (test connection +
  register, with per-service SSO toggle).
- **Phase C**: systemd/container deploy, HTTPS + reverse proxy, bcrypt, scoped
  external tokens.
- elog import linking by email lives in *each elog service*, not here (unchanged).
```
