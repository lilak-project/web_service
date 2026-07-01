# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**g4toy** — a Geant4 Toy — light nuclear-physics simulation service for the LILAK Web Portal.

**Status:** FastAPI backend (`backend/`) with portal-token SSO, per-user workspaces
+ quota, and TWO ways to run the **real nptool `npsimulation`**:
- **batch jobs** — global FIFO single-worker queue, each job runs `npsimulation -B
  <macro>` (timeout/cancel via process-group kill);
- **interactive sessions** — a live `npsimulation -N` per user; the web Run button
  pushes `/run/beamOn <n>` into its stdin one at a time (accumulating ROOT output).

There is **no cssu/dummy stand-in any more** — everything runs nptool (the
`cssu_geant4_simulation` example and `cssu_sim.py` were removed; "run only with
nptool"). Local toolchain for dev (`~/Research/nptool_cens`), Docker image for
deploy (milestone 4). Whitelisted projects in `config.PROJECTS` (first =
`ATOMX_12C`). The 3D viewer is **wired to the real nptool output (live)**: on session start the
backend auto-sends `/det/export_gdml geometry.gdml` (existing nptool command — no
C++ change) → `gdml.py` parses it (ATOMX = 199 solids, `<assembly>` expanded) →
geometry renders; each `/run/beamOn` updates `online_stream.dat` → `scene.from_online`
→ tracks/energy points, the frontend polling `/api/session/scene`. The text stream
comes from a NEW nptool option **`--online-data-streaming <N>`** added to
`~/Research/nptool_cens` (`NPOptionManager` + `SteppingAction`, rebuilt) — flushed
per step so it's readable while the session's ROOT file stays open. ROOT remains the
authoritative output (read after close). These nptool source edits must ship in the
Docker image (milestone 4).

## START HERE

Read **[PLAN.md](PLAN.md)** first — it is the full development brief (the work
order): goal, **portal integration contract** (single managed service, SSO via the
portal JWT + shared `ELOG_SECRET_KEY`, base-path awareness, private visibility),
Docker/toolchain architecture (ROOT+Geant4+nptool in a **separate** image — do not
bake into the portal image), the **single-worker job queue** (one job at a time,
FIFO, per-job timeout), per-user workspaces + disk quotas, the API design, data
model, security, and milestones.

## Portal facts you need

- Portal lives at `~/web_service/service_manager` (port 8025). Its rulebook is
  `service_manager/SERVICE_CONTRACT.md` + `AI_SERVICE_GUIDE.md`.
- This service is registered at `~/web_service/data/g4toy/service.json` (single,
  managed, `accepts_portal_token: true`, visibility private). Entered at `/p/g4toy/`.
  The manifest now launches the backend (`start.cmd = "uvicorn main:app"`,
  `cwd = backend/`, health `/api/health`). The managed adapter runs it as
  `python -m uvicorn … --workers 1` using the portal's shared venv python, so the
  single in-process worker thread = exactly one worker (don't raise `--workers`).
  **Decided:** execution env = **Docker, external service**, and the **image is the
  deliverable** — built here, pushed to a registry, run on a *different/remote*
  server (PLAN §3.1). The local Geant4/ROOT/nptool install is dev-reference only,
  not shipped. The toolchain image follows nptool's recipe *structure*
  (`~/Research/nptool_cens/Dockerfile/`: ROOT base → Geant4 → nptool) and pins
  **ROOT 6.38.00** (`rootproject/root:6.38.00` base) + **Geant4 11.4.0** (source
  build, data + GDML), matching local — built INSIDE the image, not copied from the
  host (PLAN §3.2 has the Dockerfile sketch). The engine is **nptool** — the image
  must bake our `nptool_cens` fork + the project(s) in `config.PROJECTS` (first =
  `ATOMX_12C`, `~/Research/nptool_cens/Projects/jungwoo/simulation_12C`). Milestone 4
  builds the image (ROOT+Geant4+nptool+projects+backend), adds a compose `g4toy`
  service (persist volume for user folders + sqlite), and flips the manifest to
  `mode=external, url=http://g4toy:8050`. Until then: managed+local against the
  installed toolchain. Open decisions (PLAN §3.5): which nptool fork/branch + which
  projects go in the image; target arch + registry.
- Good reference for a single SSO + base-path service: `~/web_service/asset_manager`
  (`src-lilak/App.jsx`).

## Layout

- `backend/` — FastAPI. `main.py` (routes), `auth.py` (portal-JWT SSO via `jose`,
  same secret as the portal), `db.py` (SQLite + `Job` model = the queue), `worker.py`
  (the single global worker loop + cancel/timeout via process-group kill),
  `params.py` (whitelisted param schema + `.mac` template — never arbitrary macros),
  `workspace.py` (per-user job/session dirs + quota), `inputs.py` (**editable input
  workspace**: per-user `inputs/` of nptool files — detector/reaction/cross-section/
  project.config — seeded from an example in `config.PROJECTS`; `manifest.json` records
  which file is detector/reaction/output so the run command is general; sessions/jobs
  copy this workspace and run `npsimulation -D <det> -E <rea> -O <out>`), `params.py`
  (batch job knob = n_events → `/run/beamOn n`), `scene.py` (viewer Scene JSON;
  geometry from GDML, nptool track/point extraction TODO), `gdml.py`
  (**GDML → geometry automation**:
  Geant4-style `.gdml` → box/cylinder/sphere with placement+rotation+hierarchy, so
  any example's geometry follows automatically once a run exports a `geometry.gdml`),
  `worker.py` (FIFO single worker → `npsimulation -B`), `session.py` (**interactive
  nptool sessions**: keeps a live `npsimulation -N` per user and pushes
  `/run/beamOn <n>` to its stdin one at a time — one session/user, global cap,
  isolated per-session project copy; **only ever writes the fixed `/run/beamOn
  <validated int>`, never user text**, since a G4 terminal accepts `/control/shell`
  shell-escapes), `config.py`. `run-dev.sh` runs it standalone on :8050.
- `frontend/` — **Vite + React + react-three-fiber** (base-path aware, `base:'./'`,
  `<base href>`). `npm run build` outputs to `../public`. `App.jsx` = shell: top bar
  (Phosphor LegoSmiley + `g4toy` + **tabs** Simulation/Inputs/Analysis + account name
  + sign-out). SimulationTab stays mounted/hidden so its live polling survives tab
  switches. `SimulationTab.jsx` = 3D viewer + a left **dock of collapsible cards**
  (session / volumes / display). `InputsTab.jsx` = the **Setup** tab (first): full-page editor of three abstracted
  slots — **Physics list / Detector / Reaction** (real nptool filenames hidden;
  `manifest.json` maps slot→file; project.config auto-named from the account, macros
  hidden); a PRESET loader seeds from `config.PROJECTS`. The **Detector** slot has a
  **form/text toggle**: `DetectorForm.jsx` renders the params **actually present** in
  each block (faithful — handles STARK's POS/Rotate vs Rho/Phi/Z/Flip/Group variants,
  Target, ATOMX) using a schema **registry** (`detector.js` `DETECTOR_BLOCKS` w/ labels/
  comments/units; Target MATERIAL = datalist of the nptool material library; per-block
  add/remove + clear-all; add-field per block) and round-trips losslessly. The **Reaction** slot has
  the same form/text (`ReactionForm.jsx` + `reaction.js`: Beam → TwoBodyReaction →
  optional Decay w/ nucleus arg). A 4th **Cross-section** item (`CrossSectionEditor.jsx`)
  generates the dσ/dΩ table (flat / exponential / gaussian) with an inline SVG plot;
  the backend resolves its file from the reaction's `CrossSectionPath` and writes it
  there (`/api/inputs/crosssection`). The **Physics list** slot also has a form
  (`PhysicsForm.jsx`/`physics.js`: EM-list dropdown + cut-off + a checkbox grid of the
  0/1 physics processes; a default `PhysicsListOption.txt` is seeded if the project
  lacks one). STARK uses **placement-combo** picking (cart/car2/cyld/sphe/reso/targ from STARK.cc);
  Gas presets apply via **buttons** (active one highlighted). Target MATERIAL shows
  its composition. The **Reaction** form draws particle diagrams where **every particle
  is a circle and same species → same size & colour** (`particles.jsx` `particleStyle`,
  size ∝ A^⅓, colour hashed from the name): a two-body `A(a,b)B` diagram
  (`ReactionDiagram.jsx`) and, for Decay blocks, a parent→daughters diagram
  (`DecayDiagram.jsx`). The reaction's CrossSectionPath is a dropdown of available CS
  files (`/api/inputs/crosssections`, auto-filled). The **Cross-section** editor is a
  **multi-file manager**: open any saved CS from a dropdown, edit/generate, and "save
  as" under a name (`csGet(name)`/`csSave(content,name)`, `?name=`/`{name}` on
  `/api/inputs/crosssection`; bare names get `.txt`). The Setup sidebar
  also has **named configs** (`Configs.jsx` +
  `backend/configs.py`, `/api/configs`): save the current workspace under a name,
  reload it, and **share** it so other users see/load it like a preset (cross-user
  verified). Adding a detector/reaction type = a new registry entry. `AnalysisTab.jsx`
  = placeholder for output.root plots. **Light theme** (white bg, CSS variables);
  the viewer canvas is white with darkened wireframes/tracks for contrast. The
  viewer follows the **live session** (`/api/session/scene`, polled 1.2s) by default,
  or a finished job with `?job=<id>`. Perf: all volumes are merged into ONE
  wireframe `LineSegments` (vertex-coloured, 1 draw call) rebuilt only when geometry
  changes — geometry/event state is split so the 1.2s poll only updates tracks/points;
  tracks are likewise one merged LineSegments; camera auto-fits a robust (85th-pct)
  bbox so nptool's stray 10 m "sample" volume doesn't blow up framing. Renders wireframe volumes +
  per-event track polylines + energy-coloured point cloud. Controls: per-volume show/hide +
  solo (each GDML volume listed by name/type/colour), tracks & energy-point toggles,
  point-size slider, and a **reset-view** button (OrbitControls.reset back to the
  home camera), plus an orientation gizmo. The volume panel is **grouped**: gdml.py
  tags each placed solid with `group` (its enclosing `<assembly>`) and a `short`
  name (no `0x…` suffix); the UI dedups repeated imprints into `name ×N` rows and
  puts assembly imprints under a collapsible group with a group on/off toggle (so an
  N-imprint detector array toggles as one). Header `▶ session` opens `Session.jsx` —
  the interactive-session panel (project select, start/stop, `/run/beamOn` input +
  Run, status badge, live stdout log polling `/api/session/log`).
- `public/` — **build output** of `frontend/` (was the placeholder), served at `/`
  by the backend, mounted last so it never shadows `/api/*`.
- Preview/dev: `~/.claude/launch.json` has a `g4toy` entry (uvicorn on :8050);
  `preview_start g4toy` serves backend+built viewer together.

## Run / test the backend

Standalone (uses the portal's shared venv so deps match the managed spawn):
`backend/run-dev.sh` → http://localhost:8050. Mint a test token with the dev
secret (`lilak-dev-secret-CHANGE-in-production`) carrying an `email` claim and call
`/api/me`, `POST /api/jobs {params}`, `/api/jobs`, `/api/queue`,
`/api/jobs/{id}/cancel`, `/api/jobs/{id}/viewer`, `/api/jobs/{id}/result`. Runtime
data + DB live under `<PORTAL_DATA_ROOT>/g4toy/`.
