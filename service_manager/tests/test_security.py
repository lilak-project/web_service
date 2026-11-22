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

    def test_link_project_is_one_managers_choice(self):
        for name, projects in (("racka", ("one", "two")), ("rackb", ("main",))):
            for proj in projects:
                (registry.service_dir(name) / "projects" / proj).mkdir(parents=True, exist_ok=True)
            registry.write_manifest(name, {**registry.default_manifest("rack", "managed"),
                "capabilities": {"multi_project": True, "tags": True}, "entry_project": projects[0]})
            db = SessionLocal()
            from app.routers.services import get_or_create_service
            get_or_create_service(db, name, "rack")
            db.commit(); db.close()
        rec = registry.service_dir("rackb") / "projects" / "main" / "data" / "items" / "r.json"
        rec.parent.mkdir(parents=True)
        rec.write_text('{"id": "r", "refs": [{"svc": "racka", "proj": "one", "id": "x"}]}')
        admin = bearer(self.admin)
        self.assertEqual(registry.link_projects()["racka"], "one")

        user = self.register("linker")
        r = c.put("/api/services/racka/link-project", json={"project": "two"}, headers=bearer(user))
        self.assertEqual(r.status_code, 403)
        # An account's own entrance moves nothing the other services see.
        c.put("/api/services/racka/entry", json={"project": "two"}, headers=bearer(user))
        self.assertEqual(registry.link_project("racka"), "one")

        got = c.get("/api/services/racka/link-project/impact", headers=admin).json()
        self.assertEqual((got["links_in"], got["links_out"]), (1, 0))
        got = c.get("/api/services/rackb/link-project/impact", headers=admin).json()
        self.assertEqual((got["links_in"], got["links_out"]), (0, 1))

        self.assertEqual(c.delete("/api/services/racka/projects/one", headers=admin).status_code, 409)
        self.assertEqual(c.put("/api/services/racka/link-project", json={"project": "nope"}, headers=admin).status_code, 404)
        self.assertEqual(c.put("/api/services/racka/link-project", json={"project": "two"}, headers=admin).status_code, 200)
        self.assertEqual(registry.link_project("racka"), "two")
        self.assertEqual(c.delete("/api/services/racka/projects/one", headers=admin).status_code, 200)

    def test_split_cards_swap_in_place_and_merge_to_first_group(self):
        from app.routers import service_groups as sg
        keys = ["a", "svc", "b"]
        split = sg.swap_card(keys, "svc", ["p", "q"], True)
        self.assertEqual(split, ["a", "svc/p", "svc/q", "b"])
        self.assertEqual(sg.swap_card(split, "svc", ["p", "q"], False), keys)
        self.assertTrue(sg._is_project_card("svc/p"))
        self.assertFalse(sg._is_project_card("svc/../p"))
        self.assertFalse(sg._is_project_card("svc/"))
        sg._write({"groups": [{"id": "g1", "members": ["svc/p"]}, {"id": "g2", "members": ["svc/q", "x"]}]})
        sg.split_members("svc", ["p", "q"], False)
        self.assertEqual([g["members"] for g in sg.all_groups()], [["svc"], ["x"]])
        sg._write({"groups": []})

    def test_share_sets_are_a_managers_and_disjoint(self):
        for name, tags in (("sharea", True), ("shareb", True), ("sharelog", "log"), ("sharejobs", "jobs")):
            for proj in ("main", "second"):
                (registry.service_dir(name) / "projects" / proj).mkdir(parents=True, exist_ok=True)
            registry.write_manifest(name, {**registry.default_manifest("rack", "managed"),
                "capabilities": {"multi_project": True, "tags": tags}, "entry_project": "main"})
        admin = bearer(self.admin)
        # Before a manager saves: the manifests' groups, through the main projects.
        sets = {s["name"]: s["members"] for s in c.get("/api/share-sets", headers=admin).json()["sets"]}
        # …named as the templates name them: the manager bundle is "manage", and the old "jobs" and
        # "log" groups (jobboard, parameters) are ONE set, "jobboard" — they must see each other.
        self.assertEqual((sets["manage"].get("sharea"), sets["jobboard"]), ("main", {"sharelog": "main", "sharejobs": "main"}))

        user = self.register("sharer")
        self.assertEqual(c.get("/api/share-sets", headers=bearer(user)).status_code, 403)
        two = {"sets": [{"name": "a", "members": {"sharea": "main"}}, {"name": "b", "members": {"sharea": "main"}}]}
        self.assertEqual(c.put("/api/share-sets", json=two, headers=admin).status_code, 400)
        nope = {"sets": [{"name": "a", "members": {"sharea": "nope"}}]}
        self.assertEqual(c.put("/api/share-sets", json=nope, headers=admin).status_code, 400)

        ok = {"sets": [{"name": "managers", "members": {"sharea": "main", "shareb": "main"}},
                       {"name": "second", "members": {"sharea": "second", "shareb": "second", "sharelog": "main"}}]}
        self.assertEqual(c.put("/api/share-sets", json=ok, headers=admin).status_code, 200)
        self.assertEqual(registry.share_for("sharelog", "main"), ok["sets"][1]["members"])
        self.assertEqual(registry.share_for("sharea", "second")["shareb"], "second")
        # In no set: it reads its main project's set.
        self.assertEqual(registry.share_for("sharelog", "second"), ok["sets"][1]["members"])
        self.assertTrue(c.delete("/api/share-sets", headers=admin).json()["stored"] is False)
        self.assertEqual(registry.share_for("sharelog", "main"), {"sharelog": "main", "sharejobs": "main"})
        # A set that keeps its name through "back to default" keeps its id (tokens and the group stay bound).
        put = c.put("/api/share-sets", json={"sets": [{"name": "manage", "members": {"sharea": "second"}}]}, headers=admin).json()
        sid = put["sets"][0]["id"]
        # …and through a save that leaves the id out (the page autosaves what it holds).
        again = c.put("/api/share-sets", json={"sets": [{"name": "manage", "members": {"sharea": "second"}}]}, headers=admin).json()
        self.assertEqual(again["sets"][0]["id"], sid)
        back = c.delete("/api/share-sets", headers=admin).json()["sets"]
        self.assertEqual(next(s for s in back if s["name"] == "manage").get("id"), sid)
        self.assertEqual(next(s for s in back if s["name"] == "manage")["members"]["sharea"], "main")
        registry._share_file().unlink(missing_ok=True)

    def test_recent_is_deduped_and_capped(self):
        tok = self.register("recent")
        keys = ["a/1", "b", "a/1"] + [f"x{i}" for i in range(10)]
        r = c.put("/api/account/prefs", headers=bearer(tok), json={"recent": keys})
        self.assertEqual(r.json()["prefs"]["recent"], ["a/1", "b"] + [f"x{i}" for i in range(6)])

    def test_density_is_compact_or_nothing(self):
        tok = self.register("density")
        r = c.put("/api/account/prefs", headers=bearer(tok), json={"density": "compact"})
        self.assertEqual(r.json()["prefs"]["density"], "compact")
        r = c.put("/api/account/prefs", headers=bearer(tok), json={"density": "wide"})
        self.assertNotIn("density", r.json()["prefs"])
        r = c.put("/api/account/prefs", headers=bearer(tok), json={"density": "tiny"})
        self.assertEqual(r.status_code, 400)

    def test_open_directly_card_takes_the_projects_name(self):
        (registry.service_dir("entrysvc") / "projects" / "main").mkdir(parents=True, exist_ok=True)
        (registry.service_dir("entrysvc") / "projects" / "other").mkdir(parents=True, exist_ok=True)
        registry.write_manifest("entrysvc", {**registry.default_manifest("rack", "managed"), "label": "Entry svc",
                                             "capabilities": {"multi_project": True}, "entry_project": "main"})
        admin = bearer(self.admin)
        self.assertEqual(c.put("/api/services/entrysvc/projects/main/name", json={"name": "main-jw"}, headers=admin).status_code, 200)
        card = lambda: next(s for s in c.get("/api/services", headers=admin).json() if s["name"] == "entrysvc")   # noqa: E731
        # The service's own main project does not rename the card; this account's "open directly" does.
        self.assertEqual(card()["label"], "Entry svc")
        from app import prefs
        with SessionLocal() as db:
            u = db.query(models.User).filter(models.User.username == "admin").first()
            prefs.put(u, entry={"entrysvc": "main"})
            db.commit()
        self.assertEqual((card()["label"], card()["service_label"]), ("main-jw", "Entry svc"))

    def test_home_tabs_writes_are_a_managers(self):
        # Every call the Home tabs make beyond reading: group editing, rack services,
        # share sets, the store. A signed-in user who is not a manager gets 403 on each.
        user = bearer(self.register("homeuser"))
        calls = [("get", "/api/share-sets", None), ("put", "/api/share-sets", {"sets": []}),
                 ("delete", "/api/share-sets", None),
                 ("post", "/api/admin/service-groups", {"name": "x"}),
                 ("put", "/api/admin/service-groups/abcd1234", {"name": "x"}),
                 ("put", "/api/admin/home-service", {"name": "elog", "split": True}),
                 ("post", "/api/services/elog/projects", {"name": "x"}),
                 ("get", "/api/admin/store", None), ("post", "/api/admin/store/install", {"name": "x"}),
                 ("post", "/api/admin/store/build-portal", {"pull": False}),
                 ("post", "/api/admin/services/scaffold", {"name": "x"})]
        for verb, url, body in calls:
            r = getattr(c, verb)(url, headers=user, **({"json": body} if body is not None else {}))
            self.assertEqual(r.status_code, 403, f"{verb} {url}: {r.status_code}")

    def test_home_view_is_list_or_group(self):
        tok = bearer(self.register("homeview"))
        self.assertEqual(c.put("/api/account/prefs", headers=tok, json={"homeView": "list"}).json()["prefs"]["homeView"], "list")
        self.assertNotIn("homeView", c.put("/api/account/prefs", headers=tok, json={"homeView": "group"}).json()["prefs"])
        self.assertEqual(c.put("/api/account/prefs", headers=tok, json={"homeView": "tree"}).status_code, 400)
        self.assertEqual(c.put("/api/account/prefs", headers=tok, json={"theme": "dark"}).json()["prefs"]["theme"], "dark")
        self.assertNotIn("theme", c.put("/api/account/prefs", headers=tok, json={"theme": "bright"}).json()["prefs"])
        self.assertEqual(c.put("/api/account/prefs", headers=tok, json={"theme": "neon"}).status_code, 400)

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

    def test_a_renamed_service_goes_on_under_its_new_name(self):
        r = c.get("/pp/author_manager/authors/?solo=x", follow_redirects=False)
        self.assertEqual((r.status_code, r.headers["location"]), (307, "/pp/authors/authors/?solo=x"))
        r = c.get("/launcher/p/asset_manager2/api/data", follow_redirects=False)
        self.assertEqual(r.headers["location"], "/p/inventory/api/data")
        self.assertNotEqual(c.get("/pp/asset_manager/x/", follow_redirects=False).status_code, 307)   # the old one stays

    def test_theme_is_set_before_the_page_draws(self):
        """A page opened in the panel is in the account's theme from its first
        paint: the script that says so is in <head>, before the page's own CSS."""
        out = proxy_util.inject_base(b"<html><head><link rel=stylesheet href=a.css></head>", "/p/s").decode()
        self.assertLess(out.index("lilak.theme"), out.index("a.css"))

    def test_image_request_carries_the_session_on(self):
        """An <img> sends no Authorization header — only the cookie. A service
        that accepts the portal token gets that same token as a bearer, so a
        picture on a page the user is signed in to is not a 401."""
        class Req:
            def __init__(self, headers, cookies):
                self.headers, self.cookies = headers, cookies
        tok = "abc.def.ghi"
        img = Req({}, {"lilak_portal_token": tok})
        self.assertEqual(proxy_util.cookie_bearer(img, True), f"Bearer {tok}")
        # Not to a service that does not accept the portal token, and not over
        # a header the caller already sent.
        self.assertIsNone(proxy_util.cookie_bearer(img, False))
        withhdr = Req({"authorization": "Bearer other"}, {"lilak_portal_token": tok})
        self.assertIsNone(proxy_util.cookie_bearer(withhdr, True))
        self.assertIsNone(proxy_util.cookie_bearer(Req({}, {}), True))

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

    def test_stale_pid_naming_the_portal_is_not_running(self):
        # After a container restart a kept `.pid` can name the portal's own PID.
        d = TMP / "stalepid"
        d.mkdir(exist_ok=True)
        pf = d / ".port"
        for pid in (os.getpid(), os.getppid()):
            pf.write_text("8259")
            base.write_pid(pf, pid)
            self.assertIsNone(base.read_running_port(pf))
            self.assertFalse(pf.exists() or (d / ".pid").exists())
        # A live service that has not bound yet stays claimed (no duplicate spawns).
        live = subprocess.Popen(["sleep", "5"], env={**os.environ, "PORTAL_SERVICE_PORT": "8259"})
        try:
            pf.write_text("8259")
            base.write_pid(pf, live.pid)
            self.assertEqual(base.read_running_port(pf), 8259)
        finally:
            live.kill(); live.wait()

    def test_pid_taken_after_a_reboot_is_not_running(self):
        # A reboot keeps `.pid` files whose numbers the system then hands to its
        # own processes (macOS: no procfs to read their environment). A process
        # that began after the `.pid` was written cannot be the one written there.
        d = TMP / "rebootpid"
        d.mkdir(exist_ok=True)
        pf = d / ".port"
        other = subprocess.Popen(["sleep", "5"])
        try:
            pf.write_text("8258")
            base.write_pid(pf, other.pid)
            old = time.time() - 3600
            os.utime(d / ".pid", (old, old))               # written an hour before it started
            self.assertIsNone(base.read_running_port(pf))
            self.assertFalse(pf.exists() or (d / ".pid").exists())
        finally:
            other.kill(); other.wait()

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


class StoreToolPath(unittest.TestCase):
    def test_tool_dir_on_path(self):
        """A launchd portal (PATH=/usr/bin:/bin) runs /opt/homebrew/bin/npm, whose
        `env node` shebang needs node's dir on PATH — _stream puts it there."""
        from app.routers import store
        d = tempfile.mkdtemp()
        (Path(d) / "node").write_text("#!/bin/sh\necho found\n")
        (Path(d) / "npm").write_text("#!/usr/bin/env node\n")
        for f in ("node", "npm"):
            os.chmod(Path(d) / f, 0o755)
        store._jobs["t"] = {"log": []}
        old = os.environ["PATH"]
        os.environ["PATH"] = "/usr/bin:/bin"
        try:
            self.assertEqual(store._stream("t", [str(Path(d) / "npm")]), 0)
        finally:
            os.environ["PATH"] = old
        self.assertIn("found", store._jobs["t"]["log"])


class Renamed(unittest.TestCase):
    def test_old_service_address_moves_to_the_new_one(self):
        r = c.get("/pp/jobbook/platform/api/data?x=1", follow_redirects=False)
        self.assertEqual((r.status_code, r.headers["location"]), (307, "/pp/jobboard/jobboard/api/data?x=1"))


class Accounts2(unittest.TestCase):
    """Holes found in the 2026-11-13 review."""
    def reg(self, name):
        r = c.post("/api/auth/register", json={"username": name, "password": "user-pass-1", "email": f"{name}@x.org"})
        self.assertIn(r.status_code, (200, 201), r.text)
        return r.json()

    def test_a_deleted_accounts_id_is_never_given_again(self):
        from app import mcp_tokens
        from app.db import SessionLocal
        old = self.reg("leaver")
        with SessionLocal() as db:
            tok = mcp_tokens.issue(db, "old", db.get(models.User, old["user_id"]), True, 30)
            db.add(models.Passkey(user_id=old["user_id"], credential_id="leaver-cred", public_key="k", rp_id="localhost", name="mac"))
            db.commit()
        self.assertEqual(c.request("DELETE", "/api/account", headers=bearer(old["access_token"]),
                                   json={"password": "user-pass-1"}).status_code, 200)
        new = self.reg("joiner")
        self.assertGreater(new["user_id"], old["user_id"])            # SQLite would have handed the id back
        with SessionLocal() as db:
            self.assertIsNone(mcp_tokens.owner_of(db, tok))           # the old token is nobody's now
            self.assertEqual(db.query(models.Passkey).filter_by(credential_id="leaver-cred").count(), 0)

    def test_a_services_own_token_is_not_a_portal_user_at_the_proxy(self):
        from app import permissions, security as sec
        from app.db import SessionLocal
        theirs = sec.create_access_token(1, "someone", "user")        # same secret, no `portal` claim (elog's own)
        with SessionLocal() as db:
            self.assertIsNone(permissions.user_from_request(db, theirs))
            self.assertEqual(permissions.user_from_request(db, c.post(
                "/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]).username, "admin")

    def test_yearly_verification_needs_the_mailed_code(self):
        tok = bearer(self.reg("lapsed")["access_token"])
        from app import config
        echo, config.EMAIL_VERIFY_DEV_ECHO = config.EMAIL_VERIFY_DEV_ECHO, True      # no mailer in a test: the code is echoed
        try:
            sent = c.post("/api/account/verify", json={}, headers=tok).json()
            self.assertTrue(sent["sent"])
            self.assertNotIn("verification_current", sent)             # asking does not verify
            wrong = "000000" if sent["verify_code"] != "000000" else "111111"
            self.assertEqual(c.post("/api/account/verify", json={"code": wrong}, headers=tok).status_code, 400)
            ok = c.post("/api/account/verify", json={"code": sent["verify_code"]}, headers=tok)
            self.assertEqual(ok.status_code, 200)
            self.assertTrue(ok.json()["verification_current"])
            # Without a mailer and without the dev echo, nothing is stamped and nothing is handed back.
            config.EMAIL_VERIFY_DEV_ECHO = False
            self.assertEqual(c.post("/api/account/verify", json={}, headers=tok).status_code, 502)
        finally:
            config.EMAIL_VERIFY_DEV_ECHO = echo


class Hardening(unittest.TestCase):
    """Phase A of the 2026-11-13 review: names, sessions, throttles, requests, grants."""
    @classmethod
    def setUpClass(cls):
        cls.admin = bearer(c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"])

    def reg(self, name, **more):
        return c.post("/api/auth/register", json={"username": name, "password": "user-pass-1", "email": f"{name}@x.org", **more})

    def test_a_name_cannot_read_as_someone_else(self):
        self.assertEqual(self.reg("Hong", display_name="홍 길동").status_code, 201)
        for bad in ("a", "x" * 33, "two words", "a/b", "agent", "ALL", "hong"):
            self.assertEqual(self.reg(bad).status_code, 400, bad)
        self.assertEqual(self.reg("gildong", display_name="hong").status_code, 400)       # another's id
        self.assertEqual(self.reg("gildong", display_name="홍  길동").status_code, 400)    # another's display name
        tok = bearer(self.reg("gildong").json()["access_token"])
        put = lambda n: c.post("/api/account/profile", headers=tok, json={"display_name": n}).status_code  # noqa: E731
        self.assertEqual([put("Admin"), put("x\u202ey"), put("y" * 41), put("길동"), put("길동")], [400, 400, 400, 200, 200])

    def test_a_manager_set_password_ends_that_accounts_sessions(self):
        r = self.reg("leaked").json()
        self.assertEqual(c.post(f"/api/admin/users/{r['user_id']}/password", headers=self.admin,
                                json={"new_password": "fresh-pass-9"}).status_code, 200)
        self.assertEqual(c.get("/api/auth/me", headers=bearer(r["access_token"])).status_code, 401)
        self.assertEqual(c.get("/api/auth/me", headers=self.admin).status_code, 200)

    def test_another_address_cannot_lock_an_account_out(self):
        self.reg("victim")
        far = {"X-Forwarded-For": "203.0.113.9"}
        for i in range(11):
            c.post("/api/auth/login", json={"username": "victim", "password": f"no{i}"}, headers=far)
        self.assertEqual(c.post("/api/auth/login", json={"username": "victim", "password": "no"}, headers=far).status_code, 429)
        self.assertEqual(c.post("/api/auth/login", json={"username": "victim", "password": "user-pass-1"}).status_code, 200)

    def test_invite_code_guessing_is_slowed(self):
        tok = bearer(self.reg("guesser").json()["access_token"])
        codes = [c.post("/api/invite-codes/redeem", headers=tok, json={"code": f"nope{i}"}).status_code for i in range(11)]
        self.assertEqual((codes[:10], codes[10]), ([400] * 10, 429))

    def test_a_request_is_for_something_that_exists_and_a_regrant_keeps_admin(self):
        from app import config
        u = self.reg("asker").json()
        tok = bearer(u["access_token"])
        (config.DATA_ROOT / "realsvc" / "projects" / "p1").mkdir(parents=True, exist_ok=True)
        ask = lambda **b: c.post("/api/access-requests", headers=tok, json=b).status_code  # noqa: E731
        self.assertEqual([ask(service="ghost"), ask(service="realsvc", project="nope"), ask(service="realsvc", project="p1")],
                         [404, 404, 201])
        grant = lambda **b: c.post("/api/admin/permissions", headers=self.admin,  # noqa: E731
                                   json={"user_id": u["user_id"], "service": "realsvc", "project": "p1", **b})
        grant(admin=True); grant()                          # the second is what a plain "grant" sends
        self.assertTrue(c.get("/api/account", headers=tok).json()["scoped_admin"])
        grant(admin=False)
        self.assertFalse(c.get("/api/account", headers=tok).json()["scoped_admin"])

    def test_deleting_yourself_takes_your_password(self):
        tok = bearer(self.reg("goner").json()["access_token"])
        self.assertEqual(c.delete("/api/account", headers=tok).status_code, 403)
        self.assertEqual(c.request("DELETE", "/api/account", headers=tok, json={"password": "wrong"}).status_code, 403)
        self.assertEqual(c.request("DELETE", "/api/account", headers=tok, json={"password": "user-pass-1"}).status_code, 200)


class ProjectAdmins(unittest.TestCase):
    """Phase B: a project's admin answers its requests and makes its codes; nobody else's."""
    def test_requests_and_codes_of_their_own_project_only(self):
        from app import config
        admin = bearer(c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"])
        reg = lambda n: c.post("/api/auth/register", json={"username": n, "password": "user-pass-1", "email": f"{n}@x.org"}).json()  # noqa: E731
        for pr in ("mine", "other"):
            (config.DATA_ROOT / "labsvc" / "projects" / pr).mkdir(parents=True, exist_ok=True)
        boss, asker = reg("pboss"), reg("pasker")
        bt, at = bearer(boss["access_token"]), bearer(asker["access_token"])
        c.post("/api/admin/permissions", headers=admin, json={"user_id": boss["user_id"], "service": "labsvc", "project": "mine", "admin": True})
        for pr in ("mine", "other"):
            self.assertEqual(c.post("/api/access-requests", headers=at, json={"service": "labsvc", "project": pr}).status_code, 201)
        # The admin of `mine` sees and answers that one; `other` is not theirs; the asker answers none.
        seen = c.get("/api/admin/access-requests", headers=bt).json()
        self.assertEqual([(r["username"], r["project"]) for r in seen], [("pasker", "mine")])
        self.assertEqual(c.get("/api/access-requests", headers=bt).json()["to_resolve"], 1)
        self.assertEqual(c.get("/api/admin/access-requests", headers=at).json(), [])
        other = next(r["id"] for r in c.get("/api/admin/access-requests", headers=admin).json() if r["project"] == "other")
        self.assertEqual(c.post(f"/api/admin/access-requests/{other}", headers=bt, json={"action": "approve"}).status_code, 404)
        self.assertEqual(c.post(f"/api/admin/access-requests/{seen[0]['id']}", headers=at, json={"action": "approve"}).status_code, 404)
        self.assertEqual(c.post(f"/api/admin/access-requests/{seen[0]['id']}", headers=bt, json={"action": "approve"}).status_code, 200)
        # The asker is told once, until they have looked.
        mine = c.get("/api/access-requests", headers=at).json()
        self.assertEqual((mine["unseen"], {r["project"]: r["status"] for r in mine["mine"]}), (1, {"mine": "approved", "other": "pending"}))
        c.post("/api/access-requests/seen", headers=at)
        self.assertEqual(c.get("/api/access-requests", headers=at).json()["unseen"], 0)
        # Codes: their project's, never unverified, and not a way into the portal for a stranger.
        mk = lambda h, **b: c.post("/api/admin/invite-codes", headers=h, json={"service": "labsvc", **b})  # noqa: E731
        self.assertEqual([mk(bt, project="other").status_code, mk(bt, kind="group", group_id=1).status_code, mk(at, project="mine").status_code],
                         [403, 403, 403])
        code = mk(bt, project="mine", no_verify=True).json()
        self.assertFalse(code["no_verify"])
        theirs = mk(admin, project="other").json()
        self.assertEqual([x["code"] for x in c.get("/api/admin/invite-codes", headers=bt).json()], [code["code"]])
        self.assertEqual(c.delete(f"/api/admin/invite-codes/{theirs['id']}", headers=bt).status_code, 404)
        from app.db import SessionLocal
        from app.routers.accounts import code_is_valid
        with SessionLocal() as db:
            self.assertEqual((code_is_valid(db, code["code"]), code_is_valid(db, theirs["code"])), (False, True))
        self.assertEqual(c.delete(f"/api/admin/invite-codes/{code['id']}", headers=bt).status_code, 200)


class SignupDomains(unittest.TestCase):
    def test_a_manager_sets_who_signs_up_without_a_code(self):
        admin = bearer(c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"])
        reg = lambda n, mail, **m: c.post("/api/auth/register", json={"username": n, "password": "user-pass-1", "email": mail, **m})  # noqa: E731
        user = bearer(reg("dom0", "dom0@x.org").json()["access_token"])
        put = lambda h, **b: c.put("/api/admin/system/signup", headers=h, json=b)  # noqa: E731
        self.assertEqual([put(user, domains=[]).status_code, put(admin, domains=["not a domain"]).status_code], [403, 400])
        try:
            self.assertEqual(put(admin, domains=["@Lab.Example", "lab.example"]).json()["domains"], ["lab.example"])
            self.assertEqual([reg("dom1", "a@lab.example").status_code, reg("dom2", "a@else.where").status_code], [201, 403])
            code = c.post("/api/admin/invite-codes", headers=admin, json={"service": "labsvc"}).json()["code"]
            self.assertEqual(reg("dom2", "a@else.where", invite_code=code).status_code, 201)
        finally:
            self.assertEqual(put(admin, domains=[]).json()["domains"], [])      # back to open, for the other tests
        self.assertEqual(reg("dom3", "b@else.where").status_code, 201)


class SetMakers(unittest.TestCase):
    def test_a_project_admin_reads_sets_but_does_not_rearrange_them(self):
        from app.db import SessionLocal
        from app import security as sec
        db = SessionLocal()
        for name, admin in (("projadmin", True), ("plainuser", False)):
            u = models.User(username=name, email=f"{name}@x.org", password_hash=sec.hash_password("pw-12345678"),
                            role="user", is_active=True, email_verified=True)
            db.add(u)
            db.commit()
            if admin:
                db.add(models.ServicePermission(user_id=u.id, service_name="note", project="note", is_admin=True))
                db.commit()
        db.close()
        tok = lambda n: c.post("/api/auth/login", json={"username": n, "password": "pw-12345678"}).json()["access_token"]
        pa, pu = bearer(tok("projadmin")), bearer(tok("plainuser"))
        self.assertEqual(c.get("/api/share-sets", headers=pa).status_code, 200)
        self.assertEqual(c.get("/api/share-sets/templates", headers=pa).status_code, 200)
        self.assertEqual(c.get("/api/share-sets", headers=pu).status_code, 403)
        self.assertEqual(c.put("/api/share-sets", json={"sets": []}, headers=pa).status_code, 403)


class StoreChain(unittest.TestCase):
    def test_rack_services_bring_log_and_pipeline(self):
        from app.routers import store
        rack = store._entry("rack")
        self.assertEqual([e["name"] for e in store._chain(rack)], ["rack", "log", "pipeline"])
        for part in ("log", "pipeline"):
            self.assertEqual(store._entry(part)["part_of"], "rack")


class SetGroups(unittest.TestCase):
    def test_a_set_has_one_fixed_group_that_follows_it(self):
        from app.routers import service_groups as sg
        registry.write_share_sets([{"name": "manage", "members": {"authors": "authors", "note": "note"}}])
        sg.sync_set_groups()
        g = next(x for x in sg.all_groups() if x.get("share_set") == "manage")
        self.assertEqual((g["name"], g["members"]), ("manage", ["authors", "note"]))
        # The set changes, the group follows; a set that is gone leaves an ordinary group.
        registry.write_share_sets([{"name": "manage", "members": {"note": "note"}}])
        sg.sync_set_groups()
        self.assertEqual(next(x for x in sg.all_groups() if x["id"] == g["id"])["members"], ["note"])
        tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin-pass-1"}).json()["access_token"]
        r = c.put(f"/api/admin/service-groups/{g['id']}", json={"members": ["note", "elog"]}, headers=bearer(tok))
        self.assertEqual(r.status_code, 400)                  # members follow the set, not a hand
        self.assertEqual(c.delete(f"/api/admin/service-groups/{g['id']}", headers=bearer(tok)).status_code, 400)
        # A service in two sets is one card per project, and cannot be put back to one card.
        for proj in ("a", "b"):
            (registry.service_dir("twosets") / "projects" / proj).mkdir(parents=True, exist_ok=True)
        registry.write_manifest("twosets", {**registry.default_manifest("rack", "managed"),
                                            "capabilities": {"multi_project": True, "tags": True}, "entry_project": "a"})
        registry.write_share_sets([{"name": "manage", "members": {"note": "note", "twosets": "a"}},
                                   {"name": "jobboard", "members": {"twosets": "b"}}])
        sg.sync_set_groups()
        by = {x.get("share_set"): x["members"] for x in sg.all_groups() if x.get("share_set")}
        self.assertEqual((by["manage"], by["jobboard"]), (["note", "twosets/a"], ["twosets/b"]))
        r = c.put("/api/admin/home-service", json={"name": "twosets", "split": False}, headers=bearer(tok))
        self.assertEqual(r.status_code, 409)
        registry.write_share_sets([{"name": "manage", "members": {"note": "note"}}])
        sg.sync_set_groups()
        self.assertEqual(c.put("/api/admin/home-service", json={"name": "twosets", "split": False},
                               headers=bearer(tok)).status_code, 200)
        # Renamed, the set keeps its group (followed by id), and the group takes the new name.
        sid = registry.share_sets()[0][0].get("id")
        if sid:
            registry.write_share_sets([{"id": sid, "name": "admin", "members": {"note": "note"}}])
            sg.sync_set_groups()
            self.assertEqual(next(x for x in sg.all_groups() if x["id"] == g["id"])["name"], "admin")
        registry.write_share_sets([])
        sg.sync_set_groups()
        self.assertNotIn("share_set", next(x for x in sg.all_groups() if x["id"] == g["id"]))

    def test_a_set_holding_a_non_main_project_gets_that_project_card(self):
        from app.routers import service_groups as sg
        for proj in ("flows", "team"):
            (registry.service_dir("onemain") / "projects" / proj).mkdir(parents=True, exist_ok=True)
        registry.write_manifest("onemain", {**registry.default_manifest("rack", "managed"),
                                            "capabilities": {"multi_project": True, "tags": True}, "entry_project": "flows"})
        # In one set only, but not through its main project: the whole-service card would open
        # flows, so the group holds the team project's own card.
        registry.write_share_sets([{"name": "crew", "members": {"note": "note", "onemain": "team"}}])
        sg.sync_set_groups()
        g = next(x for x in sg.all_groups() if x.get("share_set") == "crew")
        self.assertEqual(g["members"], ["note", "onemain/team"])
        registry.write_share_sets([])
        sg.sync_set_groups()


if __name__ == "__main__":
    unittest.main(verbosity=2)
