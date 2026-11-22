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
        for sv in ("note", "authors"):
            db.add(models.ServicePermission(user_id=ids["pa"], service_name=sv, project="p1", is_admin=True))
        db.add(models.ServicePermission(user_id=ids["other"], service_name="note", project="p1", is_admin=True))
        db.commit()
        db.close()
        cls.ids = ids
        registry.write_share_sets([{"id": "s1", "name": "s", "members": {"note": "p1", "authors": "p1"}}])
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


    def test_mcp_tokens_for_a_set_admin(self):
        u = "/api/share-sets/mcp-tokens"
        self.assertEqual(c.get(u, params={"set": "s1"}, headers=self.other).status_code, 403)
        self.assertEqual(c.post(u, json={"set": "s1", "can_write": True}, headers=self.other).status_code, 403)
        r = c.post(u, json={"set": "s1", "can_write": True}, headers=self.pa)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue(r.json()["token"].startswith("lpm_"))
        rows = c.get(u, params={"set": "s"}, headers=self.pa).json()
        self.assertEqual([(t["scope"], t["owner"]) for t in rows], [("set:s1", "pa")])   # bound by id, the issuer's own
        self.assertEqual(c.get("/api/admin/mcp-tokens", headers=self.pa).status_code, 403)  # the whole list stays a manager's
        self.assertEqual(c.delete(f"{u}/{rows[0]['id']}", params={"set": "s1"}, headers=self.other).status_code, 403)
        self.assertEqual(c.delete(f"{u}/{rows[0]['id']}", params={"set": "s1"}, headers=self.pa).status_code, 200)
        self.assertTrue(c.get(u, params={"set": "s1"}, headers=self.mgr).json()[0]["revoked"])

    def test_zz_the_last_admin_stays_unless_a_manager_says(self):
        off = lambda who, uid: c.post("/api/share-sets/admins", json={"set": "s1", "user_id": uid, "admin": False}, headers=who).status_code  # noqa: E731
        self.assertEqual(off(self.pa, self.ids["pa"]), 409)                     # pa is the only one: not even themselves
        c.post("/api/share-sets/admins", json={"set": "s1", "user_id": self.ids["new"], "admin": True}, headers=self.pa)
        self.assertEqual(off(self.pa, self.ids["new"]), 200)                    # another admin remains (pa)
        self.assertEqual(off(self.mgr, self.ids["pa"]), 200)                    # a manager may empty it

    def test_zzz_a_service_a_set_hid_comes_back_when_it_leaves_every_set(self):
        from app.routers import home, project_mgmt
        project_mgmt._hide_joined(["project_manager"])
        d = home._read(); d["hidden_services"].append("byhand"); home._write(d)
        registry.write_share_sets([{"id": "s2", "name": "t", "members": {"project_manager": "p1", "note": "p1"}}])
        project_mgmt._show_left()
        self.assertIn("project_manager", home.hidden_services())                # still in a set
        registry.write_share_sets([{"id": "s2", "name": "t", "members": {"note": "p1"}}])
        project_mgmt._show_left()
        self.assertEqual(home.hidden_services(), {"byhand"})                    # a manager's own hide is not undone

    def test_zzzz_only_the_sets_project_card_is_hidden(self):
        from app import config
        from app.routers import home, project_mgmt, projects
        for p in ("inset", "free"):
            (config.DATA_ROOT / "project_manager" / "projects" / p).mkdir(parents=True, exist_ok=True)
        registry.write_share_sets([{"id": "s3", "name": "u", "members": {"project_manager": "inset"}}])
        project_mgmt._hide_joined(["project_manager"])
        d = home._read(); d["split_cards"] = ["project_manager"]; home._write(d)
        db = SessionLocal()
        mgr = db.query(models.User).filter_by(role="manager").first()
        cards = projects.split_cards([{"name": "project_manager", "multi_project": True, "hidden": True, "label": "p", "labels": None}], mgr, db)
        db.close()
        self.assertEqual({c["project_card"]: c["hidden"] for c in cards}, {"inset": True, "free": False})


if __name__ == "__main__":
    unittest.main(verbosity=2)
