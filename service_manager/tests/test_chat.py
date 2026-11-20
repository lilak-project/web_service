"""Portal chat rooms and their gates, on a throwaway data root.

    cd service_manager && .venv/bin/python tests/test_chat.py
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

from fastapi.testclient import TestClient     # noqa: E402

from app import main, models, security         # noqa: E402
from app.db import SessionLocal                # noqa: E402
from app.deps import portal_token              # noqa: E402

c = TestClient(main.app)


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


class Chat(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = bearer(c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"])
        with SessionLocal() as db:
            u = models.User(username="kim", email="kim@x.org", password_hash=security.hash_password("pw-12345678"),
                            role="user", is_active=True, email_verified=True)
            db.add(u)
            db.commit()
            cls.user = bearer(portal_token(u))
        # Project rooms exist once opened: the tests' project room, opened by the manager.
        assert c.post("/api/chat/rooms", headers=cls.admin, json={"service": "elog", "project": "exp1"}).status_code == 200

    def test_portal_room(self):
        r = c.post("/api/chat/messages", headers=self.user, json={"room": "portal", "body": "hello @admin"})
        self.assertEqual(r.status_code, 200, r.text)
        mid = r.json()["id"]
        got = c.get("/api/chat/messages", headers=self.admin, params={"room": "portal"}).json()
        self.assertIn("hello @admin", [m["body"] for m in got["messages"]])
        self.assertEqual(c.get("/api/chat/messages", headers=self.admin, params={"room": "portal", "after": mid}).json()["messages"], [])
        # Someone else's message: only its author or a manager deletes it.
        self.assertEqual(c.delete(f"/api/chat/messages/{mid}", headers=self.admin).status_code, 200)

    def test_project_room_needs_entry(self):
        self.assertEqual(c.get("/api/chat/messages", headers=self.user, params={"room": "elog/exp1"}).status_code, 403)
        self.assertEqual(c.post("/api/chat/messages", headers=self.user, json={"room": "elog/exp1", "body": "x"}).status_code, 403)
        self.assertEqual(c.get("/api/chat/messages", headers=self.user, params={"room": "../etc"}).status_code, 400)

    def test_a_project_admin_clears_messages_in_its_room_only(self):
        with SessionLocal() as db:
            u = models.User(username="roomboss", email="rb@x.org", password_hash="x", role="user", is_active=True, email_verified=True)
            db.add(u); db.commit()
            db.add(models.ServicePermission(user_id=u.id, service_name="elog", project="exp1", is_admin=True)); db.commit()
            boss = bearer(portal_token(u))
        inside = c.post("/api/chat/messages", headers=self.admin, json={"room": "elog/exp1", "body": "in the room"}).json()["id"]
        outside = c.post("/api/chat/messages", headers=self.admin, json={"room": "portal", "body": "in the hall"}).json()["id"]
        self.assertTrue(c.get("/api/chat/messages", headers=boss, params={"room": "elog/exp1"}).json()["me"]["admin"])
        self.assertFalse(c.get("/api/chat/messages", headers=boss, params={"room": "portal"}).json()["me"]["admin"])
        self.assertEqual([c.delete(f"/api/chat/messages/{i}", headers=boss).status_code for i in (inside, outside)], [200, 404])

    def test_mentions_are_resolved_and_counted_on_the_account(self):
        with SessionLocal() as db:
            for n, d in (("lee", None), ("lee.min", "이 민")):
                db.add(models.User(username=n, display_name=d, email=f"{n}@x.org", password_hash="x", role="user", is_active=True, email_verified=True))
            db.commit()
            ids = {u.username: u.id for u in db.query(models.User).all()}
            lee, leemin = (bearer(portal_token(db.query(models.User).filter_by(username=n).one())) for n in ("lee", "lee.min"))
        say = lambda h, body, room="portal": c.post("/api/chat/messages", headers=h, json={"room": room, "body": body}).json()  # noqa: E731
        # By id or display name, the longest name winning; an address is not a mention; @all is the room's admin's.
        self.assertEqual(say(self.user, "@lee.min 보세요")["mentions"], [ids["lee.min"]])
        self.assertEqual(sorted(say(self.user, "@이 민, @LEE님!")["mentions"]), sorted([ids["lee.min"], ids["lee"]]))
        self.assertEqual(say(self.user, "mail lee@x.org @leeway @all @kim")["mentions"], [])
        top = say(self.admin, "@all 공지")
        self.assertEqual(top["mentions"], [0])
        self.assertEqual({m["username"] for m in c.get("/api/chat/members", headers=lee, params={"room": "portal"}).json()} >= {"lee", "kim", "admin"}, True)
        self.assertEqual(c.get("/api/chat/members", headers=lee, params={"room": "elog/exp1"}).status_code, 403)
        # A room never opened counts its mentions only; once read, what comes after.
        got = c.get("/api/chat/unread", headers=lee).json()
        self.assertEqual((got["unread"], got["mentions"]), (0, 2))
        self.assertEqual(c.post("/api/chat/read", headers=lee, json={"room": "portal", "id": top["id"]}).status_code, 200)
        self.assertEqual(c.get("/api/chat/unread", headers=lee).json()["rooms"], {})
        say(self.user, "그냥 말"); say(leemin, "@lee 한 번 더"); say(lee, "@lee 내 말은 세지 않는다")
        self.assertEqual(c.get("/api/chat/unread", headers=lee).json()["rooms"], {"portal": {"unread": 2, "mentions": 1}})
        self.assertEqual(c.post("/api/chat/read", headers=lee, json={"room": "elog/exp1", "id": 1}).status_code, 403)
        # A mention sitting in a room this account cannot enter is not counted (nor is the room looked up otherwise).
        with SessionLocal() as db:
            db.add(models.ChatMessage(room="elog/exp1", user_id=1, author_name="admin", body="@lee", mentions_json=f"[{ids['lee']}]"))
            db.commit()
        self.assertEqual(c.get("/api/chat/unread", headers=lee).json()["rooms"], {"portal": {"unread": 2, "mentions": 1}})
        # Paging back: the messages before one.
        older = c.get("/api/chat/messages", headers=lee, params={"room": "portal", "before": top["id"]}).json()["messages"]
        self.assertTrue(older and all(m["id"] < top["id"] for m in older))

    def test_zz_flooding_is_slowed(self):
        with SessionLocal() as db:
            u = models.User(username="flood", email="flood@x.org", password_hash="x", role="user", is_active=True, email_verified=True)
            db.add(u); db.commit()
            tok = bearer(portal_token(u))
        codes = [c.post("/api/chat/messages", headers=tok, json={"room": "portal", "body": f"m{i}"}).status_code for i in range(31)]
        self.assertEqual((codes[29], codes[30]), (200, 429))
        ups = [c.post("/api/chat/upload", headers=tok, files={"file": ("a.txt", b"x")}).status_code for i in range(21)]
        self.assertEqual((ups[19], ups[20]), (200, 429))

    def test_a_reply_cannot_quote_another_room(self):
        # A reply shows its target's author and first words: one to a room you cannot read would leak it.
        secret = c.post("/api/chat/messages", headers=self.admin, json={"room": "elog/exp1", "body": "the private plan"}).json()
        r = c.post("/api/chat/messages", headers=self.user, json={"room": "portal", "body": "hi", "reply_to_id": secret["id"]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(c.post("/api/chat/messages", headers=self.user,
                                json={"room": "portal", "body": "hi", "reply_to_id": 10 ** 9}).status_code, 400)
        # …and a row written before that check is not quoted either.
        with SessionLocal() as db:
            db.add(models.ChatMessage(room="portal", user_id=1, author_name="x", body="old", reply_to_id=secret["id"]))
            db.commit()
        got = c.get("/api/chat/messages", headers=self.user, params={"room": "portal"}).json()["messages"]
        self.assertTrue(all(m["reply_to_body"] is None for m in got if m["body"] == "old"))
        # A reply inside the room still quotes.
        here = c.post("/api/chat/messages", headers=self.user, json={"room": "portal", "body": "first"}).json()
        r = c.post("/api/chat/messages", headers=self.admin, json={"room": "portal", "body": "re", "reply_to_id": here["id"]})
        self.assertEqual(r.status_code, 200)
        got = c.get("/api/chat/messages", headers=self.user, params={"room": "portal"}).json()["messages"]
        self.assertEqual(next(m for m in got if m["body"] == "re")["reply_to_body"], "first")

    def test_rooms_are_everyone_system_and_opened_ones(self):
        keys = [r["key"] for r in c.get("/api/chat/rooms", headers=self.user).json()]
        self.assertEqual(keys[:2], ["portal", "system"])
        self.assertNotIn("elog/exp1", keys)                      # opened, but kim may not enter it
        self.assertIn("elog/exp1", [r["key"] for r in c.get("/api/chat/rooms", headers=self.admin).json()])
        # A project nobody opened has no room yet, even for a manager.
        self.assertEqual(c.get("/api/chat/messages", headers=self.admin, params={"room": "elog/exp2"}).status_code, 404)
        self.assertEqual(c.post("/api/chat/rooms", headers=self.user, json={"service": "elog", "project": "exp2"}).status_code, 403)

    def test_system_room_is_each_accounts_own(self):
        with SessionLocal() as db:
            db.add(models.ChatMessage(room="system:1", user_id=1, author_name="admin", body="mine"))
            db.commit()
        self.assertEqual(c.get("/api/chat/messages", headers=self.user, params={"room": "system"}).json()["messages"], [])
        self.assertIn("mine", [m["body"] for m in c.get("/api/chat/messages", headers=self.admin, params={"room": "system"}).json()["messages"]])
        # What an account says there goes to the agent — a manager's for now.
        self.assertEqual(c.post("/api/chat/messages", headers=self.user, json={"room": "system", "body": "hi"}).status_code, 403)
        self.assertEqual(c.put("/api/account/prefs", headers=self.user, json={"chatRoom": "system"}).status_code, 200)

    def test_mcp_chat_tools(self):
        import json as _json
        def tok(scope=""):
            return c.post("/api/admin/mcp-tokens", headers=self.admin,
                          json={"name": "claude", "can_write": True, "scope": scope}).json()["token"]
        def call(t, name, **args):
            r = c.post("/mcp", headers={"Authorization": f"Bearer {t}"},
                       json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}).json()["result"]
            return r["isError"], (_json.loads(r["content"][0]["text"]) if not r["isError"] else r["content"][0]["text"])
        t = tok()
        err, rooms = call(t, "chat_rooms")
        self.assertFalse(err); self.assertIn("system", rooms["rooms"]); self.assertIn("elog/exp1", rooms["rooms"])
        err, sent = call(t, "chat_send", room="elog/exp1", text="answer from claude")
        self.assertFalse(err, sent)
        err, got = call(t, "chat_read", room="elog/exp1", after=sent["id"] - 1)
        line = next(m for m in got["messages"] if m["id"] == sent["id"])
        self.assertEqual((line["via"], line["who"]), ("claude", "admin"))
        # Shown as the token, never claimable from a page: the HTTP route ignores a "via".
        r = c.post("/api/chat/messages", headers=self.admin, json={"room": "portal", "body": "x", "via": "claude"}).json()
        self.assertEqual(r["via"], "")
        # A program's line in the system room is not a task for the agent (no key here would 400).
        self.assertFalse(call(t, "chat_send", room="system", text="note to self")[0])
        # A token kept to note cannot use a project room outside it.
        self.assertTrue(call(tok("note"), "chat_read", room="elog/exp1")[0])
        self.assertTrue(call(t, "chat_read", room="../x")[0])

    def test_a_report_keeps_its_files(self):
        up = c.post("/api/chat/upload", headers=self.user, files={"file": ("bug.png", b"PNG", "image/png")}).json()
        r = c.post("/api/reports", headers=self.user, json={"kind": "bug", "subject": "s", "body": "b",
                                                             "attachments": [up, {"id": "f" * 32, "name": "not there"}]}).json()
        self.assertEqual([a["id"] for a in r["attachments"]], [up["id"]])          # only files that exist
        url = f"/api/reports/{r['id']}/files/{up['id']}"
        self.assertEqual(c.get(url, headers=self.user).content, b"PNG")             # its writer
        self.assertEqual(c.get(url, headers=self.admin).content, b"PNG")            # an admin
        with SessionLocal() as db:
            o = models.User(username="other", email="o@x.org", password_hash="x", role="user", is_active=True, email_verified=True)
            db.add(o); db.commit(); other = bearer(portal_token(o))
        self.assertEqual(c.get(url, headers=other).status_code, 404)                # nobody else

    def test_agent_only_in_project_rooms(self):
        r = c.post("/api/chat/messages", headers=self.user, json={"room": "portal", "body": "@agent do it"})
        self.assertEqual(r.status_code, 400)

    def test_files_follow_the_room(self):
        up = c.post("/api/chat/upload", headers=self.user, files={"file": ("a.txt", b"hi", "text/plain")}).json()
        c.post("/api/chat/messages", headers=self.user, json={"room": "portal", "attachments": [up]})
        self.assertEqual(c.get(f"/api/chat/files/{up['id']}", headers=self.admin, params={"room": "portal"}).content, b"hi")
        self.assertEqual(c.get(f"/api/chat/files/{up['id']}", headers=self.user, params={"room": "elog/exp1"}).status_code, 403)
        self.assertEqual(c.get("/api/chat/files/nothere", headers=self.user, params={"room": "portal"}).status_code, 404)

    def test_last_room_saved(self):
        p = c.put("/api/account/prefs", headers=self.user, json={"chatRoom": "elog/exp1"}).json()["prefs"]
        self.assertEqual(p["chatRoom"], "elog/exp1")
        self.assertEqual(c.put("/api/account/prefs", headers=self.user, json={"chatRoom": "a/b/c"}).status_code, 400)
        self.assertEqual(c.get("/api/chat/rooms", headers=self.user).json()[0]["key"], "portal")


if __name__ == "__main__":
    unittest.main(verbosity=2)
