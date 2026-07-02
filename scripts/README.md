# scripts

Tooling for the `~/web_service` service stack.

## `new-service.mjs` — scaffold a new portal service

Generates a full-stack LILAK Web Portal service from three inputs (name, tabs,
main theme colour), built on the kit's `AppShell`. The result already runs
(top bar + `/` command bar + `\` drawer + `?` shortcuts), is portal-integrated
(base-path aware + SSO), is responsive (tabs fold into a ☰ menu on phones), and
— with `--settings` — carries a portal-centric Settings tab. Fill the tab
bodies afterwards.

```bash
node scripts/new-service.mjs \
  --name mysvc --service "sample" \
  --tabs "home:홈:home,data:데이터:table,set:설정:settings" \
  --color "#2563eb" --settings \
  --port 5199 --backend-port 8199 \
  --register            # optional: also create the portal DB row via /api/handshake
```

### Flags

| flag | meaning | default |
|---|---|---|
| `--name` | service id (lowercase `[a-z0-9_]`) — dir + manifest name | (required) |
| `--service` | brand subtitle (two-line `라일락` / `<service>`) | `app` |
| `--brand` | brand top line (English uses lowercase `lilak`) | `라일락` |
| `--tabs` | `id:label:icon` comma list | `home:홈:home` |
| `--color` | main theme colour `#rrggbb` → nav + accent tokens (hover/tint derived) | `#9333ea` |
| `--settings` | add the portal-centric Settings tab | off |
| `--port` / `--backend-port` | dev server / backend ports | `5160` / `8160` |
| `--register` | POST `/api/handshake` to create the portal DB row | off |
| `--portal-url` / `--register-token` | for `--register` (else `PORTAL_BASE_URL` / `PORTAL_REGISTER_TOKEN`) | `:8025` / env |
| `--out` | base dir | `~/web_service` |
| `--force` | overwrite existing files | off |

### What it writes

- `<name>/frontend/` — React+Vite on the kit (alias via `LILAK_UI_PATH`): thin
  `AppShell` config (`components/Shell.jsx`), colour preset (`theme/main.js`),
  i18n, per-tab `Placeholder`, `api.js` (base-path + SSO), favicon.
- `<name>/backend/` — minimal FastAPI (`/api/health` + `/api/whoami` + serves
  `dist`), `portal_auth.py` SSO. Runs on the shared `service_manager/.venv`.
- `data/<name>/service.json` — the portal manifest (managed, `accepts_portal_token`).
- With `--settings`: a Settings tab (SideNav → account[whoami + portal link] /
  manage-users[portal link] / tabs·profile-types service-local stubs). Accounts
  stay owned by the portal.

### After generating

```bash
cd <name>/frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm install && npm run build
```

If you didn't pass `--register`, register `data/<name>/service.json` with the
portal via the admin **Services** UI or `/api/handshake`. Fix `start.cwd` per
host if the checkout moves.
