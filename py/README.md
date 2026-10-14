# hackbuild_3mf

The Python half of hackbuild-3mf: `validate_3mf` (the reference validator
the TypeScript mirror agrees with), `orca3mf` (the writer) and
`harvest_filament_keys`. See the repository README for the dialect and the
verified block.

    uv run --project py validate-3mf --roundtrip corpus/gold/hackbuild-coin-nfc.3mf
    uv run --project py orca3mf out.3mf body.stl:1 inlay.stl:2
