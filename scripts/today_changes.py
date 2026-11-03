#!/usr/bin/env python3
"""What changed on one day, for the daily digest note. Reads data/ only.

    scripts/today_changes.py [YYYY-MM-DD]    # default: today, local time
    scripts/today_changes.py --check         # self-check on a throwaway folder

A note wearing #agent/… is an agent's, any other the owner's. A rack record has
no per-record author, so records are listed without one.
ponytail: a note's day is its file's mtime, so a sync that rewrites a file counts
as a change; compare against the sync's stamps if that turns out noisy.
"""
import json
import re
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote

DATA = Path(__file__).resolve().parents[1] / "data"
# The list ?solo= opens, per service; a record of any other list has no page of its own.
ITEMS = {"academic_activities": "activities", "author_manager": "authors", "reference_manager": "references",
         "asset_manager2": "assets", "project_manager": "projects"}
NAME_KEYS = ("name", "title", "citeKey", "engName", "assetId", "id")
CAP = 30   # a bulk edit touches hundreds; the digest wants the count, not the list


def local_day(stamp):
    """The local date of an ISO stamp, '' if it is not one."""
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone().date().isoformat()
    except ValueError:
        return ""


def notes(root, day):
    out = {"owner": [], "agent": []}
    for p in sorted(root.glob("projects/note/notes/*.md")):
        if datetime.fromtimestamp(p.stat().st_mtime).date().isoformat() != day:
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        m = re.match(r"---\n(.*?)\n---\n", text, re.S)
        head, body = (m.group(1), text[m.end():]) if m else ("", text)
        if re.search(r"(^|\s)#digest(\s|$)", body):
            continue
        title = re.search(r"^title:\s*(.+)$", head, re.M)
        made = re.search(r"^date:\s*(\S+)$", head, re.M)
        lines = [ln.strip() for ln in body.splitlines() if ln.strip() and not re.fullmatch(r"[%\s]*(#\S+\s*)+", ln.strip())]
        who = "agent" if re.search(r"(^|\s)#agent/\S", body) else "owner"
        out[who].append({"id": p.stem, "title": title.group(1).strip("'\"") if title else p.stem,
                         "new": bool(made) and made.group(1) == day, "first": lines[0][:100] if lines else ""})
    return out


def records(root, day):
    out = {}
    svc = root.name
    for f in sorted(root.glob("projects/*/data/*/*.json")):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(r, dict) or local_day(r.get("updatedAt")) != day:
            continue
        name = next((str(r[k]) for k in NAME_KEYS if r.get(k)), f.stem)
        row = {"name": name[:80], "new": local_day(r.get("createdAt")) == day}
        rid = r.get("assetId") if svc == "asset_manager2" else r.get("id")
        if f.parent.name == ITEMS.get(svc) and rid:
            row["link"] = f"/pp/{svc}/{f.parents[2].name}/?solo={quote(str(rid), safe='')}"
        out.setdefault(f.parent.name, []).append(row)
    return {k: {"count": len(v), "items": v[:CAP]} for k, v in out.items()}


def collect(day, data=DATA):
    return {"day": day, "notes": notes(data / "note", day),
            "services": {s: c for s in ITEMS if (c := records(data / s, day))}}


def check():
    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        n = t / "note/projects/note/notes"
        n.mkdir(parents=True)
        (n / "a.md").write_text("---\ntitle: 에이전트\ndate: 2000-01-01\n---\n\n#x #agent/rack\n\n본문\n", encoding="utf-8")
        (n / "b.md").write_text("---\ntitle: 내 것\ndate: 2000-01-01\n---\n\n둘째\n", encoding="utf-8")
        (n / "c.md").write_text("---\ntitle: Digest\ndate: 2000-01-01\n---\n\n#digest\n", encoding="utf-8")
        today = date.today().isoformat()
        r = t / "project_manager/projects/p/data/projects"
        r.mkdir(parents=True)
        (r / "1.json").write_text(json.dumps({"id": "a b", "name": "오늘", "updatedAt": datetime.now().astimezone().isoformat()}), encoding="utf-8")
        (r / "2.json").write_text(json.dumps({"name": "옛날", "updatedAt": "2000-01-01T00:00:00Z"}), encoding="utf-8")
        got = collect(today, t)
        assert [x["title"] for x in got["notes"]["agent"]] == ["에이전트"], got
        assert got["notes"]["agent"][0]["first"] == "본문", got
        assert [x["title"] for x in got["notes"]["owner"]] == ["내 것"], got
        got_p = got["services"]["project_manager"]["projects"]
        assert got_p["count"] == 1, got
        assert got_p["items"][0]["link"] == "/pp/project_manager/p/?solo=a%20b", got
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        check()
    else:
        day = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
        print(json.dumps(collect(day), ensure_ascii=False, indent=1))
