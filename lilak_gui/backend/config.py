import os
from pathlib import Path

# Locate LILAK via $LILAK_PATH (injected by the portal manifest's start.env).
# This backend lives outside the LILAK tree, so there is no correct relative
# fallback on every host — fall back to the conventional checkout only for
# standalone dev convenience.
_env = os.environ.get("LILAK_PATH", "").strip()
LILAK_PATH = Path(_env).expanduser().resolve() if _env else (Path.home() / "Research" / "lilak")

LILAK_FOUND = (LILAK_PATH / "macros" / "command_lilak.sh").is_file()
