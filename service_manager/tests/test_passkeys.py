"""Passkeys end to end with a software authenticator, on a throwaway data root.

    cd service_manager && .venv/bin/python tests/test_passkeys.py

Registers a passkey for the admin, then signs in with no username, and checks
that another origin, a replayed challenge and a removed passkey are refused.
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"PORTAL_DATA_ROOT": str(TMP / "data"), "PORTAL_SECRET_KEY": "test-secret",
                   "EMAIL_VERIFY_REQUIRED": "0"})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cbor2                                                     # noqa: E402
from cryptography.hazmat.primitives import hashes                # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec         # noqa: E402
from fastapi.testclient import TestClient                        # noqa: E402
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url as b64  # noqa: E402

from app import main                                             # noqa: E402

c = TestClient(main.app)
ORIGIN = "http://localhost:8025"


class SoftKey:
    """One ES256 passkey, the way a platform authenticator answers."""
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cid = os.urandom(16)
        self.count = 0

    def _client(self, kind, challenge, origin):
        return json.dumps({"type": kind, "challenge": challenge, "origin": origin}).encode()

    def create(self, options, origin=ORIGIN):
        o = json.loads(options)
        nums = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")})
        auth = (hashlib.sha256(o["rp"]["id"].encode()).digest() + bytes([0x45]) + (0).to_bytes(4, "big")
                + bytes(16) + len(self.cid).to_bytes(2, "big") + self.cid + cose)          # UP|UV|AT
        att = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth})
        return {"id": b64(self.cid), "rawId": b64(self.cid), "type": "public-key",
                "response": {"clientDataJSON": b64(self._client("webauthn.create", o["challenge"], origin)),
                             "attestationObject": b64(att)}, "clientExtensionResults": {}}

    def get(self, options, origin=ORIGIN, user_id=b"1"):
        o = json.loads(options)
        self.count += 1
        auth = hashlib.sha256(o["rpId"].encode()).digest() + bytes([0x05]) + self.count.to_bytes(4, "big")
        cd = self._client("webauthn.get", o["challenge"], origin)
        sig = self.key.sign(auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64(self.cid), "rawId": b64(self.cid), "type": "public-key",
                "response": {"clientDataJSON": b64(cd), "authenticatorData": b64(auth),
                             "signature": b64(sig), "userHandle": b64(user_id)}, "clientExtensionResults": {}}


class Passkeys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = c.post("/api/auth/setup", json={"password": "admin-pass-1"})
        cls.h = {"Authorization": f"Bearer {r.json()['access_token']}", "Origin": ORIGIN}
        cls.k = SoftKey()
        r = c.post("/api/auth/passkey/register/options", headers=cls.h)
        st, opt = r.json()["state"], r.json()["options"]
        r = c.post("/api/auth/passkey/register", headers=cls.h,
                   json={"state": st, "credential": cls.k.create(opt), "name": "mac"})
        assert r.status_code == 200, r.text

    def login(self, origin=ORIGIN, key=None):
        r = c.post("/api/auth/passkey/login/options", headers={"Origin": origin})
        st, opt = r.json()["state"], r.json()["options"]
        self.assertEqual(json.loads(opt)["allowCredentials"], [])      # usernameless
        return st, (key or self.k).get(opt, origin)

    def test_usernameless_login(self):
        st, cred = self.login()
        r = c.post("/api/auth/passkey/login", headers={"Origin": ORIGIN}, json={"state": st, "credential": cred})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["username"], "admin")
        # The same answer twice: its challenge was used up.
        r = c.post("/api/auth/passkey/login", headers={"Origin": ORIGIN}, json={"state": st, "credential": cred})
        self.assertEqual(r.status_code, 400)

    def test_other_host_refused(self):
        st, cred = self.login(origin="https://evil.example")
        r = c.post("/api/auth/passkey/login", headers={"Origin": "https://evil.example"}, json={"state": st, "credential": cred})
        self.assertEqual(r.status_code, 401)

    def test_unknown_key_refused(self):
        st, cred = self.login(key=SoftKey())
        r = c.post("/api/auth/passkey/login", headers={"Origin": ORIGIN}, json={"state": st, "credential": cred})
        self.assertEqual(r.status_code, 401)

    def test_zz_removed_key_refused(self):
        lst = c.get("/api/auth/passkeys", headers=self.h).json()
        self.assertEqual([p["rp_id"] for p in lst], ["localhost"])
        c.delete(f"/api/auth/passkeys/{lst[0]['id']}", headers=self.h)
        st, cred = self.login()
        r = c.post("/api/auth/passkey/login", headers={"Origin": ORIGIN}, json={"state": st, "credential": cred})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
