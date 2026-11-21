"""The gates of /mcp, on a throwaway data root, with the note service faked.

    cd service_manager && .venv/bin/python tests/test_mcp.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
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
            if path == "file":
                return httpx.Response(200, json={"name": kw["files"]["f"][0]})
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

        async def inbox(request, grant, record, proj=""):
            cls.proposed.append(record)
            return httpx.Response(200, json={"record": record})
        cls.proposed, cls.real_inbox, mcp._inbox = [], mcp._inbox, inbox
        # Which set's inbox (no inbox service installed here): the named set's, else "inbox".
        cls.real_inbox_of, mcp._inbox_of = mcp._inbox_of, lambda g, home: home.get("inbox") or "inbox"

        async def activities(request, grant):
            return httpx.Response(200, json={"activities": [{"id": "a1", "name": "TAMU"}]})
        cls.real_activities, mcp._activities = mcp._activities, activities

    @classmethod
    def tearDownClass(cls):
        mcp._note, mcp._inbox, mcp._activities = cls.real, cls.real_inbox, cls.real_activities
        mcp._inbox_of = cls.real_inbox_of
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
        self.assertEqual(names, {"tags", "find", "related", "my_tasks", "job_context", "job_recipes", "guide", "job_status", "list_services", "search",
                                 "get_record", "by_tag",
                                 "search_notes", "get_note", "note_units", "list_issues", "propose_note", "propose_tags", "propose_activity", "agent_run",
                                 "chat_rooms", "chat_read"})
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

    def test_a_parameter_set_is_registered(self):
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            sent.append((svc, path, kw))
            if path == "register":
                return httpx.Response(200, json={"existing": False, "record": {
                    "id": "P1", "title": kw["params"]["title"], "format": kw["params"]["format"], "count": 2, "value_hash": "h"}})
            raise AssertionError(path)
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            got = json.loads(call(tok, "add_params", text="a 1\nb 2\n", title="reco")["content"][0]["text"])
            self.assertEqual((got["id"], got["format"], got["existing"]), ("P1", "lilak-par", False))
            self.assertEqual(sent[0][2]["content"], b"a 1\nb 2\n")
            self.assertTrue(call(tok, "add_params", text=" ").get("isError"))
            self.assertTrue(call(self.issue(write=False), "add_params", text="a 1").get("isError"))
        finally:
            mcp._portal = real

    def test_records_leave_out_settings_and_the_inbox(self):
        async def fake(request, grant, svc, method, path, proj="", **kw):
            self.assertEqual((svc, path), ("author_manager", "data"))
            return httpx.Response(200, json={
                "settings": {"secret": "x"}, "inbox": [{"id": "m", "name": "메일"}], "version": 3,
                "prefs": [{"id": "p", "name": "메일 화면"}], "pins": [{"id": "q", "name": "메일 고정"}],
                "authors": [{"id": "a", "name": "Kim Lee", "tags": ["x"]}, {"id": "b", "name": "Park"}, {"name": "no id"}]})
        real, real_rack, mcp._portal, mcp._rack = mcp._portal, mcp._rack, fake, lambda: ("author_manager",)
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
            mcp._portal, mcp._rack = real, real_rack

    def test_get_record_and_get_note_take_an_edit_tab_path_line(self):
        asked = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            asked.append((svc, proj, path))
            if svc == "note":
                return httpx.Response(200, json={"id": "회의 메모", "title": "t", "date": "", "tags": [], "fields": {},
                                                 "version": "1", "body": "b"})
            return httpx.Response(200, json={"authors": [{"id": "dee049b9", "name": "Park"}]})
        real, real_rack, mcp._portal, mcp._rack = mcp._portal, mcp._rack, fake, lambda: ("author_manager",)
        try:
            tok = self.issue()
            r = call(tok, "get_record", path="http://testserver/pp/author_manager/authors/authors/dee049b9")
            self.assertFalse(r["isError"], r)
            self.assertEqual(json.loads(r["content"][0]["text"])["record"]["name"], "Park")
            self.assertEqual(asked[-1][:2], ("author_manager", "authors"))
            for tool in ("get_record", "get_note"):
                r = call(tok, tool, path="http://testserver/pp/note/notes-job/notes/회의 메모")
                self.assertFalse(r["isError"], r)
                self.assertEqual(asked[-1], ("note", "notes-job", "notes/%ED%9A%8C%EC%9D%98%20%EB%A9%94%EB%AA%A8"))
            self.assertFalse(call(tok, "get_note", address="/pp/note/notes-job/notes/회의 메모")["isError"], "address = path")
            asked.clear()
            r = call(tok, "get_record", path="https://elsewhere.example/pp/author_manager/authors/authors/dee049b9")
            self.assertIn("다른 포털", r["content"][0]["text"])
            for bad in ("/pp/author_manager/authors", "http://testserver/p/x/y/z/w", "/pp/note/n/notes/a%2Fb"):
                self.assertTrue(call(tok, "get_record", path=bad)["isError"], bad)
            self.assertTrue(call(tok, "get_note", path="/pp/author_manager/authors/authors/x")["isError"])
            self.assertTrue(call(tok, "get_record")["isError"])
            self.assertEqual(asked, [])
        finally:
            mcp._portal, mcp._rack = real, real_rack

    def test_get_record_reads_a_set_inbox_and_search_does_not(self):
        sets = [{"name": "manage", "members": {"note": "note", "inbox": "inbox"}},
                {"name": "jobboard", "members": {"note": "notes-job", "inbox": "research"}}]
        asked = []

        async def fake(request, grant, method, url, **kw):
            asked.append(url)
            rows = [{"id": "mcp-1", "target": "job", "status": "approved", "made": {"svc": "jobboard", "proj": "jobboard", "id": "j9"}}]
            return httpx.Response(200, json={"settings": {}, "version": 1, "inbox": rows if "research" in url else []})
        real, real_sets, mcp._self, mcp.registry.share_sets = mcp._self, mcp.registry.share_sets, fake, lambda: (sets, True)
        try:
            tok = self.issue()
            r = json.loads(call(tok, "get_record", service="inbox", id="mcp-1")["content"][0]["text"])
            self.assertEqual((r["project"], r["record"]["status"], r["record"]["made"]["id"]), ("research", "approved", "j9"))
            self.assertIn("/pp/inbox/inbox/api/data", asked)                        # every set's inbox is looked in
            self.assertTrue(call(tok, "get_record", service="inbox", id="nope")["isError"])
            self.assertTrue(call(tok, "search", query="job", service="inbox")["isError"])     # not a readable service
        finally:
            mcp._self, mcp.registry.share_sets = real, real_sets

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

    def test_rack_services_come_from_their_manifests(self):
        for name, m in (("parameters", {"kind": "rack"}), ("author_manager", {"kind": "author", "capabilities": {"tags": True}}),
                        ("asset_manager", {"kind": "asset"}), ("note", {"kind": "note", "capabilities": {"tags": True}})):
            d = mcp.registry.service_dir(name)
            d.mkdir(parents=True, exist_ok=True)
            (d / "service.json").write_text(json.dumps(m))
        got = mcp._rack()           # other tests add manifests of their own to the same data root
        self.assertTrue({"author_manager", "parameters"} <= set(got) and not {"asset_manager", "note"} & set(got), got)

    def test_a_job_takes_what_people_write_and_keeps_what_jobrun_owns(self):
        jobs = [{"id": "jobrun-20261112-005005-915d7d", "title": "skim", "tags": ["job/915d7d", "spirit"]},
                {"id": "jobrun-20261111-000000-aaaaaa", "title": "other", "tags": ["job/aaaaaa"]}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs, "prefs": [{"id": "x"}]})
            sent.append(kw["json"])
            return httpx.Response(200, json={"record": {**jobs[0], **kw["json"]["fields"]}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            r = call(tok, "update_job", id="915d7d", goal="g", why="w", add_tags=["#req/x"], remove_tags=["spirit"])
            self.assertFalse(r["isError"], r)
            f = sent[0]["fields"]
            self.assertEqual(sent[0]["id"], "jobrun-20261112-005005-915d7d")
            self.assertEqual((f["goal"], f["why"], f["agent"], f["tags"]), ("g", "w", "Claude", ["job/915d7d", "req/x"]))
            self.assertFalse(call(tok, "update_job", id="20261112-005005-915d7d", report="r")["isError"])
            sent.clear()
            for bad in ({"id": "915d7d", "status": "done"}, {"id": "915d7d", "title": "x"},
                        {"id": "915d7d", "remove_tags": ["job/915d7d"]}, {"id": "915d7d"},
                        {"id": "bbbbbb", "goal": "g"}, {"id": "915d7d", "logs": "L1"}):
                self.assertTrue(call(tok, "update_job", **bad)["isError"], bad)
            self.assertEqual(sent, [])
            self.assertIn("30", call(tok, "update_job", id="jobrun-nope", goal="g")["content"][0]["text"])
            self.assertTrue(call(self.issue(write=False), "update_job", id="915d7d", goal="g")["isError"])
        finally:
            mcp._portal = real

    def test_a_job_files_merge_and_comments_name_a_file(self):
        jobs = [{"id": "jobrun-20261112-005005-915d7d", "tags": ["job/915d7d"], "files": {"a.png": "old", "b.png": "keep"}}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs})
            sent.append(kw["json"])
            return httpx.Response(200, json={"record": {"id": "e1", **jobs[0], **kw["json"].get("fields", {})}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            self.assertFalse(call(tok, "update_job", id="915d7d", files={"a.png": "", "c.png": "new"})["isError"])
            self.assertEqual(sent[0]["fields"]["files"], {"b.png": "keep", "c.png": "new"})
            sent.clear()
            self.assertFalse(call(tok, "update_job", id="915d7d", files=json.dumps({"a.png": "", "c.png": "new"}))["isError"])
            self.assertEqual(sent[0]["fields"]["files"], {"b.png": "keep", "c.png": "new"})
            self.assertTrue(call(tok, "update_job", id="915d7d", files="[1]")["isError"])
            sent.clear()
            self.assertTrue(call(tok, "update_job", id="915d7d", files={"x/a.png": "n"})["isError"])
            self.assertFalse(call(tok, "add_evaluation", id="915d7d", text="t", file="b.png")["isError"])
            self.assertEqual(sent[0]["record"]["file"], "b.png")
            self.assertTrue(call(tok, "add_evaluation", id="915d7d", text="t", file="../b.png")["isError"])
        finally:
            mcp._portal = real

    def test_file_descriptions_go_to_files_not_note(self):
        jobs = [{"id": "jobrun-20261112-005005-915d7d", "jobId": "20261112-005005-915d7d", "tags": [],
                 "files": {"a.png": "A"}}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs})
            if path.startswith("jobrun/"):
                return httpx.Response(200, json={"state": "done", "files": ["a.png", "b.png", "c.root", "job.log"]})
            sent.append(kw["json"])
            return httpx.Response(200, json={"record": {**jobs[0], **kw["json"]["fields"]}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            r = call(tok, "update_job", id="915d7d", note="a.png: x\nb.png: y")
            self.assertTrue(r["isError"]) ; self.assertIn("files 인자", r["content"][0]["text"])
            long = "b.png 은 어떤 그림인지 길게 설명하는 문장이 여기 계속 이어지고 c.root 도 함께 이야기한다 " * 2
            self.assertTrue(call(tok, "update_job", id="915d7d", report=long, files={"b.png": "B"})["isError"])
            r = call(tok, "update_job", id="915d7d", report="## 그림\n- a.png\n- b.png")
            self.assertTrue(r["isError"]) ; self.assertIn("b.png", r["content"][0]["text"])
            self.assertEqual(sent, [])
            r = call(tok, "update_job", id="915d7d", report="## 그림\n- a.png\n- b.png", files={"b.png": "B"})
            self.assertFalse(r["isError"], r)
            self.assertEqual(json.loads(r["content"][0]["text"])["files_missing"], ["c.root"])
        finally:
            mcp._portal = real

    def test_evidence_links_set_references_once_each(self):
        jobs = [{"id": "jobrun-20261112-005005-915d7d", "tags": [],
                 "evidence": [{"svc": "reference_manager", "proj": "refs", "id": "r1", "place": "Figure 3", "state": "agent"}]}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data" and svc == "reference_manager":
                return httpx.Response(200, json={"references": [{"id": "r1"}, {"id": "r2"}] if proj == "refs"
                                                 else [{"id": "p9"}, {"id": "r2"}]})
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs})
            sent.append(kw["json"])
            return httpx.Response(200, json={"record": {**jobs[0], **kw["json"]["fields"]}})
        real, share, mcp._portal = mcp._portal, mcp.registry.share_for, fake
        mcp.registry.share_for = lambda svc, proj: {"jobboard": proj, "reference_manager": "refs"}
        link, mcp.registry.link_project = mcp.registry.link_project, lambda svc: "papers"
        try:
            tok = self.issue()
            r = call(tok, "update_job", id="915d7d", add_evidence=[{"id": "r1", "place": "그림 3"},
                     {"id": "r2", "place": "Fig. 3-5", "why": "w"}], remove_evidence=[])
            self.assertFalse(r["isError"], r)
            ev = sent[0]["fields"]["evidence"]
            self.assertEqual([(e["id"], e["place"]) for e in ev], [("r1", "Figure 3"), ("r2", "Figures 3-5")])
            self.assertEqual((ev[1]["proj"], ev[1]["why"]), ("refs", "w"))
            self.assertTrue(ev[1]["by"] and ev[1]["at"])
            self.assertEqual({e["state"] for e in ev[1:]}, {"agent"})
            self.assertEqual(ev[1]["states"][0]["state"], "agent")
            sent.clear()
            for bad in ([{"id": "r2", "state": "approved"}], [{"id": "r2", "strength": "hunch"}]):
                self.assertTrue(call(tok, "update_job", id="915d7d", add_evidence=bad)["isError"], bad)
            self.assertEqual(sent, [])
            self.assertFalse(call(tok, "update_job", id="915d7d", add_evidence=[{"id": "r2", "place": "p. 9", "strength": "measurement"}])["isError"])
            self.assertEqual(sent[0]["fields"]["evidence"][-1]["strength"], "measurement")
            jobs[0]["evidence"].append({"svc": "reference_manager", "proj": "refs", "id": "r2", "place": "Table 1", "state": "person"})
            sent.clear()
            self.assertTrue(call(tok, "update_job", id="915d7d", remove_evidence=[{"id": "r2", "place": "Table 1"}])["isError"])
            jobs[0]["evidence"].pop()
            jobs[0]["evidence"].append({"svc": "reference_manager", "proj": "refs", "id": "r2", "place": "Table 2", "by": "jungwoo"})
            self.assertTrue(call(tok, "update_job", id="915d7d", remove_evidence=[{"id": "r2", "place": "Table 2"}])["isError"],
                            "no state, a person's name: the board shows it as a person's")
            jobs[0]["evidence"][-1]["by"] = "플랫폼 agent"
            self.assertFalse(call(tok, "update_job", id="915d7d", remove_evidence=[{"id": "r2", "place": "Table 2"}])["isError"])
            jobs[0]["evidence"].pop()
            sent.clear()
            sent.clear()
            call(tok, "update_job", id="915d7d", remove_evidence=[{"id": "r1", "place": "Fig.3"}])
            self.assertEqual(sent[0]["fields"]["evidence"], [])
            sent.clear()
            call(tok, "update_job", id="915d7d", add_evidence=json.dumps([{"id": "r2", "place": "p. 4"}]))
            self.assertEqual([(e["id"], e["place"]) for e in sent[0]["fields"]["evidence"]], [("r1", "Figure 3"), ("r2", "Page 4")])
            sent.clear()
            for bad in ("[1, 2]", '["r2"]', "not json", '{"id": "r2"}'):
                r = call(tok, "update_job", id="915d7d", add_evidence=bad)
                self.assertTrue(r["isError"], bad)
            self.assertIn("{id, place, why} 객체", call(tok, "update_job", id="915d7d", add_evidence=["r2"])["content"][0]["text"])
            self.assertEqual(sent, [])
            self.assertIn("refs에 없는", call(tok, "update_job", id="915d7d", add_evidence=[{"id": "p9"}])["content"][0]["text"],
                          "sets stay apart: papers is not looked in")
            self.assertTrue(call(tok, "update_job", id="915d7d", add_evidence=[{"id": "p9", "proj": "papers"}])["isError"])
            self.assertEqual(sent, [])
            r = call(tok, "update_job", id="915d7d", add_evidence=[{"id": "nope"}])
            self.assertIn("refs에 없는", r["content"][0]["text"])
            self.assertIn("먼저 reference_manager에 등록", r["content"][0]["text"])
            self.assertEqual(sent, [])
        finally:
            mcp._portal, mcp.registry.share_for, mcp.registry.link_project = real, share, link

    def test_report_check_warns_only_of_unknown_keys(self):
        t = "Gain is 80 [@K1]. Width 3 [@K2] [@K1]. Peak 550 ADC. Seen 4 [@NOPE]. Job ::abc123 done."
        r = mcp.check_report(t, {"K1": "approved", "K2": "agent"})
        self.assertEqual(r, {"keys": [{"key": "K1", "state": "approved"}, {"key": "K2", "state": "agent"}],
                             "unknown_keys": ["NOPE"]})
        r = mcp.check_report("Seen 4 [@X].", {}, ["papers"])
        self.assertEqual(r, {"keys": [], "unreadable_keys": ["X"], "unread_projects": ["papers"]})

    def test_review_tools_go_through_the_note_service(self):
        asked = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            asked.append((svc, method, path, proj, kw.get("params"), kw.get("json")))
            if path.endswith("/units"):
                return httpx.Response(200, json={"units": [{"n": 1, "text": "Gain 80."}], "moved": []})
            if method == "GET":
                return httpx.Response(200, json={"id": "r", "title": "t", "date": "", "tags": [], "version": "1", "body": "b",
                                                 "fields": {"reviews": [{"id": "x"}], "mode": "note"}})
            return httpx.Response(201, json={"id": "rv1"})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            r = call(tok, "note_units", path="/pp/note/notes-job/notes/보고서 1", level="paragraph")
            self.assertFalse(r["isError"], r)
            self.assertEqual(asked[-1][2:5], ("notes/%EB%B3%B4%EA%B3%A0%EC%84%9C%201/units", "notes-job", {"level": "paragraph"}))
            g = json.loads(call(tok, "get_note", id="r")["content"][0]["text"])
            self.assertEqual((g["fields"], g["reviews"]), ({"mode": "note"}, 1), "reviews are read through note_units")
            self.assertFalse(call(tok, "add_review", id="r", n=2, text="근거?")["isError"])
            self.assertEqual(asked[-1][5], {"level": "sentence", "text": "근거?", "via": "t", "n": 2})
            self.assertFalse(call(tok, "add_review", id="r", level="doc", text="전체")["isError"])
            self.assertNotIn("n", asked[-1][5])
            self.assertFalse(call(tok, "reply_review", id="r", rid="rv1", text="고침: 근거 달았음")["isError"])
            self.assertEqual(asked[-1][2], "notes/r/reviews/rv1/replies")
            asked.clear()
            for bad in ({"id": "r", "text": "x"}, {"id": "r", "n": 1, "text": " "}, {"id": "r", "n": 1, "level": "word", "text": "x"}):
                self.assertTrue(call(tok, "add_review", **bad)["isError"], bad)
            self.assertTrue(call(tok, "reply_review", id="r", rid="a/b", text="x")["isError"])
            self.assertTrue(call(self.issue(write=False), "add_review", id="r", n=1, text="x")["isError"])
            self.assertNotIn("resolve_review", [t["name"] for t in mcp.TOOLS])
            self.assertEqual(asked, [])
        finally:
            mcp._portal = real

    def test_empty_notes_by_title_and_body_not_id(self):
        from app.tidy import empty_reason as e
        self.assertEqual(e("", ""), "제목도 본문도 없음")
        self.assertEqual(e("Untitled-5", "#a +B\n\n"), "제목도 본문도 없음")
        self.assertEqual((e("명령모드", "#x"), e("Untitled", "words")), ("본문 없음", "제목 없음(Untitled)"))
        self.assertEqual((e("명령모드", "# 헤딩\n본문"), e("Untitle", "x")), ("", ""))

    def test_empty_records_by_name_fields_and_one_id_per_thing(self):
        from app.tidy import cand_id, empty_records
        doc = {"authors": [{"id": "a", "korFamily": "김"}, {"id": "b", "korFamily": " ", "tags": ["x"]}],
               "inbox": [{"id": "i"}], "places": [{"id": "p", "city": "Seoul"}], "settings": {"x": 1}}
        self.assertEqual([(k, r["id"]) for k, r in empty_records(doc)], [("authors", "b")])  # places use no name field
        self.assertEqual([(k, r["id"]) for k, r in empty_records(doc, {"places": ["name"]})], [("places", "p")])
        self.assertEqual(cand_id("note", "n", "x"), cand_id("note", "n", "x"))   # both portals write the same candidate
        self.assertNotEqual(cand_id("note", "n", "x"), cand_id("note", "n", "y"))
        from app import tidy
        tidy._remember({"tidy-a", "mcp-b"})
        self.assertEqual(tidy._asked(), {"tidy-a"})                                # a no outlives the inbox's 10 days

    def test_reports_as_on_the_issues_screen(self):
        from app import security
        u = models.User(username="rep", email="rep@x.org", password_hash=security.hash_password("pw-rep-1234"),
                        role="user", is_active=True, email_verified=True)
        self.db.add(u)
        self.db.commit()
        mine = models.Report(user_id=u.id, kind="bug", subject="깨짐", body="b",
                             attachments_json=json.dumps([{"id": "f" * 32, "name": "s.png", "size": 9}]))
        other = models.Report(user_id=self.user.id, kind="inquiry", subject="관리자 것", body="c")
        self.db.add_all([mine, other])
        self.db.commit()
        mgr, plain = self.issue(), mcp_tokens.issue(self.db, "p", u, True, 30)
        got = json.loads(call(mgr, "list_issues")["content"][0]["text"])
        self.assertEqual({r["subject"] for r in got["reports"]} >= {"깨짐", "관리자 것"}, True)
        att = next(r for r in got["reports"] if r["id"] == mine.id)["attachments"][0]
        self.assertEqual(att, {"name": "s.png", "size": 9, "type": None, "path": f"/api/reports/{mine.id}/files/{'f' * 32}"})
        got = json.loads(call(plain, "list_issues", status="all")["content"][0]["text"])
        self.assertEqual([r["id"] for r in got["reports"]], [mine.id])                 # their own only
        self.assertTrue(call(plain, "reply_issue", id=mine.id, reply="x")["isError"])  # answering is a manager's
        self.assertTrue(call(self.issue(write=False), "reply_issue", id=mine.id, resolved=True)["isError"])
        r = json.loads(call(mgr, "reply_issue", id=mine.id, reply="고침: abc123", resolved=True)["content"][0]["text"])
        self.assertEqual((r["status"], r["comments"]), ("resolved", 1))
        got = json.loads(call(mgr, "list_issues")["content"][0]["text"])
        self.assertNotIn(mine.id, [x["id"] for x in got["reports"]])                    # open only, by default
        self.assertTrue(call(mgr, "reply_issue", id=mine.id)["isError"])
        self.assertFalse(call(mgr, "list_reports")["isError"])                          # the old name still answers

    def test_propose_tags_leaves_one_candidate(self):
        left = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if svc == "note":
                return httpx.Response(200, json={"title": "회의"})
            if path == "data":
                return httpx.Response(200, json={"authors": [{"id": "a1", "name": "Kim"}]})
            return httpx.Response(404)

        async def inbox(request, grant, record, proj):
            left.append((proj, record))
            return httpx.Response(200, json={"record": record})
        real, real_rack, real_inbox = mcp._portal, mcp._rack, mcp._inbox
        mcp._portal, mcp._rack, mcp._inbox, real_of = fake, lambda: ("author_manager",), inbox, mcp._inbox_of
        mcp._inbox_of = lambda grant, home: home.get("inbox", "")
        mcp.registry.write_share_sets([{"id": "m1", "name": "m", "members": {"note": "n1", "author_manager": "authors", "inbox": "ib"}}])
        try:
            tok = self.issue(write=False)
            r = call(tok, "propose_tags", why="오늘 정리", set="m",
                     items=[{"service": "note", "id": "x", "add": ["#STARK"]}, {"service": "author_manager", "id": "a1", "add": ["gain"]}])
            self.assertFalse(r["isError"], r)
            self.assertEqual(len(left), 1)
            rec = left[0][1]
            self.assertEqual((rec["target"], [(i["project"], i["title"], i["add"]) for i in rec["items"]]),
                             ("tags", [("n1", "회의", ["STARK"]), ("authors", "Kim", ["gain"])]))
            for bad in ([], [{"service": "note", "id": "x", "add": ["two words"]}], [{"service": "note", "id": "x", "add": []}]):
                self.assertTrue(call(tok, "propose_tags", why="w", set="m", items=bad)["isError"], bad)
        finally:
            mcp._portal, mcp._rack, mcp._inbox, mcp._inbox_of = real, real_rack, real_inbox, real_of
            mcp.registry.write_share_sets([])

    def test_guide_reads_the_jobboard_guide(self):
        d = mcp.registry.service_dir("jobboard")
        d.mkdir(parents=True, exist_ok=True)
        (d / "GUIDE.md").write_text("# rules")
        (d / "service.json").write_text(json.dumps({"kind": "rack", "start": {"cwd": str(d)}}))
        r = call(self.issue(write=False), "guide")
        self.assertFalse(r["isError"], r)
        self.assertIn("# rules", r["content"][0]["text"])

    def test_a_job_takes_its_parents_where_jobrun_named_none(self):
        jobs = [{"id": "jobrun-20261112-000000-aaaaaa", "tags": ["job/aaaaaa"]},
                {"id": "jobrun-20261112-000001-bbbbbb", "tags": ["job/bbbbbb"], "inputs": [{"id": "jobrun-20261112-000000-aaaaaa"}]},
                {"id": "jobrun-20261112-000002-cccccc", "tags": ["job/cccccc"],
                 "paramValues": {"scan": "20261112-000000-aaaaaa"}}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs})
            sent.append(kw["json"])
            return httpx.Response(200, json={"record": {**jobs[0], **kw["json"]["fields"]}})
        real, mcp._portal = mcp._portal, fake
        try:
            tok = self.issue()
            r = call(tok, "update_job", id="cccccc", goal="g")
            self.assertFalse(r["isError"], r)
            sent.clear()
            r = call(tok, "update_job", id="bbbbbb", inputs=["aaaaaa", "jobrun-20261112-000000-aaaaaa"])
            self.assertFalse(r["isError"], r)
            self.assertEqual(sent[-1]["fields"]["inputs"], [{"id": "jobrun-20261112-000000-aaaaaa"}], "short ids, once each")
            self.assertFalse(call(tok, "update_job", id="bbbbbb", inputs=[])["isError"], "[] clears")
            n = len(sent)
            for bad in ({"id": "cccccc", "inputs": ["aaaaaa"]},          # jobrun's parameter names its parent
                        {"id": "aaaaaa", "inputs": ["aaaaaa"]},          # itself
                        {"id": "aaaaaa", "inputs": ["bbbbbb"]},          # bbbbbb is built on aaaaaa: a loop
                        {"id": "bbbbbb", "inputs": ["dddddd"]},          # no such job
                        {"id": "bbbbbb", "inputs": "aaaaaa"}):           # not a list
                self.assertTrue(call(tok, "update_job", **bad)["isError"], bad)
            self.assertEqual(len(sent), n)
            call(tok, "update_job", id="aaaaaa", briefing="next: widen the scan")
            self.assertEqual(sent[-1]["fields"]["briefingBy"], "", "an agent's proposal is shown with its agent fields")
        finally:
            mcp._portal = real

    def test_a_platform_agent_approves_as_itself_only(self):
        jobs = [{"id": "jobrun-20261112-005005-915d7d", "title": "skim", "tags": ["job/915d7d"]}]
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            if path == "data":
                return httpx.Response(200, json={"jobs": jobs})
            sent.append((path, kw["json"]))
            if path.startswith("approve/"):
                return httpx.Response(200, json={"allowed": False, "mode": "human", "entry": {"action": "request"},
                                                 "state": {"approved": False, "confirmed": False}})
            return httpx.Response(200, json={"record": {"id": "e1", **kw["json"].get("record", {}),
                                                        **jobs[0], **kw["json"].get("fields", {})}})
        real, mcp._portal = mcp._portal, fake
        try:
            run = models.AgentRun(user_id=self.user.id, service="jobboard", project="", provider="claude",
                                  approval="similar", task="t")
            self.db.add(run)
            self.db.commit()
            agent = mcp_tokens.issue(self.db, f"agent-run-{run.id}", self.user, True, 1)
            r = call(agent, "approve_job", id="915d7d", by="사람", reason="done")
            self.assertFalse(r["isError"], r)
            path, body = sent[-1]
            self.assertEqual(path, "approve/jobrun-20261112-005005-915d7d")
            self.assertEqual((body["by"], body["run"], body["requester"], body["run_mode"]),
                             ("플랫폼 agent", str(run.id), "admin", "similar"), "the token decides, not by=")
            self.assertEqual(json.loads(r["content"][0]["text"])["done"], "request")
            call(agent, "add_evaluation", id="915d7d", text="looks fine", verdict="good", by="person")
            ev = sent[-1][1]["record"]
            self.assertEqual((ev["by"], ev["agent"], ev["requester"], ev["verdict"]), ("agent", "플랫폼 agent", "admin", "good"))
            call(agent, "update_job", id="915d7d", goal="g", agent="사람")
            f = sent[-1][1]["fields"]
            self.assertEqual((f["agent"], f["agentRun"], f["agentRequester"]), ("플랫폼 agent", str(run.id), "admin"))
            # Anyone else: by as given (default Claude), and no run.
            call(self.issue(), "approve_job", id="915d7d")
            self.assertEqual(sent[-1][1]["by"], "Claude")
            self.assertNotIn("run", sent[-1][1])
            self.assertTrue(call(self.issue(), "approve_job", id="915d7d", action="confirm")["isError"])
        finally:
            mcp._portal = real

    def _world(self):
        """A share set of references, authors, notes and jobs, behind a fake proxy."""
        jobs = [{"id": "jobrun-1-aaaaaa", "title": "skim", "status": "성공", "agent": "Claude", "tags": ["job/aaaaaa", "SpiRIT"],
                 "params": ["P1"], "approvals": [{"at": "1", "action": "request", "by": "플랫폼 agent"}]},
                {"id": "jobrun-2-bbbbbb", "title": "plot", "status": "성공", "report": "done", "tags": ["job/bbbbbb"],
                 "approvals": [{"at": "1", "action": "approve", "by": "사람"}]},
                {"id": "jobrun-3-cccccc", "title": "wait", "status": "대기", "agent": "Codex", "tags": ["job/cccccc"]}]
        data = {
            "reference_manager": {"references": [
                {"id": "r-0001-pion", "title": "Pion production in HIC", "date": "2024-03-01", "tags": ["SpiRIT", "pion"],
                 "authors": [{"name": "K. Pion", "ref": "a-0001-kimp"}]},
                {"id": "r-0002-kaon", "title": "Kaon flow", "date": "2019-05-01", "tags": ["kaon"]}],
                "settings": {"x": 1}},
            "author_manager": {"authors": [{"id": "a-0001-kimp", "name": "Kim Pion", "tags": ["SpiRIT"]}]},
            "jobboard": {"jobs": jobs, "evaluations": [{"id": "E1", "task": "jobrun-1-aaaaaa", "text": "ok"}],
                         "approval": [{"id": "rule"}]},
            "parameters": {"sets": [{"id": "P1", "title": "skim pars"}]},
        }
        notes = [{"id": "n1", "title": "pion plan", "date": "2026-11-01", "tags": ["SpiRIT", "agent/x"], "excerpt": "first"}]
        calls = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            calls.append((svc, path, (kw.get("params") or {}).get("q")))
            if svc == "note":
                if path == "notes":
                    return httpx.Response(200, json={"notes": notes})
                if path == "tags":
                    return httpx.Response(200, json={"tags": {"SpiRIT": 1, "agent/x": 1}})
                if path == "search":
                    q = kw["params"]["q"]
                    hit = q in ("pion", "::aaaaaa", "r-0001-pion")
                    return httpx.Response(200, json={"hits": [{"id": "n1", "title": "pion plan", "line": 2,
                                                               "text": f"line with {q}"}] if hit else []})
                if path == "notes/n1":
                    return httpx.Response(200, json={"id": "n1", "title": "pion plan", "tags": ["SpiRIT"],
                                                     "body": "see r-0001-pion and ::aaaaaa", "version": "1", "fields": {}})
            if path == "data":
                return httpx.Response(200, json=data[svc])
            if path == "tags":
                n = {}
                for k, rows in data[svc].items():
                    for r in rows if isinstance(rows, list) else []:
                        for t in r.get("tags") or []:
                            n[t] = n.get(t, 0) + 1
                return httpx.Response(200, json={"tags": n})
            return httpx.Response(404, json={"detail": "no"})
        world = {"jobboard": "jobboard", "parameters": "sets", "reference_manager": "papers",
                 "author_manager": "authors", "note": "note"}
        real = (mcp._portal, mcp._rack, mcp.registry.link_project, mcp.registry.share_for, mcp.registry.share_sets, mcp._note)
        mcp._portal, mcp._rack = fake, (lambda: ("author_manager", "jobboard", "parameters", "reference_manager"))
        mcp._note = lambda request, grant, method, path, **kw: fake(request, grant, "note", method, path, **kw)
        mcp.registry.link_project = lambda s, m=None: world.get(s, "")
        mcp.registry.share_for = lambda s, p: dict(world)
        mcp.registry.share_sets = lambda: ([{"name": "jobboard", "members": {"jobboard": "jobboard", "parameters": "sets"}}], True)
        self.addCleanup(lambda: setattr(mcp, "_portal", real[0]) or setattr(mcp, "_rack", real[1])
                        or setattr(mcp.registry, "link_project", real[2]) or setattr(mcp.registry, "share_for", real[3])
                        or setattr(mcp.registry, "share_sets", real[4]) or setattr(mcp, "_note", real[5]))
        return calls

    def out(self, tok, name, **args):
        r = call(tok, name, **args)
        self.assertFalse(r["isError"], r)
        return json.loads(r["content"][0]["text"])

    def test_tags_are_counted_per_service_and_narrowed_by_prefix(self):
        self._world()
        tok = self.issue(write=False)
        got = {s["service"]: s["tags"] for s in self.out(tok, "tags")["services"]}
        self.assertEqual(got["reference_manager"], {"SpiRIT": 1, "kaon": 1, "pion": 1})
        self.assertEqual(got["note"]["agent/x"], 1)
        got = {s["service"]: s["tags"] for s in self.out(tok, "tags", prefix="agent")["services"]}
        self.assertEqual(got, {"note": {"agent/x": 1}})
        got = {s["service"] for s in self.out(tok, "tags", set="jobboard")["services"]}
        self.assertEqual(got, {"jobboard"})

    def test_find_mixes_words_and_tags_across_services(self):
        self._world()
        tok = self.issue(write=False)
        hits = self.out(tok, "find", query="pion")["hits"]
        self.assertEqual({(h["service"], h["id"]) for h in hits},
                         {("reference_manager", "r-0001-pion"), ("author_manager", "a-0001-kimp"), ("note", "n1")})
        self.assertEqual(hits[0]["id"], "r-0001-pion")          # in the title, and in a tag
        self.assertIn("Pion", next(h for h in hits if h["id"] == "r-0001-pion")["snippet"])
        ids = lambda **a: {h["id"] for h in self.out(tok, "find", **a)["hits"]}  # noqa: E731
        self.assertEqual(ids(tags=["SpiRIT", "pion"]), {"r-0001-pion"})
        self.assertEqual(ids(tags=["kaon", "pion"], match="any"), {"r-0001-pion", "r-0002-kaon"})
        self.assertEqual(ids(tags=["agent"]), {"n1"})        # a tag finds the tags inside it
        self.assertEqual(ids(query="pion", kind="authors"), {"a-0001-kimp"})
        self.assertEqual(ids(tags=["kaon", "pion"], match="any", since="2020-01-01"), {"r-0001-pion"})
        self.assertNotIn("rule", ids(query="rule"))         # the approval policy is not a record
        self.assertTrue(call(tok, "find")["isError"])

    def test_related_follows_links_both_ways_and_shared_tags(self):
        self._world()
        tok = self.issue(write=False)
        r = self.out(tok, "related", service="reference_manager", id="r-0001-pion")
        self.assertEqual([x["id"] for x in r["links"]], ["a-0001-kimp"])
        self.assertEqual([x["id"] for x in r["backlinks"]], ["n1"])      # the note names R1
        self.assertIn("jobrun-1-aaaaaa", [x["id"] for x in r["same_tags"]])
        r = self.out(tok, "related", service="note", id="n1")
        self.assertEqual({x["id"] for x in r["links"]}, {"r-0001-pion", "jobrun-1-aaaaaa"})   # an id and a ::short id
        self.assertTrue(call(tok, "related", service="reference_manager", id="nope")["isError"])

    def test_my_tasks_and_a_jobs_context(self):
        self._world()
        tok = self.issue(write=False)
        t = self.out(tok, "my_tasks")
        self.assertEqual((t["agent"], [j["id"] for j in t["awaiting_approval"]]), ("Claude", ["jobrun-1-aaaaaa"]))
        self.assertTrue(t["awaiting_approval"][0]["requested"])
        self.assertEqual([j["id"] for j in t["no_report"]], ["jobrun-1-aaaaaa"])
        self.assertEqual([j["id"] for j in t["mine"]], ["jobrun-1-aaaaaa"])
        self.assertEqual([j["id"] for j in self.out(tok, "my_tasks", agent="Codex")["mine"]], ["jobrun-3-cccccc"])
        c = self.out(tok, "job_context", id="aaaaaa")
        self.assertEqual((c["job"]["id"], c["approval"]["requested"]), ("jobrun-1-aaaaaa", True))
        self.assertEqual([p["id"] for p in c["params"]], ["P1"])
        self.assertEqual([e["id"] for e in c["evaluations"]], ["E1"])
        self.assertEqual([n["id"] for n in c["notes"]], ["n1"])
        self.assertNotIn("approvals", c["job"])

    def test_jobs_are_submitted_and_watched_through_jobboard(self):
        calls = self._world()
        tok = self.issue()

        async def fake(request, grant, svc, method, path, proj="", **kw):
            calls.append((svc, method, path, kw.get("json")))
            if path == "recipes":
                return httpx.Response(200, json={"local": {"skim": {"params": ["run"]}}, "stark-zt": {"error": "down"}})
            if path == "submit":
                if kw["json"]["project"] == "nope":
                    return httpx.Response(400, json={"detail": "no such project: nope"})
                return httpx.Response(200, json={"id": "jobrun-9-dddddd", "jobId": "9-dddddd", "server": "local"})
            if path == "data":
                return httpx.Response(200, json={"jobs": [{"id": "jobrun-9-dddddd", "jobId": "9-dddddd", "status": "실행",
                                                           "recipe": "skim", "tags": ["job/dddddd"]}]})
            if path == "jobrun/9-dddddd":
                return httpx.Response(200, json={"state": "running", "error": None, "log_tail": "x" * 3000,
                                                 "files": ["out.root"], "recipe": "skim"})
            return httpx.Response(404, json={"detail": "no"})
        mcp._portal = fake
        self.assertEqual(self.out(tok, "job_recipes", server="stark-zt"), {"stark-zt": {"error": "down"}})
        self.assertIn("local", self.out(tok, "job_recipes"))
        got = self.out(tok, "submit_job", recipe="skim", project="SpiRIT", params={"run": 1241}, why="needed")
        self.assertEqual((got["status"], got["server"], got["project"]), ("waiting", "local", "SpiRIT"))
        self.assertFalse(any(c[2] == "submit" for c in calls))      # nothing ran: a person approves first
        cand = self.proposed[-1]
        self.assertEqual((cand["target"], cand["recipe"], cand["jobProject"], json.loads(cand["params"]), cand["remark"]),
                         ("job", "skim", "SpiRIT", {"run": 1241}, "needed"))
        self.assertEqual(cand["server"], "local")         # the one server that has it, written down for the person
        self.assertTrue(call(tok, "submit_job", recipe="nope", project="SpiRIT", why="w")["isError"])
        self.assertTrue(call(tok, "submit_job", recipe="skim", project="SpiRIT", server="stark-zt", why="w")["isError"])
        self.assertTrue(call(tok, "submit_job", recipe="skim", project="SpiRIT")["isError"])   # no why
        self.assertTrue(call(self.issue(write=False), "submit_job", recipe="skim", project="SpiRIT", why="w")["isError"])
        st = self.out(tok, "job_status", id="dddddd")
        self.assertEqual((st["status"], st["state"], st["files"], len(st["log_tail"])), ("실행", "running", ["out.root"], 2000))

    def test_a_note_becomes_slides_and_back(self):
        tok = self.issue()
        self.assertFalse(call(tok, "add_note", title="t", body="b", mode="slide", ratio="16x9")["isError"])
        self.assertEqual(self.calls[-1][2]["fields"], {"mode": "slide", "ratio": "16x9"})
        self.calls.clear()
        self.assertFalse(call(tok, "add_note", title="t", body="b")["isError"])
        self.assertNotIn("fields", self.calls[-1][2])
        self.calls.clear()
        self.assertFalse(call(tok, "update_note", id="plain", base_version="1", mode="slide")["isError"])
        self.assertEqual(self.calls[-1][2], {"baseVersion": "1", "fields": {"mode": "slide"}})
        self.assertTrue(call(tok, "update_note", id="paper", base_version="1", mode="slide")["isError"])   # tex
        self.assertTrue(call(tok, "add_note", title="t", body="b", mode="slide", ratio="3x2")["isError"])

    def test_a_token_bound_to_a_set_goes_to_its_projects(self):
        sets = [{"name": "jobboard", "members": {"note": "notes-job", "jobboard": "jobboard"}}]
        real = mcp.registry.share_sets
        mcp.registry.share_sets = lambda: (sets, True)
        self.addCleanup(lambda: setattr(mcp.registry, "share_sets", real))
        allowed = mcp_tokens.allowed
        self.assertTrue(allowed("set:jobboard", "note", "notes-job"))
        self.assertFalse(allowed("set:jobboard", "note", "note"))
        self.assertFalse(allowed("set:jobboard", "author_manager"))
        self.assertFalse(allowed("set:gone", "note", "note"))           # a set that is gone opens nothing
        self.assertEqual(mcp_tokens.home("note,set:jobboard"), {"note": "notes-job", "jobboard": "jobboard"})
        seen = []

        async def through(request, grant, method, url, **kw):
            seen.append(url)
            return httpx.Response(200, json={"hits": []})
        real_self, mcp._self = mcp._self, through
        try:
            grant = mcp.Grant("jwt", True, "t", "set:jobboard", mcp_tokens.home("set:jobboard"))
            asyncio.run(mcp._portal(None, grant, "note", "GET", "search"))
            self.assertEqual(seen, ["/pp/note/notes-job/api/search"])
            with self.assertRaises(mcp.ToolError):
                asyncio.run(mcp._portal(None, grant, "note", "GET", "search", "note"))
        finally:
            mcp._self = real_self

    def test_reads_cover_both_sets_and_a_delegate_stays_in_one_project(self):
        sets = [{"name": "manage", "members": {"note": "note", "author_manager": "authors"}},
                {"name": "jobboard", "members": {"note": "notes-job", "jobboard": "jobboard"}}]
        real = (mcp.registry.share_sets, mcp.registry.link_project)
        mcp.registry.share_sets = lambda: (sets, True)
        mcp.registry.link_project = lambda s, m=None: {"note": "note", "author_manager": "authors", "jobboard": "jobboard"}.get(s, "")
        self.addCleanup(lambda: setattr(mcp.registry, "share_sets", real[0]) or setattr(mcp.registry, "link_project", real[1]))
        # A token that opens everything, or both sets, reads note in BOTH projects; one bound to a set, its own.
        for scope in ("", "set:manage,set:jobboard"):
            g = mcp.Grant("jwt", True, "t", scope, mcp_tokens.home(scope))
            self.assertEqual(mcp._spread(g, ["note", "jobboard"]),
                             [("note", "note"), ("note", "notes-job"), ("jobboard", "jobboard")])
        g = mcp.Grant("jwt", True, "t", "set:jobboard", mcp_tokens.home("set:jobboard"))
        self.assertEqual(mcp._spread(g, ["note", "author_manager"]), [("note", "notes-job")])
        # delegate: no project named is the token's own project of that service, never the service as a whole.
        sent = []

        async def through(request, grant, method, url, **kw):
            sent.append(kw.get("json"))
            return httpx.Response(200, json={"id": 7, "status": "queued"})
        real_self, mcp._self = mcp._self, through
        try:
            asyncio.run(mcp._delegate(None, g, {"service": "note", "task": "x"}))
            self.assertEqual(sent[-1]["project"], "notes-job")
            with self.assertRaises(mcp.ToolError):
                asyncio.run(mcp._delegate(None, g, {"service": "note", "project": "note", "task": "x"}))
            with self.assertRaises(mcp.ToolError):
                asyncio.run(mcp._delegate(None, g, {"service": "author_manager", "task": "x"}))
        finally:
            mcp._self = real_self
        # The run's own token (scope svc/proj) defaults to that project, not the service's main one.
        self.assertEqual(mcp_tokens.home("note/notes-job"), {"note": "notes-job"})

    def test_a_sets_inbox_is_open_to_its_people_and_the_cover_lists_it(self):
        from app import permissions, security
        sets = [{"name": "manage", "members": {"note": "note", "inbox": "inbox"}},
                {"name": "jobboard", "members": {"note": "notes-job", "inbox": "research"}}]
        real = mcp.registry.share_sets
        mcp.registry.share_sets = lambda: (sets, True)
        self.addCleanup(lambda: setattr(mcp.registry, "share_sets", real))
        mcp.registry.write_manifest("inbox", {"kind": "rack", "capabilities": {"multi_project": True, "inbox": True}})
        mcp.registry.write_manifest("note", {"kind": "rack", "capabilities": {"multi_project": True}})
        db = SessionLocal()
        try:
            u = models.User(username="setmate", email="sm@x.org", password_hash=security.hash_password("pw-setmate-1"),
                            role="user", is_active=True, email_verified=True, email_verified_at=datetime.utcnow())
            db.add(u)
            db.commit()
            db.add(models.ServicePermission(user_id=u.id, service_name="note", project="notes-job"))
            db.commit()
            self.assertTrue(permissions.can_enter_project(db, u, "inbox", "research"))   # in the jobboard set
            self.assertFalse(permissions.can_enter_project(db, u, "inbox", "inbox"))     # not in manage
            self.assertFalse(permissions.can_enter_project(db, u, "note", "note"))       # nothing else opens
        finally:
            db.close()
        tok = c.post("/api/auth/login", json={"username": "setmate", "password": "pw-setmate-1"}).json()["access_token"]
        self.assertEqual(c.get("/api/inbox/sources", headers={"Authorization": f"Bearer {tok}"}).json(),
                         [{"svc": "inbox", "proj": "research", "set": "jobboard"}])
        admin = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        self.assertEqual([s["set"] for s in c.get("/api/inbox/sources", headers={"Authorization": f"Bearer {admin}"}).json()],
                         ["manage", "jobboard"])
        self.assertEqual(c.get("/api/inbox/sources").status_code, 401)

    def test_a_proposal_goes_to_the_inbox_of_the_set_it_names_made_where_that_set_says(self):
        sets = [{"name": "manage", "members": {"note": "note", "academic_activities": "activities", "inbox": "inbox"}},
                {"name": "jobboard", "members": {"note": "notes-job", "academic_activities": "acts-job", "inbox": "research"}},
                {"name": "bare", "members": {"note": "x"}}]
        real = mcp.registry.share_sets
        mcp.registry.share_sets = lambda: (sets, True)
        self.addCleanup(lambda: setattr(mcp.registry, "share_sets", real))
        went = []

        async def inbox(request, grant, record, proj):
            went.append((proj, record.get("destProj")))
            return httpx.Response(200, json={"record": record})
        real_inbox, mcp._inbox = mcp._inbox, inbox
        try:
            g = mcp.Grant("jwt", True, "t", "", {})
            asyncio.run(mcp._propose_note(None, g, {"title": "t", "body": "b", "why": "w", "set": "jobboard"}))
            asyncio.run(mcp._propose_activity(None, g, {"name": "n", "start": "2026-11-13", "why": "w", "set": "jobboard"}))
            self.assertEqual(went, [("research", "notes-job"), ("research", "acts-job")])
            for bad in ("nope", "bare"):                                   # no such set; a set with no inbox
                with self.assertRaises(mcp.ToolError):
                    asyncio.run(mcp._propose_note(None, g, {"title": "t", "body": "b", "why": "w", "set": bad}))
        finally:
            mcp._inbox = real_inbox

    def test_a_file_goes_up_as_text_or_base64(self):
        tok = self.issue()
        r = json.loads(call(tok, "add_file", name="fig.svg", text="<svg/>")["content"][0]["text"])
        self.assertEqual(self.calls[-1][:2], ("POST", "file"))
        self.assertIn("embed", r)
        for bad in ({"name": "../x.png", "text": "x"}, {"name": "a.png", "data": "!!"}, {"name": "a.png"},
                    {"name": "a.png", "text": "x", "data": "eA=="}):
            self.assertTrue(call(tok, "add_file", **bad)["isError"], bad)
        self.assertTrue(call(self.issue(write=False), "add_file", name="a.svg", text="x")["isError"])

    def test_a_set_is_made_from_a_template_in_one_go(self):
        from app import registry
        for name, m in (("note", {"kind": "note", "capabilities": {"multi_project": True, "tags": True}}),
                        ("project_manager", {"kind": "rack", "capabilities": {"multi_project": True}}),
                        ("analysis", {"kind": "generic"})):
            d = registry.service_dir(name)
            (d / "projects" / "base").mkdir(parents=True, exist_ok=True)
            (d / "service.json").write_text(json.dumps(m))
        admin = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        h = {"Authorization": f"Bearer {admin}"}
        c.put("/api/share-sets", headers=h, json={"sets": [{"name": "jobboard", "members": {"note": "base"}}]})
        r = c.post("/api/share-sets/make", headers=h, json={"name": "jobboard", "services": ["note", "project_manager"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["made"], r.json()["joined"]), (["project_manager/jobboard"], ["project_manager"]))
        self.assertTrue((registry.service_dir("project_manager") / "projects" / "jobboard").is_dir())
        got = {s["name"]: s["members"] for s in r.json()["sets"]}
        self.assertEqual(got["jobboard"], {"note": "base", "project_manager": "jobboard"})
        # project_manager joins the set but leaves the cover: the tags tabs show its projects
        from app.routers import home
        self.assertIn("project_manager", home.hidden_services())
        self.assertNotIn("note", home.hidden_services())
        self.assertEqual(c.post("/api/share-sets/make", headers=h, json={"name": "x", "services": ["analysis"]}).status_code, 400)
        # a project already in a set cannot join another
        self.assertEqual(c.post("/api/share-sets/make", headers=h,
                                json={"name": "other", "project": "jobboard", "services": ["project_manager"]}).status_code, 400)
        self.assertEqual(c.post("/api/share-sets/make", json={"name": "y", "services": []}).status_code, 401)
        names = [t["name"] for t in c.get("/api/share-sets/templates", headers=h).json()]
        self.assertIn("jobboard", names)

    def test_a_token_stays_bound_to_its_set_through_a_rename(self):
        from app import registry
        for name in ("note", "project_manager"):
            d = registry.service_dir(name)
            (d / "projects" / "keep").mkdir(parents=True, exist_ok=True)
            (d / "service.json").write_text(json.dumps({"kind": "rack", "capabilities": {"multi_project": True}}))
        admin = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        h = {"Authorization": f"Bearer {admin}"}
        r = c.put("/api/share-sets", headers=h, json={"sets": [{"name": "lab", "members": {"note": "keep"}}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.post("/api/admin/mcp-tokens", headers=h, json={"name": "x", "scope": "set:nope"}).status_code, 400)
        self.assertEqual(c.post("/api/admin/mcp-tokens", headers=h, json={"name": "lab", "scope": "set:lab"}).status_code, 201)
        sid = registry.share_sets()[0][0]["id"]
        row = next(t for t in c.get("/api/admin/mcp-tokens", headers=h).json() if t["name"] == "lab")
        self.assertEqual((row["scope"], row["scope_label"]), (f"set:{sid}", "set:lab"))
        # renamed on the screen (the id rides along), the token still opens the same projects
        c.put("/api/share-sets", headers=h, json={"sets": [{"id": sid, "name": "lab2", "members": {"note": "keep"}}]})
        self.assertTrue(mcp_tokens.allowed(row["scope"], "note", "keep"))
        self.assertEqual(mcp_tokens.home(row["scope"]), {"note": "keep"})
        row = next(t for t in c.get("/api/admin/mcp-tokens", headers=h).json() if t["name"] == "lab")
        self.assertEqual(row["scope_label"], "set:lab2")

    def test_a_jobs_plot_goes_into_notes_without_passing_through_the_agent(self):
        sent = []

        async def fake(request, grant, svc, method, path, proj="", **kw):
            sent.append((svc, path))
            if path == "data":
                return httpx.Response(200, json={"jobs": [{"id": "jobrun-1-e8c5b8", "jobId": "1-e8c5b8", "tags": ["job/e8c5b8"]}]})
            if path == "jobrun/1-e8c5b8/file/pid.png":
                return httpx.Response(200, content=b"\x89PNG...")
            if path == "file":
                return httpx.Response(200, json={"name": kw["files"]["f"][0], "size": len(kw["files"]["f"][1])})
            return httpx.Response(404, json={"detail": "not in this job's output"})
        real, mcp._portal = mcp._portal, fake
        real_note, mcp._note = mcp._note, (lambda request, grant, method, path, **kw: fake(request, grant, "note", method, path, **kw))
        try:
            tok = self.issue()
            r = self.out(tok, "add_file", job="e8c5b8", file="pid.png")
            self.assertEqual(r["embed"], "![[pid.png]]")
            self.assertIn(("jobboard", "jobrun/1-e8c5b8/file/pid.png"), sent)
            self.assertTrue(call(tok, "add_file", job="e8c5b8", file="nope.png")["isError"])
            self.assertTrue(call(tok, "add_file", job="e8c5b8", file="../x")["isError"])
            self.assertTrue(call(tok, "add_file", job="e8c5b8", file="pid.png", text="x")["isError"])
        finally:
            mcp._portal, mcp._note = real, real_note

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
