# Changelog

Versions follow semver. npm `hackbuild-3mf` and PyPI `hackbuild_3mf` publish
from one tag `v<version>` (D-027).

## 0.1.0 (unreleased, publish pending D-037)

- js: the Orca and Bambu dialect writer (`bbs`, the default target) with the
  per-slot filament template of the gold save, every per-filament key written
  once per slot, and a 3MF Core target with one colorgroup entry per filament.
- js and py: `curr_bed_type` written from the machine preset's
  `slicer.bedType` ("Textured PEI Plate" for ffc5p).
- js and py: reproducible bytes from `SOURCE_DATE_EPOCH`, artifactHash over
  sorted entry names and entry sha256 values, export completeness before any
  byte is written.
- js: the validator mirror of `validate_3mf.py` (CHK-3MF-01, 02, 03, 06, 07,
  CHK-PRT-01, CHK-PRT-03, export completeness).
- py: `validate-3mf`, `orca3mf` and `harvest-filament-keys` console entry
  points.
- corpus: the conformance corpus from hackbuild-fab with its manifest; the
  gold round trip, known-bad fixtures, BOSS exports, owner saves and legacy
  exports.
