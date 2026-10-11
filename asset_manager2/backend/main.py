"""asset_manager2 backend — one shared document per portal project.

Runs one process per portal project: the portal passes the project's own data
dir as ASSET2_DATA_DIR ({project_data}), so each project's list is isolated.
Every project starts EMPTY — there is no master/seed inventory; a project's
list is built up by the people who share it.

  server : assets, records (saved lists), locations, types, settings
  browser: each person's own working set (what they ticked, which tabs are
           open) — never sent here, so nobody's save clobbers it.

The document is stored whole and carries a `version`; a PUT that was edited
from an older one is refused with 409 + the current document. That machinery
is the shared `lilak_portal_auth.store`.

Every save keeps what it replaces (keep_days=30): `data.prev.json` is the step
back, `backups/data-<date>.json` the first save of each day, thirty kept. The
document carries its photos inline, so a day's copy is about a megabyte. To
restore one, stop the service and move the file over `data.json`.
"""
import os
from pathlib import Path

from fastapi import FastAPI

from lilak_portal_auth.store import Document, mount_spa

DATA = Path(os.environ.get("ASSET2_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("ASSET2_DIST_DIR", "/app/asset_manager/dist"))

DOC = Document(DATA / "data.json", keys=("assets", "records", "locations", "types", "settings"),
               what="자산 데이터", keep_days=30)

app = FastAPI(title="asset_manager2")
DOC.mount(app, project=PROJECT)

# Must stay last: the catch-all would shadow /api/*.
mount_spa(app, DIST, name="asset_manager2")
