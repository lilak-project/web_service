#!/usr/bin/env python3
"""RACK — the portal's screen vocabulary. Keeps RACK.md's inventory honest.

The point is not the list, it is the DRIFT: when a RACK rule changes, every
screen on the rack has to be walked, and a screen nobody wrote down is a
screen nobody walks.

  scripts/rack.py            print the inventory
  scripts/rack.py --check    exit 1 if RACK.md has drifted (a screen added,
                             removed, or filed under no nameplate)
  scripts/rack.py --write    rewrite RACK.md's table, keeping the hand-set
                             nameplate column
  scripts/rack.py --selftest the classifier's own check
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "frontend/src/pages"
DOC = PAGES / "portal/RACK.md"
BEGIN, END = "<!-- rack:begin -->", "<!-- rack:end -->"

# component  → the part's RACK name          CSS class → the same
PARTS = [("Panel", "모듈"), ("Field", "표"), ("FieldActions", "표"),
         ("Row", "채널"), ("Pill", "표시등")]
CLASSES = [("set-panel", "모듈"), ("set-bar", "명판"), ("set-card", "표"),
           ("set-row", "채널"), ("set-pill", "표시등")]
IMPORT = re.compile(r"""from\s+['"][^'"]*Field['"]""")


def parts_of(src):
    """Which RACK parts a source file uses, and whether it rolls its own markup."""
    found = []
    imported = bool(IMPORT.search(src))
    if imported:
        names = ",".join(re.findall(r"import\s*\{([^}]*)\}\s*from\s*['\"][^'\"]*Field['\"]", src))
        found += [k for c, k in PARTS if re.search(rf"\b{c}\b", names)]
    found += [k for c, k in CLASSES if c in src]
    # A file that paints RACK classes without importing the parts has copied the
    # markup: it will NOT follow when Field.jsx changes.
    return sorted(set(found), key="모듈 명판 표 채널 표시등".split().index), (bool(found) and not imported)


SOURCE = {"portal/Field.jsx"}        # the rack itself, not a screen on it


def scan():
    out = {}
    for p in sorted(PAGES.rglob("*.jsx")):
        if str(p.relative_to(PAGES)) in SOURCE:
            continue
        used, handrolled = parts_of(p.read_text())
        if used:
            out[str(p.relative_to(PAGES))] = (used, handrolled)
    return out


def table(rows, plates):
    lines = ["| 화면 | 명판 | 부품 |", "|---|---|---|"]
    for path, (used, hand) in rows.items():
        mark = " ⚠직접마크업" if hand else ""
        lines.append(f"| `{path}` | {plates.get(path, '?')} | {'·'.join(used)}{mark} |")
    return "\n".join(lines)


def read_doc():
    """The nameplate each screen is filed under, as RACK.md has it."""
    if not DOC.exists():
        return {}, ""
    text = DOC.read_text()
    body = text.split(BEGIN)[1].split(END)[0] if BEGIN in text else ""
    plates = {}
    for line in body.strip().splitlines()[2:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) >= 2:
            plates[cells[0].strip("`")] = cells[1]
    return plates, text


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--selftest":
        used, hand = parts_of("import { Panel, Row } from './Field'\n<div className='set-pill'>")
        assert used == ["모듈", "채널", "표시등"] and not hand, used
        used, hand = parts_of("<div className='set-panel'>")
        assert used == ["모듈"] and hand
        assert parts_of("nothing here") == ([], False)
        print("ok")
        return 0

    rows = scan()
    plates, text = read_doc()
    if arg == "--write":
        new = f"{BEGIN}\n\n{table(rows, plates)}\n\n{END}"
        DOC.write_text(re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), lambda _: new, text, flags=re.S))
        print(f"{DOC.relative_to(ROOT)}: {len(rows)} screens")
        return 0

    print(table(rows, plates))
    if arg == "--check":
        gone = [p for p in plates if p not in rows]
        new = [p for p in rows if p not in plates]
        unfiled = [p for p in rows if plates.get(p, "?") == "?"]
        hand = [p for p, (_, h) in rows.items() if h]
        bad = False
        for label, items in (("RACK.md에만 있음", gone), ("RACK.md에 없음", new),
                             ("명판 미정", unfiled), ("부품 대신 직접 마크업", hand)):
            if items:
                bad = True
                print(f"\n{label}:", *("  " + i for i in items), sep="\n", file=sys.stderr)
        if bad:
            print("\nscripts/rack.py --write 로 표를 갱신하고 명판을 채우세요.", file=sys.stderr)
            return 1
        print("\nRACK.md 와 일치합니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
