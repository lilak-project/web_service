# sci-runner — running nptool in a container, identical to your local build

This is the **heavy simulation backend** for the LILAK portal. ROOT + Geant4 +
nptool live in *this* container, not in the portal image. The portal (and the
`nptoy` service inside it) talk to it over a small internal HTTP API and read
results off a shared volume.

The whole point of the setup below: **the nptool inside the container is
byte-identical to the one on your dev machine** — same commit, same *uncommitted*
changes, same custom detectors (CSSU / Coaxial_Germanium / ATOMX …) and the same
geometry-export patch the web 3D viewer depends on. Nothing is cloned from a
possibly-stale GitHub branch; the image is built from a snapshot of your working
tree, and a `verify.sh` proves it before you trust it.

```
┌──────────────── portal container (light) ────────────────┐        ┌──── sci-runner container (heavy) ────┐
│  service_manager (portal)   +   nptoy backend (FastAPI)   │        │  ROOT 6.38 + Geant4 11.4 + nptool     │
│                                                           │  HTTP  │  (built from YOUR local snapshot)     │
│  submits jobs ───────────────────────────────────────────┼───────▶│  runner.py  :8100  (internal only)    │
│  reads outputs ◀──────────────┐                           │        │  runs npsimulation / npanalysis       │
└───────────────────────────────┼───────────────────────────┘        └───────────────┬──────────────────────┘
                                 │            shared volume  (sci-data)                │
                                 └──────────────────  /sci  ⇄  /data  ─────────────────┘
```

Versions are pinned to the dev box: **ROOT 6.38.00, Geant4 11.4.0.**

---

## 0. Prerequisites

- An **x86_64** host with Docker + docker-compose. The base image
  `rootproject/root:6.38.00-ubuntu25.10` is amd64; building on Apple Silicon works
  only under emulation and is *very* slow — build on the target server (or an
  amd64 CI runner) and push the image.
- **~1 hour** for the first build (ROOT is prebuilt; Geant4 and nptool compile from
  source) and **~10 GB** free disk for the image.
- The nptool source on the build host at `~/Research/nptool_cens` (or set
  `NPTOOL_SRC`). This is the tree that becomes the container's nptool.

---

## 1. Build the image (identical to local)

Two commands, from `web_service/`:

```bash
# 1) snapshot your LOCAL nptool working tree into the build context
#    (committed + uncommitted + untracked; excludes .git, build outputs, ROOT files)
./sci-runner/stage-nptool.sh
#    → sci-runner/nptool-src/            (~190 MB, git-ignored)
#    → sci-runner/nptool-src/NPTOOL_PROVENANCE.txt   (commit + diff hash + dirty list)

# 2) build the image from that snapshot
docker build -t lilak-sci-runner ./sci-runner
```

`stage-nptool.sh` prints the exact commit / branch / dirty-count it captured — that
same provenance is baked into the image, so you can always answer *"what nptool is
in this container?"*.

> **Change nptool later?** Just re-run the two commands. `stage-nptool.sh` re-snapshots
> your current working tree (new commits *and* new uncommitted edits), and the rebuild
> picks them up. There is no git push/pull in the loop — the image always mirrors
> whatever is on your disk at stage time.

---

## 2. Verify it matches your local nptool

Run the built-in check **inside the image**:

```bash
docker run --rm lilak-sci-runner /opt/verify.sh
```

It asserts, and exits non-zero on the first failure:

- **provenance** — prints the commit / branch / dirty-count baked in;
- **toolchain** — `npsimulation` on PATH, `NPTOOL` set, ROOT version;
- **custom detectors compiled in** — `CSSU`, `GasBox`, `Coaxial_Germanium`, `ATOMX`
  tokens present in `libNPSimulation` (proves *your* detector code, not a stock nptool);
- **a real 1-event sim** — builds a CSSU GasBox + fires one alpha, checks the log shows
  `Adding Detector CSSU`;
- **geometry-JSON export** — runs `/det/export_geometry` (the `DumpPV` patch the web
  viewer uses) and checks it produced volumes.

A green `✅ VERIFY PASSED` means the container nptool is the real one and runs.

> Sanity cross-check against your machine: compare `git rev-parse HEAD` and
> `git status --porcelain` on `~/Research/nptool_cens` with the `git_commit` /
> `git_dirty_count` the verify prints.

---

## 3. Run the stack (portal + sci-runner + shared volume)

The compose file wires everything: the portal image, the sci-runner image, one
shared `sci-data` volume mounted `/data` in the runner and `/sci` in the portal, and
the env that points nptoy at the runner.

```bash
cd service_manager/deploy
cp .env.example .env            # set PORTAL_SECRET_KEY, and optionally SCI_TOKEN
STACK_DIR=/absolute/path/to/web_service \
  docker compose up -d --build   # builds BOTH images; run stage-nptool.sh first!
```

Key env (in `deploy/.env` / compose):

| var              | where     | meaning                                                        |
|------------------|-----------|----------------------------------------------------------------|
| `SCI_RUNNER_URL` | portal    | `http://sci-runner:8100` — how nptoy reaches the runner        |
| `SCI_SHARED_DIR` | portal    | `/sci` — where nptoy reads the runner's job outputs            |
| `SCI_TOKEN`      | both      | shared secret; blank = no check (ok on an internal-only net)   |
| `SCI_JOB_TIMEOUT`| runner    | hard per-job wall-clock cap (seconds)                          |

Setting `SCI_RUNNER_URL` flips nptoy's `config.RUNNER` from `local` → `sci`.

---

## 4. Verify the connection (portal ↔ runner)

The runner is internal (not published), so test from inside the compose network:

```bash
# health — no auth needed
docker compose exec portal curl -fsS http://sci-runner:8100/health
# → {"ok":true,"busy":false,"nptool":"/opt/nptool"}

# a real job end-to-end (submit → run → read output off the shared volume)
docker compose exec sci-runner /opt/verify.sh        # runs the full sim check in place
```

If `/health` returns the JSON above, the portal can reach the runner and nptool is
live. (When `SCI_TOKEN` is set, add `-H "Authorization: Bearer $SCI_TOKEN"`.)

---

## 5. Provenance — proving what's in a running container

```bash
docker run --rm lilak-sci-runner cat /opt/nptool/NPTOOL_PROVENANCE.txt
```

Shows the staged-at timestamp, git branch/commit, dirty count, `git diff` sha256, and
the full uncommitted/untracked file list the image was built from.

---

## 6. Troubleshooting

| symptom | cause / fix |
|---|---|
| build is glacially slow / `exec format error` | building amd64 on Apple Silicon. Build on an x86_64 host, or `docker build --platform linux/amd64` on a fast machine and push. |
| `verify.sh`: `detector token MISSING: CSSU` | the snapshot didn't include your detector, or nptool didn't rebuild. Re-run `stage-nptool.sh` (check it lists your branch), confirm `sci-runner/nptool-src/NPSimulation/Detectors/CSSU` exists, rebuild with `--no-cache`. |
| `verify.sh`: `geometry JSON NOT produced` | the `DumpPV` / `/det/export_geometry` patch isn't in the snapshot. Confirm `grep -c ExportGeometryJSON sci-runner/nptool-src/NPSimulation/Core/DetectorConstruction.cc` is > 0, re-stage, rebuild. |
| `COPY nptool-src/ …: not found` at build | you didn't run `stage-nptool.sh` before `docker build`. |
| image is huge | expected — ROOT + Geant4 + Geant4 data is several GB. The *nptool source* is only ~190 MB. |
| runner OOM-killed on big sims | raise the container memory limit; sims run one-at-a-time (serial queue) by design. |
| portal can't reach runner | both must be on the same compose network and `SCI_RUNNER_URL=http://sci-runner:8100`. Check `docker compose ps` shows `sci-runner` healthy. |

---

## 7. What's wired vs. what's next

**Wired now (this doc):**
- Identical-to-local nptool image (`stage-nptool.sh` + Dockerfile) + `verify.sh`.
- The runner's **batch** job API (`runner.py`: submit `npsimulation`/`npanalysis`/`root`
  argv → run one-at-a-time with a timeout → outputs on the shared volume).
- Portal↔runner compose wiring + shared volume + health/connection checks.

**Next phase — interactive sessions through the runner.** The app's live
`Start / Run / Stop` sessions (`nptoy/backend/session.py`) currently spawn
`npsimulation -N` as a **local subprocess** — fine on the dev Mac, but in the split
deploy nptool lives in the runner, not the portal. To route sessions through the
runner, add a stateful session API to `runner.py` and a `sci` backend to
`session.py` (the `config.RUNNER == "sci"` seam already exists):

- `runner.py`: `POST /session/start` (spawn `npsimulation -N` in a user workdir on the
  shared volume, keep the process handle) · `POST /session/{id}/cmd` (write one
  validated line to stdin, e.g. `/run/beamOn N`) · `GET /session/{id}/log?since=` ·
  `POST /session/{id}/stop`. The existing serial-subprocess pattern generalizes to
  holding live processes.
- `session.py`: when `RUNNER == "sci"`, call that API instead of `subprocess.Popen`;
  read `online_stream.dat` / `*.geom.json` from the shared volume the runner writes.
- `rbrowser.py` (the ROOT-file browser) similarly needs ROOT, so it either runs in the
  runner or the runner grows a small RBrowser endpoint.

Until then, the deploy runs **batch jobs** end-to-end; keep `nptoy` in `local` mode
(bundle nptool into the portal image) if you need live sessions before that phase
lands. Ping me and we'll build + test it against the freshly-built image.
