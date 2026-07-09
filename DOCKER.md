# Running the whole stack with Docker

One image bakes the entire `web_service/` stack — the portal plus every service
(elog, asset_manager, scattering_simulation_2d, g4toy) and the shared UI kit. All
runtime state lives in **one host folder** (bind-mounted at `/app/data`), so it
sits OUTSIDE the container and is managed per server.

## On another server

Copy the `web_service/` directory there (or `git clone` the repos so they sit as
siblings under one folder), then:

```sh
cd web_service
cp .env.example .env          # edit the secrets (see below)
docker compose up -d --build  # build the image + start
```

The portal is then at `http://<host>:8025`. The **first account you sign up
becomes the admin**; the three services are already registered.

### Secrets to set in `.env`

- `ELOG_SECRET_KEY` — a long random string. The portal and the elog backend it
  spawns both use it, so login tokens are trusted on entry (SSO). Generate one:
  `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `PORTAL_REGISTER_TOKEN` — token a service uses to self-register via handshake.
- `PORTAL_BASE_URL` — the public URL (e.g. `https://portal.example.org`), used in
  entry/handshake links.

## What's baked vs. persisted — data lives OUTSIDE Docker

- **Image** (rebuilt from source): all backends + pre-built frontends + the seed
  service registrations (`service_manager/deploy/seed/`), with in-container paths
  (`/app/...`). Same image on every server.
- **Data = a host folder** bind-mounted at `/app/data` (set by `PORTAL_DATA_DIR`,
  default `./portal-data`): `_portal/portal.db` (accounts + permissions + groups +
  invite codes + service registry) and every service's live data
  (`elog/projects/<exp>/`, `asset_manager/projects/...`, …). It's a normal directory
  on the host — inspect it, `tar`/`rsync` it, back it up, point it at a big disk.

**Per-server data:** each server has its OWN `PORTAL_DATA_DIR`, so the data is
managed separately per server while the image stays identical. Move/clone a
deployment = copy that one folder to the new server's `PORTAL_DATA_DIR`.

```sh
# e.g. a dedicated disk on the production server
PORTAL_DATA_DIR=/srv/lilak/data    # in .env
# back up / sync that server's data
rsync -a /srv/lilak/data/  backup-host:/backups/lilak/$(hostname)/
```

On the **first** boot (empty folder) the seed registrations are copied in; later
boots keep it untouched. Update code → `docker compose up -d --build` (data kept).
Note: the container writes as root, so files in the host folder are root-owned.

## Bringing existing data over

A fresh container starts with the services registered but **no experiments / asset
lists** — that data lives in your dev machine's `data/` and isn't baked into the
image. Two ways to migrate:

1. **Per project (recommended):** in the portal, open a service → **Export** each
   project to a `.zip`, then **Import** (drag-drop) it on the new server.
2. **Bulk copy:** after the first boot, copy only the project *data* dirs into the
   server's `PORTAL_DATA_DIR` — e.g. `data/elog/projects/<exp>/` →
   `$PORTAL_DATA_DIR/elog/projects/<exp>/`. Do **not** copy the dev `data/<svc>/service.json`
   manifests; they contain dev host paths. The container's seeded manifests
   (`/app/...`) are the correct ones.

## Notes / limits

- PDF/EPS icon export works in the container (`librsvg2-bin`). The macOS `.app`
  icon rebuild (`iconutil`) is mac-only and is skipped gracefully on Linux.
- Service ports (8026–8075) stay internal to the container; only `8025` is exposed.
- Email verification is on by default with a dev echo (no real sender wired).
  Point the verify step at a real provider before exposing signups publicly.
- A dev variant that bind-mounts source with `--reload` lives at
  `service_manager/deploy/docker-compose.dev.yml`.
