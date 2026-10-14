# Contributing

The code in this repository is split from hackbuild-fab (`packages/3mf`,
`tools/py`, `tools/corpus/3mf`). Open a change there when you can; a PR here
is ported back by a maintainer and returns with the next split.

| rule | what it means |
|---|---|
| authors | people only. The git author of every commit is a person. No AI assistant, model or AI tool is an author, co-author, contributor or credit anywhere: messages, trailers, file headers, CHANGELOG, package metadata, 3MF metadata (D-001). |
| hooks | run `npm ci --prefix js` once per clone. Its `prepare` script sets `core.hooksPath` to `.githooks`, so the commit-msg and pre-commit hooks run on every commit (D-002). Check with `git config core.hooksPath`; never pass `--no-verify`. |
| trailers | none of any kind. No Signed-off-by, Co-Authored-By, Reviewed-by or generated-with lines. The commit-msg hook rejects every `<word>-by:` and `<word>-with:` line, people's included, and CI repeats the check (D-002). |
| outside PRs | a maintainer squashes the PR and rewrites the message so it passes the hook. Your git author line is kept; that line is the credit. |
| commit subjects | imperative, lowercase, under 60 characters, no trailing punctuation, optional lowercase scope: `js: write curr_bed_type from the preset` (D-005 default). |
| licence | inbound equals outbound: code is MIT (LICENSE), README, CHANGELOG and docs are CC-BY-4.0 with code samples also MIT (LICENSES/CC-BY-4.0.txt), the failure corpus is CC-BY-4.0 and the owner's design 3MFs under corpus/ are CC-BY-SA-4.0 (LICENSES/CC-BY-SA-4.0.txt); the README Licence section maps each path. No CLA, no DCO sign-off. |
| corpus | a new fixture enters `corpus/manifest.json` with its sha256 and source, and both validators must reach one verdict on it. |
| marks | a contribution grants no right to the hack.build name or logo (TRADEMARKS.md, D-171). |

Before you open a PR, run `npm test --prefix js`, `uv run --project py
pytest` and `uv run --project py corpus/run.py`. A harness that did not run
is reported as not run.
