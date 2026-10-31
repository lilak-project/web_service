"""The rack store's shared tags: what it wears, who wears one, and renaming
one (or merging several) in every record, whatever the case.

    service_manager/.venv/bin/python lilak_portal_auth/test_store_tags.py
"""
import os
import tempfile
import time
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ["PORTAL_SECRET_KEY"] = "test-secret"
os.environ["PORTAL_DATA_ROOT"] = str(TMP / "data")
os.environ.pop("PORTAL_PORT", None)

from fastapi import FastAPI                  # noqa: E402
from fastapi.testclient import TestClient    # noqa: E402
from jose import jwt                         # noqa: E402

from lilak_portal_auth.store import Document  # noqa: E402

H = {"Authorization": "Bearer " + jwt.encode({"sub": "1", "username": "kim", "email": "kim@x", "role": "user",
                                              "portal": True, "exp": time.time() + 600}, "test-secret", algorithm="HS256")}


class Tags(unittest.TestCase):
    def setUp(self):
        (TMP / "data" / "_portal").mkdir(parents=True, exist_ok=True)
        (TMP / "data" / "_portal" / "secret.key").write_text("test-secret")
        self.doc = Document(TMP / f"s{time.time_ns()}.json", keys=("items", "groups", "settings"))
        d = self.doc.read()
        d["items"] = [{"id": "a", "tags": ["SpiRIT", "TPC"], "mainTag": "spirit"},
                      {"id": "b", "tags": ["spirit"]}, {"id": "c", "tags": ["EOS"]}]
        d["groups"] = [{"id": "g", "tags": ["Spirit"]}]
        self.doc.write(d)
        app = FastAPI()
        self.doc.mount(app)
        self.c = TestClient(app)

    def test_counts_and_tagged(self):
        self.assertEqual(self.c.get("/api/tags", headers=H).json()["tags"]["SpiRIT"], 1)
        got = self.c.get("/api/tagged?tag=SPIRIT", headers=H).json()["items"]
        self.assertEqual(sorted(x["rec"]["id"] for x in got), ["a", "b", "g"])

    def test_rename_merges_every_spelling_once(self):
        r = self.c.post("/api/tags/rename", json={"from": ["spirit", "tpc"], "to": "S-TPC"}, headers=H).json()
        self.assertEqual(r["changed"], 3)
        d = self.doc.read()
        by = {x["id"]: x for x in d["items"] + d["groups"]}
        self.assertEqual(by["a"]["tags"], ["S-TPC"])
        self.assertEqual(by["a"]["mainTag"], "S-TPC")
        self.assertEqual(by["b"]["tags"], ["S-TPC"])
        self.assertEqual(by["g"]["tags"], ["S-TPC"])
        self.assertEqual(by["c"]["tags"], ["EOS"])


class Records(Tags):
    def test_add_record_gets_an_id_and_goes_on_top(self):
        r = self.c.post("/api/records", json={"key": "items", "record": {"name": "new", "tags": ["X"]}}, headers=H).json()["record"]
        self.assertTrue(r["id"] and r["createdAt"])
        self.assertEqual(self.doc.read()["items"][0]["name"], "new")
        self.assertEqual(self.c.post("/api/records", json={"key": "settings", "record": {}}, headers=H).status_code, 400)
        self.assertEqual(self.c.post("/api/records", json={"key": "items", "record": {"id": "a"}}, headers=H).status_code, 409)


if __name__ == "__main__":
    unittest.main()
