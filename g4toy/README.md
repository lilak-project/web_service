# g4toy

Geant4 Toy — light nuclear-physics simulation — a LILAK Web Portal service (skeleton).

Web UI to tune simulation parameters, run Geant4 (+ROOT+nptool) jobs **one at a
time via a queue**, embed an event viewer, and download results — with per-user
workspaces, disk quotas, and job timeouts.

**Status:** backend + job queue built (PLAN milestones 2–3). FastAPI `backend/`
does portal-token SSO, per-user workspaces + quota, and a global FIFO single-worker
queue with per-job timeout + cancel; the simulator is a dummy stand-in until the
real ROOT+Geant4+nptool toolchain is wired in. Next: real toolchain (4) + frontend
with JSROOT viewer (5).

👉 Read **[PLAN.md](PLAN.md)** — the full development brief (portal integration,
architecture, job queue, API, milestones). Built to continue in a fresh session.

Registered in the portal at `data/g4toy/service.json` (single managed service,
private, SSO). Entered at `/p/g4toy/`.
