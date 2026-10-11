"""mount_folders: a folder by its name, files only inside it.

    service_manager/.venv/bin/python lilak_portal_auth/test_store_folders.py
"""
import os
import tempfile
import unicodedata
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lilak_portal_auth import identity
from lilak_portal_auth.store import Document, mount_folders


def main():
    tmp = Path(tempfile.mkdtemp())
    root = tmp / "root"
    (root / unicodedata.normalize("NFD", "Academic_한글")).mkdir(parents=True)
    rec = root / "Academic_A"
    (rec / "sub").mkdir(parents=True)
    (rec / "talk.pdf").write_bytes(b"%PDF-1.4")
    (rec / "sub" / "note.txt").write_text("hi")
    (rec / ".DS_Store").write_text("x")
    (tmp / "secret.txt").write_text("no")
    os.symlink(tmp / "secret.txt", rec / "escape.txt")

    doc = Document(tmp / "data.json", keys=("items", "settings"))
    d = doc.read()
    d["settings"] = {"folderRoots": [str(root)]}
    doc.write(d)

    app = FastAPI()
    app.dependency_overrides[identity] = lambda: {"email": "t@t"}
    mount_folders(app, doc)
    c = TestClient(app)

    dirs = c.get("/api/folders").json()["dirs"]
    assert set(dirs) == {"Academic_A", "Academic_한글"}, dirs          # NFC names

    files = [f["path"] for f in c.get("/api/folders/list", params={"name": "Academic_A"}).json()["files"]]
    assert "talk.pdf" in files and "sub/note.txt" in files and ".DS_Store" not in files, files

    r = c.get("/api/folders/file", params={"name": "Academic_A", "path": "talk.pdf"})
    assert r.status_code == 200 and r.content == b"%PDF-1.4" and "inline" in r.headers["content-disposition"]
    r = c.get("/api/folders/file", params={"name": "Academic_A", "path": "talk.pdf", "download": 1})
    assert "attachment" in r.headers["content-disposition"]

    for name, path in [("Academic_A", "../../secret.txt"), ("Academic_A", "escape.txt"),
                       ("..", "secret.txt"), ("/", "etc/passwd"), ("nope", "x")]:
        assert c.get("/api/folders/file", params={"name": name, "path": path}).status_code == 404, (name, path)

    for bad in ["", ".hidden", "a/b", "..", "Academic_A"]:
        assert c.post("/api/folders/make", json={"name": bad}).status_code in (409, 422), bad
    assert c.post("/api/folders/make", json={"name": "Academic_B"}).status_code == 200
    assert (root / "Academic_B").is_dir()
    print("ok")


if __name__ == "__main__":
    main()
