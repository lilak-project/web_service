"""mount_folders / mount_files: a folder by its name, a file by its path —
nothing outside the roots.

    service_manager/.venv/bin/python lilak_portal_auth/test_store_folders.py
"""
import os
import tempfile
import unicodedata
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lilak_portal_auth import identity
from lilak_portal_auth.store import Document, mount_files, mount_folders


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

    # adopting: by listed name, by a path deeper in the root; never from outside
    (root / "old name").mkdir()
    (root / "deep" / "talk").mkdir(parents=True)
    (tmp / "outside").mkdir()
    assert c.post("/api/folders/adopt", json={"source": "old name", "name": "Academic_C"}).status_code == 200
    assert (root / "Academic_C").is_dir() and not (root / "old name").exists()
    assert c.post("/api/folders/adopt", json={"source": str(root / "deep" / "talk"), "name": "Academic_D"}).status_code == 200
    assert (root / "Academic_D").is_dir()
    for src, name in [(str(tmp / "outside"), "Academic_E"), (str(root), "Academic_E"),
                      ("Academic_C", "Academic_A"), ("Academic_C", "../x")]:
        assert c.post("/api/folders/adopt", json={"source": src, "name": name}).status_code in (404, 409, 422), (src, name)
    assert (tmp / "outside").is_dir()
    # by a bare name, as a browser reports a folder dropped from Finder
    (root / "deep" / "slides 2024").mkdir()
    assert c.post("/api/folders/adopt", json={"source": "slides 2024", "name": "Academic_F"}).status_code == 200
    assert (root / "Academic_F").is_dir()
    (root / "a" / "twin").mkdir(parents=True)
    (root / "b" / "twin").mkdir(parents=True)
    assert c.post("/api/folders/adopt", json={"source": "twin", "name": "Academic_G"}).status_code == 409
    assert c.post("/api/folders/adopt", json={"source": "outside", "name": "Academic_G"}).status_code == 404
    kinds_check()
    files_check()
    print("ok")


def kinds_check():
    """Several roots, one per kind: a new folder goes where its kind already is."""
    tmp = Path(tempfile.mkdtemp())
    acad, prop = tmp / "01 Academic", tmp / "07 Proposal"
    (acad / "Academic_20240101_X").mkdir(parents=True)
    (prop / "Proposal_20240101_Y").mkdir(parents=True)
    doc = Document(tmp / "d.json", keys=("items", "settings"))
    d = doc.read()
    d["settings"] = {"folderRoots": [str(acad), str(prop)]}
    doc.write(d)
    app = FastAPI()
    app.dependency_overrides[identity] = lambda: {}
    mount_folders(app, doc)
    c = TestClient(app)
    assert set(c.get("/api/folders").json()["dirs"]) == {"Academic_20240101_X", "Proposal_20240101_Y"}
    assert c.post("/api/folders/make", json={"name": "Proposal_20261007_Z"}).status_code == 200
    assert (prop / "Proposal_20261007_Z").is_dir()
    assert c.post("/api/folders/make", json={"name": "PAC_20261208_W"}).status_code == 200
    assert (acad / "PAC_20261208_W").is_dir()        # no PAC_ yet: the first root


def files_check():
    tmp = Path(tempfile.mkdtemp())
    root = tmp / "papers"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "JAlmeid_ApJ_1983.pdf").write_bytes(b"%PDF")
    (tmp / "x.pdf").write_bytes(b"no")
    os.symlink(tmp / "x.pdf", root / "escape.pdf")
    doc = Document(tmp / "d.json", keys=("references", "settings"))
    d = doc.read()
    d["settings"] = {"pdfRoots": [str(root)]}
    doc.write(d)
    app = FastAPI()
    app.dependency_overrides[identity] = lambda: {}
    mount_files(app, doc, setting="pdfRoots")
    c = TestClient(app)
    assert c.get("/api/scan").json()["files"]["JAlmeid_ApJ_1983"] == ["sub/JAlmeid_ApJ_1983.pdf"]
    assert c.get("/api/file", params={"path": "sub/JAlmeid_ApJ_1983.pdf"}).content == b"%PDF"
    for bad in ["escape.pdf", "../x.pdf", str(tmp / "x.pdf")]:
        assert c.get("/api/file", params={"path": bad}).status_code == 404, bad
    assert c.get("/api/realpath", params={"path": "sub/JAlmeid_ApJ_1983.pdf"}).json()["name"] == "JAlmeid_ApJ_1983.pdf"


if __name__ == "__main__":
    main()
