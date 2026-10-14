// feeds 26 messages to .githooks/commit-msg: 8 pass, 18 reject with a named rule
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


// every temp folder this file makes is removed when the file's tests end
const TEMPS = [];
const keep = (d) => {
  TEMPS.push(d);
  return d;
};
after(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});
const hook = join(import.meta.dirname, "..", "..", ".githooks", "commit-msg");
const dir = keep(mkdtempSync(join(tmpdir(), "commit-msg-")));
const cp = (n) => String.fromCodePoint(n);
const trailer = "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>";

const cases = [
  // four real hackbuild-bench subjects
  ["bench 6ddae18", "fix what an audit of the rtl-sdr driver found\n", 0, ""],
  ["bench deb6be8", "actually feed the radio audio to whisper\n", 0, ""],
  ["bench 0e2f757", "audit fixes: real hackrf wideband sweep, honest pineapple\n", 0, ""],
  ["bench f227184", "support nooelec nesdr and match the r820t to librtlsdr\n", 0, ""],
  // four hackbuild-resume messages that carried the trailer
  ["resume 317ffb8", `Trim the dissolution-clause line from the wiki-forensics slide\n\n${trailer}\n`, 1, "trailers"],
  ["resume 43e639e", `Also thank Sudo Room on the talk deck\n\n${trailer}\n`, 1, "trailers"],
  ["resume ad197fa", `Thank Pumping Station: One and CRASH Space on the talk deck\n\n${trailer}\n`, 1, "trailers"],
  ["resume 568d8d8", `Add "Hacking Your Hackerspace" talk deck + links\n\nBundle the interactive talk deck at /hacking-your-hackerspace.html and\nlink it from a nav item ("The Talk") and a callout at the bottom of the\nAbout section.\n\n${trailer}\n`, 1, "trailers"],
  // four edge cases
  ["em dash", `fix the router ${cp(0x2014)} widen the lanes\n`, 1, "dashes"],
  ["emoji", `add the coupon print card ${cp(0x1f680)}\n`, 1, "emoji"],
  ["77 characters", "port the toggle pinch healer with the frozen cell count and a coarse grid run\n", 1, "under 60"],
  ["generated line", "add the seed conformance test\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n", 1, "credit"],
  // RULES.md Git conventions and Language
  ["type word", "feat: add thing\n", 1, "type word"],
  ["double hyphen", "mesh: fix pinch -- widen lanes\n", 1, "double hyphen"],
  // AI credit worded other ways, each a body line under a valid subject
  ["credit written with help", "add walking skeleton\n\nThis change was written with help from Claude.\n", 1, "credit"],
  ["credit made with", "add walking skeleton\n\nMade with an AI assistant (Claude Opus).\n", 1, "credit"],
  ["credit assisted with", "add walking skeleton\n\nAssisted with Claude Code.\n", 1, "credit"],
  ["credit author key", "add walking skeleton\n\nAuthor: Claude Opus\n", 1, "credit"],
  ["credit with trailer", "add walking skeleton\n\nGenerated-with: Claude Code\n", 1, "trailers"],
  ["credit thanks", "add walking skeleton\n\nThanks to ChatGPT for the review.\n", 1, "credit"],
  // D-005 scoped subjects that name a tool without crediting it
  ["scope settings", "settings: empty the claude attribution keys\n", 0, ""],
  ["scope hooks", "hooks: reject claude trailers in commit-msg\n", 0, ""],
  ["claude.md", "update claude.md reading order\n", 0, ""],
  ["helper is not help", "settings: add the claude settings helper\n", 0, ""],
  // D-005 subject form, the message names the failure and then the fix
  ["capital", "Add skeleton\n", 1, "starts with a capital, start it lowercase"],
  ["trailing punctuation", "add skeleton.\n", 1, "ends in punctuation, drop it"],
];

for (const [name, msg, code, reason] of cases) {
  test(name, () => {
    const f = join(dir, "msg");
    writeFileSync(f, msg);
    const r = spawnSync("sh", [hook, f], { encoding: "utf8" });
    assert.equal(r.status, code, r.stderr);
    if (reason) assert.match(r.stderr, new RegExp(reason));
  });
}

test("twenty-six cases, eight pass", () => {
  assert.equal(cases.length, 26);
  assert.equal(cases.filter((c) => c[2] === 0).length, 8);
  assert.equal(cases[10][1].trimEnd().length, 77);
});

// Holes the 2026-10-08 audit landed through the hook in a scratch clone; each
// is now caught by the lint-voice --kind commit call at the end of the hook.
const holes = [
  ["paired with", "add walking skeleton\n\nPaired with Claude Code on this change.\n"],
  ["model key", "add walking skeleton\n\nModel: Claude Opus 4.5\n"],
  ["drafted by sonnet", "add walking skeleton\n\nDrafted by Sonnet 4.5\n"],
  ["drafted by gpt", "add walking skeleton\n\nDrafted by GPT-4\n"],
  ["made via", "add walking skeleton\n\nChange made via Claude.\n"],
  ["ai key", "add walking skeleton\n\nAI: Claude Code\n"],
  ["star", `add the coupon print card ${cp(0x2b50)}\n`],
  ["alarm clock", `add the coupon print card ${cp(0x23f0)}\n`],
  ["double exclamation", `add the coupon print card\n\nit works ${cp(0x203c)}\n`],
  ["black square", `add the coupon print card ${cp(0x2b1b)}\n`],
  ["exclamation after a space", "add the coupon print card\n\nit works " + "!\n"],
  ["two-em dash", `add the coupon print card\n\nwide ${cp(0x2e3a)} lanes\n`],
];
for (const [name, msg] of holes) {
  test(`hole closed: ${name}`, () => {
    const f = join(dir, "msg");
    writeFileSync(f, msg);
    const r = spawnSync("sh", [hook, f], { encoding: "utf8", cwd: join(import.meta.dirname, "..", "..") });
    assert.equal(r.status, 1, r.stderr);
  });
}

test("a file named for a tool in a commit subject passes the hook", () => {
  const f = join(dir, "msg");
  writeFileSync(f, "update CLAUDE.md with the new rules\n");
  const r = spawnSync("sh", [hook, f], { encoding: "utf8", cwd: join(import.meta.dirname, "..", "..") });
  assert.equal(r.status, 0, r.stderr);
});
