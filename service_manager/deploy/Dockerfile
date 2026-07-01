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
COPY lilak_ui ./lilak_ui
COPY lilak_elog/frontend ./lilak_elog/frontend
COPY service_manager/frontend ./service_manager/frontend
COPY asset_manager ./asset_manager
COPY scattering_simulation_2d ./scattering_simulation_2d
ENV LILAK_UI_PATH=/src/lilak_ui
# The kit is consumed as SOURCE (vite alias → lilak_ui/src). Its OWN bare imports
# (@phosphor-icons/react, react, …) resolve from lilak_ui/node_modules, so install
# them here. Vite dedups react, so no double-react.
RUN cd lilak_ui                  && npm install --no-audit --no-fund
RUN cd lilak_elog/frontend       && npm install --no-audit --no-fund && npm run build
RUN cd service_manager/frontend  && npm install --no-audit --no-fund && npm run build
RUN cd asset_manager             && npm install --no-audit --no-fund && npm run build
RUN cd scattering_simulation_2d  && npm install --no-audit --no-fund && npm run build

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
COPY --from=frontend /src/service_manager/frontend/dist /app/service_manager/frontend/dist
COPY --from=frontend /src/lilak_elog/frontend/dist      /app/lilak_elog/frontend/dist
COPY --from=frontend /src/asset_manager/dist            /app/asset_manager/dist
COPY --from=frontend /src/scattering_simulation_2d/dist /app/scattering_simulation_2d/dist

# Seed (services pre-registered on first run) + entrypoint.
COPY service_manager/deploy/seed          /app/data-seed
COPY service_manager/deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PORTAL_DATA_ROOT=/app/data \
    PORTAL_PORT=8025 \
    PORTAL_PYTHON=python3 \
    EMAIL_VERIFY_DEV_ECHO=1
WORKDIR /app/service_manager
EXPOSE 8025
ENTRYPOINT ["/app/entrypoint.sh"]
