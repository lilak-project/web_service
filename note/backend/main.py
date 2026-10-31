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
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lilak_portal_auth import identity, manager, signed_in

DATA = Path(os.environ.get("NOTE_DATA_DIR", "./data"))
PROJECT = os.environ.get("PORTAL_PROJECT", "")
DIST = Path(os.environ.get("NOTE_DIST_DIR", "/app/note/dist"))
NOTES = DATA / "notes"
TEMPLATES = DATA / "templates"
# What a note points at: images and anything else it embeds. Obsidian keeps
# these beside the notes in the vault, and a note names one by file name alone.
FILES = DATA / "files"
# A note holds a picture or a scan, not a disk image.
MAX_FILE = 32 << 20
# A tex note's PDF is made from the note, not kept by it: it lives outside the
# project folder so it never syncs, never exports and never has to be excluded
# from either. A lost one costs one recompile.
BUILD = Path(tempfile.gettempdir()) / "note-build" / (PROJECT or "_")
TECTONIC = os.environ.get("NOTE_TECTONIC", "tectonic")
COMPILE_SECONDS = 180

app = FastAPI(title="note")

# The fields the app knows by name. Anything else in the front matter is kept
# and handed back untouched — a note may carry fields this app never heard of,
# which is how "속성 추가하기" works without a schema.
KNOWN = ("title", "date")
TODO_RE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$")
# `#태그` written in the body, the way Obsidian spells one. A heading is `# `
# WITH a space after the hash, so the two cannot be confused — which is why the
# tag needs no field of its own.
TAG_RE = re.compile(r"(?:^|[\s(])#(?![0-9]+(?![^\s#.,;:!?()\[\]{}'\"]))([^\s#.,;:!?()\[\]{}'\"]+)")
# `+name` names a project (project_manager's), by the same rule as a tag.
# A project's name may have spaces ("STARK + CRIB"); in text it is called with
# them, and anything else a name cannot hold, run into one `_`: `+STARK_CRIB`.
_proj_key = lambda s: re.sub(r"[\s#+.,;:!?()\[\]{}'\"_]+", "_", str(s).strip().lower()).strip("_")  # noqa: E731
PROJ_RE = re.compile(r"(?:^|[\s(])\+(?![0-9]+(?![^\s#+.,;:!?()\[\]{}'\"]))([^\s#+.,;:!?()\[\]{}'\"]+)")
# The day a box was ticked: `✓ 2026-08-04`. The vault these notes came from
# used Obsidian Tasks' `✅`, so that is still read — only what this app WRITES
# changed, to a mark that is a line rather than a picture.
DONE_RE = re.compile(r"\s*[✓✅]\s*(\d{4}-\d{2}-\d{2})")
# The day it is due, the same way. `>>2026-10-20` is the typing-friendly
# spelling of it — the editor turns one into the other as you write, and a
# file written elsewhere is read either way.
DUE_RE = re.compile(r"\s*(?:»|📅|>>)\s*(\d{4}-\d{2}-\d{2})")
# An empty line inside a checklist is written out as `- [ ] <br />`: a box with
# nothing in it, which is a blank line the person is still typing on, not a job.
BLANK_RE = re.compile(r"(?:\s|<br\s*/?>|&nbsp;)*$")


def _todo(line: str):
    """The checkbox on this line, if it has anything in it."""
    m = TODO_RE.match(line)
    return m if m and not BLANK_RE.fullmatch(m.group(4)) else None


def _todo_text(raw: str) -> tuple[str, str, str]:
    """The todo as a person wrote it, the day it is due, the day it was done."""
    done = DONE_RE.search(raw)
    due = DUE_RE.search(raw)
    text = DUE_RE.sub("", DONE_RE.sub("", raw)).strip()
    return text, (due.group(1) if due else ""), (done.group(1) if done else "")


def _todo_line(text: str, due: str, done_at: str) -> str:
    """…and back again, with the marks in the order Obsidian writes them."""
    return text + (f" » {due}" if due else "") + (f" ✓ {done_at}" if done_at else "")


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
    # Tags live in the BODY and nowhere else: `#태그`, which is both Obsidian's
    # spelling and the only place a reader of the file would look. A `tags:`
    # key someone leaves in the front matter is kept as an ordinary field, not
    # read as tags — two places to write one thing is how they disagree.
    tags = []
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
    todos = [m for m in (_todo(ln) for ln in n["body"].splitlines()) if m]
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
    due: Optional[str] = None      # '' clears it, None leaves it alone


@app.get("/api/notes")
def list_notes(_: dict = Depends(signed_in)) -> dict:
    notes = [_summary(n) for n in _all(NOTES)]
    return {"notes": notes, "templates": [n["id"] for n in _all(TEMPLATES)],
            "project": PROJECT, "updatedAt": _now()}


@app.get("/api/notes/{note_id}")
def get_note(note_id: str, _: dict = Depends(signed_in)) -> dict:
    p = _path(note_id)
    if not p.is_file():
        raise HTTPException(404, "그 노트가 없습니다.")
    # When this note's PDF was made, if it has one — so the editor can offer
    # to show it, and can tell whether it is still the note (its stamp is
    # later than the note's own `version`, which is the file's).
    return {**_read(p), "pdf_at": _pdf_at(note_id)}


@app.post("/api/notes", status_code=201)
def new_note(body: NewBody, _: dict = Depends(signed_in)) -> dict:
    title = body.title.strip() or "제목 없음"
    meta, text = {"title": title, "date": date.today().isoformat()}, ""
    if body.template:
        tp = (TEMPLATES / f"{body.template}.md")
        if tp.is_file():
            tmeta, text = _split(tp.read_text(encoding="utf-8"))
            tmeta.pop("title", None)
            # The template's own #tags come along in its body, where they live.
            meta = {**{"title": title, "date": date.today().isoformat()}, **tmeta}
    stem = f"{meta['date']}-{_slug(title)}"
    p = _path(stem)
    n = 2
    while p.exists():                       # two notes may share a title on a day
        p = _path(f"{stem}-{n}")
        n += 1
    _atomic_write(p, _join(meta, text))
    return _read(p)


@app.put("/api/notes/{note_id}")
def put_note(note_id: str, body: SaveBody, _: dict = Depends(signed_in)):
    p = _path(note_id)
    if not p.is_file():
        raise HTTPException(404, "그 노트가 없습니다.")
    cur = _read(p)
    if body.baseVersion is not None and body.baseVersion != cur["version"]:
        return JSONResponse(status_code=409, content={
            "detail": "이 노트가 그 사이에 바뀌었습니다. 최신 내용을 불러옵니다.",
            "current": cur})
    meta = {
        "title": cur["title"] if body.title is None else body.title.strip(),
        "date": cur["date"] if body.date is None else body.date.strip(),
        **(cur["fields"] if body.fields is None else body.fields),
    }
    _atomic_write(p, _join(meta, cur["body"] if body.body is None else body.body))
    return _read(p)


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str, _: dict = Depends(signed_in)) -> dict:
    p = _path(note_id)
    if p.is_file():
        p.unlink()
    return {"ok": True, "id": note_id}


@app.get("/api/tags")
def tags(_: dict = Depends(signed_in)) -> dict:
    """The tags the notes wear, with how many notes wear each — what the rack
    services offer as you type one (they answer the same here, and note asks them)."""
    n: dict = {}
    for note in _all(NOTES):
        for t in note["tags"]:
            n[t] = n.get(t, 0) + 1
    return {"tags": n}


@app.post("/api/tags/rename")
def rename_tags(body: dict, _: dict = Depends(signed_in)) -> dict:
    """Every `#tag` in `from` (any case) becomes `#to`, in every note — the
    text is the only place a tag lives. Renaming one tag, or merging several;
    project_manager asks every service in turn. An empty `to` deletes the
    tag: its `#` goes, the word stays (the sentence still reads)."""
    gone = {str(t).strip().lower() for t in body.get("from") or [] if str(t).strip()}
    to = str(body.get("to") or "").strip()
    if not gone or re.search(r"[\s#]", to):
        raise HTTPException(400, "바꿀 태그와 새 이름(띄어쓰기 없이)이 필요합니다.")
    lead = re.compile(r"(^|[\s(])#(?![0-9]+(?![^\s#.,;:!?()\[\]{}'\"]))([^\s#.,;:!?()\[\]{}'\"]+)")
    n = 0
    for p in sorted(NOTES.glob("*.md")):
        text = p.read_text(encoding="utf-8")
        m = re.match(r"---\n.*?\n---\n", text, re.S)
        head, rest = (text[:m.end()], text[m.end():]) if m else ("", text)
        new = lead.sub(lambda x: f"{x.group(1)}{'#' + to if to else x.group(2)}" if x.group(2).lower() in gone else x.group(0), rest)
        if new != rest:
            _atomic_write(p, head + new)
            n += 1
    return {"changed": n}


@app.get("/api/tagged")
def tagged(tag: str = "", project: str = "", _: dict = Depends(signed_in)) -> dict:
    """The notes wearing `tag` (any case), and the todos written with it — what
    project_manager gathers from every service. With `project` instead, the
    ones that name it (`+STARK`)."""
    rule, want = (PROJ_RE, _proj_key(project)) if project.strip() else (TAG_RE, tag.strip().lower())
    hit = (lambda m: _proj_key(m.group(1)) == want) if rule is PROJ_RE else (lambda m: m.group(1).lower() == want)
    out = []
    for note in _all(NOTES):
        if want and (any(t.lower() == want for t in note["tags"]) if rule is TAG_RE
                     else any(hit(m) for m in PROJ_RE.finditer(note["body"]))):
            out.append({"key": "notes", "rec": {"id": note["id"], "title": note["title"], "date": note["date"]}})
        for i, ln in enumerate(note["body"].splitlines()):
            m = _todo(ln)
            if not m:
                continue
            text, due, at = _todo_text(m.group(4))
            if want and any(hit(t) for t in rule.finditer(text)):
                out.append({"key": "todos", "rec": {"id": note["id"], "title": note["title"], "line": i,
                                                    "text": text, "done": m.group(2) != " ", "due": due}})
    return {"items": out}


@app.get("/api/todos")
def todos(_: dict = Depends(signed_in)) -> dict:
    """Every GFM checkbox in every note. Collected, never stored — the line in
    the note is the only copy, so a box ticked here is ticked there."""
    out = []
    for n in _all(NOTES):
        for i, ln in enumerate(n["body"].splitlines()):
            m = _todo(ln)
            if m:
                text, due, at = _todo_text(m.group(4))
                # The tags of the LINE, not of the note: a todo wears what was
                # written on it, which is the only way a list of them can be
                # told apart.
                out.append({"id": n["id"], "title": n["title"], "date": n["date"],
                            "tags": [t.group(1) for t in TAG_RE.finditer(text)],
                            "line": i, "done": m.group(2) != " ",
                            "due": due, "doneAt": at, "text": text})
    return {"todos": out}


@app.put("/api/todos")
def set_todo(body: TodoBody, _: dict = Depends(signed_in)):
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
    text, due, _ = _todo_text(m.group(4)) if m else ("", "", "")
    if not m or (body.text is not None and text != body.text.strip()):
        raise HTTPException(409, "그 줄이 바뀌었습니다 — 노트를 다시 읽어주세요.")
    # Ticked here, dated here; unticked, the date goes with it. A due date the
    # line already carried is not ours to drop.
    if body.due is not None:
        due = body.due.strip()
    done_at = date.today().isoformat() if body.done else ""
    rest = _todo_line(text, due, done_at)
    lines[body.line] = f"{m.group(1)}{'x' if body.done else ' '}{m.group(3)}{rest}"
    _atomic_write(p, _join({"title": n["title"], "date": n["date"], **n["fields"]},
                           "\n".join(lines)))
    return {"ok": True, "id": body.id, "line": body.line, "done": body.done,
            "due": due, "doneAt": done_at}


@app.get("/api/search")
def search(q: str = "", _: dict = Depends(signed_in)) -> dict:
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


def _files(note: str = "") -> Path:
    """Where a note's files live.

    A markdown note shares the project's files folder: that folder is a vault,
    `![[a.png]]` names one file in it, and two notes showing the same picture
    should be showing the same file.

    A tex note gets a folder of its own (`files/<note>/`), because LaTeX names
    a file by a plain name that the compile copies next to `main.tex` — two
    papers that each have a `fig1.pdf` must not be one file.
    """
    if not note:
        return FILES
    if "/" in note or "\\" in note or note.startswith("."):
        raise HTTPException(400, "잘못된 노트 이름입니다.")
    return FILES / note


@app.get("/api/file/{name}")
def get_file(name: str, note: str = "", _: dict = Depends(signed_in)):
    """A file a note embeds — `![[name.png]]`, which is Obsidian's spelling and
    names the file alone. It never leaves the project's files folder.

    `note` asks that note's own folder first (a tex note), and the shared
    folder after it, so a picture already in the vault still shows."""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(400, "잘못된 파일 이름입니다.")
    for base in ([_files(note), FILES] if note else [FILES]):
        p = (base / name).resolve()
        if str(p).startswith(str(FILES.resolve())) and p.is_file():
            return FileResponse(p)
    raise HTTPException(404, "그 파일이 없습니다.")


def _pdf_at(note_id: str) -> str:
    """When this note's PDF was last written, as a string of nanoseconds — the
    same clock and the same shape as a note's `version`, so the two compare.
    Empty when there is no PDF."""
    p = BUILD / f"{note_id}.pdf"
    return str(p.stat().st_mtime_ns) if p.is_file() else ""


def _tex_body(note_id: str) -> str:
    """The note as LaTeX. The front matter is NOT part of the document — the
    body alone is `main.tex`, which is also why an error's line number is the
    line the editor shows."""
    p = _path(note_id)
    if not p.is_file():
        raise HTTPException(404, "그런 노트가 없습니다.")
    meta, body = _split(p.read_text(encoding="utf-8"))
    if str(meta.get("format", "")).lower() != "tex":
        raise HTTPException(400, "LaTeX 노트가 아닙니다 (앞머리에 format: tex).")
    return body


# `error: main.tex:12: …` — the line of the note the engine stopped on.
TEX_AT = re.compile(r"\bmain\.tex:(\d+):\s*(.*)")


@app.post("/api/compile/{note_id}")
def compile_note(note_id: str, _: dict = Depends(signed_in)) -> dict:
    r"""The note, typeset. Its body is written out as `main.tex` and its files
    land beside it — which is why a tex note has a folder of its own, and why
    `\includegraphics{fig1.pdf}` means the plain name it says.

    `--untrusted` is the point: no shell-escape, nothing read from outside the
    folder we just made. The document is text from a browser."""
    body = _tex_body(note_id)
    exe = shutil.which(TECTONIC)
    if not exe:
        raise HTTPException(501, "이 서버에는 tectonic이 없습니다.")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "main.tex").write_text(body, encoding="utf-8")
        src = _files(note_id)
        if src.is_dir():
            for f in src.iterdir():
                if f.is_file():
                    shutil.copy(f, work / f.name)
        try:
            r = subprocess.run([exe, "--untrusted", "main.tex"], cwd=work,
                               capture_output=True, text=True,
                               timeout=COMPILE_SECONDS)
            log, code = (r.stderr or "") + (r.stdout or ""), r.returncode
        except subprocess.TimeoutExpired:
            log, code = f"{COMPILE_SECONDS}초 안에 끝나지 않았습니다.", 1
        pdf = work / "main.pdf"
        ok = code == 0 and pdf.is_file()
        if ok:
            BUILD.mkdir(parents=True, exist_ok=True)
            shutil.copy(pdf, BUILD / f"{note_id}.pdf")
    # Only what went wrong: a LaTeX run says thousands of words about boxes
    # being a little too wide, and none of them is why the PDF is missing.
    bad = [ln for ln in log.splitlines() if ln.startswith("error:")]
    errors = []
    for ln in bad:
        m = TEX_AT.search(ln)
        errors.append({"line": int(m.group(1)), "text": m.group(2)} if m
                      else {"line": 0, "text": ln[len("error:"):].strip()})
    return {"ok": ok, "errors": errors, "log": log[-8000:], "pdf_at": _pdf_at(note_id)}


@app.get("/api/pdf/{note_id}")
def get_pdf(note_id: str, _: dict = Depends(signed_in)):
    """The PDF the last compile left. It is not the note — a note whose PDF is
    gone is a note that has not been compiled on this server yet."""
    _path(note_id)                      # the name is a note's, not a path
    p = BUILD / f"{note_id}.pdf"
    if not p.is_file():
        raise HTTPException(404, "아직 컴파일하지 않았습니다.")
    return FileResponse(p, media_type="application/pdf")


@app.get("/api/where")
def where(note: str = "", _: dict = Depends(signed_in)) -> dict:
    """Where this project keeps what it is made of — the folders behind the
    notes and their files, so the app can say it rather than make you guess."""
    return {"project": PROJECT, "notes": str(NOTES), "files": str(_files(note))}


@app.post("/api/reveal")
def reveal(note: str = "", _: dict = Depends(manager)) -> dict:
    """Show the files folder in the host's own file manager. The portal spawns
    this service on the machine it runs on, so 'the host' is that machine — in
    a container, or behind a portal somewhere else, there is nothing to open
    and the caller is told so rather than left waiting."""
    folder = _files(note)
    folder.mkdir(parents=True, exist_ok=True)
    opener = {"darwin": "open", "win32": "explorer"}.get(sys.platform, "xdg-open")
    try:
        subprocess.Popen([opener, str(folder)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        raise HTTPException(501, "이 서버에서는 폴더를 열 수 없습니다.")
    return {"path": str(folder)}


@app.post("/api/file")
async def put_file(f: UploadFile = File(...), note: str = "",
                   _: dict = Depends(signed_in)):
    """A file dropped into a note. It lands beside the notes under its own
    name, the way a vault keeps it; a name already taken grows a number rather
    than overwriting someone else's picture. `note` puts it in that note's own
    folder instead (a tex note — see `_files`)."""
    raw = await f.read(MAX_FILE + 1)
    if len(raw) > MAX_FILE:
        raise HTTPException(413, f"파일이 너무 큽니다 ({MAX_FILE // (1 << 20)}MB까지).")
    name = _slug(Path(f.filename or "file").name) or "file"
    stem, ext = os.path.splitext(name)
    folder = _files(note)
    folder.mkdir(parents=True, exist_ok=True)
    n = 1
    while (folder / name).exists():
        name = f"{stem}-{n}{ext}"
        n += 1
    (folder / name).write_bytes(raw)
    return {"name": _pdfify(folder / name) or name}


def _pdfify(p: Path) -> str:
    """PostScript, turned into a PDF beside itself — and the PDF's name, which
    is the one a document should point at.

    Tectonic cannot place an EPS at all: not a shell-escape rule, the PDF
    writer simply has no PostScript in it. So the conversion happens once, when
    the file arrives, rather than on every compile. The original is kept — it
    is what was handed to us. No ghostscript on this host means the file stays
    as it is and the compile says which picture it could not read."""
    if p.suffix.lower() not in (".eps", ".ps"):
        return ""
    gs = shutil.which("gs")
    if not gs:
        return ""
    out = p.with_suffix(".pdf")
    r = subprocess.run([gs, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop",
                        "-sDEVICE=pdfwrite", f"-sOutputFile={out}", str(p)],
                       capture_output=True, timeout=120)
    return out.name if r.returncode == 0 and out.is_file() else ""


@app.get("/api/whoami")
def whoami(me: dict = Depends(identity)) -> dict:
    return {**me, "project": PROJECT}


# ── Static SPA (must stay last: the catch-all would shadow /api/*) ────────────
_assets = DIST / "assets"
if _assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    candidate = (DIST / path).resolve()
    if path and candidate.is_file() and candidate.is_relative_to(DIST.resolve()):
        return FileResponse(candidate)
    index = DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "note dist not built")
