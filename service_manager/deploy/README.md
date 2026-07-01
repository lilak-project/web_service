# Deploy — one Docker image, three repos

Bakes **lilak_ui + lilak_elog + service_manager** into a single image (built with
the same logic as `build-all.sh`), runs the portal behind one port, and keeps all
state in a **persistent volume**.

> Code/registrations → image · live data → volume. Rebuild the image to update
> code; the volume (accounts, logs, each service's data) survives.

## Layout the build needs

The build context must contain the three repos **as siblings**:

```
<stack>/
  lilak_ui/
  lilak_elog/
  service_manager/   (this repo; deploy/ lives here)
```

On this machine they are already co-located under **`~/web_service/`**, so
`STACK_DIR=~/web_service` works directly (drop a copy of `deploy/.dockerignore`
at that root first). On a fresh server, clone the three side by side. `stage.sh`
remains if you ever need to assemble a clean context from elsewhere.

## Build & run (production)

```bash
cp deploy/.env.example deploy/.env      # set PORTAL_SECRET_KEY, PORTAL_REGISTER_TOKEN, …
./deploy/stage.sh                       # split machine only; sets up STACK_DIR

STACK_DIR=~/web_service/_stack \
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

- Portal at `http://<host>:8025` (the single front door; service ports stay
  internal). First signup = admin.
- On first run the volume is **seeded** from `deploy/seed/` — the **elog** service
  comes pre-registered (paths point at `/app/lilak_elog/backend` inside the image).
  Add more services to `deploy/seed/<name>/service.json` to ship them pre-registered.
- To carry over existing data instead of seeding, load your `PORTAL_DATA_ROOT`
  contents into the `portal-data` volume before first start.

## Update the code

| what | how | data |
|------|-----|------|
| **production** | edit code → `docker compose … up -d --build` (rebuilds the image) | volume kept |
| **dev on the box** | mount the source + hot-reload (below) | volume kept |

```bash
# dev: backend hot-reloads on host edits (frontend edits need npm run build)
SM_DIR=~/web_service/service_manager LILAK_ELOG_DIR=~/web_service/lilak_elog \
  docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml \
  --env-file deploy/.env up
```

**Registrations & data** (add/remove services, accounts, logs) are runtime — done
in the portal UI / via handshake, stored in the volume, **no rebuild**.

## Firebase (email-verification / activation)

Same image, switched by env — no rebuild:

- dev: `EMAIL_VERIFY_DEV_ECHO=1` (returns the link).
- prod: `EMAIL_VERIFY_DEV_ECHO=0` + provide Firebase creds at runtime
  (`GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase.json`, mounted as a
  secret — never baked in).

> The Firebase *send* hook in `app/routers/auth.py` `register()` is still a stub
> (prints the link). Implement it to call Firebase, reading creds from env; the
> gating + verify endpoint stay as-is.

## Notes

- Single container runs the portal **and** the elog experiment subprocesses
  (ports 8026–8044 internal, proxied via 8025). For heavy scale, split services
  into their own containers (register them as `external`) and/or put nginx/caddy
  in front.
- Not tested on the machine these files were written on (no Docker there) — they
  follow the standard multi-stage pattern; verify on a host with Docker.
