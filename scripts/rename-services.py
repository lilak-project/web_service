#!/usr/bin/env python3
"""Rename rack services in a portal's data: folders, links, settings, DB.

    python3 scripts/rename-services.py --data ~/web_service/data            # dry run: what would change
    python3 scripts/rename-services.py --data ~/web_service/data --apply    # do it (stop the services first)

The renames (2026-11-21): academic_activities -> activities,
author_manager -> authors, asset_manager2 -> inventory. The old asset_manager
is another service and is not touched.

What changes, by the same few rules everywhere so nothing is renamed by guess:
  - data/<old>/ moves to data/<new>/; its manifest's paths (lilak_rack/<old>)
    follow; its .port/.pid go (the old process is not the new one's).
  - JSON files under data/ (records, home.json, groups, share sets, inbox):
    the id as a whole JSON string ("old"), as the head of one ("old/proj"),
    and in a portal path (/pp/old/, /p/old/).
  - Markdown (note bodies): portal paths only. A note that says the old name
    in prose keeps it: that is what was written then.
  - portal.db: every text column, by the JSON rules, a value that IS the id or
    starts "old/", and the MCP scopes' comma lists.
  - sync.json / sync-pending.json are set aside as *.paused-rename: the other
    side still has the old name until it is renamed too; link again after.
Backups, *.bak-* files and the _backups folder are left alone.
"""
import argparse
import json
import re
import sqlite3
from pathlib import Path

RENAMES = {"academic_activities": "activities", "author_manager": "authors", "asset_manager2": "inventory"}


def rules(old, new):
    o = re.escape(old)
    # Not followed by a name character, so asset_manager2 never touches asset_manager2x
    # and the old asset_manager (a different service) is never matched at all.
    end = r"(?![A-Za-z0-9_])"
    return {
        "json": [(re.compile(rf'"{o}(?=["/])'), f'"{new}'),
                 (re.compile(rf"/(pp?)/{o}/"), rf"/\1/{new}/"),
                 (re.compile(rf"lilak_rack/{o}{end}"), f"lilak_rack/{new}")],
        "md": [(re.compile(rf"/(pp?)/{o}/"), rf"/\1/{new}/")],
        "scope": [(re.compile(rf"(^|[,\s]){o}(?=$|[,/\s])"), rf"\1{new}")],
    }


RULES = {old: rules(old, new) for old, new in RENAMES.items()}


def sub_all(text, kind):
    n = 0
    for r in RULES.values():
        for pat, rep in r[kind]:
            text, k = pat.subn(rep, text)
            n += k
    return text, n


def skipped(p: Path, data: Path):
    rel = p.relative_to(data).parts
    return rel[0] == "_backups" or ".bak-" in p.name or p.name.endswith((".paused-rename", ".pre-split", ".before-restore"))


def files(data: Path, apply: bool, report: dict):
    for p in sorted(data.rglob("*")):
        if not p.is_file() or skipped(p, data) or p.suffix not in (".json", ".jsonl", ".md"):
            continue
        if p.name in ("sync.json", "sync-pending.json") and p.parent.name in RENAMES:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new, n = sub_all(text, "md" if p.suffix == ".md" else "json")
        if n:
            top = p.relative_to(data).parts[0]
            report.setdefault(top, [0, 0])
            report[top][0] += 1
            report[top][1] += n
            if apply:
                p.write_text(new, encoding="utf-8")


def folders(data: Path, apply: bool, out: list):
    for old, new in RENAMES.items():
        src, dst = data / old, data / new
        if not src.exists():
            out.append(f"  {old}: no folder (already moved?)")
            continue
        if dst.exists():
            raise SystemExit(f"refusing: {dst} already exists")
        gone = [f for f in (".port", ".pid") if (src / f).exists()]
        paused = [f for f in ("sync.json", "sync-pending.json") if (src / f).exists()]
        out.append(f"  data/{old} -> data/{new}" + (f"; drop {', '.join(gone)}" if gone else "")
                   + (f"; pause {', '.join(paused)}" if paused else ""))
        if apply:
            for f in gone:
                (src / f).unlink()
            for f in paused:
                (src / f).rename(src / f"{f}.paused-rename")
            src.rename(dst)


def database(db: Path, apply: bool, out: list):
    con = sqlite3.connect(db)
    total = 0
    for (table,) in con.execute("select name from sqlite_master where type='table'").fetchall():
        cols = [r[1] for r in con.execute(f'pragma table_info("{table}")') if (r[2] or "").upper().startswith(("VARCHAR", "TEXT", "JSON")) or r[2] == ""]
        if not cols:
            continue
        rows = con.execute(f'select rowid, {", ".join(f"[{c}]" for c in cols)} from "{table}"').fetchall()
        n_table = 0
        for row in rows:
            rowid, vals = row[0], row[1:]
            changes = {}
            for c, v in zip(cols, vals):
                if not isinstance(v, str):
                    continue
                nv = v
                for old, new in RENAMES.items():
                    if nv == old:
                        nv = new
                    elif nv.startswith(old + "/"):
                        nv = new + nv[len(old):]
                nv, _ = sub_all(nv, "scope" if c == "scope" else "json")
                if nv != v:
                    changes[c] = nv
            if changes:
                n_table += 1
                if apply:
                    sets = ", ".join(f"[{c}] = ?" for c in changes)
                    con.execute(f'update "{table}" set {sets} where rowid = ?', (*changes.values(), rowid))
        if n_table:
            out.append(f"  {table}: {n_table} rows")
            total += n_table
    if apply:
        con.commit()
    con.close()
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    data = a.data.expanduser().resolve()
    print(("APPLY" if a.apply else "DRY RUN") + f" in {data}")
    for old, new in RENAMES.items():
        print(f"  {old} -> {new}")
    report, out = {}, []
    files(data, a.apply, report)          # before the folders move, so the paths read are the old ones
    print("\nfiles (folder: files changed, places):")
    for top, (nf, n) in sorted(report.items()):
        print(f"  {top}: {nf} files, {n} places")
    print("\nportal.db:")
    db_out = []
    database(data / "_portal" / "portal.db", a.apply, db_out)
    print("\n".join(db_out) or "  nothing")
    folders(data, a.apply, out)
    print("\nfolders:")
    print("\n".join(out))


if __name__ == "__main__":
    main()
