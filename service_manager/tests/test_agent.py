"""AI keys and platform agent runs, on a throwaway data root. The agent CLI is
replaced by a stand-in, so nothing is spent.

    cd service_manager && .venv/bin/python tests/test_agent.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"PORTAL_DATA_ROOT": str(TMP / "data"), "PORTAL_SECRET_KEY": "test-secret",
                   "EMAIL_VERIFY_REQUIRED": "0"})
os.environ.pop("PORTAL_KEYS_SECRET", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient   # noqa: E402

from app import agent_worker, main, mcp_tokens, models, security  # noqa: E402
from app.db import SessionLocal               # noqa: E402

c = TestClient(main.app)


def h(tok):
    return {"Authorization": f"Bearer {tok}"}


class Agent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = h(c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"])
        db = SessionLocal()
        u = models.User(username="pa", email="pa@x.org", password_hash=security.hash_password("pw-pa-1234"),
                        role="user", is_active=True, email_verified=True)
        db.add(u)
        db.commit()
        db.add(models.ServicePermission(user_id=u.id, service_name="jobboard", project="jobboard", is_admin=True))
        db.commit()
        db.close()
        cls.pa = h(c.post("/api/auth/login", json={"username": "pa", "password": "pw-pa-1234"}).json()["access_token"])

    def test_1_keys_and_who_may_aim_them(self):
        r = c.post("/api/agent/keys", headers=self.admin,
                   json={"name": "lab", "provider": "claude", "kind": "api", "secret": "sk-ant-abcdef123", "uses": ["portal"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hint"], "sk-ant-…")
        self.assertNotIn("secret", r.json())
        db = SessionLocal()
        stored = db.get(models.LlmKey, r.json()["id"]).secret
        db.close()
        self.assertNotIn("abcdef", stored)                    # sealed, not plain
        # A project admin: their own project yes, the portal default no.
        self.assertEqual(c.post("/api/agent/keys", headers=self.pa, json={
            "provider": "claude", "kind": "login", "uses": ["portal"]}).status_code, 403)
        r = c.post("/api/agent/keys", headers=self.pa, json={
            "name": "mine", "provider": "claude", "kind": "login", "uses": ["jobboard/jobboard"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.post("/api/agent/keys", headers=self.pa, json={
            "provider": "claude", "kind": "login", "uses": ["note/note"]}).status_code, 403)
        # The project admin sees their key, not the manager's portal key.
        names = [k["name"] for k in c.get("/api/agent/keys", headers=self.pa).json()]
        self.assertEqual(names, ["mine"])

    def test_2_run_through_the_worker(self):
        r = c.post("/api/agent/runs", headers=self.pa, json={
            "service": "jobboard", "project": "jobboard", "task": "look", "approval": "auto"})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        self.assertEqual(c.post("/api/agent/runs", headers=self.pa, json={
            "service": "jobboard", "project": "jobboard", "task": "x", "provider": "openai"}).status_code, 400)
        seen = {}

        def fake(run, prompt, secret, token, cwd):
            seen.update(prompt=prompt, secret=secret, token=token)
            db = SessionLocal()
            row = mcp_tokens.owner_of(db, token)
            seen["scope"], seen["write"] = row[0].scope, row[0].can_write
            db.close()
            return True, "did it", 10, 5, "0.0010"
        agent_worker._claude, real = fake, agent_worker._claude
        try:
            db = SessionLocal()
            self.assertTrue(agent_worker.run_one(db))
            db.close()
        finally:
            agent_worker._claude = real
        self.assertIsNone(seen["secret"])                     # the project's own key ("login") wins
        self.assertEqual((seen["scope"], seen["write"]), ("jobboard/jobboard", True))
        self.assertIn("approve jobs yourself", seen["prompt"])
        db = SessionLocal()
        self.assertIsNone(mcp_tokens.owner_of(db, seen["token"]))   # revoked after the run
        db.close()
        out = c.get(f"/api/agent/runs/{rid}", headers=self.pa).json()
        self.assertEqual((out["status"], out["result"], out["tokens_out"]), ("done", "did it", 5))


if __name__ == "__main__":
    unittest.main(verbosity=2)
