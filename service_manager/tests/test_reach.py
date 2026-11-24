"""Host paths a service may use (/api/reach): asked by the service, answered by a manager.

    cd service_manager && .venv/bin/python tests/test_reach.py
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

from app import main, security               # noqa: E402

c = TestClient(main.app)
H = str(Path.home())          # a service may ask only for what is in the home folder


class Reach(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mgr = {"Authorization": "Bearer " + c.post("/api/auth/setup", json={"password": "admin-pass-1"}).json()["access_token"]}
        r = c.post("/api/auth/register", json={"username": "plain", "password": "user-pass-1", "email": "plain@x.org"})
        cls.user = {"Authorization": "Bearer " + r.json()["access_token"]}

    def ask(self, path, svc="flow", key=None):
        return c.post("/api/reach/check", json={"path": path, "why": "test"}, headers={
            "X-Portal-Service": svc, "X-Portal-Service-Key": security.service_key(svc) if key is None else key})

    def put(self, **b):
        return c.post("/api/admin/reach/paths", headers=self.mgr, json=b)

    def test_1_asked_waits_then_a_manager_answers(self):
        self.assertEqual(self.ask(H + "/x/data", key="wrong").status_code, 403)          # only a service the portal started
        self.assertEqual(self.ask(H + "/x/data").json(), {"allowed": False, "status": "waiting", "comments": []})
        self.assertEqual(c.get("/api/access-requests", headers=self.mgr).json()["paths_waiting"], 1)
        self.assertNotIn("paths_waiting", c.get("/api/access-requests", headers=self.user).json())
        self.assertEqual(c.get("/api/admin/reach", headers=self.user).status_code, 403)
        self.assertEqual(self.put(service="flow", path=H + "/x/data/").status_code, 200)
        # an approved folder covers what is below it, not a neighbour that starts the same
        self.assertEqual([self.ask(p).json()["allowed"] for p in (H + "/x/data", H + "/x/data/run/1.root", H + "/x/database", H + "/x")],
                         [True, True, False, False])
        # the longest entry decides: a blocked folder inside an approved one
        self.put(service="flow", path=H + "/x/data/private", status="blocked")
        self.assertEqual([self.ask(p).json()["allowed"] for p in (H + "/x/data/private/a", H + "/x/data/public/a")], [False, True])
        # another service is not answered by this one's list
        self.assertFalse(self.ask(H + "/x/data", svc="other").json()["allowed"])
        # taken off the list: refused, and waiting again when asked
        c.request("DELETE", "/api/admin/reach/paths", headers=self.mgr, json={"service": "flow", "path": H + "/x/data"})
        self.assertEqual(self.ask(H + "/x/data/run").json()["status"], "waiting")

    def test_1b_a_service_asks_only_inside_the_home_folder(self):
        for wide in ("/", "/Volumes", str(Path.home().parent), "/acq/run"):
            self.assertEqual(self.ask(wide).json(), {"allowed": False, "status": "outside"}, wide)
        self.assertEqual(self.ask(H).json()["status"], "waiting")                      # the home folder itself may be asked for
        listed = [e["path"] for s in c.get("/api/admin/reach", headers=self.mgr).json()["services"] for e in s["paths"]]
        self.assertTrue("/Volumes" not in listed and "/acq/run" not in listed)        # nothing was left waiting
        self.put(service="flow", path="/acq")                                          # a manager's own word still allows it
        self.assertTrue(self.ask("/acq/run").json()["allowed"])
        c.request("DELETE", "/api/admin/reach/paths", headers=self.mgr, json={"service": "flow", "path": H})
        c.request("DELETE", "/api/admin/reach/paths", headers=self.mgr, json={"service": "flow", "path": "/acq"})

    def test_2_allow_all_and_block_all(self):
        mode = lambda **b: c.put("/api/admin/reach/mode", headers=self.mgr, json=b)  # noqa: E731
        self.assertEqual(mode(service="flow", mode="nope").status_code, 400)
        mode(service="flow", mode="allow")
        self.assertTrue(self.ask(H + "/anywhere").json()["allowed"])
        mode(service="", mode="block")                                               # every service, whatever its own says
        self.assertFalse(self.ask(H + "/anywhere").json()["allowed"])
        mode(service="", mode="allow"); mode(service="flow", mode="block")           # a service's own block still holds
        self.assertEqual((self.ask(H + "/anywhere").json()["allowed"], self.ask(H + "/anywhere", svc="other").json()["allowed"]), (False, True))
        mode(service="", mode="list"); mode(service="flow", mode="list")
        self.assertFalse(self.ask(H + "/never/asked").json()["allowed"])

    def test_4_what_waits_about_the_portal_is_in_the_inbox(self):
        self.ask(H + "/inbox/one"); self.ask(H + "/inbox/two")
        c.post("/api/account/request-email", headers=self.user, json={"new_email": "new@x.org"})
        self.assertEqual(c.get("/api/inbox/sources", headers=self.mgr).json()[0]["portal"], True)
        self.assertEqual(c.get("/api/inbox/sources", headers=self.user).json(), [])        # nothing is this account's to answer
        self.assertEqual(c.get("/api/inbox/portal/pending", headers=self.user).json()["items"], [])
        items = {x["title"]: x for x in c.get("/api/inbox/portal/pending", headers=self.mgr).json()["items"]}
        one, two = items[f"flow → {H}/inbox/one"], items[f"flow → {H}/inbox/two"]
        mail = next(x for x in items.values() if x["kind"] == "email")
        self.assertEqual((one["kind"], one["actions"]), ("path", ["approve", "hold", "discard"]))
        self.assertEqual(c.get(f"/api/inbox/portal/inbox/{one['id']}", headers=self.mgr).json()["sections"][0]["text"], H + "/inbox/one")
        decide = lambda who, x, a: c.post(f"/api/inbox/portal/inbox/{x['id']}/decide", headers=who, json={"action": a}).status_code  # noqa: E731
        self.assertEqual(decide(self.user, one, "approve"), 409)                           # not theirs
        self.assertEqual([decide(self.mgr, one, "approve"), decide(self.mgr, two, "discard"), decide(self.mgr, mail, "approve")], [200] * 3)
        self.assertEqual([self.ask(p).json()["status"] for p in (H + "/inbox/one/x", H + "/inbox/two")], ["approved", "blocked"])
        self.assertEqual(c.get("/api/account", headers=self.user).json()["email"], "new@x.org")
        self.assertEqual(decide(self.mgr, one, "approve"), 409)                            # decided: no longer waiting

    def test_5_link_requests_from_other_servers_are_in_the_inbox_with_their_pin(self):
        import time
        from app import registry, sync
        registry.write_manifest("note", {"kind": "rack", "mode": "managed"})
        sync.write_list("note", "sync-requests.json", [{"id": "r1", "claim": "c-sync", "status": "pending", "at": time.time(),
                                                        "from_url": "https://other.example", "from_name": "other", "by": "kim",
                                                        "project": "", "two_way": True}])
        asked = c.post("/api/issues/link/requests", json={"from_url": "https://sub.example", "from_name": "sub", "by": "lee"}).json()
        items = {x["kind"]: x for x in c.get("/api/inbox/portal/pending", headers=self.mgr).json()["items"] if x["kind"] in ("sync", "issues")}
        self.assertIn(f"pin {sync.pin('c-sync')}", items["sync"]["from"])               # what the asking side must show too
        self.assertIn(f"pin {asked['pin']}", items["issues"]["from"])
        self.assertEqual(c.get(f"/api/inbox/portal/inbox/{items['sync']['id']}", headers=self.mgr).json()["sections"][0]["text"], "note  ⇄")
        decide = lambda x, a: c.post(f"/api/inbox/portal/inbox/{x['id']}/decide", headers=self.mgr, json={"action": a}).status_code  # noqa: E731
        self.assertEqual([decide(items["sync"], "discard"), decide(items["issues"], "approve")], [200, 200])
        self.assertEqual(sync.read_list("note", "sync-requests.json")[0]["status"], "rejected")
        self.assertEqual(c.get(f"/api/issues/link/requests/{asked['id']}", params={"claim": asked["claim"]}).json()["status"], "approved")
        left = [x["kind"] for x in c.get("/api/inbox/portal/pending", headers=self.mgr).json()["items"]]
        self.assertTrue("sync" not in left and "issues" not in left)

    def test_6_hold_with_an_opinion_and_asking_again(self):
        inbox = lambda who=None: {x["title"]: x for x in c.get("/api/inbox/portal/pending", headers=who or self.mgr).json()["items"]}  # noqa: E731
        act = lambda x, **b: c.post(f"/api/inbox/portal/inbox/{x['id']}/decide", headers=self.mgr, json=b)  # noqa: E731
        # a host path: the service reads the opinion, and asking again (changed) waits again
        self.ask(H + "/held/run")
        one = inbox()[f"flow → {H}/held/run"]
        self.assertEqual(act(one, action="hold").status_code, 400)                       # an opinion is the point
        self.assertEqual(act(one, action="hold", text="run 폴더 하나로 좁혀 주세요").status_code, 200)
        got = self.ask(H + "/held/run").json()
        self.assertEqual((got["allowed"], got["status"], [m["text"] for m in got["comments"]]), (False, "held", ["run 폴더 하나로 좁혀 주세요"]))
        held = inbox()[f"flow → {H}/held/run"]
        self.assertEqual((held["status"], len(held["comments"]), held["comments"][0]["by"]), ("held", 1, "admin"))
        c.post(f"/api/inbox/portal/inbox/{one['id']}/comment", headers=self.mgr, json={"text": "run0232면 됩니다"})
        again = c.post("/api/reach/check", json={"path": H + "/held/run", "why": "run0232만", "again": True}, headers={
            "X-Portal-Service": "flow", "X-Portal-Service-Key": security.service_key("flow")}).json()
        self.assertEqual((again["status"], len(again["comments"])), ("waiting", 2))      # waiting again, the thread kept
        self.assertEqual(act(one, action="approve").status_code, 200)
        self.assertEqual(self.ask(H + "/held/run").json()["status"], "approved")
        # an access request: the one who asked sees it held with the opinion, once, and asks again
        from app import config
        (config.DATA_ROOT / "heldsvc" / "projects" / "p1").mkdir(parents=True, exist_ok=True)
        c.post("/api/access-requests", headers=self.user, json={"service": "heldsvc", "project": "p1"})
        req = inbox()["plain → heldsvc/p1"]
        act(req, action="hold", text="어느 실험인지 알려 주세요")
        mine = c.get("/api/access-requests", headers=self.user).json()
        self.assertEqual((mine["mine"][0]["status"], mine["mine"][0]["comments"][0]["text"], mine["unseen"]), ("held", "어느 실험인지 알려 주세요", 1))
        c.post("/api/access-requests/seen", headers=self.user)
        self.assertEqual(c.get("/api/access-requests", headers=self.user).json()["unseen"], 0)
        c.post("/api/access-requests", headers=self.user, json={"service": "heldsvc", "project": "p1"})       # asked again
        self.assertEqual((c.get("/api/access-requests", headers=self.user).json()["mine"][0]["status"], inbox()["plain → heldsvc/p1"]["status"]),
                         ("pending", "waiting"))
        # an address change, and a link request from another server: the opinion reaches whoever asked
        c.post("/api/account/request-email", headers=self.user, json={"new_email": "again@x.org"})
        act(next(x for x in inbox().values() if x["kind"] == "email"), action="hold", text="기관 주소로 부탁합니다")
        self.assertEqual(c.get("/api/access-requests", headers=self.user).json()["email"]["status"], "held")
        asked = c.post("/api/issues/link/requests", json={"from_url": "https://held.example", "from_name": "heldsub", "by": "lee"}).json()
        act(inbox()["heldsub"], action="hold", text="핀을 전화로 확인한 뒤에")
        st = c.get(f"/api/issues/link/requests/{asked['id']}", params={"claim": asked["claim"]}).json()
        self.assertEqual((st["status"], st["held"], st["comments"][0]["text"]), ("pending", True, "핀을 전화로 확인한 뒤에"))

    def test_7_who_sends_to_the_inbox(self):
        from app.routers import inbox
        card = lambda i, **c: {"_key": f"inbox/inbox/{i}", "id": i, "status": "waiting", "date": "2026-11-20", **c}  # noqa: E731
        rows = {(r["type"], r["name"]): r for r in inbox.senders([
            card("a", kind="note", **{"from": "Tony Ahn <t@x.org>"}, subject="Re: beam time"),          # a mail, by who wrote it
            card("b", kind="activity", **{"from": "MCP mail-task"}, subject="seminar", sender={"user": "admin", "via": "MCP mail-task"}),
            card("c", kind="tags", **{"from": "MCP set-manage"}, status="held", date="2026-11-22"),      # before `sender` was kept
            card("d", kind="tags", **{"from": "MCP set-manage"}, status="approved"),
            card("e", kind="note_delete", **{"from": "포털 정리"}, status="discarded"),
            card("f", kind="path", **{"from": "lilak_flow"}),
            card("g", kind="access", **{"from": "plain"}),
            card("h", kind="sync", **{"from": "kim · pin 1234"}),
            card("i", kind="job", **{"from": ""}),
        ])}
        self.assertEqual(set(rows), {("mail", "mail"), ("token", "mail-task"), ("token", "set-manage"), ("tidy", "포털 정리"),
                                     ("service", "lilak_flow"), ("account", "plain"), ("portal", "kim"), ("other", "?")})
        t = rows[("token", "set-manage")]
        self.assertEqual((t["waiting"], t["held"], t["done"], t["last"], t["back"], t["kinds"], len(t["ids"])),
                         (0, 1, 1, "2026-11-22", "my_proposals", ["tags"], 2))
        self.assertEqual([rows[k]["back"] for k in (("mail", "mail"), ("tidy", "포털 정리"), ("service", "lilak_flow"), ("account", "plain"), ("portal", "kim"))],
                         ["none", "none", "browse", "my_requests", "link"])
        # the page's own call: the portal's items are there for a manager, nothing for an account with nothing to decide
        self.ask(H + "/senders/x")
        got = c.get("/api/inbox/senders", headers=self.mgr).json()
        self.assertTrue(any(r["type"] == "service" and r["name"] == "flow" and r["waiting"] >= 1 for r in got))
        self.assertEqual(c.get("/api/inbox/senders", headers=self.user).json(), [])

    def test_3_a_service_asks_through_the_helper(self):
        import importlib
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lilak_portal_auth"))
        import lilak_portal_auth as lpa
        importlib.reload(lpa)
        self.assertTrue(lpa.reach(str(TMP / "data" / "flow" / "x")))                 # the portal's own data: never asked
        self.assertTrue(lpa.reach("/somewhere"))                                     # run on its own, no portal: not asked
        os.environ.update({"PORTAL_SERVICE": "flow", "PORTAL_SERVICE_KEY": security.service_key("flow")})
        lpa._PORTAL_PORT = "1"                                                       # a portal that does not answer is a no
        try:
            self.assertFalse(lpa.reach(H + "/somewhere/else"))
            self.assertEqual(lpa.reach_status(H + "/somewhere/else"), "unreachable")
            # the portal's answer, as it gives it (asked here in process instead of over the port)
            import io
            import urllib.request
            real, lpa._reach_cache = urllib.request.urlopen, {}

            def through(req, timeout=0):
                r = c.post("/api/reach/check", content=req.data, headers=dict(req.header_items()))
                return io.BytesIO(r.content)
            urllib.request.urlopen = through
            try:
                self.assertEqual(lpa.reach_status(H + "/never/seen/before"), "waiting")
                self.assertEqual(lpa.reach_info(H + "/never/seen/before"), {"status": "waiting", "comments": []})
                self.put(service="flow", path=H + "/never/seen", status="blocked")
                lpa._reach_cache = {}
                self.assertEqual((lpa.reach_status(H + "/never/seen/before"), lpa.reach(H + "/never/seen/before")), ("blocked", False))
            finally:
                urllib.request.urlopen = real
        finally:
            os.environ.pop("PORTAL_SERVICE"); os.environ.pop("PORTAL_SERVICE_KEY")


if __name__ == "__main__":
    unittest.main(verbosity=2)
