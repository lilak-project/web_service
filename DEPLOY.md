# Deploying updates to a server (git + build-on-server)

The stack is one git **superrepo** (`web_service`): the portal (`service_manager`)
+ the docker files are tracked directly; `lilak_elog`, `lilak_ui`, `asset_manager`,
`scattering_simulation_2d`, `g4toy`, `lilak_gui` are **git submodules** pointing at
their own GitHub repos.

Code lives in git; **data lives only on the server** (a host folder bind-mounted at
`/app/data`, set by `PORTAL_DATA_DIR`). So updating code never touches data, and DB
schema migrations run automatically on boot.

## One-time server setup

```sh
# on the server (needs git + docker + docker compose)
sudo mkdir -p /opt/web_service && sudo chown "$USER" /opt/web_service
git clone --recursive git@github.com:lilak-project/web_service.git /opt/web_service
cd /opt/web_service

cp .env.example .env         # then edit:
#   ELOG_SECRET_KEY       = a long random string  (portal + elog share it → SSO)
#   PORTAL_REGISTER_TOKEN = another random string
#   PORTAL_BASE_URL       = https://portal.yourhost   (public URL)
#   PORTAL_DATA_DIR       = /srv/lilak/data   (where this server keeps its data)
#   PORTAL_PORT           = 8025

docker compose up -d --build   # first boot seeds services; first signup = admin
```

## Every update (from your Mac)

```sh
cd ~/web_service
# 1) commit portal (service_manager) changes here in the superrepo
git add -A && git commit -m "…"
# 2) if you changed a submodule (elog / lilak_ui / asset_manager / scattering /
#    g4toy / lilak_gui), commit + push it IN ITS OWN dir first:
#      ( cd g4toy && git add -A && git commit -m "…" && git push )
# 3) ship it — bumps submodule pointers, pushes, rebuilds on the server:
./deploy.sh user@server            # or: ./deploy.sh user@server /srv/web_service
```

`deploy.sh` bumps the submodule pointers to their latest pushed commits, commits +
pushes the superrepo, then on the server does `git pull --recurse-submodules` +
`docker compose up -d --build`. The `PORTAL_DATA_DIR` folder is never touched, so
accounts / experiments / asset lists all survive; new DB columns are auto-migrated.

## Notes

- **Rollback:** `git checkout <old-commit> && docker compose up -d --build` on the
  server (or revert the superrepo commit and re-deploy). Submodule pins make each
  superrepo commit a reproducible snapshot.
- **Downtime:** `up -d --build` restarts the container; in-container service
  instances (elog, …) restart on next entry. Brief, data-safe.
- **No Docker on the server yet?** Install Docker + the compose plugin first.
- **Air-gapped server?** Build the image on a connected box and `docker save | ssh …
  docker load` instead of building on the server (see the note in `docker-compose.yml`).
