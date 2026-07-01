"""Scene JSON for the 3D viewer (PLAN §4.4).

Geometry is GDML-driven (gdml.py) — when a run exports a `geometry.gdml` it is
parsed into box/cylinder/sphere volumes automatically. nptool's `npsimulation`
does not export GDML out of the box yet, so geometry is empty until that is added.

Tracks / energy points are extracted from the nptool ROOT output
(`SimulatedTree`: `TrackInfo` = per-particle vertex+momentum, `InteractionCoordinates`
= detector hits). That extraction (via a ROOT macro) is the next step.
"""
from __future__ import annotations

from pathlib import Path

import gdml


def geometry(workdir: Path | None = None) -> list[dict]:
    """GDML geometry for this run if present, else empty (no hand-coded geometry)."""
    if workdir is not None:
        g = workdir / "geometry.gdml"
        if g.exists():
            try:
                return gdml.geometry(g)
            except Exception:
                pass
    return []


def empty(workdir: Path | None = None, n_events: int = 0) -> dict:
    """Geometry (if exported) but no tracks/points yet."""
    return {
        "meta": {"units": "mm", "energy_unit": "MeV", "n_events": n_events,
                 "n_points": 0, "energy_max": 0.0, "pending": True},
        "geometry": geometry(workdir),
        "tracks": [],
        "edep": [],
    }


# Render caps for the live stream.
MAX_TRACKS = 400
MAX_POINTS = 40000


def from_online(workdir: Path) -> dict:
    """Scene from nptool's live stream `online_stream.dat`
    (`evt trk parent pdg charge x y z edep`, mm/MeV) + GDML geometry.

    Tracks are grouped by (event, trackID) into step polylines; energy-deposit
    points are the steps with edep>0. The file is flushed per step and truncated
    each /run/beamOn, so this reads the latest run live — no ROOT close needed."""
    stream = workdir / "online_stream.dat"
    tracks: dict[tuple, dict] = {}
    edep: list[list[float]] = []
    emax = 0.0
    events: set[int] = set()
    if stream.exists():
        for line in stream.read_text().splitlines():
            if not line or line[0] == "#":
                continue
            f = line.split()
            if len(f) != 9:
                continue
            try:
                ev, trk, par, pdg = int(f[0]), int(f[1]), int(f[2]), int(f[3])
                charge = float(f[4])
                x, y, z, e = float(f[5]), float(f[6]), float(f[7]), float(f[8])
            except ValueError:
                continue
            events.add(ev)
            key = (ev, trk)
            t = tracks.get(key)
            if t is None and len(tracks) < MAX_TRACKS:
                t = tracks[key] = {"eventID": ev, "trackID": trk, "pdg": pdg,
                                   "charge": charge, "points": []}
            if t is not None:
                t["points"].append([x, y, z])
            if e > 0 and len(edep) < MAX_POINTS:
                edep.append([x, y, z, e])
                if e > emax:
                    emax = e
    return {
        "meta": {"units": "mm", "energy_unit": "MeV", "n_events": len(events),
                 "n_points": len(edep), "energy_max": emax},
        "geometry": geometry(workdir),
        "tracks": list(tracks.values()),
        "edep": edep,
    }
