"""
Icon Lab — admin-only endpoints backing the in-portal icon editor.

The editor composes the final SVG client-side; the backend just (a) persists the
design so it survives a reload, (b) writes a composed SVG to the live favicon
files, and (c) writes the app-icon source + rebuilds the macOS .icns when the
render toolchain is present (dev machine; skipped gracefully elsewhere).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from .. import config, models
from ..deps import require_portal_admin

router = APIRouter(tags=["iconlab"], prefix="/api/admin/iconlab")

SM = config.ROOT             # the service_manager repo (contains app/)
STACK = SM.parent            # web_service/ — holds lilak_elog/ alongside us
CFG_PATH = config.DATA_ROOT / "_portal" / "iconlab.json"
PRESETS_PATH = config.DATA_ROOT / "_portal" / "iconlab_presets.json"
MAX_PRESETS = 10

# Common tool locations — needed because a macOS .app / launcher starts the portal
# with a stripped PATH (often just /usr/bin:/bin), so shutil.which misses Homebrew.
_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]


def _tool(name: str) -> str | None:
    """Resolve an executable by PATH, falling back to common install dirs."""
    found = shutil.which(name)
    if found:
        return found
    for d in _TOOL_DIRS:
        cand = Path(d) / name
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


def _tool_env() -> dict:
    """Env with the common tool dirs prepended to PATH (for child scripts that
    call rsvg-convert / sips / iconutil by bare name)."""
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(_TOOL_DIRS + [env.get("PATH", "")])
    return env


def _favicon_targets() -> list[Path]:
    """Every served favicon file that exists (portal + elog, public + dist)."""
    cands = [
        SM / "frontend" / "public" / "lilak.svg",
        SM / "frontend" / "dist" / "lilak.svg",
        STACK / "lilak_elog" / "frontend" / "public" / "lilak.svg",
        STACK / "lilak_elog" / "frontend" / "dist" / "lilak.svg",
    ]
    return [p for p in cands if p.parent.is_dir()]


def _check_svg(svg: str) -> str:
    s = (svg or "").strip()
    if not s.startswith("<svg") or "</svg>" not in s or len(s) > 200_000:
        raise HTTPException(400, "유효한 SVG가 아닙니다.")
    if "<script" in s.lower():
        raise HTTPException(400, "SVG에 스크립트를 포함할 수 없습니다.")
    return s


class SvgBody(BaseModel):
    svg: str


@router.get("/config")
def get_config(_: models.User = Depends(require_portal_admin)):
    if CFG_PATH.is_file():
        try:
            return {"config": json.loads(CFG_PATH.read_text(encoding="utf-8"))}
        except Exception:
            pass
    return {"config": None}


@router.put("/config")
def put_config(body: dict, _: models.User = Depends(require_portal_admin)):
    cfg = body.get("config", body)
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


@router.get("/presets")
def get_presets(_: models.User = Depends(require_portal_admin)):
    if PRESETS_PATH.is_file():
        try:
            data = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
            return {"presets": (data.get("presets", data) if isinstance(data, dict) else data)[:MAX_PRESETS]}
        except Exception:
            pass
    return {"presets": []}


@router.put("/presets")
def put_presets(body: dict, _: models.User = Depends(require_portal_admin)):
    presets = body.get("presets", [])
    if not isinstance(presets, list):
        raise HTTPException(400, "presets must be a list")
    presets = presets[:MAX_PRESETS]
    PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PRESETS_PATH.write_text(json.dumps({"presets": presets}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "count": len(presets)}


@router.post("/favicon")
def make_favicon(body: SvgBody, _: models.User = Depends(require_portal_admin)):
    svg = _check_svg(body.svg)
    wrote = []
    for p in _favicon_targets():
        p.write_text(svg, encoding="utf-8")
        try:
            wrote.append(str(p.relative_to(STACK)))
        except ValueError:
            wrote.append(str(p))
    return {"ok": True, "wrote": wrote}


@router.post("/header")
def make_header(body: SvgBody, _: models.User = Depends(require_portal_admin)):
    """Write the portal header mark (shown next to the 'LILAK Web Portal' title).
    Served at /lilak-header.svg; the cover falls back to the kit logo if absent."""
    svg = _check_svg(body.svg)
    wrote = []
    for p in [SM / "frontend" / "public" / "lilak-header.svg", SM / "frontend" / "dist" / "lilak-header.svg"]:
        if p.parent.is_dir():
            p.write_text(svg, encoding="utf-8")
            wrote.append(p.name)
    return {"ok": True, "wrote": wrote}


@router.post("/export")
def export_vector(body: dict, _: models.User = Depends(require_portal_admin)):
    """Convert the composed SVG to PDF or EPS via rsvg-convert and return the file.
    (PNG/SVG are produced client-side; PDF/EPS need the vector toolchain.)"""
    svg = _check_svg(body.get("svg", ""))
    fmt = (body.get("fmt") or "pdf").lower()
    if fmt not in ("pdf", "eps"):
        raise HTTPException(400, "fmt must be 'pdf' or 'eps'")
    rsvg = _tool("rsvg-convert")
    if not rsvg:
        raise HTTPException(503, "rsvg-convert가 설치되어 있지 않아 PDF/EPS 변환을 할 수 없습니다. (brew install librsvg)")
    with tempfile.TemporaryDirectory() as td:
        ip, op = Path(td) / "in.svg", Path(td) / f"out.{fmt}"
        ip.write_text(svg, encoding="utf-8")
        r = subprocess.run([rsvg, "-f", fmt, "-w", "512", "-h", "512", "--keep-aspect-ratio",
                            str(ip), "-o", str(op)], capture_output=True, text=True, timeout=30)
        if r.returncode != 0 or not op.exists():
            raise HTTPException(500, (r.stderr or "변환 실패").strip()[-300:])
        data = op.read_bytes()
    media = "application/pdf" if fmt == "pdf" else "application/postscript"
    return Response(content=data, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="lilak-icon.{fmt}"'})


class WebIconBody(BaseModel):
    svg: str
    bg: Optional[str] = "#EBEBEA"
    name: Optional[str] = "LILAK Portal"


@router.post("/webicon")
def make_webicon(body: WebIconBody, _: models.User = Depends(require_portal_admin)):
    """Cross-platform "install as app" (PWA) icons: PNGs + a web manifest written
    next to the portal's index.html. Works on Linux + mac via rsvg-convert (unlike
    the mac-only .icns)."""
    svg = _check_svg(body.svg)
    rsvg = _tool("rsvg-convert")
    if not rsvg:
        raise HTTPException(503, "rsvg-convert가 없어 PNG 아이콘을 만들 수 없습니다. (apt: librsvg2-bin / brew: librsvg)")
    dirs = [d for d in (SM / "frontend" / "public", SM / "frontend" / "dist") if d.is_dir()]
    if not dirs:
        raise HTTPException(500, "frontend public/dist 디렉터리가 없습니다.")
    sizes = {"icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180}
    wrote = []
    with tempfile.TemporaryDirectory() as td:
        ip = Path(td) / "in.svg"
        ip.write_text(svg, encoding="utf-8")
        for fname, sz in sizes.items():
            op = Path(td) / fname
            r = subprocess.run([rsvg, "-w", str(sz), "-h", str(sz), str(ip), "-o", str(op)],
                               capture_output=True, text=True, timeout=30)
            if r.returncode != 0 or not op.exists():
                raise HTTPException(500, (r.stderr or "PNG 변환 실패").strip()[-300:])
            data = op.read_bytes()
            for d in dirs:
                (d / fname).write_bytes(data)
            wrote.append(fname)
    manifest = {
        "name": (body.name or "LILAK Portal"), "short_name": "LILAK",
        "start_url": "/projects", "scope": "/", "display": "standalone",
        "background_color": (body.bg or "#EBEBEA"), "theme_color": (body.bg or "#EBEBEA"),
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    mtext = json.dumps(manifest, ensure_ascii=False, indent=2)
    for d in dirs:
        (d / "manifest.webmanifest").write_text(mtext, encoding="utf-8")
    wrote.append("manifest.webmanifest")
    return {"ok": True, "wrote": wrote}


@router.post("/appicon")
def make_appicon(body: SvgBody, _: models.User = Depends(require_portal_admin)):
    svg = _check_svg(body.svg)
    icon_svg = SM / "deploy" / "app-icon.svg"
    icon_svg.parent.mkdir(parents=True, exist_ok=True)
    icon_svg.write_text(svg, encoding="utf-8")

    script = SM / "deploy" / "make-mac-app.sh"
    rebuilt, detail = False, "app-icon.svg 저장됨"
    if script.is_file() and _tool("rsvg-convert") and _tool("iconutil"):
        try:
            env = dict(_tool_env(), APP_DEST=str(Path.home() / "Applications"))
            r = subprocess.run(["bash", str(script)], cwd=str(SM), env=env,
                               capture_output=True, text=True, timeout=120)
            rebuilt = r.returncode == 0
            tail = (r.stdout if rebuilt else (r.stderr or r.stdout)) or ""
            detail = tail.strip()[-300:]
        except Exception as e:
            detail = str(e)
    else:
        detail = "이 환경엔 .icns 재생성 도구가 없어 SVG만 저장했습니다."
    return {"ok": True, "icns_rebuilt": rebuilt, "detail": detail}
