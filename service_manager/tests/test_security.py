"""The portal's gates, end to end on a throwaway data root.

    cd service_manager && .venv/bin/python tests/test_security.py

Everything runs in-process (no server, no ports); the data root is a temp
folder, so the live data is never touched.
"""
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({
    "PORTAL_DATA_ROOT": str(TMP / "data"),
    "PORTAL_SECRET_KEY": "test-secret",
    "EMAIL_VERIFY_REQUIRED": "0",
    "PORTAL_REGISTER_TOKEN": "reg-token",
    "SERVICE_PORT_START": "8250", "SERVICE_PORT_END": "8260",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx                                         # noqa: E402
from fastapi import HTTPException                    # noqa: E402
from fastapi.testclient import TestClient            # noqa: E402

from app import main, models, project_runtime as pr, proxy_util, registry  # noqa: E402
from app.adapters import base                        # noqa: E402
from app.db import SessionLocal                      # noqa: E402

c = TestClient(main.app)                             # no `with`: startup tasks stay off


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


class Accounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = c.post("/api/auth/setup", json={"password": "admin-pass-1"})
        assert r.status_code == 200, r.text
        cls.admin = r.json()["access_token"]

    def register(self, name, pw="user-pass-1"):
        r = c.post("/api/auth/register", json={"username": name, "password": pw, "email": f"{name}@x.org"})
        self.assertIn(r.status_code, (200, 201), r.text)
        return r.json()["access_token"]

    def test_login_guessing_is_slowed(self):
        self.register("guessme")
        codes = [c.post("/api/auth/login", json={"username": "guessme", "password": f"wrong{i}"}).status_code
                 for i in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)
        # the right password is refused too while the account is cooling down
        r = c.post("/api/auth/login", json={"username": "guessme", "password": "user-pass-1"})
        self.assertEqual(r.status_code, 429)

    def test_verify_code_guessing_is_slowed(self):
        codes = [c.post("/api/auth/verify-code", json={"username": "nobody", "code": f"{i:06d}"}).status_code
                 for i in range(6)]
        self.assertEqual(codes[-1], 429)

    def test_password_change_ends_other_sessions(self):
        old = self.register("pwchange")
        r = c.post("/api/account/password", headers=bearer(old),
                   json={"current_password": "user-pass-1", "new_password": "user-pass-2"})
        self.assertEqual(r.status_code, 200, r.text)
        new = r.json()["access_token"]
        self.assertEqual(c.get("/api/auth/me", headers=bearer(old)).status_code, 401)
        self.assertEqual(c.get("/api/auth/me", headers=bearer(new)).status_code, 200)

    def test_hidden_services_are_not_listed_to_users(self):
        for name, vis in (("opensvc", models.VIS_PUBLIC), ("adminsvc", models.VIS_ADMIN)):
            registry.service_dir(name).mkdir(parents=True, exist_ok=True)
            registry.write_manifest(name, registry.default_manifest("service", "external"))
            db = SessionLocal()
            from app.routers.services import get_or_create_service
            get_or_create_service(db, name, "service").visibility = vis
            db.commit(); db.close()
        user = self.register("viewer")
        names = {s["name"] for s in c.get("/api/projects", headers=bearer(user)).json()}
        self.assertIn("opensvc", names)
        self.assertNotIn("adminsvc", names)
        names = {s["name"] for s in c.get("/api/projects", headers=bearer(self.admin)).json()}
        self.assertIn("adminsvc", names)

    def test_handshake_cannot_turn_a_managed_service_external(self):
        registry.service_dir("runsvc").mkdir(parents=True, exist_ok=True)
        registry.write_manifest("runsvc", registry.default_manifest("service", "managed"))
        r = c.post("/api/handshake", headers=bearer("reg-token"),
                   json={"name": "runsvc", "mode": "external", "url": "http://evil.example", "accepts_portal_token": True})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(registry.read_manifest("runsvc")["mode"], "managed")


class Names(unittest.TestCase):
    def test_names_cannot_leave_the_data_root(self):
        for bad in ("..", "_portal", ".", "a/b", "", "-x"):
            with self.assertRaises(HTTPException, msg=bad):
                registry.service_dir(bad)
            with self.assertRaises(HTTPException, msg=bad):
                pr.project_dir("svc", bad)
        self.assertTrue(str(registry.service_dir("note")).endswith("/note"))

    def test_proxy_refuses_internal_folders(self):
        r = c.get("/p/_portal/secret.key", headers=bearer("x"))
        self.assertEqual(r.status_code, 404)


class Files(unittest.TestCase):
    def setUp(self):
        self.d = pr.project_dir("filesvc", "p1")
        self.d.mkdir(parents=True, exist_ok=True)
        (self.d / "keep.json").write_text("{}")

    def test_project_file_stays_inside(self):
        (self.d.parent / "p1x").mkdir(exist_ok=True)
        (self.d.parent / "p1x" / "other.json").write_text("{}")
        for rel in ("../p1x/other.json", "../../../_portal/secret.key"):
            with self.assertRaises(FileNotFoundError, msg=rel):
                pr.project_file("filesvc", "p1", rel)

    def test_bad_zip_keeps_the_old_copy(self):
        with self.assertRaises(ValueError):
            pr.import_project("filesvc", b"not a zip", "p1", replace=True)
        self.assertTrue((self.d / "keep.json").is_file())

    def test_zip_slip_is_ignored(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("../escaped.txt", "x")
            z.writestr("ok.txt", "y")
        pr.import_project("filesvc", buf.getvalue(), "p2")
        self.assertTrue((pr.project_dir("filesvc", "p2") / "ok.txt").is_file())
        self.assertFalse((pr.projects_root("filesvc") / "escaped.txt").exists())


class Proxy(unittest.TestCase):
    def test_injected_base_is_escaped(self):
        out = proxy_util.inject_base(b"<html><head></head>", '/pp/s/"x', {"label": "</script><img>"}).decode()
        self.assertNotIn("</script><img>", out)
        self.assertIn('&quot;', out)

    def test_service_cannot_set_the_portal_cookie(self):
        up = httpx.Response(200, headers=[("set-cookie", "lilak_portal_token=evil; Path=/"),
                                          ("set-cookie", "theirs=1; Path=/")])
        _, cookies = proxy_util._copy_headers(up, body_rewritten=False)
        self.assertEqual(cookies, ["theirs=1; Path=/"])


class Runtime(unittest.TestCase):
    def test_log_is_kept_and_rotated(self):
        p = TMP / "svc.log"
        p.write_text("crash trace\n")
        registry.open_service_log(p).close()
        self.assertIn("crash trace", p.read_text())
        p.write_bytes(b"x" * (registry.LOG_ROTATE_BYTES + 1))
        registry.open_service_log(p).close()
        self.assertTrue(p.with_name("svc.log.1").is_file())
        self.assertLess(p.stat().st_size, 1000)

    def test_exited_child_is_not_alive(self):
        proc = subprocess.Popen(["true"])
        time.sleep(0.3)                              # exited, not yet reaped: a zombie
        self.assertFalse(base._pid_alive(proc.pid))
        live = subprocess.Popen(["sleep", "5"])
        try:
            self.assertTrue(base._pid_alive(live.pid))
        finally:
            live.kill(); live.wait()

    def test_restart_running_brings_services_back(self):
        from app.adapters import get_adapter
        from app.adapters.managed import _port_file
        registry.service_dir("websvc").mkdir(parents=True, exist_ok=True)
        m = registry.default_manifest("service", "managed")
        m["start"] = {"cmd": f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1", "cwd": str(TMP)}
        registry.write_manifest("websvc", m)
        ad = get_adapter(m)
        ad.start("websvc", m)
        pid = (_port_file("websvc").parent / ".pid").read_text().strip()
        admin = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        try:
            self.assertEqual(c.post("/api/admin/system/restart").status_code, 401)
            r = c.post("/api/admin/system/restart", headers=bearer(admin))
            self.assertIn("websvc", r.json()["restarting"])
            up = lambda: (p := ad.status("websvc", m).get("port")) and base.port_alive(p)
            for _ in range(40):
                if up():
                    break
                time.sleep(0.25)
            self.assertTrue(up())
            time.sleep(1)                            # the start thread confirms health, then returns
            self.assertNotEqual((_port_file("websvc").parent / ".pid").read_text().strip(), pid)
        finally:
            ad.stop("websvc", m)


class Sync(unittest.TestCase):
    def test_seed_only_starts_an_empty_main(self):
        """A sub may give main its data only where main has none — never overwrite."""
        from app import sync
        registry.write_manifest("seedsvc", registry.default_manifest("service", "external"))
        sync.write("seedsvc", {"role": "main", "token": "tok-seed"})
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("data/a.json", '{"x": 1}')
        raw = buf.getvalue()
        url = "/api/sync/seedsvc/projects/p1/seed"
        self.assertEqual(c.put(url, content=raw, headers=bearer("wrong")).status_code, 401)
        self.assertEqual(c.put(url, content=raw, headers=bearer("tok-seed")).status_code, 200)
        self.assertEqual((pr.project_dir("seedsvc", "p1") / "data/a.json").read_text(), '{"x": 1}')
        # Now main has data: a second seed is refused and nothing changes.
        buf2 = io.BytesIO()
        with zipfile.ZipFile(buf2, "w") as z:
            z.writestr("data/a.json", '{"x": 2}')
        self.assertEqual(c.put(url, content=buf2.getvalue(), headers=bearer("tok-seed")).status_code, 409)
        self.assertEqual((pr.project_dir("seedsvc", "p1") / "data/a.json").read_text(), '{"x": 1}')


if __name__ == "__main__":
    unittest.main(verbosity=2)
