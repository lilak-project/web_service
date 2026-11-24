"""MCP tokens register as senders before they may put candidates in the inbox (app/senders.py).

    cd service_manager && .venv/bin/python tests/test_senders.py
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

from app import main, mcp_tokens, models, senders   # noqa: E402
from app.db import SessionLocal               # noqa: E402

c = TestClient(main.app)


class Senders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mgr = {"Authorization": "Bearer " + c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"]}
        r = c.post("/api/auth/register", json={"username": "plain", "password": "user-pass-1", "email": "plain@x.org"})
        cls.user = {"Authorization": "Bearer " + r.json()["access_token"]}
        with SessionLocal() as db:
            admin = db.query(models.User).filter_by(username="admin").one()
            for n in ("mail-task", "session-a", "quiet"):
                mcp_tokens.issue(db, n, admin, True, 30)
            cls.tid = {t.name: t.id for t in db.query(models.McpToken).all()}

    def inbox(self):
        return {x["title"]: x for x in c.get("/api/inbox/portal/pending", headers=self.mgr).json()["items"] if x["kind"] == "sender"}

    def act(self, x, **b):
        return c.post(f"/api/inbox/portal/inbox/{x['id']}/decide", headers=self.mgr, json=b).status_code

    def test_1_a_token_applies_and_a_manager_answers(self):
        t = self.tid["session-a"]
        self.assertEqual((senders.info(t)["status"], senders.allowed(t)), (None, False))
        for bad in ({"name": ""}, {"kinds": ["nope"]}, {"kinds": []}, {"reads": "sometimes"}):
            with self.assertRaises(ValueError):
                senders.apply(t, "session-a", "admin", **{"name": "분석 세션", "kinds": ["note"], "reads": "session", **bad})
        self.assertEqual(senders.apply(t, "session-a", "admin", "분석 세션", ["note", "job"], "session")["status"], "waiting")
        card = self.inbox()["분석 세션 (session-a)"]
        self.assertEqual((card["actions"], senders.allowed(t)), (["approve", "hold", "discard"], False))
        # held with an opinion: the token reads it, and applying again (changed) waits again with the thread kept
        self.assertEqual(self.act(card, action="hold", text="잡은 빼 주세요"), 200)
        got = senders.info(t)
        self.assertEqual((got["status"], got["comments"][0]["text"]), ("held", "잡은 빼 주세요"))
        again = senders.apply(t, "session-a", "admin", "분석 세션", ["note"], "session")
        self.assertEqual((again["status"], len(again["comments"])), ("waiting", 1))
        self.assertEqual(self.act(self.inbox()["분석 세션 (session-a)"], action="approve"), 200)
        self.assertEqual((senders.allowed(t), self.inbox()), (True, {}))
        # the same words again change nothing; other words wait for a yes again
        self.assertEqual(senders.apply(t, "session-a", "admin", "분석 세션", ["note"], "session")["status"], "approved")
        self.assertEqual(senders.apply(t, "session-a", "admin", "분석 세션", ["note", "tags"], "session")["status"], "waiting")
        self.assertEqual(self.act(self.inbox()["분석 세션 (session-a)"], action="discard"), 200)
        self.assertEqual((senders.info(t)["status"], senders.allowed(t)), ("rejected", False))

    def test_2_a_manager_registers_changes_and_drops(self):
        t = self.tid["mail-task"]
        put = lambda who, **b: c.post("/api/admin/senders", headers=who, json={"token_id": t, **b})  # noqa: E731
        ok = {"name": "메일 정리", "kinds": ["note", "activity"], "reads": "schedule", "reads_at": "매일 10시·17시"}
        self.assertEqual([put(self.user, **ok).status_code, put(self.mgr, **{**ok, "reads": "x"}).status_code,
                          c.post("/api/admin/senders", headers=self.mgr, json={"token_id": 9999, **ok}).status_code], [403, 400, 404])
        self.assertEqual(put(self.mgr, **ok).status_code, 200)
        self.assertTrue(senders.allowed(t))
        senders.register(self.tid["quiet"], "quiet", "admin", "조용한 작업", ["tags"], "never")
        # what a card shows of its sender, by the token's name; what the list of senders says
        self.assertEqual(c.get("/api/inbox/registered", headers=self.user).json()["mail-task"],
                         {"name": "메일 정리", "reads": "schedule", "reads_at": "매일 10시·17시"})
        rows = {r["name"]: r for r in c.get("/api/inbox/senders", headers=self.mgr).json() if r["type"] == "token"}
        self.assertEqual((rows["mail-task"]["registered"]["name"], rows["mail-task"]["back"], rows["quiet"]["back"]),
                         ("메일 정리", "my_proposals", "none"))
        self.assertEqual({x["name"] for x in c.get("/api/admin/senders", headers=self.mgr).json()["tokens"]} >= {"mail-task", "quiet"}, True)
        self.assertEqual(c.delete(f"/api/admin/senders/{t}", headers=self.mgr).status_code, 200)
        self.assertEqual((senders.allowed(t), "mail-task" in c.get("/api/inbox/registered", headers=self.user).json()), (False, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
