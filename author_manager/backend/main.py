"""author_manager backend — one shared document per portal project.

Runs one process per portal project: the portal passes the project's own data
dir as AUTHOR_DATA_DIR ({project_data}), so each project's list is isolated.

The document holds the authors and the two kinds of class they point at. It is
stored whole and carries a `version`; a PUT sends the `baseVersion` it edited
and is refused with 409 + the current document if someone saved first, so the
client reloads instead of overwriting them. That machinery is the shared
`lilak_portal_auth.store`, the same one every rack-list service runs on.

Per-user working state (what you ticked, which tabs are open) stays in the
browser and is never sent here.
"""
import os
from pathlib import Path

from fastapi import FastAPI

from lilak_portal_auth.store import Document, mount_spa

DATA = Path(os.environ.get("AUTHOR_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("AUTHOR_DIST_DIR", "/app/author_manager/dist"))

DOC = Document(DATA / "data.json", keys=("authors", "affiliations", "groups", "settings"),
               what="저자 데이터",
               links=(("authors", "affiliations.tag", "affiliations"), ("authors", "groups.group", "groups")))

app = FastAPI(title="author_manager")
DOC.mount(app, project=PROJECT)

# Must stay last: the catch-all would shadow /api/*.
mount_spa(app, DIST, name="author_manager")
