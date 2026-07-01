# Service Contract

How a service plugs into the LILAK Service Manager portal: what it must provide,
the rules it must follow, and how it connects. This is the standard the launcher
and adapters enforce — keep it and your service "just works" in the portal.

---

## 1. A service has a connection mode

| mode | who runs it | the portal owns |
|------|-------------|-----------------|
| **managed** | the portal, as a child process on this host | lifecycle + port + data |
| **external** | something else, on another host/process | only the registry entry (visibility / permission / proxy) |

Everything else in this document is split by what each mode must satisfy.

---

## 2. The manifest is the contract — `data/<name>/service.json`

| field | managed | external | meaning |
|-------|:--:|:--:|---------|
| `kind` | ✓ | ✓ | type label → list badge / icon / per-kind defaults |
| `mode` | ✓ | ✓ | `managed` \| `external` |
| `start` `{cmd, cwd, env}` | ✓ | — | how the portal boots it |
| `health` | ✓ | ✓ | health path (GET, no auth, `<500` when ready) |
| `entry` | ✓ | ✓ | path a user lands on when entering |
| `url` | — | ✓ | where the service lives |
| `token` | — | ✓ | bearer the portal attaches (service-to-service auth) |
| `identity` `{accepts_portal_token, link_by}` | ✓ | ✓ | how the user identity is carried in (§7) |
| `capabilities` `{multi_project, import_export}` | optional | optional | declared capabilities (§3.5) |
| `icon`, `color` | optional | optional | cosmetic; travel with the data |

Missing keys are filled from `registry.KIND_DEFAULTS[kind]` on read, so an empty
service dir + a `kind` is enough for a managed service of a known kind.

---

## 3. Managed services are API-only

**Rule.** A managed service is a **backend/API cell**. The portal owns the user
interface; the service exposes stable HTTP API paths, not a UI.

Why: a managed service is reached at `<portal>/p/<name>/…` (§6). A service that
served its own HTML/assets from `/` would have its links/assets break under that
prefix. Keeping cells API-only removes the whole base-path problem. (This is the
elog lesson — its UI assumed the site root, so only the portal-owned cover worked
through the proxy.)

> A service that genuinely must ship its own UI should run as **external** and own
> its own routing/base path, then be registered by URL (§8).

---

## 3.5 Multi-project services (model A)

A service with `capabilities.multi_project` is a **template**: the portal manages
the **projects** under it (creating, listing, running, deleting them). Each project
runs as its own instance — `data/<service>/projects/<project>/` data dir + its own
port — reusing the service's `start` recipe.

**Rule.** The `start.cmd` is run per project with substitutions and env:

- `{project}` / `{port}` are substituted into the command;
- the portal exports `PORT`, `PORTAL_PROJECT` (the project name), and
  `PORTAL_PROJECT_DATA` (its data dir), plus the usual `PORTAL_SERVICE`/… ;
- `start.cwd` defaults to the **project** dir (so a self-contained server serves
  that project) or the recipe's own cwd (for a backend selected by
  `$PORTAL_PROJECT`, e.g. elog's `ELOG_EXPERIMENT`).

A project is reached at **`/pp/<service>/<project>/…`** (separate from the
single-service `/p/<name>/…`). With `capabilities.import_export`, each project is
exportable/importable as a zip (`data/<service>/projects/<project>/`, minus
`.port`). Single-service (non-multi) services ignore all of this.

## 4. Network & port (managed)

**Rule.** The portal assigns a free port from its window
(`SERVICE_PORT_START..END`) and tells the service which one. The service **must
bind `0.0.0.0:$PORT`**.

The port is handed over **kind-agnostically** — any program works, not just
uvicorn. The portal always exports `PORT` (and `PORTAL_SERVICE_PORT`) in the
environment, and the `start.cmd` consumes it one of three ways:

| `start.cmd` form | how the port is passed |
|------------------|------------------------|
| contains `{port}` | substituted into the command, run verbatim — e.g. `"my-server --listen {port}"` |
| bare `uvicorn …` | run as `python -m uvicorn …` with `--host 0.0.0.0 --port <port>` appended |
| anything else | run verbatim; the program reads `$PORT` |

So a non-uvicorn service just reads `$PORT` (or uses `{port}`); the contract is
the same: *bind the port the portal gives you.* The chosen port is tracked in
`data/<name>/.port` (runtime-only).

---

## 5. Lifecycle (managed)

**Rule.** The service must be:

- **start-able** by running `start.cmd` in `start.cwd` with the portal's env
  merged over `start.env` — non-interactive, no prompts;
- **stop-able** by signal — the portal sends `SIGTERM`, waits, then `SIGKILL`s
  whatever still holds the port (the listening port is the source of truth for
  "running");
- **ready fast** — it must pass its `health` check within the startup window
  (~8s) or the start is considered failed.

The portal injects these env vars at start: `PORTAL_SERVICE` (the name),
`PORTAL_DATA_ROOT`, `PORTAL_PORT`, plus anything in `start.env`.

---

## 6. Entry & proxy (both modes)

**Rule.** A service is always reached through the portal's stable reverse proxy:

```
<portal>/p/<name>/<path>   →   <service>/<path>
```

The portal strips `/p/<name>`, so the service sees `/<path>`. This is the single
stable entry point: a managed service's internal port can change and an external
service can move hosts without anything that saved
`http(s)://<portal>/p/<name>` breaking. The portal forwards method, query, body,
and `content-type`/`accept`; the auth header depends on §7.

`entry` is where "Enter" sends the user (default `/`).

---

## 7. Identity & auth (both modes)

The portal has central accounts and mints a portal **JWT** (HS256, signed with the
shared `PORTAL_SECRET_KEY`) carrying `sub, username, role/prole, email, name, …`.
How that identity reaches a service is **the service's choice**, declared in
`identity.accepts_portal_token`:

- **`accepts_portal_token: true` — SSO.** The portal forwards the caller's portal
  JWT as the `Authorization` header. The service **must validate it with the same
  `PORTAL_SECRET_KEY`** and link/provision a local principal by `identity.link_by`
  (default `email`). Managed cells default to this (same host, same secret).
- **`accepts_portal_token: false` — service token.** The portal does **not**
  forward the user's token; instead it attaches the registered service `token`
  (external) or no auth. The service authenticates the portal, not the end user,
  and does its own user handling (or needs none). This is the common case for
  external services that don't require per-user login.

**Security rules.** Managed cells on a host share `PORTAL_SECRET_KEY` (set it via
env, never commit it). Rotate by env. Use a strong password hash (bcrypt/argon2)
in production — swap `app/security.hash_password` only. Give each external service
its own scoped `token`.

---

## 8. Registration & extension

**Visibility & permission** (orthogonal to the manifest) live in the portal DB:
tier 1 private / 2 protected / 3 admin, plus per-account grants and access
requests. Every registered service gets a row (default tier 2).

**Registering a managed service:** create it from the cover ("New", with a kind)
or import an exported `.zip`/a hand-written `data/<name>/` dir. The portal assigns
a port on first start.

**Registering an external service:** an admin provides `{name, kind, url, token?,
health?, entry?, accepts_portal_token?}`; the portal writes an `external`
manifest and a DB row. A connection test probes `url + health` (with the token)
before saving.

**Adding a new kind:** add a `registry.KIND_DEFAULTS[kind]` entry (start / health /
entry / identity defaults) — no launcher change.

**Adding a new mode:** implement an `Adapter`
(`status / start / stop / target_base / proxy_headers`) and register it in
`app/adapters/__init__.py`. The launcher only knows the Adapter interface.

---

## 9. Data & portability (managed)

**Rule.** All service state lives under `data/<name>/`, with **no absolute
paths**. `.port` is runtime-only and never exported. A service is therefore
movable as one unit:

- **export** = a `.zip` of `data/<name>/` minus `.port`;
- **import** = unzip into a new name;
- **backup/migrate** the whole portal = copy `data/` + `data/_portal/portal.db`.
