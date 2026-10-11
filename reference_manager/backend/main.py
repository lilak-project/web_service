"""reference_manager backend — one shared document per portal project.

  references  the papers: citeKey, title, authors[], journal, year, tags[], cites[], pdf
  journals    a class with fields of its own (shortName, abbrev)
  authors     a class: one person, a #handle, and the spellings they appear under
  settings    service-wide, e.g. pdfRoots — where a linked PDF may live

The document is stored whole and guarded by a version (lilak_portal_auth.store):
a save edited from an older version is refused with 409 and the current
document, so two people editing at once cannot silently overwrite each other.

The PDFs: a browser cannot open file:///… from an http page, so the service
reads the file for it — only from the roots the project lists, and only after
the path is resolved (store.mount_files). The screen is the kit's RackService.
"""
import os
from pathlib import Path

from fastapi import FastAPI

from lilak_portal_auth.store import Document, mount_files, mount_spa

# The portal hands each project process its own data dir via {project_data}.
DATA = Path(os.environ.get("REFERENCE_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("REFERENCE_DIST_DIR", "/app/reference_manager/dist"))

DOC = Document(DATA / "data.json", keys=("references", "journals", "authors", "settings"),
               what="레퍼런스 데이터")

app = FastAPI(title="reference_manager")
DOC.mount(app, project=PROJECT)
mount_files(app, DOC, setting="pdfRoots", exts=(".pdf",))

# Must stay last: the catch-all would shadow /api/*.
mount_spa(app, DIST, name="reference_manager")
