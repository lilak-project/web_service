"""A NEON service's build first gets neon_ui's own node_modules back (a host may
delete them after a build), and only for frontends that alias neon_ui.

    cd service_manager && .venv/bin/python tests/test_store_neon.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"PORTAL_DATA_ROOT": str(TMP / "data"), "PORTAL_SECRET_KEY": "test-secret"})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers import store  # noqa: E402


class NeonDeps(unittest.TestCase):
    def setUp(self):
        self.ran = []
        store._stream = lambda job, argv, cwd=None, env_extra=None: self.ran.append((argv[1], cwd)) or 0
        store.NEON_UI_PATH = TMP / "neon_ui"
        store.NEON_UI_PATH.mkdir(exist_ok=True)
        (store.NEON_UI_PATH / "package.json").write_text("{}")
        store._jobs["j"] = {"log": []}

    def fe(self, name, vite):
        d = TMP / name
        d.mkdir(exist_ok=True)
        (d / "vite.config.ts").write_text(vite)
        return d

    def test_a_neon_frontend_gets_neon_ui_deps_when_missing(self):
        self.assertTrue(store._ensure_neon("j", self.fe("scope", 'new URL("../../neon_ui/src")'), "npm"))
        self.assertEqual(self.ran, [("ci", store.NEON_UI_PATH)])

    def test_nothing_when_present_or_not_neon(self):
        store._ensure_neon("j", self.fe("plain", "export default {}"), "npm")
        (store.NEON_UI_PATH / "node_modules").mkdir()
        store._ensure_neon("j", self.fe("scope2", "neon_ui"), "npm")
        (store.NEON_UI_PATH / "node_modules").rmdir()
        self.assertEqual(self.ran, [])


if __name__ == "__main__":
    unittest.main()
