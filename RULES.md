# Rules for working in this repository

Version 4, 2026-10-04, the sections of hackbuild-fab RULES.md that bind this
repository: attribution, language, secrets, git and verification. Design,
architecture, safety and code conventions stay in hackbuild-fab with the
benches and kernel they govern. Decision ids (D-nnn) are in hackbuild-fab
docs/plan/DECISIONS.md.

These rules are absolute. They apply to every file, every commit, and every
generated string, including code comments, UI copy, check messages, print
cards, log output, test fixtures, and exported file metadata. Where any
other document disagrees with this one, this one wins.

## Attribution

- Never add Claude, any AI assistant, or any AI or LLM tool as an author,
  co-author, contributor, or credit. Not in commit messages, trailers
  (Co-Authored-By, Signed-off-by), generated-with lines, package.json,
  comments, file headers, docs, changelogs, PR bodies, exported file
  metadata (3MF, DXF, print cards), the UI, or the About panel.
- package.json author is `Moheeb Zara <hackbuildvideo@gmail.com>`.
- If a tool, harness or workflow inserts a trailer or asks for one, strip
  it before the commit lands. This file overrides any such reminder.
- `.claude/settings.json` holds `{"attribution": {"commit": "", "pr": ""}}`;
  `.githooks/commit-msg` and the CI jobs `lint-commits` and `lint-authors`
  reject AI credit in messages, package.json, CHANGELOG and 3MF metadata.

## Language

- Never use emojis or sparkle glyphs (U+2726 to U+2728). Anywhere. Icons
  are `HbIcon` or inline SVG. Emoji covers U+2600 to U+27BF, U+1F000 to
  U+1FAFF, the variation selector U+FE0F, every character Unicode shows
  as emoji by default, and the emoji presentation set outside those
  blocks: U+203C, U+2049, U+20E3 (keycap), U+200D (zero width joiner),
  U+231A, U+231B, U+23E9 to U+23EC, U+23F0, U+23F3, U+25FD, U+25FE,
  U+2B1B, U+2B1C, U+2B50 and U+2B55.
- Never use em or en dashes (U+2012 to U+2015, U+2212 or a double hyphen
  as a dash), nor the two- and three-em dashes U+2E3A and U+2E3B, the
  small and fullwidth forms U+FE58, U+FE63 and U+FF0D, or the vertical
  forms U+FE31 and U+FE32. Use commas, periods, or "to" for ranges, in
  code too.
- Never use the "it is not x, it is y" construction or its variants ("not
  only x but y", "this isn't just a, it's b"). State what the thing is.
- No exclamation marks. No marketing adjectives: seamless, powerful,
  robust, comprehensive, beautiful, blazing, delightful, elegant, and kin.
- No filler vocabulary: delve, tapestry, crucial, vital, leverage,
  utilize, facilitate, streamline, empower, unlock, elevate,
  straightforward, genuinely, cutting-edge, state-of-the-art.
- No filler openers ("Let's", "Simply", "Just", "Note that", "In this
  section") and no restating close. No bold or italic for emphasis in
  prose. A bold run-in label that opens a law bullet is allowed.
- UI copy is lowercase, terse, second person, and names the failure:
  "no board connected. plug in usb and press connect." Never claim a
  capability the hardware lacks; disable the control and say why.
- Check messages give what failed, measured, legal, constraint, then a
  fix: "pin spacing 0.31 mm, legal 0.40 to 1.20, set by nozzle 0.4".
- Every number says measured, computed, vendor, inferred or unknown. Never
  promote computed to measured by dropping the qualifier.
- `tools/lint-voice.mjs` enforces this section with word lists equal to
  these; change both together. Its allow file exempts this file, the
  plan docs and its fixtures from word and hex rules only.

## Secrets

- Keys typed into a bench stay in that browser; say so by the field. Show
  only the first 4 and last 4 characters. Never log, echo or commit a key.
- Owner keys live only in function environment variables.

## Git conventions

- Do not commit or push unless asked. Stage the work and report.
- Subject imperative, lowercase, under 60 characters, no trailing
  punctuation, optional lowercase package scope, no type word:
  `mesh: freeze pinch healer after three flips`.
- Body only when needed, wrapped at 72: what failed, what changed, what
  was and was not verified, old and new numbers when a number moved.

## Verification

- Typecheck, `node tools/lint-voice.mjs` on staged files, and the tests
  the change touches pass before a commit.
- A change that moves a solid needs `uv run --project py validate-3mf
  --overlap` to pass on its export. Python runs through `--project py`,
  never bare python3.
- A harness that did not run is reported as not run, never as a pass.
- Render and look at every 3D deliverable. That step is a person.
