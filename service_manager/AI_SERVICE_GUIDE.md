# AI Service Integration Guide

A manual for an **AI agent** that is building (or adapting) a web service to plug
into the **LILAK Service Manager** portal.

This guide sits on top of [SERVICE_CONTRACT.md](SERVICE_CONTRACT.md): the contract
is the *formal spec*; this guide is the *intake process* — a short set of decisive
questions to ask the human, and a mapping from their answers to concrete
manifest + registration decisions.

> **How to use this guide (AI):**
> 1. Read this guide **and** `SERVICE_CONTRACT.md`.
> 2. Ask the human the **Intake Questions** below — *ask in the human's language*,
>    one block at a time, and stop to get answers. Do not assume defaults for the
>    starred (★) questions.
> 3. Map the answers with the **Decision → Config** table into a service descriptor.
> 4. Implement the service so it passes the **Definition of Done** checklist.
> 5. **Register it with one handshake** (§0): write a small handshake script into
>    the service that POSTs its descriptor to the portal. The human only sets the
>    **portal URL + registration token** — no long admin form.

---

## 0. One-step registration — the handshake

Instead of an admin filling a long form, a service **registers itself**: it POSTs
its descriptor to the portal once. Write this into the service (a `register.py`,
an entry in its start script, or a startup hook). The human configures only
`PORTAL_URL` + `PORTAL_REGISTER_TOKEN` (shown in the portal's **Services** screen).

```python
# register_with_portal.py — run once (or on startup). Self-registers this service.
import os, json, urllib.request

PORTAL = os.environ["PORTAL_URL"].rstrip("/")          # e.g. http://lab-host:8025
TOKEN  = os.environ["PORTAL_REGISTER_TOKEN"]           # from the portal Services screen

descriptor = {
    "name": "myservice",            # slug [A-Za-z0-9_-]
    "kind": "dashboard",            # type label
    "mode": "external",             # this service runs itself → external
    "url":  os.environ["SELF_URL"], # this service's reachable URL (what the portal proxies to)
    "health": "/health",            # GET, no auth, <500 when ready
    "entry": "/",
    # ↓ the intake answers, as flags:
    "accepts_portal_token": True,   # Q1: log users in via portal SSO?
    "multi_project": False,         # Q2: hosts multiple projects?
    "import_export": False,         # Q8: per-project zip import/export?
}

req = urllib.request.Request(
    f"{PORTAL}/api/handshake",
    data=json.dumps(descriptor).encode(),
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    method="POST",
)
print(urllib.request.urlopen(req).read().decode())
```

…or a one-liner:

```bash
curl -X POST "$PORTAL_URL/api/handshake" \
  -H "Authorization: Bearer $PORTAL_REGISTER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"myservice","kind":"dashboard","mode":"external","url":"'"$SELF_URL"'","health":"/health","accepts_portal_token":true}'
```

The handshake is **idempotent** — running it again updates the registration (new
URL, new capabilities). The portal replies with the entry link
(`<portal>/p/<name>/`). The descriptor fields are exactly the intake answers
below; the long manual form (Services screen) stays as a fallback.

> Managed services (the portal runs them) are still registered by an admin on the
> Services screen — handshake is for services that run themselves (external).

---

## Intake Questions

Ask these before writing any code. Each answer pins down a contract decision.

### ★ Q1 — Login & identity
**"Does this service require users to log in?"**
(이 서비스는 사용자 로그인이 필요한가요? 필요하면 포털 계정과 연동합니다.)

- **No login** → the portal forwards no user identity. Set
  `identity.accepts_portal_token = false`. The portal authenticates *to* the
  service with a service token (external) or nothing (managed).
- **Yes, integrate with portal accounts (SSO)** → set
  `identity.accepts_portal_token = true`. The portal forwards the caller's portal
  **JWT** as `Authorization: Bearer …`. The service **must**:
  - validate the JWT with `HS256` and the shared `PORTAL_SECRET_KEY`;
  - trust its claims (`sub`, `username`, `role`/`prole`, `email`, `name`);
  - **link/provision a local user by `identity.link_by`** (default `email`) — link
    to an existing local user with the same email, else auto-create one.
  - *Follow-up:* does the service need the portal **role** (`manager` vs `user`)
    for its own authorization? If yes, map `manager → service admin`.

### ★ Q2 — Single service or multi-project
**"Is this ONE web service, or does it create/host multiple projects (like LILAK
elog creates experiments)?"**
(단일 웹서비스인가요, 아니면 LILAK elog처럼 여러 프로젝트를 만드는 서비스인가요?)

- **Single** → one service: one manifest, one entry, one registry row.
- **Multi-project** → *who owns the projects?*
  - **(A) Portal-registered** — each project is its **own portal service
    instance** (separate `data/<name>/`, own port, own visibility/permissions).
    The portal's service list *is* the project list. Best when projects are
    isolated (own DB) and you want per-project access control. *(This is today's
    LILAK elog model: "New LILAK elog" registers one managed instance.)*
  - **(B) Service-internal** — **one** service instance manages its projects
    internally (its own list/routing); the portal sees a single service. Best when
    projects share infrastructure and you want a single entry.
  - *Decision to capture:* should the **portal register each project** (A), or does
    the **service manage them itself** (B)?

### ★ Q3 — Security & visibility
**"Is this service sensitive — should access be restricted?"**
(보안이 필요한 서비스인가요? 그렇다면 private로 등록합니다.)

- **Open** → tier **2 protected** (default): everyone sees it; permitted users
  enter; others can request access.
- **Sensitive / restricted** → tier **1 private**: only granted users can even see
  it. Pair with Q1 = login required.
- **Internal/admin** → tier **3 admin**: visible to portal admins only.

### Q4 — Where does it run? (managed vs external)
**"Should the portal run this service on its own host, or does it already run
somewhere else?"**

- **Portal runs it** → `mode: managed`. Provide a start command that binds the
  port (`$PORT` or `{port}`), a working dir, and a health path.
- **Runs elsewhere** → `mode: external`. Provide the `url`, an optional service
  `token`, and a health path. The portal only gates + proxies.

### Q5 — Who owns the UI on "Enter"?
**"When a user enters this service, where does the screen come from?"**

- **Headless / API-only** → the service exposes an API; the portal (or another
  cell) renders the UI. **Recommended for managed** services.
- **Service ships its own UI** → it serves its own pages/assets and **must be
  base-path aware** under `/p/<name>/` (so links/assets resolve through the
  proxy). Such a service is usually registered as **external** (it owns its
  routing). *(This is the key question for app-style services like elog's
  workspace.)*

### Q6 — Data & persistence (managed)
**"Does it store data? Where?"**

- **Stateless** → nothing to do.
- **Stateful** → keep **all** state under `data/<name>/` with **no absolute
  paths**, so the service is exportable/portable as a single `.zip`.

### Q7 — Runtime & lifecycle (managed)
**"How is it started, and how does it take its port?"**

- Give the exact `start.cmd`. The port arrives as: `{port}` placeholder in the
  cmd, **or** the `$PORT` env var, **or** (bare `uvicorn …`) auto `--port`.
- Must be **non-interactive**, **killable by signal**, and **healthy within ~8s**.

### Q8 — Import / export
**"Can a project's data be exported and imported as a single file (like LILAK
elog)? Should the portal expose that?"**
(LILAK elog처럼 프로젝트 데이터를 한 파일로 import/export 할 수 있나요? 포털에서 그 통로를 제공할까요?)

- **No** → nothing to add.
- **Yes** → declare `capabilities.import_export: true`. For a managed service whose
  state lives under `data/<name>/`, the portal's built-in zip export/import works
  out of the box. For a multi-project service, say whether import/export operates
  on **the whole service** or on **individual projects**. The portal surfaces an
  import/export channel only for services that declare this capability.

### Q9 — Naming & kind
**"What should the service be called, and what kind is it?"**

- `name`: a slug, `[A-Za-z0-9_-]` (the URL/dir name).
- `kind`: a short type label shown as a badge and used for per-kind defaults
  (e.g. `elog`, `dashboard`, `jupyter`, `static`).

---

## Decision → Config

| Answer | Manifest / registration |
|--------|--------------------------|
| Q1 no login | `identity.accepts_portal_token: false` |
| Q1 SSO | `identity.accepts_portal_token: true`, `identity.link_by: "email"`; service validates portal JWT with `PORTAL_SECRET_KEY` |
| Q2 single | one service registered |
| Q2 multi → portal-registered (A) | each project = a managed instance; expose a "create" path; portal lists them |
| Q2 multi → service-internal (B) | one service; projects handled inside; portal sees one entry |
| Q3 open | `visibility: 2` |
| Q3 sensitive | `visibility: 1` (private) |
| Q3 internal | `visibility: 3` (admin) |
| Q4 portal-run | `mode: "managed"` + `start{cmd,cwd,env}` + `health` |
| Q4 remote | `mode: "external"` + `url` + `token?` + `health` |
| Q5 headless | managed, API-only |
| Q5 self-UI | external (own base path) or a portal-served UI cell |
| Q6 stateful | data under `data/<name>/`, no absolute paths |
| Q7 | `start.cmd` binds `$PORT`/`{port}`; signal-stoppable |
| Q8 import/export | `capabilities.import_export: true` → portal shows an import/export channel (service- or project-level) |
| Q9 | `name`, `kind` |

### Environment the portal gives a managed service
`PORT`, `PORTAL_SERVICE_PORT` (the assigned port) · `PORTAL_SERVICE` (the name) ·
`PORTAL_DATA_ROOT` · `PORTAL_PORT`. For SSO, also share `PORTAL_SECRET_KEY`.

### How the proxy reaches it
Always `<portal>/p/<name>/<path>` → the portal strips `/p/<name>`, so the service
sees `/<path>`. Auth header per Q1 (SSO forwards the user's JWT; otherwise the
service token / none).

---

## Definition of Done (the AI must verify all that apply)

- [ ] **Port**: binds `0.0.0.0:$PORT` (or consumes `{port}`). *(managed)*
- [ ] **Health**: `health` path returns `<500` when ready, no auth.
- [ ] **Lifecycle**: starts non-interactively, stops on `SIGTERM`, ready < ~8s. *(managed)*
- [ ] **Proxy-safe**: works when reached under `/p/<name>/…` (API paths stable; if
      it serves a UI, it is base-path aware).
- [ ] **Identity**: if login → validates the portal JWT with `PORTAL_SECRET_KEY`
      and links by `email` (auto-provisions new users).
- [ ] **Data**: all state under `data/<name>/`, no absolute paths. *(managed)*
- [ ] **Manifest**: a valid `service.json` with the fields above.
- [ ] **Registered**: appears in the portal with the right `mode`, `kind`, and
      `visibility`; an admin can see/enter it.

---

## Worked example — adapting LILAK elog

Run the intake against elog so you can request the exact changes:

| Q | Answer for elog | Consequence |
|---|-----------------|-------------|
| Q1 login | **Yes — SSO** | `accepts_portal_token: true`, link by `email`. elog already validates the token (shared `ELOG_SECRET_KEY`) and provisions by email (`auth._resolve_portal_user`). ✔ mostly done |
| Q2 multi-project | **Multi → (A) portal-registered** | each elog **experiment** = one managed elog instance (`data/<name>/`, own DB/port). "New LILAK elog" already registers one. ✔ |
| Q3 security | **Per experiment** | default tier 2; sensitive experiments → tier 1 (private) |
| Q4 run | **managed** | `start.cmd: "uvicorn main:app"`, `health: "/api/projects"`. ✔ |
| Q5 UI on Enter | **elog ships its own workspace UI** | ← **the change to make**: the elog backend must serve its built frontend and be **base-path aware under `/p/<name>/`** so "Enter" → `/p/<name>/` shows the elog workspace (not just the API). Today only the portal-owned cover renders through the proxy. |
| Q6 data | **stateful** | per-experiment DB under `data/<name>/` (via `ELOG_DATA_ROOT`). ✔ |
| Q7 lifecycle | uvicorn, binds `$PORT`, signal-stoppable | ✔ |
| Q8 name/kind | name = experiment slug, `kind: "elog"` | ✔ |

**Net: the one real change to request from elog** is **Q5** — make the entered
experiment's UI work behind the `/p/<name>/` base path (serve the built frontend
from the elog backend with a configurable base href, e.g. honor a
`PORTAL_BASE_PATH=/p/<name>` env var). Everything else (SSO token, email linking,
per-experiment data, managed lifecycle) already satisfies the contract.
