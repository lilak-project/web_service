"""AI provider keys for platform agents: encrypting them, and choosing one.

The secret is sealed with Fernet under a master key that is NOT the JWT secret
(rotating that must not lose every key): PORTAL_KEYS_SECRET from the environment
(the server's .env), else data/_portal/keys.key, made on first use (the Mac test).
"""
import json
import os

from cryptography.fernet import Fernet

from . import config, models


def _fernet() -> Fernet:
    env = os.environ.get("PORTAL_KEYS_SECRET")
    if env:
        return Fernet(env.encode())
    path = config.DATA_ROOT / "_portal" / "keys.key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(Fernet.generate_key())
        path.chmod(0o600)
    return Fernet(path.read_bytes().strip())


def seal(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def unseal(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def uses(k: models.LlmKey) -> list:
    try:
        v = json.loads(k.uses or "[]")
        return v if isinstance(v, list) else []
    except ValueError:
        return []


def choose(db, provider: str, svc: str, proj: str):
    """The key a run in svc/proj spends: one named for that project, else the portal default."""
    rows = db.query(models.LlmKey).filter_by(provider=provider).order_by(models.LlmKey.id).all()
    for want in (f"{svc}/{proj}", "portal"):
        for k in rows:
            if want in uses(k):
                return k
    return None


if __name__ == "__main__":       # self-check: seal/unseal and the choice order
    import tempfile
    from pathlib import Path
    config.DATA_ROOT = Path(tempfile.mkdtemp())
    assert unseal(seal("sk-test")) == "sk-test"

    class Q(list):
        def filter_by(self, **kw): return Q(r for r in self if all(getattr(r, a) == b for a, b in kw.items()))
        def order_by(self, *_): return self
        def all(self): return list(self)

    class DB:
        def __init__(self, rows): self.rows = rows
        def query(self, _): return Q(self.rows)
    a = models.LlmKey(id=1, provider="claude", uses='["portal"]')
    b = models.LlmKey(id=2, provider="claude", uses='["jobboard/jobboard"]')
    assert choose(DB([a, b]), "claude", "jobboard", "jobboard") is b
    assert choose(DB([a, b]), "claude", "note", "note") is a
    assert choose(DB([a, b]), "openai", "note", "note") is None
    print("ok")
