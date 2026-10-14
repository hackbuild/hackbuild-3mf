# hackbuild-3mf

The slicer dialect: writer, validator mirror, artifact hash. Split from
hackbuild-fab `packages/3mf` (D-027). Code MIT; this README CC-BY-4.0 with
the code samples also MIT.

    npm install hackbuild-3mf

## Writer

`src/writer/` is the TypeScript port of the seed `orca3mf.js` (M00-T07). It
keeps the seed's public shape:

    import { build, stl, printCard } from "hackbuild-3mf";

    const out = build({
      filaments: [{ color: "#1A1A1A", type: "PETG" }, { color: "#FE0386", type: "PLA" }],
      printer: { printer_settings_id: "Flashforge Creator 5 Pro 0.4 nozzle",
                 print_settings_id: "0.24mm Standard @FF C5", curr_bed_type: "Textured PEI Plate" },
      presetPattern: "Generic {TYPE} @FF C5P",
      sourceDateEpoch: 1791072000,
      chase: "collar-coin", buildHash: "...",
      objects: [{ name: "coin", positions: [[128, 128, 0]],
                  parts: [{ name: "body", slot: 1, positions, indices }] }],
    });
    if (out.ok) { await out.zip(); await out.stlZip(); out.card(); }
    else out.completeness; // CHK-ART-01 fail, no bytes

- Target `bbs` (default) is the Orca and Bambu dialect Flash Studio opens as
  a project (D-159). Every per-filament key of the gold save is written once
  per slot. A slot takes the non-computed keys from the preset row its
  `filament_settings_id` names; rows come from slicer saves only, harvested
  into `data/filament_presets.json` by `scripts/harvest-presets.mjs`
  (`--check` fails on drift). A TPU slot borrows the `Generic PETG @FF C5P`
  row at tier inferred and raises `TPU preset row inferred` until a slicer
  save holds `Generic TPU @FF C5P` (PROFILE.md 8.1).
- With no `printer`, the build writes the machine preset in
  `data/default_preset.json`: printer, process, filament pattern, plate and
  nozzle of one row of hackbuild-fab `packages/profile/data/machines.json`,
  kept equal to it by the agreement test. An unknown filament type or
  preset id is refused with E_REF and up to 3 `didYouMean` ids by edit
  distance.
- Target `core` is plain 3MF Core with one Materials colorgroup entry per
  filament and every triangle pointing at its slot.
- Bytes are reproducible from `sourceDateEpoch` (D-052): model dates and zip
  mtimes from the epoch, clamped to 1980-01-01, no directory entries, names
  in sorted byte order, DEFLATE level 6. Nothing in `src/` reads a clock.
- Coordinates print as `toFixed(10)` with trailing zeros stripped and `-0`
  written `0`, exact for meshes on the 1/1024 mm grid (D-054).
- `artifactHash` is sha256 over `name NUL sha256(bytes) LF` for each entry in
  sorted order, with the model dates blanked. Text entries and member names
  are UTF-8 through spec `utf8Bytes` (D-206) with a lone surrogate written
  U+FFFD, and the zip receives those bytes, so the hash is over the bytes
  the zip holds whichever encoder the runtime gives JSZip.
- `Metadata/hackbuild_chase.json` holds `{"buildHash", "chase"}` as RFC 8785
  canonical JSON.
- Export completeness (CHK-ART-01, `export-completeness` in M00) runs before
  any byte: unresolved or repeated names return a failing CheckResult and no
  file.

- `License` (bbs) or `LicenseTerms` (core) carries `license`, the chase's
  SPDX id. `Designer` and `Copyright` come from `designer`, the name part of
  the root package.json author (`authorName`), with Copyright as
  `Copyright (c) <UTC year of sourceDateEpoch> <Designer>`; both stay empty
  when `designer` is absent, and an AI or tool name is refused (D-001,
  LICENSING.md 1.4, `src/metadata.ts`).

## Reader

`readEntries`, `zipMemberNames` and `validateZip` read every 3MF and STL zip
through `src/validate/reader.ts` under D-166 (ARCHITECTURE.md 11.1). An
entry name with a `..` segment, a leading `/` or `\` or a drive letter, more
than 4096 entries, or a total inflated size over 256 MiB counted while
inflating is refused with E_SCHEMA, record `3mf-reader/<rule>`; a file that
is not a readable zip is refused with rule `zip`. The header sizes are never
trusted. `test/reader.fuzz.prop.test.ts` is the TESTING.md 4.2.1 fuzz job.

`write3mf` and `threeMfEntries` take the typed input `core` builds from Part
IR and a machine preset; they throw a command error where `build` returns
the failing check.

## Mesh audit

`src/mesh.ts` holds `MeshData`, `signedVolume` and the CHK-PRT-01 `audit`
the validator mirror runs, so the package loads no wasm and depends on no
mesh library. hackbuild-fab keeps a second copy of this code in its mesh
package and tests that the two agree; this repository carries only this one.

## What is verified, and what is not

### Verified on this machine

- 2026-10-05: `npm test -w packages/3mf` passes in hackbuild-fab, including the gold key set
  read from `corpus/gold/hackbuild-coin-nfc.3mf`, column by column
  agreement with the gold on every non-computed key when the slots name the
  gold's three presets, and equal sha256 under `TZ=UTC` and
  `TZ=America/Phoenix`.
- 2026-10-05: `test/template.test.ts` pins the 29 computed per-filament
  values for PETG, PLA and TPU slots against `seed/materials.json`; the
  audit mutation that wrote `nozzle_temperature_initial_layer` from
  `nozzle` fails it.
- 2026-10-05: `npx vitest run packages/3mf/test/reader.fuzz.prop.test.ts`
  passes at FC_RUNS 100 (9 tests) and at the nightly FC_RUNS 2000
  (255 s), and the audit's hostile files are
  refused: traversal names (`entry-name`), 5014 entries (`entries`) and a
  787404 byte file inflating to 600 MiB (`inflated-size`, stopped past
  256 MiB, 361 MB RSS).
- 2026-10-05: a three-slot `bbs` export of three boxes passes
  `uv run --project py validate-3mf --overlap` with lib3mf
  reading it and no unexpected warning.

### Measured on a printed body

None. The Flash Studio 1.7.14 CLI sliced a writer export in the virtual
exit B (2026-10-07, hackbuild-fab `reference/keys/flex-pair/README.md`, computed); no
writer export has been opened in the Flash Studio GUI or printed.

### Checked by machine on geometry

None at the package level; the CHK-3MF checks run on each design's export.

### Not verified by anything

- The `core` target in any slicer or in a validator mode for core; the seed
  validator checks the bbs dialect only until M00-T09.
- That Flash Studio opens a TPU slot written from the borrowed PETG row as
  the owner expects.
