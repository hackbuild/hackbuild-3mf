# hackbuild-3mf

Writers and validators for the slicer 3MF dialect hack.build designs export:
the Orca and Bambu project dialect that Flash Studio opens with every
filament slot filled (target `bbs`), plus plain 3MF Core (target `core`).
Split from hackbuild-fab `packages/3mf` and `tools/py` (D-027).
Decision ids (D-nnn) are in hackbuild-fab docs/plan/DECISIONS.md.

| folder | package | what it holds |
|---|---|---|
| `js/` | npm `hackbuild-3mf` | the TypeScript writer, the validator mirror, the artifact hash |
| `py/` | PyPI `hackbuild_3mf` | `validate-3mf` (the reference validator), `orca3mf` (writer), `harvest-filament-keys` |
| `corpus/` | none | the conformance corpus both validators must agree on, with `manifest.json` |

## The dialect

- Every per-filament key of the gold Flash Studio save is written once per
  slot (127 keys per slot, counted from the gold save
  `corpus/gold/hackbuild-coin-nfc.3mf`). A slot takes its non-computed values
  from the preset row its `filament_settings_id` names; rows come from slicer
  saves only.
- `curr_bed_type` comes from the machine preset's `slicer.bedType`
  ("Textured PEI Plate" for ffc5p, owner report 2026-10-05).
- Bytes are reproducible from `SOURCE_DATE_EPOCH`. `artifactHash` is sha256
  over `name NUL sha256(bytes) LF` per entry in sorted order, and the two
  writers agree on it entry by entry.
- Export completeness runs before any byte is written: an unresolved or
  repeated name returns a failing check and no file.

## Use

Not published yet (D-037). Install from a clone:

    npm ci --prefix js && npm run build --prefix js
    uv tool install ./py    # validate-3mf, orca3mf, harvest-filament-keys

    validate-3mf --roundtrip corpus/gold/hackbuild-coin-nfc.3mf
    orca3mf out.3mf body.stl:1 inlay.stl:2 --name coin

The JavaScript API is in `js/README.md`.

After the first release:

    npm install hackbuild-3mf
    uv tool install hackbuild_3mf

## Develop

    npm ci --prefix js && npm run build --prefix js
    npm test --prefix js
    uv run --project py pytest
    uv run --project py corpus/run.py

The first `npm ci --prefix js` in a clone also sets `core.hooksPath` to
`.githooks` through its `prepare` script, so the commit-msg and pre-commit
hooks run on every commit (D-002). Confirm it once per clone with `git config
core.hooksPath`, and never pass `--no-verify`. RULES.md holds the house rules:
people-only authorship with no AI credit anywhere (D-001), no trailers of any
kind (D-002), no emojis, no em or en dashes. CONTRIBUTING.md has the commit
subject format and the PR checklist.

`tools/import-from-fab.sh` rebuilds `js/`, `py/hackbuild_3mf/`, `py/tests/`
and `corpus/` from a hackbuild-fab checkout and its subtree split.
`tools/import-from-fab.sh --check <fab>` rehearses a split of the fab
working tree (every file git does not ignore, committed at
SOURCE_DATE_EPOCH 315532800), imports it into a scratch copy and names every
file that differs from this tree; run it before a release, since a split
older than fab fails its own agreement tests. A split repo named after
`<fab>` is checked instead.

## What is verified, and what is not

### Verified on this machine

- 2026-10-13, after `npm run build --prefix js`: `npm test --prefix js`
  passed 233 of 233 tests (counted). In the full run 229 passed and 4 timed
  out at a load average near 300 (measured); the 4 passed on a rerun by
  name. The legacy read-back test in `js/test/plate-layout.test.ts` ran
  because a hackbuild-fab checkout sat beside this one; without one
  (`HBF_FAB` unset and no `../hackbuild-fab`) it skips.
- 2026-10-13: `uv run --project py pytest` passed 85 of 85 tests (counted),
  with the owner saves under fab-knowledge present, so none skipped. The
  agreement tests import `js/dist`, so the js build runs first.
- 2026-10-13: `uv run --project py corpus/run.py` reached the expected
  verdict on 126 of 126 rows with the two validators agreeing on every row
  (counted), and rewrote `corpus/reports/`.
- 2026-10-13: `npm run check:presets --prefix js` matched 2 saves and 4
  rows (counted), both saves read from `corpus/`.
- 2026-10-13: `tools/import-from-fab.sh --check ../hackbuild-fab` exited 0
  against the fab working tree as it stood that day (no fab commit exists).

### Checked by machine on geometry

- none at the package level

### Measured on a printed body

None. No export of this writer has been printed.

### Not verified by anything

- Installation from the registries: nothing is published until the owner
  clears D-037.
- The `core` target in any slicer.

## Licence

Each path takes the licence of the first row that matches it:

| paths | what | licence |
|---|---|---|
| `corpus/known-bad/**`, `corpus/reports/**` | failure corpus | CC-BY-4.0 (`LICENSES/CC-BY-4.0.txt`) |
| `corpus/owner/**`, `corpus/legacy/**`, `corpus/boss/**`, `corpus/sprue/**`, `corpus/gold/**` | printable designs by the owner | CC-BY-SA-4.0 (`LICENSES/CC-BY-SA-4.0.txt`) |
| `*.md` | this README, `CHANGELOG.md` and the other docs | CC-BY-4.0, with the code samples inside them also MIT |
| everything else | code, tests, corpus inputs and scripts | MIT (`LICENSE`) |

The hack.build name and logo are outside every grant (`TRADEMARKS.md`).
