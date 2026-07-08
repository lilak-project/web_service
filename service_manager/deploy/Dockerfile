# syntax=docker/dockerfile:1
#
# One image baking the WHOLE web_service stack. The BUILD CONTEXT is the
# `web_service/` dir itself (it already holds the repos as siblings):
#   lilak_ui/  lilak_elog/  service_manager/  asset_manager/  scattering_simulation_2d/
#
# Build it (from web_service/):
#   docker compose up -d --build                         # uses ./docker-compose.yml
#   docker build -f service_manager/deploy/Dockerfile -t lilak-web-portal .
#
# lilak_ui is needed only to BUILD the React frontends (it's compiled into the
# dists); it is not in the runtime image.

# ── 1) Frontend builder — build every dist against the shared kit ─────────────
FROM node:20-slim AS frontend
WORKDIR /src
# Whole stack SOURCE — .dockerignore keeps it lean (no node_modules/.git/dist/data).
COPY . .
ENV LILAK_UI_PATH=/src/lilak_ui
# The kit is consumed as SOURCE (vite alias → lilak_ui/src). Its OWN bare imports
# (@phosphor-icons/react, react, …) resolve from lilak_ui/node_modules, so install
# them here. Vite dedups react, so no double-react.
RUN cd lilak_ui                  && npm install --no-audit --no-fund
RUN cd lilak_elog/frontend       && npm install --no-audit --no-fund && npm run build
RUN cd service_manager/frontend  && npm install --no-audit --no-fund && npm run build
RUN cd asset_manager             && npm install --no-audit --no-fund && npm run build
RUN cd scattering_simulation_2d  && npm install --no-audit --no-fund && npm run build

# Scaffolded services (admin "create empty service"): build EVERY deploy/seed/<name>
# that ships uniform code (web_service/<name>/frontend on the kit, <name>/backend on
# the shared venv), then assemble each one's backend + built dist into /out for a
# single runtime COPY. New services thus deploy automatically once committed.
RUN set -e; mkdir -p /out; \
    for seed in service_manager/deploy/seed/*/; do \
      name=$(basename "$seed"); \
      case "$name" in elog|asset_manager|scattering_simulation_2d) continue ;; esac; \
      [ -d "$name/backend" ] || continue; \
      echo "→ scaffolded service: $name"; \
      if [ -f "$name/frontend/package.json" ]; then \
        (cd "$name/frontend" && LILAK_UI_PATH=/src/lilak_ui npm install --no-audit --no-fund && npm run build); \
      fi; \
      cp -a "$name" "/out/$name"; \
      find "/out/$name" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true; \
    done

# Live scaffolding also runs in the RUNTIME container, so prebuild a shared
# node_modules every generated service can reuse (identical deps → offline, fast).
RUN node scripts/new-service.mjs --name svctmpl --out /tmp/tmpl --data-service --lilak-ui /src/lilak_ui \
 && cd /tmp/tmpl/svctmpl/frontend && LILAK_UI_PATH=/src/lilak_ui npm install --no-audit --no-fund

# ── 2) Runtime — python + both backends + every built dist ────────────────────
FROM python:3.12-slim AS runtime
# lsof: elog stop() finds the port owner. librsvg2-bin: the icon editor's PDF/EPS
# export (rsvg-convert). (.icns rebuild needs macOS iconutil → degrades gracefully.)
RUN apt-get update && apt-get install -y --no-install-recommends lsof librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# One Python env with BOTH dep sets — the portal SPAWNS the elog backend with it.
COPY service_manager/requirements.txt /tmp/portal-req.txt
COPY lilak_elog/requirements.txt      /tmp/elog-req.txt
RUN pip install --no-cache-dir -r /tmp/portal-req.txt -r /tmp/elog-req.txt

# Backends + static services (code). Frontends/dists come pre-built from stage 1.
COPY service_manager          /app/service_manager
COPY lilak_elog               /app/lilak_elog
COPY asset_manager            /app/asset_manager
COPY scattering_simulation_2d /app/scattering_simulation_2d
COPY --from=frontend /src/nptool_cens/Projects /app/nptool_cens/Projects
COPY --from=frontend /src/service_manager/frontend/dist /app/service_manager/frontend/dist
COPY --from=frontend /src/lilak_elog/frontend/dist      /app/lilak_elog/frontend/dist
COPY --from=frontend /src/asset_manager/dist            /app/asset_manager/dist
COPY --from=frontend /src/scattering_simulation_2d/dist /app/scattering_simulation_2d/dist
# Scaffolded services (uniform layout): backend + built dist, assembled in stage 1.
# cwd in each seed manifest points at /app/<name>/backend.
COPY --from=frontend /out /app

# Live service scaffolding (admin "create empty service"): Node runtime + the
# generator + the kit source + a shared prebuilt node_modules. New services are
# written to the data volume, built once here, then served like any other.
COPY --from=frontend /usr/local/bin/node               /usr/local/bin/node
COPY --from=frontend /usr/local/lib/node_modules/npm   /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY scripts                                            /app/scripts
COPY --from=frontend /src/lilak_ui                      /app/lilak_ui
# Must live at a path literally ending in `node_modules`: a generated service
# symlinks its frontend/node_modules here, and Node resolves vite's deps (esbuild…)
# by walking up from the realpath looking for a `node_modules` ancestor.
COPY --from=frontend /tmp/tmpl/svctmpl/frontend/node_modules /app/svc-modules/node_modules

# Seed (services pre-registered on first run) + entrypoint.
COPY service_manager/deploy/seed          /app/data-seed
COPY service_manager/deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PORTAL_DATA_ROOT=/app/data \
    PORTAL_PORT=8025 \
    PORTAL_PYTHON=python3 \
    EMAIL_VERIFY_DEV_ECHO=1 \
    PORTAL_SCAFFOLD_SCRIPT=/app/scripts/new-service.mjs \
    LILAK_UI_PATH=/app/lilak_ui \
    PORTAL_SVC_NODE_MODULES=/app/svc-modules/node_modules
WORKDIR /app/service_manager
EXPOSE 8025
ENTRYPOINT ["/app/entrypoint.sh"]
