"""The gates of /mcp, on a throwaway data root, with the note service faked.

    cd service_manager && .venv/bin/python tests/test_mcp.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

os.environ.update({
    "PORTAL_DATA_ROOT": str(Path(tempfile.mkdtemp()) / "data"),
    "PORTAL_SECRET_KEY": "test-secret",
    "EMAIL_VERIFY_REQUIRED": "0",
    "SERVICE_PORT_START": "8262", "SERVICE_PORT_END": "8269",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx                                         # noqa: E402
from fastapi.testclient import TestClient            # noqa: E402

from app import main, mcp_tokens, models             # noqa: E402
from app.db import SessionLocal                      # noqa: E402
from app.routers import mcp                          # noqa: E402

c = TestClient(main.app)


def rpc(token, method, params=None, rid=1):
    return c.post("/mcp", headers={"Authorization": f"Bearer {token}"},
                  json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def call(token, name, /, **args):
    return rpc(token, "tools/call", {"name": name, "arguments": args}).json()["result"]


class Gates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert c.post("/api/auth/setup", json={"password": "admin-pass-1"}).status_code == 200
        cls.db = SessionLocal()
        cls.user = cls.db.query(models.User).filter(models.User.username == "admin").one()
        cls.calls = []

        # Stands in for the service behind /pp: a write to `taken` is a conflict.
        async def fake(request, grant, method, path, **kw):
            cls.calls.append((method, path, kw.get("json")))
            if path == "notes/paper":
                return httpx.Response(200, json={"id": "paper", "fields": {"format": "tex"}, "version": "1", "body": "x"})
            if path == "notes/busy" and method == "GET":
                return httpx.Response(200, json={"id": "busy", "title": "b", "fields": {}, "version": "1", "body": "old\n\n"})
            if path == "notes/busy" and sum(c[:2] == ("PUT", "notes/busy") for c in cls.calls) == 1:
                return httpx.Response(409, json={"detail": "moved on", "current": {}})
            if path == "notes/gone":
                return httpx.Response(404, json={"detail": "그 노트가 없습니다."})
            if path == "notes/taken":
                return httpx.Response(409, json={"detail": "moved on", "current": {}})
            if method == "POST":
                return httpx.Response(201, json={"id": "new", "title": "t", "version": "1"})
            if path == "tagged":
                return httpx.Response(200, json={"items": [
                    {"key": "notes", "rec": {"id": "a", "title": "A", "date": "d"}},
                    {"key": "notes", "rec": {"id": "b", "title": "B", "date": "d"}},
                    {"key": "todos", "rec": {"id": "c", "title": "C", "line": 1, "text": "x"}}]})
            if path == "search":
                return httpx.Response(200, json={"hits": [{"id": "b", "title": "B", "line": 3, "text": "x"},
                                                          {"id": "z", "title": "Z", "line": 1, "text": "x"}]})
            return httpx.Response(200, json={"id": "new", "title": "t", "date": "d", "tags": [], "fields": {},
                                             "version": "2", "body": ""})
        cls.real, mcp._note = mcp._note, fake

        async def inbox(request, grant, record):
            cls.proposed.append(record)
            return httpx.Response(200, json={"record": record})
        cls.proposed, cls.real_inbox, mcp._inbox = [], mcp._inbox, inbox

        async def activities(request, grant):
            return httpx.Response(200, json={"activities": [{"id": "a1", "name": "TAMU"}]})
        cls.real_activities, mcp._activities = mcp._activities, activities

    @classmethod
    def tearDownClass(cls):
        mcp._note, mcp._inbox, mcp._activities = cls.real, cls.real_inbox, cls.real_activities
        cls.db.close()

    def setUp(self):
        self.calls.clear()
        self.proposed.clear()

    def issue(self, write=True, days=30):
        return mcp_tokens.issue(self.db, "t", self.user, write, days)

    def test_no_or_unknown_token_is_refused(self):
        self.assertEqual(c.post("/mcp", json={}).status_code, 401)
        self.assertEqual(rpc("lpm_nope", "ping").status_code, 401)

    def test_expired_and_revoked_tokens_are_refused(self):
        for change in ({"expires_at": mcp_tokens._now() - timedelta(seconds=1)}, {"revoked_at": mcp_tokens._now()}):
            tok = self.issue()
            self.assertEqual(rpc(tok, "ping").status_code, 200)
            row = self.db.query(models.McpToken).filter(models.McpToken.token_hash == mcp_tokens.digest(tok)).one()
            for k, v in change.items():
                setattr(row, k, v)
            self.db.commit()
            self.assertEqual(rpc(tok, "ping").status_code, 401)

    def test_inactive_owner_stops_the_token(self):
        tok = self.issue()
        self.user.is_active = False
        self.db.commit()
        try:
            self.assertEqual(rpc(tok, "ping").status_code, 401)
        finally:
            self.user.is_active = True
            self.db.commit()

    def test_only_the_hash_is_stored(self):
        tok = self.issue()
        hashes = [r.token_hash for r in self.db.query(models.McpToken)]
        self.assertNotIn(tok, hashes)
        self.assertIn(mcp_tokens.digest(tok), hashes)

    def test_token_opens_nothing_but_mcp(self):
        tok = self.issue()
        h = {"Authorization": f"Bearer {tok}"}
        self.assertEqual(c.get("/api/auth/me", headers=h).status_code, 401)
        self.assertEqual(c.get("/api/admin/services/note/sync", headers=h).status_code, 401)

    def test_read_token_cannot_write(self):
        tok = self.issue(write=False)
        names = {t["name"] for t in rpc(tok, "tools/list").json()["result"]["tools"]}
        self.assertEqual(names, {"list_services", "search", "get_record", "by_tag", "search_notes", "get_note", "propose_note", "propose_activity"})
        r = call(tok, "add_note", title="x", body="y")
        self.assertTrue(r["isError"])
        self.assertEqual(self.calls, [])

    def test_update_needs_a_version_and_a_conflict_writes_nothing(self):
        tok = self.issue()
        self.assertTrue(call(tok, "update_note", id="x", body="b")["isError"])
        self.assertEqual(self.calls, [])
        r = call(tok, "update_note", id="taken", base_version="1", body="b")
        self.assertTrue(r["isError"])
        self.assertIn("get_note", r["content"][0]["text"])

    def test_add_saves_the_body_on_the_version_it_just_got(self):
        r = call(self.issue(), "add_note", title="t", body="#agent/x hello")
        self.assertFalse(r["isError"])
        self.assertEqual(self.calls[1], ("PUT", "notes/new", {"baseVersion": "1", "body": "#agent/x hello"}))

    def test_append_reads_again_when_the_note_moved_on(self):
        r = call(self.issue(), "append_note", id="busy", text=" 새 줄 ")
        self.assertFalse(r["isError"])
        puts = [c for c in self.calls if c[0] == "PUT"]
        self.assertEqual(len(puts), 2)
        self.assertEqual(puts[1][2], {"baseVersion": "1", "body": "old\n\n새 줄\n"})

    def test_append_refuses_a_tex_note_and_empty_text(self):
        tok = self.issue()
        self.assertTrue(call(tok, "append_note", id="paper", text="x")["isError"])
        self.assertTrue(call(tok, "append_note", id="busy", text="  ")["isError"])
        self.assertEqual([c for c in self.calls if c[0] == "PUT"], [])

    def test_read_token_cannot_append(self):
        self.assertTrue(call(self.issue(write=False), "append_note", id="busy", text="x")["isError"])
        self.assertEqual(self.calls, [])

    def test_a_proposal_only_waits_and_a_read_token_may_make_one(self):
        r = call(self.issue(write=False), "propose_note", title="제목", body="본문", why="확인 부탁", tags="#a")
        self.assertFalse(r["isError"])
        self.assertEqual(self.calls, [])                 # the note service was not touched
        rec = self.proposed[0]
        self.assertEqual((rec["target"], rec["status"], rec["title"], rec["remark"]), ("note", "waiting", "제목", "확인 부탁"))
        self.assertNotIn("feedback", rec)

    def test_a_proposal_cannot_set_its_own_status_or_feedback(self):
        r = call(self.issue(), "propose_note", title="t", body="b", why="w", status="approved", feedback="ok")
        self.assertFalse(r["isError"])
        self.assertEqual(self.proposed[0]["status"], "waiting")
        self.assertNotIn("feedback", self.proposed[0])

    def test_a_proposal_names_a_new_note_or_a_real_one(self):
        tok = self.issue()
        self.assertTrue(call(tok, "propose_note", body="b", why="w")["isError"])
        self.assertTrue(call(tok, "propose_note", title="t", match_id="busy", body="b", why="w")["isError"])
        self.assertTrue(call(tok, "propose_note", match_id="gone", body="b", why="w")["isError"])
        self.assertEqual(self.proposed, [])
        self.assertFalse(call(tok, "propose_note", match_id="busy", body="b", why="w")["isError"])
        self.assertEqual((self.proposed[0]["mode"], self.proposed[0]["match"]), ("update", {"id": "busy"}))

    def test_a_new_activity_needs_a_name_and_a_real_start(self):
        tok = self.issue(write=False)
        why = {"why": "메일에서"}
        for bad in ({"name": "x"}, {"start": "2026-11-20"}, {"name": "x", "start": "11/20"},
                    {"name": "x", "start": "2026-13-40"}, {"name": "x", "start": "2026-11-20", "startTime": "25:00"},
                    {"name": "x", "start": "2026-11-20", "kind": "잡담"},
                    {"name": "x", "start": "2026-11-20", "tripStart": "2026-11-19"}):
            self.assertTrue(call(tok, "propose_activity", **why, **bad)["isError"], bad)
        self.assertEqual(self.proposed, [])
        r = call(tok, "propose_activity", **why, name="TAMU", start="2026-11-20", kind="연구출장", status="approved", id="x")
        self.assertFalse(r["isError"])
        rec = self.proposed[0]
        self.assertEqual((rec["target"], rec["status"], rec["name"], rec["start"]), ("activity", "waiting", "TAMU", "2026-11-20"))
        self.assertTrue(rec["id"].startswith("mcp-"))

    def test_an_activity_change_names_a_real_one_and_something_to_change(self):
        tok = self.issue()
        self.assertTrue(call(tok, "propose_activity", why="w", match_id="a1")["isError"])
        self.assertTrue(call(tok, "propose_activity", why="w", match_id="nope", place="x")["isError"])
        self.assertEqual(self.proposed, [])
        self.assertFalse(call(tok, "propose_activity", why="w", match_id="a1", tripStart="2026-11-19")["isError"])
        rec = self.proposed[0]
        self.assertEqual((rec["mode"], rec["match"], rec["tripStart"]), ("update", {"id": "a1"}, "2026-11-19"))
        self.assertNotIn("name", rec)

    def test_scope_covers_a_service_or_one_project(self):
        allowed = mcp_tokens.allowed
        self.assertTrue(allowed("", "note", "note"))
        self.assertTrue(allowed("note", "note", "note"))
        self.assertFalse(allowed("note", "author_manager", "authors"))
        self.assertTrue(allowed("note, author_manager/authors", "author_manager", "authors"))
        self.assertFalse(allowed("author_manager/authors", "author_manager", "other"))
        self.assertTrue(allowed("author_manager/authors", "author_manager"))
        self.assertFalse(allowed("author_manager/authors", "note"))

    def test_a_scoped_token_cannot_reach_past_its_scope(self):
        grant = mcp.Grant("jwt", True, "t", "note")
        with self.assertRaises(mcp.ToolError):
            asyncio.run(mcp._portal(None, grant, "author_manager", "GET", "data", "authors"))

    def test_a_log_is_written_stamped_and_added_to(self):
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            self.assertEqual(svc, "logbook")
            sent.append((method, path, kw.get("json")))
            if path == "records":
                return httpx.Response(200, json={"record": {"id": "L1", **kw["json"]["record"]}})
            if path == "data":
                return httpx.Response(200, json={"logs": [{"id": "L1", "title": "beam", "body": "first"}]})
            return httpx.Response(200, json={"record": {"id": "L1", "title": "beam", **kw["json"]["fields"]}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            got = json.loads(call(tok, "add_log", title=" beam ", run="1-5", tags=["#tpc", ""])["content"][0]["text"])
            rec = sent[0][2]["record"]
            self.assertEqual((got["id"], rec["title"], rec["run"], rec["tags"], rec["author"]), ("L1", "beam", "1-5", ["tpc"], "t"))
            self.assertRegex(rec["date"] + " " + rec["time"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
            self.assertTrue(call(tok, "add_log", title="x", time="25:00").get("isError"))
            self.assertTrue(call(tok, "add_log", title="  ").get("isError"))
            sent.clear()
            call(tok, "append_log", id="L1", text="second")
            self.assertEqual(sent[-1][2], {"key": "logs", "id": "L1", "fields": {"body": "first\n\nsecond\n"}})
            self.assertTrue(call(tok, "append_log", id="nope", text="x").get("isError"))
            self.assertTrue(call(self.issue(write=False), "add_log", title="x").get("isError"))
        finally:
            mcp._portal = real

    def test_a_parameter_set_is_registered_and_tied_to_a_log(self):
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            sent.append((svc, path, kw))
            if path == "register":
                return httpx.Response(200, json={"existing": False, "record": {
                    "id": "P1", "title": kw["params"]["title"], "format": kw["params"]["format"], "count": 2, "value_hash": "h"}})
            if path == "data":
                return httpx.Response(200, json={"logs": [{"id": "L1", "title": "run", "params": [{"svc": "parameters", "proj": "sets", "id": "P0"}]}]})
            return httpx.Response(200, json={"record": {"id": "L1", **kw["json"]["fields"]}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            got = json.loads(call(tok, "add_params", text="a 1\nb 2\n", title="reco", log="L1")["content"][0]["text"])
            self.assertEqual((got["id"], got["format"], got["existing"], got["log"]), ("P1", "lilak-par", False, "L1"))
            self.assertEqual(sent[0][2]["content"], b"a 1\nb 2\n")
            self.assertEqual([x["id"] for x in sent[-1][2]["json"]["fields"]["params"]], ["P0", "P1"])
            self.assertTrue(call(tok, "add_params", text=" ").get("isError"))
            self.assertTrue(call(tok, "add_params", text="a 1", log="nope").get("isError"))
            self.assertTrue(call(self.issue(write=False), "add_params", text="a 1").get("isError"))
        finally:
            mcp._portal = real

    def test_records_leave_out_settings_and_the_inbox(self):
        async def fake(request, grant, svc, method, path, proj="", **kw):
            self.assertEqual((svc, path), ("author_manager", "data"))
            return httpx.Response(200, json={
                "settings": {"secret": "x"}, "inbox": [{"id": "m", "name": "메일"}], "version": 3,
                "authors": [{"id": "a", "name": "Kim Lee", "tags": ["x"]}, {"id": "b", "name": "Park"}, {"name": "no id"}]})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            r = call(tok, "search", query="kim", service="author_manager")
            hits = json.loads(r["content"][0]["text"])["hits"]
            self.assertEqual([h["id"] for h in hits], ["a"])
            self.assertEqual(hits[0]["tags"], ["x"])
            r = call(tok, "search", query="메일", service="author_manager")
            self.assertEqual(json.loads(r["content"][0]["text"])["hits"], [])
            r = json.loads(call(tok, "get_record", service="author_manager", id="b")["content"][0]["text"])
            self.assertEqual(r["record"]["name"], "Park")
            self.assertTrue(call(tok, "get_record", service="author_manager", id="m")["isError"])
            self.assertTrue(call(tok, "get_record", service="elog", id="m")["isError"])
        finally:
            mcp._portal = real

    def test_managers_issue_and_revoke_tokens_and_others_cannot(self):
        admin = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        h = {"Authorization": f"Bearer {admin}"}
        self.assertEqual(c.get("/api/admin/mcp-tokens").status_code, 401)
        tok = self.issue()
        self.assertEqual(c.get("/api/admin/mcp-tokens", headers={"Authorization": f"Bearer {tok}"}).status_code, 401)
        self.assertEqual(c.post("/api/admin/mcp-tokens", headers=h, json={"name": " "}).status_code, 400)
        self.assertEqual(c.post("/api/admin/mcp-tokens", headers=h, json={"name": "x", "days": 0}).status_code, 400)
        r = c.post("/api/admin/mcp-tokens", headers=h, json={"name": "화면", "scope": "note, author_manager"})
        self.assertEqual(r.status_code, 201)
        new = r.json()["token"]
        names = {t["name"]: t for t in c.get("/api/admin/mcp-tokens", headers=h).json()}
        row = names["화면"]
        self.assertEqual((row["can_write"], row["scope"], row["owner"], row["revoked"]), (False, "note,author_manager", "admin", False))
        self.assertNotIn(new, str(row))
        self.assertEqual(rpc(new, "ping").status_code, 200)
        self.assertEqual(c.delete(f"/api/admin/mcp-tokens/{row['id']}", headers=h).status_code, 200)
        self.assertEqual(rpc(new, "ping").status_code, 401)

    def test_note_id_cannot_climb_out_of_the_path(self):
        for bad in ("../../x", "a/b", "a\\b", ".hidden"):
            self.assertTrue(call(self.issue(), "get_note", id=bad)["isError"])
        self.assertEqual(self.calls, [])

    def test_a_page_instead_of_json_is_an_error(self):
        with self.assertRaises(mcp.ToolError):
            mcp._ok(httpx.Response(200, text="<html>"))

    def test_search_by_tag_and_text_keeps_what_both_found(self):
        tok = self.issue()
        ids = lambda r: [h["id"] for h in json.loads(r["content"][0]["text"])]
        self.assertEqual(ids(call(tok, "search_notes", tag="#agent")), ["a", "b"])
        self.assertEqual(ids(call(tok, "search_notes", tag="agent", query="x")), ["b"])
        self.assertTrue(call(tok, "search_notes")["isError"])

    def test_protocol_edges(self):
        tok = self.issue()
        h = {"Authorization": f"Bearer {tok}"}
        init = rpc(tok, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
        self.assertEqual(init["protocolVersion"], "2025-06-18")
        self.assertEqual(c.post("/mcp", headers=h, json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code, 202)
        self.assertEqual(rpc(tok, "nope").json()["error"]["code"], -32601)
        self.assertEqual(c.post("/mcp", headers=h, json=[1]).json()["error"]["code"], -32600)
        self.assertEqual(c.get("/mcp").status_code, 405)


if __name__ == "__main__":
    unittest.main(verbosity=1)
