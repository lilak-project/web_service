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
        for n in ("inbox", "note", "author_manager"):
            registry.write_manifest(n, {"kind": "rack", "mode": "managed",
                                        **({"capabilities": {"delegates": ["note"]}} if n == "inbox" else {})})

    def ask(self, to, svc="inbox", key=None):
        return c.post("/api/delegate", json={"to": to}, headers={
            "Authorization": f"Bearer {self.tok}", "X-Portal-Service": svc,
            "X-Portal-Service-Key": security.service_key(svc) if key is None else key})

    def test_only_a_started_service_may_ask(self):
        self.assertEqual(self.ask("note/note", key="wrong").status_code, 403)
        self.assertEqual(self.ask("nowhere/x").status_code, 400)

    def test_only_where_the_asking_service_is_registered_to_write(self):
        self.assertEqual(self.ask("note/note").status_code, 200)
        self.assertEqual(self.ask("author_manager/x").status_code, 403)        # inbox does not write there
        self.assertEqual(self.ask("inbox/inbox", svc="note").status_code, 403)   # note declares nowhere

    def test_an_update_brings_a_capability_the_seed_declares(self):
        import json
        from app.routers import store
        registry.write_manifest("older", {"kind": "rack", "mode": "managed", "capabilities": {"badge": False}})
        seed = TMP / "seed.json"
        seed.write_text(json.dumps({"capabilities": {"badge": True, "delegates": ["note"]}}))
        store._jobs["job"] = {"log": []}
        store._new_capabilities("job", "older", seed)
        caps = registry.read_manifest("older")["capabilities"]
        self.assertEqual((caps["badge"], caps["delegates"]), (False, ["note"]))   # what it had stays; the new one is added

    def test_an_expired_portal_token_is_not_a_machine_bearer(self):
        from app.routers.proxy import machine_caller
        old = security.create_access_token(1, "admin", "manager", extra={"portal": True}, minutes=-5)
        self.assertIsNone(security.decode_access_token(old))
        mk = lambda t: type("Req", (), {"headers": {"authorization": f"Bearer {t}"}})  # noqa: E731
        m = {"mode": "managed", "identity": {"accepts_portal_token": True}}
        self.assertFalse(machine_caller(mk(old), m))
        self.assertTrue(machine_caller(mk("some-device-key"), m))                # a service's own bearer still passes

    def test_a_service_reads_the_project_of_a_delegated_token(self):
        import importlib
        os.environ.update({"PORTAL_SERVICE": "note", "PORTAL_PROJECT": "note"})
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lilak_portal_auth"))
        import lilak_portal_auth as lpa
        importlib.reload(lpa)
        lpa._PORTAL_PORT = None                       # no portal to ask: the token's own claims
        req = lambda t: type("Req", (), {"cookies": {}})()  # noqa: E731
        ok = self.ask("note/note").json()["token"]
        self.assertTrue(lpa.identity(req(ok), f"Bearer {ok}")["authenticated"])
        os.environ["PORTAL_PROJECT"] = "other"
        self.assertFalse(lpa.identity(req(ok), f"Bearer {ok}")["authenticated"])
        os.environ.pop("PORTAL_PROJECT"); os.environ.pop("PORTAL_SERVICE")

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
