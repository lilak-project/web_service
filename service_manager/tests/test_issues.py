"""Portal issues ↔ GitHub / a main portal (routers/issues.py), with GitHub faked.

    cd service_manager && .venv/bin/python tests/test_issues.py
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.update({
    "PORTAL_DATA_ROOT": str(Path(tempfile.mkdtemp()) / "data"),
    "PORTAL_SECRET_KEY": "test-secret",
    "EMAIL_VERIFY_REQUIRED": "0",
    "SERVICE_PORT_START": "8272", "SERVICE_PORT_END": "8279",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient            # noqa: E402

from app import main, models                         # noqa: E402
from app.db import SessionLocal                      # noqa: E402
from app.deps import portal_token                    # noqa: E402
from app.routers import issues                       # noqa: E402

c = TestClient(main.app)
SECRET = "hook-secret"


class FakeGitHub:
    def __init__(self, *_):
        self.sent = []

    def open(self, db, r):
        self.sent.append(("open", r.kind, r.subject))
        return 100 + r.id

    def comment(self, db, r, c):
        self.sent.append(("comment", r.ext_id, c.body))
        return 9000 + c.id

    def state(self, r):
        self.sent.append(("state", r.ext_id, r.status))


def hook(event, payload, secret=SECRET):
    raw = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return c.post("/api/github/webhook", content=raw,
                  headers={"X-Hub-Signature-256": sig, "X-GitHub-Event": event, "Content-Type": "application/json"})


class Issues(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert c.post("/api/auth/setup", json={"password": "admin-pass-1"}).status_code == 200
        with SessionLocal() as db:
            cls.h = {"Authorization": "Bearer " + portal_token(db.query(models.User).filter_by(username="admin").one())}
        cls.gh = FakeGitHub()
        issues._GitHub = lambda *a: cls.gh

    def setUp(self):
        self.gh.sent.clear()
        for k in ("GITHUB_ISSUES_TOKEN", "GITHUB_ISSUES_REPO", "GITHUB_WEBHOOK_SECRET"):
            os.environ.pop(k, None)

    def github_on(self):
        os.environ.update(GITHUB_ISSUES_TOKEN="t", GITHUB_ISSUES_REPO="lilak-project/web_service",
                          GITHUB_WEBHOOK_SECRET=SECRET)

    def report(self, **kw):
        return c.post("/api/reports", headers=self.h, json={"kind": "bug", "subject": "s", "body": "b", **kw}).json()

    def test_off_sends_nothing(self):
        self.report()
        self.assertEqual(issues.sweep(), "off")
        self.assertEqual(self.gh.sent, [])

    def test_to_github_and_back(self):
        self.github_on()
        old = self.report(subject="예전 것")
        issues.sweep()                                                             # the link starts here
        self.assertEqual(self.gh.sent, [])                                         # older reports stay
        bug, local = self.report(subject="깨짐"), self.report(kind="local", subject="여기만")
        self.assertEqual(issues.sweep(), "github")
        self.assertIn(("open", "bug", "깨짐"), self.gh.sent)
        self.assertNotIn("여기만", str(self.gh.sent))                              # local stays here
        num = str(100 + bug["id"])
        c.post(f"/api/reports/{bug['id']}/comments", headers=self.h, json={"body": "보는 중"})
        c.post(f"/api/admin/reports/{bug['id']}/resolve", headers=self.h, json={"resolved": True})
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [("comment", num, "보는 중"), ("state", num, "resolved")])
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [])                                         # nothing twice

        repo = {"full_name": "lilak-project/web_service"}
        self.assertEqual(hook("issue_comment", {}, secret="wrong").status_code, 401)
        hook("issue_comment", {"action": "created", "repository": repo, "issue": {"number": int(num)},
                               "comment": {"id": 77, "body": "고쳤어요", "user": {"login": "octo"}}})
        hook("issue_comment", {"action": "created", "repository": repo, "issue": {"number": int(num)},
                               "comment": {"id": 78, "body": "x\n" + issues.MARK, "user": {"login": "bot"}}})
        hook("issues", {"action": "reopened", "repository": repo, "issue": {"number": int(num)}})
        r = next(x for x in c.get("/api/admin/reports", headers=self.h).json() if x["id"] == bug["id"])
        self.assertEqual([(x["author"], x["origin"]) for x in r["comments"]], [("admin", ""), ("octo", "github")])
        self.assertEqual(r["status"], "open")
        self.assertEqual(r["upstream"]["url"], f"https://github.com/lilak-project/web_service/issues/{num}")
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [])                                         # GitHub's own news is not echoed

        c.put("/api/admin/issues/kinds", headers=self.h, json={"kinds": {"local": True, "inquiry": False}})
        issues.sweep()
        self.assertIn(("open", "local", "여기만"), self.gh.sent)

    def test_pairing_and_relay(self):
        ask = c.post("/api/issues/link/requests", json={"from_url": "https://sub.lab", "from_name": "sub1", "by": "kim"}).json()
        st = c.get("/api/admin/issues", headers=self.h).json()
        self.assertEqual([r["pin"] for r in st["requests"]], [ask["pin"]])
        self.assertEqual(c.get(f"/api/issues/link/requests/{ask['id']}?claim=nope").status_code, 404)
        c.post(f"/api/admin/issues/requests/{ask['id']}", headers=self.h, json={"action": "approve"})
        got = c.get(f"/api/issues/link/requests/{ask['id']}?claim={ask['claim']}").json()
        self.assertIn("token", got)
        self.assertNotIn("token", c.get(f"/api/issues/link/requests/{ask['id']}?claim={ask['claim']}").json())   # once
        sub = {"Authorization": "Bearer " + got["token"]}

        self.assertEqual(c.post("/api/issues/relay/reports", json={"id": 1}).status_code, 401)
        body = {"id": 5, "kind": "bug", "subject": "원격", "body": "b", "author": "kim",
                "attachments": [{"name": "a.png", "url": "https://sub.lab/api/reports/5/files/x"}]}
        rid = c.post("/api/issues/relay/reports", headers=sub, json=body).json()["id"]
        self.assertEqual(c.post("/api/issues/relay/reports", headers=sub, json=body).json()["id"], rid)   # once
        c.post(f"/api/issues/relay/reports/{rid}/comments", headers=sub, json={"id": 1, "author": "kim", "body": "덧붙임"})
        c.post(f"/api/issues/relay/reports/{rid}/comments", headers=sub, json={"id": 1, "author": "kim", "body": "덧붙임"})
        c.post(f"/api/reports/{rid}/comments", headers=self.h, json={"body": "main 답"})
        c.post(f"/api/issues/relay/reports/{rid}/state", headers=sub, json={"resolved": True})
        u = c.get("/api/issues/relay/updates?after=0", headers=sub).json()
        self.assertEqual(u["reports"], [{"id": rid, "status": "resolved"}])
        self.assertEqual([x["body"] for x in u["comments"]], ["main 답"])             # not its own back
        self.assertEqual(c.get(f"/api/issues/relay/updates?after={u['cursor']}", headers=sub).json()["comments"], [])
        r = next(x for x in c.get("/api/admin/reports", headers=self.h).json() if x["id"] == rid)
        self.assertEqual((r["username"], r["origin"]), ("kim", "sub1"))
        self.assertIn("a.png", r["body"])

        c.delete("/api/admin/issues/subs/sub1", headers=self.h)
        self.assertEqual(c.get("/api/issues/relay/updates", headers=sub).status_code, 401)

    def test_sub_takes_mains_side(self):
        with SessionLocal() as db:
            r = models.Report(user_id=1, kind="bug", subject="x", ext_id="42", ext_state="open")
            db.add(r)
            db.commit()
            rid = r.id

        class Up:
            name = "main.lab"

            def updates(self, after):
                return {"reports": [{"id": 42, "status": "resolved"}], "cursor": 8,
                        "comments": [{"id": 8, "report_id": 42, "author": "octo", "origin": "github", "body": "됨"}]}
        with SessionLocal() as db:
            issues._pull(db, Up())
            issues._pull(db, Up())
        r = next(x for x in c.get("/api/admin/reports", headers=self.h).json() if x["id"] == rid)
        self.assertEqual((r["status"], [x["body"] for x in r["comments"]]), ("resolved", ["됨"]))
        self.assertEqual(issues._read()["cursor"], 8)


if __name__ == "__main__":
    unittest.main()
