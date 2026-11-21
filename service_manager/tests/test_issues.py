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
REPO = {"full_name": "lilak-project/web_service"}


class FakeGitHub:
    def __init__(self):
        self.sent = []

    def open(self, db, r):
        self.sent.append(("open", r.subject, tuple(json.loads(r.labels_json))))
        return 100 + r.id, 100 + r.id

    def update(self, db, r):
        self.sent.append(("update", r.subject, r.status, r.state_reason, tuple(json.loads(r.labels_json))))

    def comment(self, db, r, c):
        self.sent.append(("comment", c.body))
        return 9000 + c.id

    def edit_comment(self, r, c):
        self.sent.append(("edit", c.body))

    def delete_comment(self, r, c):
        self.sent.append(("delete", c.ext_id))


def hook(event, payload, secret=SECRET):
    raw = json.dumps({"repository": REPO, "sender": {"login": "octo"}, **payload}).encode()
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

    def get(self, rid):
        return next(x for x in c.get("/api/admin/reports", headers=self.h).json() if x["id"] == rid)

    def test_strip_post_gives_back_what_was_written(self):
        t = issues._post_text("kim", "lab", "본문\n\n둘째", "\n- [a](u)")
        self.assertEqual(issues.strip_post(t), "본문\n\n둘째")
        self.assertEqual(issues.strip_post(issues._post_text("kim", "lab", "—")), "")
        self.assertEqual(issues.strip_post("**x** (y):\n\nsomeone else's"), "**x** (y):\n\nsomeone else's")

    def test_off_sends_nothing(self):
        self.report()
        self.assertEqual(issues.sweep(), "off")
        self.assertEqual(self.gh.sent, [])

    def test_to_github_and_back(self):
        self.github_on()
        self.report(subject="예전 것")
        issues.sweep()                                                             # the link starts here
        self.assertEqual(self.gh.sent, [])                                         # older issues stay
        bug, local = self.report(subject="깨짐"), self.report(kind="local", subject="여기만")
        self.assertEqual(issues.sweep(), "github")
        self.assertEqual(self.gh.sent, [("open", "깨짐", ("bug", f"server:{issues.server_name()}"))])   # local stays
        rid, num = bug["id"], 100 + bug["id"]
        self.assertEqual(self.get(rid)["number"], num)

        cm = c.post(f"/api/reports/{rid}/comments", headers=self.h, json={"body": "보는 중"}).json()["comments"][0]
        c.put(f"/api/reports/{rid}/comments/{cm['id']}", headers=self.h, json={"body": "보는 중 (고침)"})
        c.put(f"/api/reports/{rid}", headers=self.h, json={"subject": "깨짐: 표"})
        c.put(f"/api/admin/reports/{rid}/labels", headers=self.h, json={"labels": ["bug", "ui"]})
        c.post(f"/api/admin/reports/{rid}/resolve", headers=self.h, json={"resolved": True, "reason": "not_planned"})
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [("comment", "보는 중 (고침)"),
                                        ("update", "깨짐: 표", "resolved", "not_planned", ("bug", "ui"))])
        c.delete(f"/api/reports/{rid}/comments/{cm['id']}", headers=self.h)
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [("delete", str(9000 + cm["id"]))])
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [])                                         # nothing twice
        r = self.get(rid)
        self.assertEqual([e["kind"] for e in r["events"]], ["renamed", "labeled", "unlabeled", "closed"])
        self.assertEqual((r["closed_by"], r["comments"], bool(r["edited_at"])), ("admin", [], True))

        # GitHub's side: signed only; our own echo changes nothing; theirs lands under their login
        self.assertEqual(hook("issue_comment", {}, secret="wrong").status_code, 401)
        n_events = len(self.get(rid)["events"])
        hook("issues", {"action": "closed", "issue": {"number": num, "title": "깨짐: 표", "state": "closed",
                                                      "state_reason": "not_planned", "labels": [{"name": "bug"}, {"name": "ui"}],
                                                      "body": issues._post_text("admin", "lab", "b")}})
        self.assertEqual(len(self.get(rid)["events"]), n_events)
        hook("issue_comment", {"action": "created", "issue": {"number": num},
                               "comment": {"id": 77, "body": "고쳤어요", "user": {"login": "octo"}}})
        hook("issue_comment", {"action": "created", "issue": {"number": num},
                               "comment": {"id": 78, "body": "x\n" + issues.MARK, "user": {"login": "bot"}}})
        hook("issue_comment", {"action": "edited", "issue": {"number": num},
                               "comment": {"id": 77, "body": "고쳤어요!", "user": {"login": "octo"}}})
        hook("issues", {"action": "reopened", "issue": {"number": num, "title": "표가 깨짐", "state": "open",
                                                        "labels": [{"name": "bug"}], "body": "새 본문"}})
        r = self.get(rid)
        self.assertEqual([(x["author"], x["origin"], x["body"]) for x in r["comments"]], [("octo", "github", "고쳤어요!")])
        self.assertEqual((r["status"], r["subject"], r["body"], r["labels"]), ("open", "표가 깨짐", "새 본문", ["bug"]))
        self.assertEqual(r["events"][-1]["actor"], "octo")
        self.assertEqual(r["upstream"]["url"], f"https://github.com/lilak-project/web_service/issues/{num}")
        hook("issue_comment", {"action": "deleted", "issue": {"number": num}, "comment": {"id": 77, "body": ""}})
        self.assertEqual(self.get(rid)["comments"], [])
        self.gh.sent.clear()
        issues.sweep()
        self.assertEqual(self.gh.sent, [])                                         # GitHub's own news is not echoed

        # an unsent change here wins over GitHub's
        c.put(f"/api/reports/{rid}", headers=self.h, json={"subject": "여기서 고침"})
        hook("issues", {"action": "edited", "issue": {"number": num, "title": "저기서 고침", "state": "open", "body": "새 본문"}})
        self.assertEqual(self.get(rid)["subject"], "여기서 고침")

        # opened on GitHub itself: imported; ours (MARK) is not
        hook("issues", {"action": "opened", "issue": {"number": 555, "title": "깃허브에서", "body": "직접", "state": "open",
                                                      "user": {"login": "octo"}, "labels": [{"name": "recommendation"}]}})
        hook("issues", {"action": "opened", "issue": {"number": 556, "title": "우리 것", "body": "x " + issues.MARK}})
        got = [x for x in c.get("/api/admin/reports", headers=self.h).json() if x["number"] in (555, 556)]
        self.assertEqual([(x["subject"], x["kind"], x["username"], x["origin"]) for x in got],
                         [("깃허브에서", "recommendation", "octo", "github")])

        c.put("/api/admin/issues/kinds", headers=self.h, json={"kinds": {"local": True, "inquiry": False}})
        self.gh.sent.clear()
        issues.sweep()
        self.assertIn("여기만", str(self.gh.sent))

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
        body = {"id": 5, "kind": "bug", "subject": "원격", "body": "b", "author": "kim", "labels": ["bug", "server:sub.lab"],
                "attachments": [{"name": "a.png", "url": "https://sub.lab/api/reports/5/files/x"}]}
        rid = c.post("/api/issues/relay/reports", headers=sub, json=body).json()["id"]
        self.assertEqual(c.post("/api/issues/relay/reports", headers=sub, json=body).json()["id"], rid)   # once
        cid = c.post(f"/api/issues/relay/reports/{rid}/comments", headers=sub, json={"id": 1, "author": "kim", "body": "덧"}).json()["id"]
        c.post(f"/api/issues/relay/reports/{rid}/comments", headers=sub, json={"id": 1, "author": "kim", "body": "덧"})
        c.put(f"/api/issues/relay/reports/{rid}/comments/{cid}", headers=sub, json={"id": 1, "author": "kim", "body": "덧붙임"})
        c.post(f"/api/reports/{rid}/comments", headers=self.h, json={"body": "main 답"})
        c.put(f"/api/issues/relay/reports/{rid}", headers=sub,
              json={"status": "resolved", "state_reason": "completed", "labels": ["bug"], "by": "kim"})
        u = c.get("/api/issues/relay/updates", headers=sub).json()
        self.assertEqual({k: u["reports"][0][k] for k in ("status", "labels", "closed_by")},
                         {"status": "resolved", "labels": ["bug"], "closed_by": "kim (sub1)"})
        self.assertEqual([x["body"] for x in u["comments"]], ["덧붙임", "main 답"])
        c.delete(f"/api/issues/relay/reports/{rid}/comments/{cid}", headers=sub)
        u2 = c.get(f"/api/issues/relay/updates?since={u['cursor']}", headers=sub).json()
        self.assertIn((cid, True), [(x["id"], x["deleted"]) for x in u2["comments"]])
        r = self.get(rid)
        self.assertEqual((r["username"], r["origin"], [x["body"] for x in r["comments"]]), ("kim", "sub1", ["main 답"]))
        self.assertIn("a.png", r["body"])

        c.delete("/api/admin/issues/subs/sub1", headers=self.h)
        self.assertEqual(c.get("/api/issues/relay/updates", headers=sub).status_code, 401)

    def test_sub_takes_mains_side(self):
        with SessionLocal() as db:
            r = models.Report(user_id=1, kind="bug", subject="x", ext_id="42", labels_json='["bug"]')
            db.add(r)
            db.commit()
            rid = r.id
        state = {"id": 42, "number": 17, "subject": "x", "status": "resolved", "state_reason": "not_planned",
                 "closed_by": "octo", "labels": ["bug", "wontfix"]}

        class Up:
            name = "main.lab"
            comments = [{"id": 8, "report_id": 42, "author": "octo", "origin": "github", "body": "됨"}]

            def updates(self, since):
                return {"reports": [state], "cursor": "2026-11-20T00:00:00", "comments": self.comments}
        up = Up()
        with SessionLocal() as db:
            issues._pull(db, up)
            issues._pull(db, up)
        r = self.get(rid)
        self.assertEqual((r["number"], r["status"], r["state_reason"], r["labels"], [x["body"] for x in r["comments"]]),
                         (17, "resolved", "not_planned", ["bug", "wontfix"], ["됨"]))
        self.assertEqual([(e["kind"], e["actor"]) for e in r["events"]], [("closed", "octo"), ("labeled", "main.lab")])
        up.comments = [{**up.comments[0], "body": "됨!"}]
        with SessionLocal() as db:
            issues._pull(db, up)
        self.assertEqual(self.get(rid)["comments"][0]["body"], "됨!")
        up.comments = [{**up.comments[0], "deleted": True}]
        with SessionLocal() as db:
            issues._pull(db, up)
        self.assertEqual(self.get(rid)["comments"], [])
        self.assertEqual(issues._read()["since"], "2026-11-20T00:00:00")


if __name__ == "__main__":
    unittest.main()
