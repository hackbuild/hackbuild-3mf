"""hackbuild_3mf: the Orca and Bambu dialect 3MF writer, validator and key harvester.

Modules: validate_3mf (validator, the reference for the TypeScript mirror),
orca3mf (writer), harvest_filament_keys (per-filament key harvest).
"""

import sys
from pathlib import Path

# The modules import each other by bare name, as they run in hackbuild-fab.
sys.path.insert(0, str(Path(__file__).resolve().parent))

__version__ = "0.1.0"
