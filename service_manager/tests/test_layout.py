"""An account's own sidebar layout (prefs.layout), on a throwaway data root.

    cd service_manager && .venv/bin/python tests/test_layout.py
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

from app import main                          # noqa: E402

c = TestClient(main.app)


class Layout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tok = c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"]
        cls.h = {"Authorization": f"Bearer {tok}"}

    def test_saved_cleaned_and_cleared(self):
        body = {"layout": {"order": ["elog", "#g:m1", "elog"], "junk": 1,
                           "groups": [{"id": "m1", "name": "mine", "members": ["note"], "hidden": 0, "x": 2}, {"name": "no id"}],
                           "hidden": ["nptoy"], "labels": {"elog": " my elog ", "note": "  "}}}
        p = c.put("/api/account/prefs", headers=self.h, json=body).json()["prefs"]["layout"]
        self.assertEqual(p["order"], ["elog", "#g:m1"])                       # deduplicated
        self.assertEqual(p["groups"], [{"id": "m1", "name": "mine", "members": ["note"], "hidden": False}])
        self.assertEqual(p["labels"], {"elog": "my elog"})                    # blanks dropped
        self.assertNotIn("junk", p)
        # The shared groups are not touched by a personal layout.
        self.assertFalse(any(g.get("id") == "m1" for g in c.get("/api/service-groups", headers=self.h).json()))
        p = c.put("/api/account/prefs", headers=self.h, json={"layout": None}).json()["prefs"]
        self.assertNotIn("layout", p)

    def test_too_big_refused(self):
        r = c.put("/api/account/prefs", headers=self.h, json={"layout": {"order": [f"k{i}" for i in range(3000)]}})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
