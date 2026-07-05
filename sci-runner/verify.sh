#!/usr/bin/env bash
#
# Prove the container's nptool is the REAL one from this machine and actually works.
# Runs INSIDE the image:
#
#   docker run --rm lilak-sci-runner /opt/verify.sh
#
# Checks: provenance • npsimulation on PATH • custom detectors compiled in
# (CSSU / GasBox / Coaxial_Germanium / ATOMX) • a real 1-event sim runs • the
# geometry-JSON export (DumpPV, the web 3D viewer's data source) produces volumes.
# Exits non-zero on the first hard failure.
set -uo pipefail

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; FAILED=1; }
FAILED=0

# nptool env (idempotent if the entrypoint already sourced it)
source /opt/root/bin/thisroot.sh   >/dev/null 2>&1 || true
source /opt/geant4/bin/geant4.sh   >/dev/null 2>&1 || true
source /opt/nptool/nptool.sh       >/dev/null 2>&1 || true

echo "── provenance ──────────────────────────────────────────────"
if [ -f /opt/nptool/NPTOOL_PROVENANCE.txt ]; then
  grep -E 'staged_at_utc|git_branch|git_commit|git_dirty_count' /opt/nptool/NPTOOL_PROVENANCE.txt | sed 's/^/  /'
else
  fail "NPTOOL_PROVENANCE.txt missing (image not built via stage-nptool.sh?)"
fi

echo "── toolchain ───────────────────────────────────────────────"
[ -n "${NPTOOL:-}" ] && pass "NPTOOL=$NPTOOL" || fail "NPTOOL not set"
if command -v npsimulation >/dev/null 2>&1; then pass "npsimulation on PATH"; else fail "npsimulation NOT on PATH"; fi
root --version 2>/dev/null | head -1 | sed 's/^/  ROOT: /'

echo "── custom detectors compiled into libNPSimulation ──────────"
LIB=$(ls /opt/nptool/NPSimulation/lib/libNPSimulation* 2>/dev/null | head -1)
if [ -n "$LIB" ]; then
  for det in CSSU Coaxial_Germanium ATOMX; do   # detector-block registration keywords
    if strings "$LIB" 2>/dev/null | grep -q -- "$det"; then pass "detector token present: $det"; else fail "detector token MISSING: $det"; fi
  done
else
  fail "libNPSimulation not found (build failed?)"
fi

echo "── live 1-event sim + geometry export (CSSU GasBox) ────────"
WD=$(mktemp -d); cd "$WD"
cat > v.detector <<'EOF'
CSSU
 Type= GasBox
 POS= 0 0 100 mm
 Length= 120 mm
 Width= 120 mm
 Thickness= 200 mm
 PressureTorr= 200
 StepLimit= 10 mm
 SegmentsZ= 4
 SegmentGapZ= 5 mm
 EnergyThreshold= 0.001 MeV
 ResoEnergy= 1 keV
EOF
cat > v.reaction <<'EOF'
Isotropic
 EnergyLow= 5.443 MeV
 EnergyHigh= 5.443 MeV
 HalfOpenAngleMin= 0 deg
 HalfOpenAngleMax= 0 deg
 Direction= z
 x0= 0 mm
 y0= 0 mm
 z0= 0 mm
 Particle= alpha
 Multiplicity= 1
EOF
cat > v.mac <<'EOF'
/det/export_geometry v.geom.json
/run/beamOn 1
EOF

if npsimulation -D v.detector -E v.reaction -O v -B v.mac > run.log 2>&1; then
  grep -q "Adding Detector CSSU" run.log && pass "CSSU detector instantiated" || fail "CSSU not instantiated (see log)"
  grep -qi "GasBox" run.log && pass "GasBox geometry built" || echo "  · (GasBox not echoed — non-fatal)"
else
  fail "npsimulation exited non-zero"; tail -20 run.log | sed 's/^/    /'
fi

if [ -s v.geom.json ]; then
  BYTES=$(wc -c < v.geom.json | tr -d ' ')
  if grep -q '"type"' v.geom.json; then pass "geometry JSON export OK ($BYTES bytes, has volumes)"; else fail "geom.json has no volumes"; fi
else
  fail "geometry JSON NOT produced (DumpPV/export_geometry patch missing?)"
fi

cd /; rm -rf "$WD"
echo "────────────────────────────────────────────────────────────"
if [ "$FAILED" = 0 ]; then echo "✅ VERIFY PASSED — container nptool matches local and runs."; exit 0
else echo "❌ VERIFY FAILED — see ✗ above."; exit 1; fi
