"""The tex note's two rules, checked. Run: python backend/test_note.py

A tex note's folder is named by the note id, which comes from the client —
so the one thing worth a test is that an id can never point outside the
project's files folder.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("NOTE_DATA_DIR", "/tmp/note-test-data")

from fastapi import HTTPException            # noqa: E402
from backend.main import FILES, PROJ_RE, TEX_AT, _files, _proj_key   # noqa: E402

# A markdown note shares the vault's one folder; a tex note gets its own.
assert _files() == FILES
assert _files("2026-10-31-paper") == FILES / "2026-10-31-paper"

for bad in ("..", "../..", "a/b", "a\\b", ".hidden", "../../etc"):
    try:
        _files(bad)
    except HTTPException:
        continue
    raise AssertionError(f"accepted {bad!r}")

# What an error line says, and which line of the NOTE it happened on — the
# body is main.tex, so the engine's line number is the editor's.
m = TEX_AT.search("error: main.tex:298: Unable to load picture or PDF file 'fig.pdf'")
assert m and int(m.group(1)) == 298, m
assert m.group(2) == "Unable to load picture or PDF file 'fig.pdf'", m.group(2)
assert TEX_AT.search("error: pdf: image inclusion failed for \"a.eps\" (page=1).") is None

# `+STARK` names a project; `C++`, a bullet `+ `, a number `+3` do not.
assert [m.group(1) for m in PROJ_RE.finditer("+STARK 와 (+ELARK), C++ a+b\n+ 목록 +3 명")] == ["STARK", "ELARK"]

# A name with spaces is called with them run into `_`.
assert _proj_key("STARK + CRIB") == _proj_key("stark_crib") == "stark_crib"
assert _proj_key("TAMU TeXAT 실험") == "tamu_texat_실험"

print("note: ok")
