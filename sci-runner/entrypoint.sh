#!/bin/bash
# Source ROOT + Geant4 + nptool so every simulation the API launches inherits the
# full environment, then start the job API.
set -e
source /opt/root/bin/thisroot.sh
source /opt/geant4/bin/geant4.sh
source /opt/nptool/nptool.sh
exec python3 -m uvicorn --app-dir /opt runner:app --host 0.0.0.0 --port "${SCI_PORT:-8100}"
