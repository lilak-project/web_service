#!/usr/bin/env python3
"""DOCK — the kit's own look (lilak_ui/README.md). Its colour tokens are named
`--dock-<name>`; this finds and renames the old bare `--<name>` uses.

The names come from lilak_ui/src/theme/tokens.js, so there is no second list.

  scripts/dock.py --check [paths…]   list old-name uses; exit 1 if any
  scripts/dock.py --write paths…     rename them in place
  scripts/dock.py --selftest

Paths default to every repo in the stack. A name is renamed only whole:
`--surface` but not `--surface-2` (its own name) nor `--dock-surface`.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "lilak_ui/src/theme/tokens.js"
REPOS = ["lilak_ui", "service_manager", "lilak_elog", "asset_manager", "stark_planner",
         "nptoy", "analysis", "lilak_pipeline", "dummytest", "lilak_rack", "lilak_log", "scripts"]
SKIP = {"node_modules", "dist", "build", "static", ".venv", "venv", ".git", "data", "__pycache__"}
KINDS = {".js", ".jsx", ".mjs", ".ts", ".tsx", ".css", ".html", ".md", ".py"}
# The kit writes the old names itself while they are aliases; the docs name them.
KEEP = {"lilak_ui/src/theme/applyTheme.js", "scripts/dock.py", "lilak_ui/README.md", "scripts/README.md"}


def names():
    src = TOKENS.read_text(encoding="utf8")
    return re.findall(r"^\s+'?([a-z0-9-]+)'?\s*:\s*\{\s*label", src, re.M)


def pattern(ns):
    alt = "|".join(map(re.escape, sorted(set(ns), key=len, reverse=True)))
    return re.compile(rf"(?<![\w-])--({alt})(?![\w-])")


def files(paths):
    for p in paths:
        p = Path(p)
        if p.is_file():
            yield p
            continue
        for f in p.rglob("*"):
            if f.suffix in KINDS and f.is_file() and not SKIP.intersection(f.relative_to(p).parts):
                yield f


def rel(f):
    try:
        return str(f.resolve().relative_to(ROOT))
    except ValueError:
        return str(f)


def main(argv):
    if "--selftest" in argv:
        pat = pattern(["surface", "surface-2", "text-primary"])
        s = "a{color:var(--surface);b:var(--surface-2)} --dock-surface --surfacex x--surface `--text-primary`"
        out = pat.sub(r"--dock-\1", s)
        assert out == "a{color:var(--dock-surface);b:var(--dock-surface-2)} --dock-surface --surfacex x--surface `--dock-text-primary`", out
        print("selftest ok")
        return 0
    write = "--write" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if write and not paths:
        print("--write needs paths", file=sys.stderr)
        return 2
    pat = pattern(names())
    total = 0
    for f in files(paths or [ROOT / r for r in REPOS]):
        if rel(f) in KEEP:
            continue
        try:
            src = f.read_text(encoding="utf8")
        except (UnicodeDecodeError, OSError):
            continue
        n = len(pat.findall(src))
        if not n:
            continue
        total += n
        if write:
            f.write_text(pat.sub(r"--dock-\1", src), encoding="utf8")
        print(f"{n:5}  {rel(f)}")
    print(f"{total} {'renamed' if write else 'old-name uses'}")
    return 1 if total and not write else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
