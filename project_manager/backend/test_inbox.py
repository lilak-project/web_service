"""project_manager's inbox: dropped candidates taken in once and flattened
into records of the `inbox` class, kept waiting first, an old discard dropped.

    service_manager/.venv/bin/python project_manager/backend/test_inbox.py
"""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ["PORTAL_SECRET_KEY"] = "test-secret"
os.environ["PORTAL_DATA_ROOT"] = str(TMP / "root")
os.environ["PROJECT_MANAGER_DATA_DIR"] = str(TMP / "data")
os.environ["PROJECT_MANAGER_DIST_DIR"] = str(TMP / "dist")
os.environ["PM_INBOX_TIMER"] = "0"             # ticked by hand here
os.environ.pop("PORTAL_PORT", None)
(TMP / "dist").mkdir()
(TMP / "dist" / "index.html").write_text("<html></html>")
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lilak_portal_auth"))   # the package, not its repo folder

import main                                    # noqa: E402


class Inbox(unittest.TestCase):
    def test_take_in_flatten_order_prune(self):
        main.DROP.mkdir(parents=True, exist_ok=True)
        (main.DROP / "a.json").write_text(json.dumps({
            "id": "a", "target": "note", "createdAt": "2026-10-31T10:00:00+09:00",
            "fields": {"title": "T", "tags": "#x #y", "body": "b"}, "source": {"from": "kim", "date": "2026-10-30", "subject": "S"}}))
        (main.DROP / "b.json").write_text(json.dumps({"id": "b", "target": "activity", "createdAt": "2026-10-31T09:00:00+09:00",
                                                      "fields": {"name": "Talk", "start": "2026-11-02"}}))
        (main.DROP / "bad.json").write_text("{half")
        self.assertTrue(main.tick())
        inbox = main.DOC.read()["inbox"]
        self.assertEqual([c["id"] for c in inbox], ["b", "a"])                       # oldest first
        a = inbox[1]
        self.assertEqual((a["title"], a["noteTags"], a["from"], a["subject"], a["status"]), ("T", "#x #y", "kim", "S", "waiting"))
        self.assertNotIn("fields", a)
        self.assertTrue((main.DROP / "bad.json").exists())                           # half-written: next tick
        self.assertFalse(main.tick())                                                # nothing new
        # Decided ones go after the waiting; a discard older than the keep is dropped.
        with main.DOC.lock:
            d = main.DOC.read()
            n = copy.deepcopy(d)
            n["inbox"][0].update(status="approved", decidedAt="2026-10-31T11:00:00+09:00")
            n["inbox"][1].update(status="discarded", decidedAt="2000-01-01T00:00:00+09:00")
            main.DOC.write(n, replaces=d)
        main.tick()
        self.assertEqual([(c["id"], c["status"]) for c in main.DOC.read()["inbox"]], [("b", "approved")])
        self.assertEqual(main.DOC.read()["projects"], [])


if __name__ == "__main__":
    unittest.main()
