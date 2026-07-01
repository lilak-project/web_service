"""Per-user editable input workspace (PLAN §4.1, editor phase 0).

Each user has a persistent `inputs/` workspace holding the nptool input files. The
UI exposes only THREE editable slots with friendly names (the real experiment-
specific filenames are hidden), and the run command is general:

    npsimulation -D <detector> -E <reaction> -O <output> -N

`manifest.json` maps each slot → its real file. `project.config` is managed
automatically (its Project name = the account name) and is NOT user-editable; the
unused geant4 `.mac` files are hidden too.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import config

_IGNORE = shutil.ignore_patterns("data", "figures", "__pycache__", "*.root", ".DS_Store")

# Written when a seeded project lacks PhysicsListOption.txt (it is optional in
# nptool) so the Physics-list form always has something to edit.
DEFAULT_PHYSICS = """\
EmPhysicsList                   Option4 % INCLXX_EM Option1 Option2 Option3 Option4 Standard Livermore Penelope

DefaultCutOff                   1 % mm
IonBinaryCascadePhysics         0
NPIonInelasticPhysics           0
EmExtraPhysics                  0
HadronElasticPhysics            0
StoppingPhysics                 0
OpticalPhysics                  0
DriftElectronPhysics            0

HadronPhysicsQGSP_BIC_HP        0
HadronPhysicsQGSP_BERT_HP       0
HadronPhysicsINCLXX             0
HadronPhysicsQGSP_INCLXX_HP     0
HadronPhysicsQGSP_INCLXX        0
HadronPhysicsFTFP_INCLXX_HP     0
HadronPhysicsFTFP_INCLXX        0
Decay                           0

IonGasModels                    0
pai                             0
Menate_R                        0
NeutronHP                       0
Shielding                       0
"""

# The only editable files, shown by friendly label (key → label).
SLOTS = [
    {"key": "physics", "label": "Physics list"},
    {"key": "detector", "label": "Detector"},
    {"key": "reaction", "label": "Reaction"},
]
_SLOT_KEYS = {s["key"] for s in SLOTS}


def root(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "inputs"


def _manifest_path(user_key: str) -> Path:
    return root(user_key) / "manifest.json"


def _discover(ws: Path) -> dict:
    """Map the three slots to the real files inside a freshly-seeded workspace."""
    inp = ws / "input"
    search = inp if inp.exists() else ws
    rel = lambda f: str(f.relative_to(ws)) if f else ""
    first = lambda *pats: next(iter(sorted(g for pat in pats for g in search.glob(pat))), None)
    det = first("*.detector", "*.det")        # filename varies per project
    rea = first("*.reaction", "*.reac")
    phys = ws / "PhysicsListOption.txt"
    return {
        "physics": rel(phys) if phys.exists() else "",
        "detector": rel(det),
        "reaction": rel(rea),
    }


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", (name or "user").strip()) or "user"


def _patch_project_config(ws: Path, project_name: str) -> None:
    """Set the `Project <name>` line in project.config to the account name; leave
    everything else untouched."""
    pc = ws / "project.config"
    if not pc.exists():
        return
    lines = pc.read_text().splitlines()
    for i, ln in enumerate(lines):
        if ln.strip().startswith("Project"):
            lines[i] = f"Project {project_name}"
            break
    pc.write_text("\n".join(lines) + "\n")


def seed(user_key: str, example_key: str, project_name: str | None = None) -> dict:
    """(Re)create the workspace from an example preset."""
    if example_key not in config.PROJECTS:
        raise KeyError(example_key)
    proj = config.PROJECTS[example_key]
    ws = root(user_key)
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(proj["dir"], ws, ignore=_IGNORE)
    (ws / "data").mkdir(exist_ok=True)
    if not (ws / "PhysicsListOption.txt").exists():
        (ws / "PhysicsListOption.txt").write_text(DEFAULT_PHYSICS)
    _patch_project_config(ws, _sanitize(project_name or user_key))
    disc = _discover(ws)   # preset may pin detector/reaction (layouts/extensions vary)
    man = {
        "example": example_key, "output": "output.root", "physics": disc["physics"],
        "detector": proj.get("detector") or disc["detector"],
        "reaction": proj.get("reaction") or disc["reaction"],
    }
    _manifest_path(user_key).write_text(json.dumps(man, indent=2))
    return man


def ensure(user_key: str, project_name: str | None = None) -> dict:
    if not _manifest_path(user_key).exists():
        return seed(user_key, config.DEFAULT_PROJECT, project_name)
    return manifest(user_key)


def manifest(user_key: str) -> dict:
    return json.loads(_manifest_path(user_key).read_text())


def project_name(user_key: str) -> str:
    pc = root(user_key) / "project.config"
    if pc.exists():
        for ln in pc.read_text().splitlines():
            if ln.strip().startswith("Project"):
                return ln.strip().split(None, 1)[1] if len(ln.split()) > 1 else ""
    return ""


def _resolve(user_key: str, slot: str) -> Path:
    if slot not in _SLOT_KEYS:
        raise ValueError("unknown slot")
    rel = manifest(user_key).get(slot)
    if not rel:
        raise ValueError("slot has no file")
    ws = root(user_key).resolve()
    p = (ws / rel).resolve()
    if not str(p).startswith(str(ws) + "/"):
        raise ValueError("path escapes workspace")
    return p


def read_slot(user_key: str, slot: str) -> str:
    return _resolve(user_key, slot).read_text()


def write_slot(user_key: str, slot: str, content: str) -> None:
    _resolve(user_key, slot).write_text(content)


# ── cross-section file (referenced by the reaction's CrossSectionPath) ────────
def _cs_token(user_key: str) -> str:
    try:
        rea = read_slot(user_key, "reaction")
    except Exception:
        return ""
    for ln in rea.splitlines():
        s = ln.strip()
        if s.startswith("CrossSectionPath") and "=" in s:
            toks = s.split("=", 1)[1].split()
            return toks[0] if toks else ""
    return ""


def cs_info(user_key: str) -> dict:
    return {"label": "Cross-section", "path": _cs_token(user_key) or "flat.txt"}


def _cs_file(user_key: str) -> Path:
    tok = _cs_token(user_key) or "flat.txt"
    ws = root(user_key).resolve()
    p = (ws / tok).resolve()
    if not str(p).startswith(str(ws) + "/"):
        raise ValueError("path escapes workspace")
    return p


def cs_candidates(user_key: str) -> list[str]:
    """Cross-section files available in the workspace (for the reaction dropdown)."""
    ws = root(user_key)
    out = set()
    cur = _cs_token(user_key)
    if cur:
        out.add(cur)
    if ws.exists():
        for f in ws.rglob("*.txt"):
            if f.name not in ("PhysicsListOption.txt", "export.txt", "manifest.json"):
                out.add(str(f.relative_to(ws)))
    return sorted(out)


def _named_cs_file(user_key: str, name: str) -> Path:
    ws = root(user_key).resolve()
    p = (ws / name).resolve()
    if not str(p).startswith(str(ws) + "/"):
        raise ValueError("path escapes workspace")
    return p


def read_cs(user_key: str, name: str | None = None) -> str:
    p = _named_cs_file(user_key, name) if name else _cs_file(user_key)
    return p.read_text() if p.exists() else ""


def write_cs(user_key: str, content: str, name: str | None = None) -> None:
    p = _named_cs_file(user_key, name) if name else _cs_file(user_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def prepare_run(user_key: str, dst: Path) -> dict:
    """Copy the current workspace into a run dir and return the manifest."""
    ensure(user_key)
    shutil.copytree(root(user_key), dst,
                    ignore=shutil.ignore_patterns("data", "manifest.json", "*.root", ".DS_Store"))
    (dst / "data").mkdir(exist_ok=True)
    return manifest(user_key)
