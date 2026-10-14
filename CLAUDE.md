@RULES.md

# CLAUDE.md

How an agent works in hackbuild-3mf. RULES.md is absolute and wins over this file.

## Attribution

- Never add Claude, any AI assistant, or any AI or LLM tool as an author, co-author, contributor
  or credit: not in commits, trailers, comments, docs, CHANGELOG, package metadata or 3MF metadata.
- Every package author is `Moheeb Zara <hackbuildvideo@gmail.com>`.
- `.githooks/commit-msg` rejects AI credit, trailers, dashes and subject format errors.
  `npm ci --prefix js` sets `core.hooksPath` to `.githooks` through the `prepare` script; run it
  once per clone and confirm with `git config core.hooksPath`. Never pass `--no-verify`.

## What lives here

    js/       npm package hackbuild-3mf: writer, template, validator mirror, artifact hash
    py/       PyPI package hackbuild_3mf: validate_3mf (the reference), orca3mf, harvest
    corpus/   manifest.json and the fixtures both validators must agree on
    tools/    lint-voice, lint-commits, lint-authors and their tests; import-from-fab.sh

The source of truth for the code is hackbuild-fab: `packages/3mf` and `tools/py` (D-027). A fix
lands there first and reaches this repo through the next split, so the two never diverge.

## Order of checks before a change is proposed

- `npm test --prefix js`, `uv run --project py pytest`, `uv run --project py corpus/run.py`.
- `node tools/lint-voice.mjs` on the changed files.
- Do not commit or push unless asked; stage the work and report (D-006). Nothing publishes until
  the owner clears D-037 and sets up trusted publishing.
