"""An old portal DB (grants unique per user+service) is rebuilt to per-project on start.

    cd service_manager && .venv/bin/python tests/test_db_migrate.py
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
(TMP / "_portal").mkdir()
con = sqlite3.connect(TMP / "_portal" / "portal.db")
con.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR, email_verified BOOLEAN DEFAULT 0,
                    created_at DATETIME, email_verified_at DATETIME);
INSERT INTO users (id, username) VALUES (7, 'kk');
CREATE TABLE portal_permissions (id INTEGER NOT NULL, user_id INTEGER NOT NULL, service_name VARCHAR(128) NOT NULL,
  project VARCHAR(128) NOT NULL DEFAULT '', is_admin BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id),
  CONSTRAINT uq_user_service UNIQUE (user_id, service_name));
INSERT INTO portal_permissions VALUES (1, 7, 'svc', '', 1);
CREATE TABLE portal_reports (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind VARCHAR(16) NOT NULL,
  subject VARCHAR(200) NOT NULL, body TEXT NOT NULL, status VARCHAR(16) NOT NULL, reply TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]', created_at DATETIME, updated_at DATETIME);
INSERT INTO portal_reports VALUES (3, 7, 'bug', 's', 'b', 'resolved', 'abc123 에서 고침', '[]',
  '2026-11-01 10:00:00', '2026-11-02 10:00:00');
""")
con.commit()
con.close()
os.environ["PORTAL_DATA_ROOT"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db  # noqa: E402,F401  (importing runs the migration)


class OldUnique(unittest.TestCase):
    def test_project_grant_fits_beside_service_grant(self):
        c = sqlite3.connect(TMP / "_portal" / "portal.db")
        c.execute("INSERT INTO portal_permissions (user_id, service_name, project, is_admin) VALUES (7, 'svc', 'p1', 1)")
        rows = c.execute("SELECT user_id, service_name, project FROM portal_permissions ORDER BY id").fetchall()
        self.assertEqual(rows, [(7, "svc", ""), (7, "svc", "p1")])


class OldReply(unittest.TestCase):
    """A DB from before issue threads: the comment table is made fresh, with NOT NULL columns that have no
    default in SQL (the server's first start failed on them, 2026-11-21)."""
    def test_reply_becomes_first_comment_and_kind_first_label(self):
        c = sqlite3.connect(TMP / "_portal" / "portal.db")
        self.assertEqual(c.execute("SELECT report_id, body, ext_dirty, deleted FROM portal_report_comments").fetchall(),
                         [(3, "abc123 에서 고침", 0, 0)])
        self.assertEqual(c.execute("SELECT reply, labels_json FROM portal_reports").fetchall(), [(None, '["bug"]')])


if __name__ == "__main__":
    unittest.main()
