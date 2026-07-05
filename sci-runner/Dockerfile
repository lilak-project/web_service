# sci-runner — the heavy simulation backend shared by nptoy (and later g4toy).
# ROOT + Geant4 + nptool live HERE, not in the portal image. The portal-side nptoy
# service submits jobs to this container's small HTTP API (runner.py); results land
# on a shared volume the portal reads back.
#
# Recipe follows nptool's own Docker build (Dockerfile/np_docker_base + nptool_docker
# in the nptool_cens repo): ROOT from the official prebuilt image, Geant4 compiled
# from source, then nptool (NPLib + NPSimulation).
#
# nptool is built from a SNAPSHOT OF THE LOCAL working tree (sci-runner/nptool-src/,
# produced by stage-nptool.sh) — NOT a remote clone — so the container's nptool is
# byte-identical to the dev machine, including uncommitted changes and custom
# detectors (CSSU / Coaxial_Germanium / ATOMX …). See sci-runner/DEPLOY.md.
#
# Build (on an x86_64 host — a full build is ~1h; ROOT is prebuilt, Geant4+nptool compile):
#   ./sci-runner/stage-nptool.sh            # snapshot local nptool → nptool-src/
#   docker build -t lilak-sci-runner ./sci-runner
#
# Versions pinned to match the dev machine: ROOT 6.38.00, Geant4 11.4.0.

FROM rootproject/root:6.38.00-ubuntu25.10

ARG GEANT4_VERSION=11.4.0

# ── build deps for Geant4 + nptool ────────────────────────────────────────────
RUN apt-get -y update && apt-get install -y --no-install-recommends \
      cmake ninja-build g++ wget git python3 python3-pip python3-venv \
      libexpat1-dev libxerces-c-dev libsm-dev libxft2-dev libxpm-dev libxext-dev \
      libtiff-dev libtbb-dev libgif-dev libgl1-mesa-dev libglu1-mesa-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Geant4 (from source, GDML + shipped data) ─────────────────────────────────
WORKDIR /opt
RUN wget -q https://gitlab.cern.ch/geant4/geant4/-/archive/v${GEANT4_VERSION}/geant4-v${GEANT4_VERSION}.tar.gz \
 && mkdir -p geant4-src geant4-build \
 && tar -xf geant4-v${GEANT4_VERSION}.tar.gz -C geant4-src --strip-components 1 \
 && rm -f geant4-v${GEANT4_VERSION}.tar.gz \
 && cd geant4-build \
 && cmake -GNinja -DCMAKE_INSTALL_PREFIX=/opt/geant4 \
      -DGEANT4_INSTALL_DATA=ON -DGEANT4_USE_GDML=ON -DGEANT4_BUILD_MULTITHREADED=ON \
      /opt/geant4-src \
 && ninja install && ninja clean \
 && cd /opt && rm -rf geant4-build geant4-src

# ── nptool (NPLib + NPSimulation) from the LOCAL snapshot, against ROOT + Geant4 ─
ENV NPTOOL=/opt/nptool
COPY nptool-src/ /opt/nptool/
RUN /bin/bash -c "source /opt/root/bin/thisroot.sh \
    && source /opt/geant4/bin/geant4.sh \
    && source /opt/nptool/nptool.sh \
    && cd /opt/nptool/NPLib && cmake -GNinja ./ && ninja install \
    && cd /opt/nptool/NPSimulation && cmake -GNinja ./ && ninja install"

# ── the small job API (submit → run one at a time w/ timeout → result path) ───
RUN pip3 install --no-cache-dir --break-system-packages fastapi "uvicorn[standard]" python-jose
COPY runner.py /opt/runner.py
COPY entrypoint.sh /opt/entrypoint.sh
COPY verify.sh /opt/verify.sh
RUN chmod +x /opt/entrypoint.sh /opt/verify.sh

# All simulation output goes to a shared volume the portal also mounts.
ENV SCI_DATA=/data \
    SCI_PORT=8100 \
    NPTOOL=/opt/nptool
EXPOSE 8100
ENTRYPOINT ["/opt/entrypoint.sh"]
