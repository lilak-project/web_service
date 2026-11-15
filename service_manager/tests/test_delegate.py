"""Delegated tokens (/api/delegate): a service writing in another service for a
person gets a token for that one project, never the person's own.

    cd service_manager && .venv/bin/python tests/test_delegate.py
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

from app import main, permissions, registry, security  # noqa: E402
from app.db import SessionLocal               # noqa: E402

c = TestClient(main.app)


class Delegate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tok = c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"]
        for n in ("inbox", "note"):
            registry.write_manifest(n, {"kind": "rack", "mode": "managed"})

    def ask(self, to, svc="inbox", key=None):
        return c.post("/api/delegate", json={"to": to}, headers={
            "Authorization": f"Bearer {self.tok}", "X-Portal-Service": svc,
            "X-Portal-Service-Key": security.service_key(svc) if key is None else key})

    def test_only_a_started_service_may_ask(self):
        self.assertEqual(self.ask("note/note", key="wrong").status_code, 403)
        self.assertEqual(self.ask("nowhere/x").status_code, 400)

    def test_token_fits_its_scope_only(self):
        r = self.ask("note/note")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["token"]
        p = security.decode_access_token(d)
        self.assertEqual((p["scope"], p["via"]), ("note/note", "inbox"))
        # not a portal session: account APIs refuse it, introspect answers it
        self.assertEqual(c.get("/api/account", headers={"Authorization": f"Bearer {d}"}).status_code, 401)
        self.assertEqual(c.get("/api/introspect", headers={"Authorization": f"Bearer {d}"}).status_code, 200)
        # cannot ask for more delegation with it
        self.assertEqual(c.post("/api/delegate", json={"to": "note/note"}, headers={
            "Authorization": f"Bearer {d}", "X-Portal-Service": "inbox",
            "X-Portal-Service-Key": security.service_key("inbox")}).status_code, 401)
        db = SessionLocal()
        try:
            self.assertIsNotNone(permissions.user_from_request(db, d, "/pp/note/note/api/notes"))
            self.assertIsNone(permissions.user_from_request(db, d, "/pp/note/other/api/notes"))
            self.assertIsNone(permissions.user_from_request(db, d, "/pp/academic_activities/x/api/data"))
        finally:
            db.close()
        # at the proxy, outside its scope it is refused, not handed on as a machine bearer
        from app.routers.proxy import machine_caller

        class Req:
            headers = {"authorization": f"Bearer {d}"}
        self.assertFalse(machine_caller(Req, {"mode": "managed", "identity": {"accepts_portal_token": True}}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
