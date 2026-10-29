"""The rack store's gate: who may read and write, and what the folder settings
may reach.

    service_manager/.venv/bin/python lilak_portal_auth/test_store_security.py
"""
import os
import tempfile
import time
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ["PORTAL_SECRET_KEY"] = "test-secret"
os.environ["PORTAL_DATA_ROOT"] = str(TMP / "data")
os.environ.pop("PORTAL_PORT", None)          # no portal to introspect: token claims stand

from fastapi import FastAPI                  # noqa: E402
from fastapi.testclient import TestClient    # noqa: E402
from jose import jwt                         # noqa: E402

from lilak_portal_auth.store import Document, mount_files, mount_spa  # noqa: E402


def token(role="user", **extra):
    claims = {"sub": "1", "username": "kim", "email": "kim@x", "role": role,
              "portal": True, "exp": time.time() + 600, **extra}
    return jwt.encode(claims, "test-secret", algorithm="HS256")


def auth(role="user"):
    return {"Authorization": f"Bearer {token(role)}"}


class StoreGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = Path(os.environ["PORTAL_DATA_ROOT"])
        (data / "_portal").mkdir(parents=True)
        (data / "_portal" / "secret.key").write_text("test-secret")
        cls.pdfs = TMP / "pdfs"
        cls.pdfs.mkdir()
        (cls.pdfs / "a.pdf").write_bytes(b"%PDF")
        (cls.pdfs / "notes.txt").write_text("not a pdf")
        dist = TMP / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<html>index</html>")
        (TMP / "outside.txt").write_text("outside")

        doc = Document(TMP / "store.json", keys=("items", "settings"))
        d = doc.read()
        d["settings"] = {"pdfRoots": [str(cls.pdfs)]}
        doc.write(d)
        app = FastAPI()
        doc.mount(app)
        mount_files(app, doc, setting="pdfRoots", exts=(".pdf",))
        mount_spa(app, dist)
        cls.c = TestClient(app)

    def put(self, body, headers):
        cur = self.c.get("/api/data", headers=auth("manager")).json()
        return self.c.put("/api/data", json={**body, "baseVersion": cur.get("version", 0)}, headers=headers)

    def test_anonymous_is_refused(self):
        self.assertEqual(self.c.get("/api/data").status_code, 401)
        self.assertEqual(self.c.put("/api/data", json={"items": []}).status_code, 401)
        self.assertEqual(self.c.get("/api/file", params={"path": "a.pdf"}).status_code, 401)

    def test_made_up_or_forged_token_is_refused(self):
        self.assertEqual(self.c.get("/api/data", headers={"Authorization": "Bearer x"}).status_code, 401)
        forged = jwt.encode({"role": "manager", "exp": time.time() + 600}, "wrong", algorithm="HS256")
        self.assertEqual(self.c.get("/api/data", headers={"Authorization": f"Bearer {forged}"}).status_code, 401)

    def test_whoami_stays_open(self):
        r = self.c.get("/api/whoami")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["authenticated"])

    def test_signed_in_user_reads_and_writes(self):
        self.assertEqual(self.c.get("/api/data", headers=auth()).status_code, 200)
        r = self.put({"items": [{"id": "1", "name": "x"}]}, auth())
        self.assertEqual(r.status_code, 200, r.text)

    def test_user_cannot_move_folder_roots(self):
        r = self.put({"settings": {"pdfRoots": ["/"]}}, auth())
        self.assertEqual(r.status_code, 403, r.text)

    def test_roots_never_reach_portal_private_folder(self):
        data = os.environ["PORTAL_DATA_ROOT"]
        r = self.put({"settings": {"pdfRoots": [str(self.pdfs), data, "/"]}}, auth("manager"))
        self.assertEqual(r.status_code, 200, r.text)
        secret = str(Path(data) / "_portal" / "secret.key")
        self.assertEqual(self.c.get("/api/file", params={"path": secret}, headers=auth()).status_code, 404)
        self.put({"settings": {"pdfRoots": [str(self.pdfs)]}}, auth("manager"))

    def test_only_listed_extensions_are_served(self):
        self.assertEqual(self.c.get("/api/file", params={"path": "a.pdf"}, headers=auth()).status_code, 200)
        self.assertEqual(self.c.get("/api/file", params={"path": "notes.txt"}, headers=auth()).status_code, 404)

    def test_desktop_reveal_is_for_managers(self):
        self.assertEqual(self.c.post("/api/reveal", json={"path": "a.pdf"}, headers=auth()).status_code, 403)

    def test_spa_does_not_serve_outside_dist(self):
        r = self.c.get("/%2e%2e/outside.txt")
        self.assertNotIn("outside", r.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
