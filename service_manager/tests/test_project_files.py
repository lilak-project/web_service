"""A service's per-project settings files (manifest capabilities.project_files):
only a manager reads or writes them, only the declared names, never a path.

    cd service_manager && .venv/bin/python tests/test_project_files.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"PORTAL_DATA_ROOT": str(TMP / "data"), "PORTAL_SECRET_KEY": "test-secret",
                   "EMAIL_VERIFY_REQUIRED": "0"})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient   # noqa: E402

from app import main, models, registry, security  # noqa: E402
from app.db import SessionLocal               # noqa: E402

c = TestClient(main.app)


def h(tok):
    return {"Authorization": f"Bearer {tok}"}


class ProjectFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mgr = h(c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"])
        d = registry.service_dir("viewer")
        (d / "projects" / "p1").mkdir(parents=True)
        (d / "service.json").write_text(json.dumps({"kind": "monitor", "mode": "managed", "capabilities": {
            "multi_project": True, "project_files": [{"file": "browse-path", "en": "Folders"}, {"file": "../x"}]}}))
        db = SessionLocal()
        u = models.User(username="u", email="u@x.org", password_hash=security.hash_password("pw-u-12345"),
                        role="user", is_active=True, email_verified=True)
        db.add(u)
        db.commit()
        db.add(models.ServicePermission(user_id=u.id, service_name="viewer", project="p1", is_admin=True))
        db.commit()
        db.close()
        cls.user = h(c.post("/api/auth/login", json={"username": "u", "password": "pw-u-12345"}).json()["access_token"])

    def test_manager_edits_declared_file(self):
        self.assertEqual([f["file"] for f in c.get("/api/services/viewer/project-files", headers=self.mgr).json()], ["browse-path"])
        r = c.put("/api/services/viewer/projects/p1/files/browse-path", json={"text": "/data\n/acq"}, headers=self.mgr)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((registry.service_dir("viewer") / "projects/p1/browse-path").read_text(), "/data\n/acq\n")
        self.assertEqual(c.get("/api/services/viewer/projects/p1/files/browse-path", headers=self.mgr).json()["text"], "/data\n/acq\n")

    def test_refused(self):
        # a project admin is not a manager: the file sets what the service may read on the host
        self.assertIn(c.put("/api/services/viewer/projects/p1/files/browse-path", json={"text": "/"}, headers=self.user).status_code, (401, 403))
        self.assertEqual(c.get("/api/services/viewer/projects/p1/files/service.json", headers=self.mgr).status_code, 404)
        self.assertEqual(c.get("/api/services/viewer/projects/nope/files/browse-path", headers=self.mgr).status_code, 404)


if __name__ == "__main__":
    unittest.main()
