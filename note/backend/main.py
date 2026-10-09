"""note — one markdown file per note, so the folder is the data.

Every other service in this portal keeps one JSON document and saves it whole.
A note is different: bodies are long, they are edited one at a time, and the
point of a notes app is that the notes are FILES. So:

    projects/<project>/
        notes/2026-10-08-회의.md      ← a note: YAML front matter + markdown
        templates/회의록.md            ← a template: the same thing, copied on create

That folder opens in Obsidian as it is. Nothing here is a format of our own:
front matter is YAML, the body is markdown, the todos are GFM checkboxes.

Concurrency: a note carries the file's mtime as its version. A PUT sends the
`baseVersion` it read; if the file moved on, it is rejected with 409 and the
current note, rather than overwriting someone's paragraph.
"""
import os
import re
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lilak_portal_auth import identity

DATA = Path(os.environ.get("NOTE_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("NOTE_DIST_DIR", "/app/note/dist"))
NOTES = DATA / "notes"
TEMPLATES = DATA / "templates"

app = FastAPI(title="note")

# The fields the app knows by name. Anything else in the front matter is kept
# and handed back untouched — a note may carry fields this app never heard of,
# which is how "속성 추가하기" works without a schema.
KNOWN = ("title", "date", "tags")
TODO_RE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$")
# `#태그` written in the body, the way Obsidian spells one. A heading is `# `
# WITH a space after the hash, so the two cannot be confused — which is why the
# tag needs no field of its own.
TAG_RE = re.compile(r"(?:^|[\s(])#([^\s#.,;:!?()\[\]{}'\"]+)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _slug(title: str) -> str:
    """A filename out of a title. Korean is kept — the filesystem takes it and
    the folder is meant to be read by a person."""
    s = unicodedata.normalize("NFC", (title or "").strip())
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", s)        # what a filename cannot hold
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:80] or "untitled"


def _split(text: str) -> tuple[dict, str]:
    """front matter, body. A file without front matter is all body."""
    if text.startswith("---\n"):
        end = text.find("\n---", 3)
        if end != -1:
            head = text[4:end]
            body = text[end + 4:].lstrip("\n")
            try:
                meta = yaml.safe_load(head) or {}
            except Exception:
                meta = {}
            if isinstance(meta, dict):
                return meta, body
    return {}, text


def _join(meta: dict, body: str) -> str:
    clean = {}
    for k, v in meta.items():
        if v in (None, "", [], {}):
            continue
        # A date written as a date, not as a quoted string: it is what the file
        # looks like in Obsidian and in any other reader of this folder.
        if k == "date" and isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            v = date.fromisoformat(v)
        clean[k] = v
    head = yaml.safe_dump(clean, allow_unicode=True, sort_keys=False).strip()
    return f"---\n{head}\n---\n\n{body.lstrip()}\n" if head else body.lstrip() + "\n"


def _as_tags(v: Any) -> list:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [t.strip() for t in str(v or "").replace(",", " ").split() if t.strip()]


def _path(note_id: str) -> Path:
    """`note_id` is the file's stem. It never leaves the notes folder."""
    if not note_id or "/" in note_id or "\\" in note_id or note_id.startswith("."):
        raise HTTPException(400, "잘못된 노트 이름입니다.")
    p = (NOTES / f"{note_id}.md").resolve()
    if not str(p).startswith(str(NOTES.resolve())):
        raise HTTPException(400, "잘못된 노트 이름입니다.")
    return p


def _read(p: Path) -> dict:
    text = p.read_text(encoding="utf-8")
    meta, body = _split(text)
    extra = {k: v for k, v in meta.items() if k not in KNOWN}
    d = meta.get("date")
    # Front matter first (an imported note may carry tags there), then the ones
    # written in the body. One list, in the order they were met.
    tags = _as_tags(meta.get("tags"))
    for m in TAG_RE.finditer(body):
        if m.group(1) not in tags:
            tags.append(m.group(1))
    return {
        "id": p.stem,
        "title": str(meta.get("title") or p.stem),
        "date": (d.isoformat() if isinstance(d, (date, datetime)) else str(d or "")),
        "tags": tags,
        "fields": extra,
        "body": body,
        # A STRING on purpose: st_mtime_ns is ~1.8e18, past JavaScript's safe
        # integer range, so a client that parsed it as a number handed back a
        # rounded value and every save looked like someone else's edit.
        "version": str(p.stat().st_mtime_ns),
        "bytes": p.stat().st_size,
    }


def _summary(n: dict) -> dict:
    """What the LIST needs. The body goes only as far as a first line, so a
    folder of long notes still lists in one small response."""
    first = next((ln.strip() for ln in n["body"].splitlines()
                  if ln.strip() and not ln.startswith("#")), "")
    todos = [m for m in (TODO_RE.match(ln) for ln in n["body"].splitlines()) if m]
    return {
        "id": n["id"], "title": n["title"], "date": n["date"], "tags": n["tags"],
        "fields": n["fields"], "excerpt": first[:160], "version": n["version"],
        "words": len(n["body"].split()), "bytes": n["bytes"],
        "todo": sum(1 for m in todos if m.group(2) == " "),
        "done": sum(1 for m in todos if m.group(2) != " "),
    }


def _all(folder: Path) -> list:
    if not folder.is_dir():
        return []
    out = []
    for p in sorted(folder.glob("*.md")):
        try:
            out.append(_read(p))
        except Exception:
            continue          # a file we cannot read is not a reason to show nothing
    return out


class SaveBody(BaseModel):
    baseVersion: Optional[str] = None
    title: Optional[str] = None
    date: Optional[str] = None
    tags: Optional[list] = None
    fields: Optional[dict] = None
    body: Optional[str] = None


class NewBody(BaseModel):
    title: str = ""
    template: Optional[str] = None


class TodoBody(BaseModel):
    id: str
    line: int
    done: bool
    text: Optional[str] = None     # what the line said when it was read


@app.get("/api/notes")
def list_notes(_: dict = Depends(identity)) -> dict:
    notes = [_summary(n) for n in _all(NOTES)]
    return {"notes": notes, "templates": [n["id"] for n in _all(TEMPLATES)],
            "project": PROJECT, "updatedAt": _now()}


@app.get("/api/notes/{note_id}")
def get_note(note_id: str, _: dict = Depends(identity)) -> dict:
    p = _path(note_id)
    if not p.is_file():
        raise HTTPException(404, "그 노트가 없습니다.")
    return _read(p)


@app.post("/api/notes", status_code=201)
def new_note(body: NewBody, _: dict = Depends(identity)) -> dict:
    title = body.title.strip() or "제목 없음"
    meta, text = {"title": title, "date": date.today().isoformat(), "tags": []}, ""
    if body.template:
        tp = (TEMPLATES / f"{body.template}.md")
        if tp.is_file():
            tmeta, text = _split(tp.read_text(encoding="utf-8"))
            tmeta.pop("title", None)
            meta = {**{"title": title, "date": date.today().isoformat()}, **tmeta}
            meta["tags"] = _as_tags(meta.get("tags"))
    stem = f"{meta['date']}-{_slug(title)}"
    p = _path(stem)
    n = 2
    while p.exists():                       # two notes may share a title on a day
        p = _path(f"{stem}-{n}")
        n += 1
    _atomic_write(p, _join(meta, text))
    return _read(p)


@app.put("/api/notes/{note_id}")
def put_note(note_id: str, body: SaveBody, _: dict = Depends(identity)):
    p = _path(note_id)
    if not p.is_file():
        raise HTTPException(404, "그 노트가 없습니다.")
    cur = _read(p)
    if body.baseVersion is not None and body.baseVersion != cur["version"]:
        return JSONResponse(status_code=409, content={
            "detail": "이 노트가 그 사이에 바뀌었습니다. 최신 내용을 불러옵니다.",
            "current": cur})
    # `tags` is only written when a client asks for it. Left alone, the front
    # matter keeps whatever it had and the body's #tags stay in the body —
    # writing the read-back list there would copy every inline tag into the
    # front matter on the first save.
    old_meta, _ = _split(p.read_text(encoding="utf-8"))
    meta = {
        "title": cur["title"] if body.title is None else body.title.strip(),
        "date": cur["date"] if body.date is None else body.date.strip(),
        "tags": _as_tags(old_meta.get("tags")) if body.tags is None else _as_tags(body.tags),
        **(cur["fields"] if body.fields is None else body.fields),
    }
    _atomic_write(p, _join(meta, cur["body"] if body.body is None else body.body))
    return _read(p)


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str, _: dict = Depends(identity)) -> dict:
    p = _path(note_id)
    if p.is_file():
        p.unlink()
    return {"ok": True, "id": note_id}


@app.get("/api/todos")
def todos(_: dict = Depends(identity)) -> dict:
    """Every GFM checkbox in every note. Collected, never stored — the line in
    the note is the only copy, so a box ticked here is ticked there."""
    out = []
    for n in _all(NOTES):
        for i, ln in enumerate(n["body"].splitlines()):
            m = TODO_RE.match(ln)
            if m:
                out.append({"id": n["id"], "title": n["title"], "date": n["date"],
                            "tags": n["tags"], "line": i,
                            "done": m.group(2) != " ", "text": m.group(4).strip()})
    return {"todos": out}


@app.put("/api/todos")
def set_todo(body: TodoBody, _: dict = Depends(identity)):
    p = _path(body.id)
    if not p.is_file():
        raise HTTPException(404, "그 노트가 없습니다.")
    n = _read(p)
    lines = n["body"].splitlines()
    if not 0 <= body.line < len(lines):
        raise HTTPException(409, "그 줄이 더 이상 없습니다 — 노트를 다시 읽어주세요.")
    m = TODO_RE.match(lines[body.line])
    # The line must still BE the todo it was: a note edited elsewhere must not
    # have a checkbox stamped onto whatever moved into that position.
    if not m or (body.text is not None and m.group(4).strip() != body.text.strip()):
        raise HTTPException(409, "그 줄이 바뀌었습니다 — 노트를 다시 읽어주세요.")
    lines[body.line] = f"{m.group(1)}{'x' if body.done else ' '}{m.group(3)}{m.group(4)}"
    _atomic_write(p, _join({"title": n["title"], "date": n["date"], "tags": n["tags"],
                            **n["fields"]}, "\n".join(lines)))
    return {"ok": True, "id": body.id, "line": body.line, "done": body.done}


@app.get("/api/search")
def search(q: str = "", _: dict = Depends(identity)) -> dict:
    """Body search, which the list cannot do — it only carries a first line."""
    needle = q.strip().lower()
    if not needle:
        return {"hits": []}
    hits = []
    for n in _all(NOTES):
        for i, ln in enumerate(n["body"].splitlines()):
            if needle in ln.lower():
                hits.append({"id": n["id"], "title": n["title"], "line": i,
                             "text": ln.strip()[:160]})
                break
    return {"hits": hits}


@app.get("/api/whoami")
def whoami(me: dict = Depends(identity)) -> dict:
    return {**me, "project": PROJECT}


# ── Static SPA (must stay last: the catch-all would shadow /api/*) ────────────
_assets = DIST / "assets"
if _assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    candidate = DIST / path
    if path and candidate.is_file():
        return FileResponse(candidate)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "note dist not built")
