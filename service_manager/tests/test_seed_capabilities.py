"""An installed service gains the capabilities its seed added since install (a git pull
updates seeds, not the manifests copied from them); what it already has stays.

    cd service_manager && .venv/bin/python tests/test_seed_capabilities.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"PORTAL_DATA_ROOT": str(TMP / "data"), "PORTAL_SECRET_KEY": "test-secret"})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import registry  # noqa: E402
from app.routers import store  # noqa: E402


class SeedCapabilities(unittest.TestCase):
    def test_installed_scope_gains_project_files(self):
        # scope as installed before project_files existed, with an admin's own setting
        d = registry.service_dir("scope")
        d.mkdir(parents=True, exist_ok=True)
        (d / "service.json").write_text(json.dumps({"kind": "monitor", "label": "Mine",
                                                    "capabilities": {"multi_project": True, "import_export": True}}))
        store.seed_capabilities()
        m = registry.read_manifest("scope")
        caps = m["capabilities"]
        self.assertEqual(caps["project_files"][0]["file"], "browse-path")   # added from the seed
        self.assertTrue(caps["import_export"])                               # kept: the admin's
        self.assertEqual(m["label"], "Mine")                                 # the rest untouched
        store.seed_capabilities()                                            # nothing new: no change
        self.assertEqual(registry.read_manifest("scope"), m)

    def test_not_installed_stays_absent(self):
        store.seed_capabilities()
        self.assertFalse(registry.manifest_path("vacuum").exists())


if __name__ == "__main__":
    unittest.main()
