"""A share set's admins: a manager, or whoever administers every project of the
set, makes someone admin of all its projects at once (or takes them off).

    cd service_manager && .venv/bin/python tests/test_set_admins.py
"""
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


class SetAdmins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mgr = h(c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"])
        db = SessionLocal()
        ids = {}
        for n in ("pa", "other", "new"):
            u = models.User(username=n, email=f"{n}@x.org", password_hash=security.hash_password(f"pw-{n}-1234"),
                            role="user", is_active=True, email_verified=True)
            db.add(u)
            db.commit()
            ids[n] = u.id
        # pa administers both projects of set "s"; other only one
        for sv in ("note", "author_manager"):
            db.add(models.ServicePermission(user_id=ids["pa"], service_name=sv, project="p1", is_admin=True))
        db.add(models.ServicePermission(user_id=ids["other"], service_name="note", project="p1", is_admin=True))
        db.commit()
        db.close()
        cls.ids = ids
        registry.write_share_sets([{"id": "s1", "name": "s", "members": {"note": "p1", "author_manager": "p1"}}])
        login = lambda n: h(c.post("/api/auth/login", json={"username": n, "password": f"pw-{n}-1234"}).json()["access_token"])  # noqa: E731
        cls.pa, cls.other = login("pa"), login("other")

    def test_who_may(self):
        self.assertEqual(c.get("/api/share-sets/admins", params={"set": "s1"}, headers=self.pa).status_code, 200)
        self.assertEqual(c.get("/api/share-sets/admins", params={"set": "s1"}, headers=self.other).status_code, 403)
        self.assertEqual(c.post("/api/share-sets/admins", json={"set": "s1", "user_id": self.ids["new"], "admin": True},
                                headers=self.other).status_code, 403)
        self.assertEqual(c.get("/api/share-sets/admins", params={"set": "nope"}, headers=self.mgr).status_code, 404)

    def test_all_projects_at_once(self):
        r = c.post("/api/share-sets/admins", json={"set": "s", "user_id": self.ids["new"], "admin": True}, headers=self.pa)
        self.assertEqual(r.status_code, 200, r.text)
        row = next(u for u in c.get("/api/share-sets/admins", params={"set": "s1"}, headers=self.mgr).json() if u["username"] == "new")
        self.assertEqual(len(row["admin_scopes"]), 2)
        c.post("/api/share-sets/admins", json={"set": "s1", "user_id": self.ids["new"], "admin": False}, headers=self.mgr)
        db = SessionLocal()
        rows = db.query(models.ServicePermission).filter_by(user_id=self.ids["new"]).all()
        db.close()
        self.assertEqual((len(rows), any(r.is_admin for r in rows)), (2, False))   # off as admin, way in kept


if __name__ == "__main__":
    unittest.main(verbosity=2)
