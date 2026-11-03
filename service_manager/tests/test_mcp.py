"""The gates of /mcp, on a throwaway data root, with the note service faked.

    cd service_manager && .venv/bin/python tests/test_mcp.py
"""
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


def call(token, name, **args):
    return rpc(token, "tools/call", {"name": name, "arguments": args}).json()["result"]


class Gates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert c.post("/api/auth/setup", json={"password": "admin-pass-1"}).status_code == 200
        cls.db = SessionLocal()
        cls.user = cls.db.query(models.User).filter(models.User.username == "admin").one()
        cls.calls = []

        # Stands in for the service behind /pp: a write to `taken` is a conflict.
        async def fake(request, jwt, method, path, **kw):
            cls.calls.append((method, path, kw.get("json")))
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

    @classmethod
    def tearDownClass(cls):
        mcp._note = cls.real
        cls.db.close()

    def setUp(self):
        self.calls.clear()

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
        self.assertEqual(names, {"search_notes", "get_note"})
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

    def test_note_id_cannot_climb_out_of_the_path(self):
        for bad in ("../../x", "a/b", "a\\b", ".hidden"):
            self.assertTrue(call(self.issue(), "get_note", id=bad)["isError"])
        self.assertEqual(self.calls, [])

    def test_a_page_instead_of_json_is_an_error(self):
        with self.assertRaises(mcp.ToolError):
            mcp._ok(httpx.Response(200, text="<html>"))

    def test_search_by_tag_and_text_keeps_what_both_found(self):
        tok = self.issue()
        ids = lambda r: [h["id"] for h in __import__("json").loads(r["content"][0]["text"])]
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
