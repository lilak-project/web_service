# lilak_gui

A web GUI for the existing **LILAK** analysis framework — a LILAK Web Portal
service (skeleton). Finds LILAK via `$LILAK_PATH` and exposes its features
(parameter editing, `run`, ROOT result viewing via JSROOT, …) in the browser.

**Status:** built from scratch (2026-06-30) — a purple, `lilak_elog`-style **tab
shell** on the `lilak_ui` kit (실행 / 파라미터 / 뷰어 / 설정, placeholders for now) +
a minimal FastAPI backend, portal-integrated and verified at `/p/lilak_gui/`. Real
per-tab features come next. The old UI at `~/Research/lilak/ui` is *reference only*
(its design was rejected) — not reused.

👉 Read **[PLAN.md](PLAN.md)** — the full development brief. Build the frontend with
`cd frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm run build`. Portal contract
(SSO + base-path) and `$LILAK_PATH` apply.

Registered at `data/lilak_gui/service.json` (single managed service, SSO). Entered
at `/p/lilak_gui/`.
