// lint-voice fixtures are written at run time from code points and split words, so no banned byte
// or word is ever committed. Rule table: docs/plan/milestones/M-1-housekeeping.md, card M-1-T03.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { MARKETING, FILLER, OPENERS, EXTENSIONS, scanned } from "../lint-voice.mjs";


// every temp folder this file makes is removed when the file's tests end
const TEMPS = [];
const keep = (d) => {
  TEMPS.push(d);
  return d;
};
after(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});
const root = join(import.meta.dirname, "..", "..");
const lint = join(root, "tools", "lint-voice.mjs");
const cp = (n) => String.fromCodePoint(n);
const BS = "\\";

function fixtureDir(files, allow) {
  const d = keep(mkdtempSync(join(tmpdir(), "lint-voice-")));
  mkdirSync(join(d, "tools"));
  if (allow) writeFileSync(join(d, "tools", "lint-voice.allow.json"), JSON.stringify(allow));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
}

function run(files, allow, args) {
  const d = fixtureDir(files, allow);
  return spawnSync(process.execPath, [lint, ...(args ?? Object.keys(files))], { cwd: d, encoding: "utf8" });
}

function stdin(text, kind) {
  return spawnSync(process.execPath, [lint, "--stdin", "--kind", kind], { input: text, encoding: "utf8" });
}

const bad = {
  dash: ["a.md", `range 1 ${cp(0x2013)} 2\n`],
  emoji: ["a.ts", `export const s = "go ${cp(0x1f680)}";\n`],
  sparkle: ["a.md", `new ${cp(0x2728)} here\n`],
  "brand-hex": ["a.css", `a { color: #${"FF33"}66; }\n`],
  exclaim: ["a.md", "it works" + "!\n"],
  marketing: ["a.md", "a " + "rob" + "ust tool\n"],
  filler: ["a.md", "we " + "lever" + "age it\n"],
  opener: ["a.md", "Sim" + "ply run it.\n"],
};

for (const [rule, [name, text]] of Object.entries(bad)) {
  test(`blocks ${rule}`, () => {
    const r = run({ [name]: text });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^${name.replace(".", "\\.")}:1:\\d+ ${rule} `, "m"));
  });
}

test("good fixture passes", () => {
  const r = run({ "a.md": "plain words, one range 1 to 2.\n", "b.ts": "export const ok = true;\n" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /lint-voice: 2 files, 0 block, 0 warn/);
});

test("frame warns without failing", () => {
  const r = run({ "a.md": "this is " + "not " + "just a tool.\n" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /a\.md:1:9 frame \(warn\)/);
});

test("allow entry naming dash makes the loader exit 2", () => {
  const r = run({ "a.md": "x\n" }, [{ path: "a.md", rules: ["dash"], reason: "x" }]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /names dash/);
});

test("allow entries naming emoji, sparkle or an unknown rule exit 2", () => {
  for (const rule of ["emoji", "sparkle", "nope"]) {
    assert.equal(run({ "a.md": "x\n" }, [{ path: "a.md", rules: [rule], reason: "x" }]).status, 2, rule);
  }
});

test("allow entry silences a word rule on its glob only", () => {
  const word = "rob" + "ust";
  const allow = [{ path: "docs/plan/**", rules: ["marketing"], reason: "quotes the bans" }];
  const r = run({ "docs/plan/a.md": `a ${word} tool\n`, "docs/b.md": `a ${word} tool\n` }, allow, ["docs"]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /docs\/plan\/a\.md/);
  assert.match(r.stdout, /docs\/b\.md:1:3 marketing/);
});

test("ino and scad are scanned", () => {
  assert.equal(run({ "a.ino": `// ${cp(0x2014)}\n` }).status, 1);
  assert.equal(run({ "a.scad": `// ${cp(0x2014)}\n` }).status, 1);
  assert.ok(EXTENSIONS.includes("ino") && EXTENSIONS.includes("scad"));
});

test("sh, jsonl and the .githooks scripts are scanned", () => {
  const dash = `# ${cp(0x2014)}\n`;
  for (const name of ["a.sh", "a.jsonl", ".githooks/pre-commit", ".githooks/commit-msg"]) {
    const r = run({ [name]: dash });
    assert.equal(r.status, 1, `${name} ${r.stdout}`);
    assert.match(r.stdout, new RegExp(`^${name.replace(/\./g, "\\.")}:1:3 dash `, "m"));
  }
  // directory mode walks into .githooks, whichever way the path is spelled
  for (const arg of [".githooks", "./.githooks"]) assert.equal(run({ ".githooks/pre-commit": dash }, null, [arg]).status, 1, arg);
  const d = fixtureDir({ ".githooks/pre-commit": dash });
  assert.equal(spawnSync(process.execPath, [lint, join(d, ".githooks")], { cwd: d, encoding: "utf8" }).status, 1);
  // shell is code: an exclamation mark closing a string blocks
  assert.equal(run({ "a.sh": 'echo "done' + '!"\n' }).status, 1);
  assert.equal(run({ "a.sh": "if ! git diff --quiet; then exit 1; fi\n" }).status, 0);
  // jsonl lines follow the JSON message-key rule
  assert.equal(run({ "a.jsonl": `{ "message": "saved` + `!" }\n{ "regex": "a!b" }\n` }).status, 1);
  assert.equal(run({ "a.jsonl": `{ "regex": "a!b" }\n` }).status, 0);
  assert.ok(EXTENSIONS.includes("sh") && EXTENSIONS.includes("jsonl"));
  assert.ok(scanned(".githooks/pre-commit") && scanned("./.githooks/commit-msg") && scanned("/x/y/.githooks/pre-commit"));
  assert.ok(scanned(".githooks\\pre-commit"));
  // every file with no extension is text to scan when it decodes as UTF-8: LICENSE, SHA256SUMS, .nvmrc
  assert.ok(scanned("LICENSE") && scanned("SHA256SUMS") && scanned(".nvmrc") && scanned(".githooks/sub/x"));
  for (const ext of ["c", "cpp", "h", "hpp", "gcode", "xml", "cfg"]) assert.ok(scanned(`a.${ext}`), ext);
  assert.ok(!scanned("a.png") && !scanned("a.3mf") && !scanned("a.zip"));
});

test("U+2713 passes in a test file and blocks elsewhere", () => {
  assert.equal(run({ "x.test.mjs": `// ${cp(0x2713)} ${cp(0x2717)}\n` }).status, 0);
  assert.equal(run({ "x.mjs": `// ${cp(0x2713)}\n` }).status, 1);
});

test("escaped dash, emoji and sparkle forms block", () => {
  const forms = [
    ["a.ts", `export const s = "${BS}u2014";\n`, "dash"],
    ["a.html", "<p>a &" + "mdash; b</p>\n", "dash"],
    ["a.html", "<p>a &" + "ndash; b</p>\n", "dash"],
    ["a.html", "<p>a &#" + "8212; b</p>\n", "dash"],
    ["a.html", "<p>a &#x" + "2013; b</p>\n", "dash"],
    ["a.ts", `export const s = "${BS}u{1F680}";\n`, "emoji"],
    ["a.ts", `export const s = "${BS}uD83D${BS}uDE80";\n`, "emoji"],
    ["a.html", "<p>&#x" + "1F680;</p>\n", "emoji"],
    ["a.ts", `export const s = "${BS}u2728";\n`, "sparkle"],
  ];
  for (const [name, text, rule] of forms) {
    const r = run({ [name]: text });
    assert.equal(r.status, 1, `${text} ${r.stdout}`);
    assert.match(r.stdout, new RegExp(` ${rule} `), text);
  }
});

test("markdown word rules skip code, character and hex rules do not", () => {
  const word = "rob" + "ust";
  const md = ["```sh", `echo ${word}`, "```", `run \`${word}\` here.`, ""].join("\n");
  assert.equal(run({ "a.md": md }).status, 0);
  const hex = ["```css", `a { color: #${"ff2d"}7b; }`, "```", ""].join("\n");
  const r = run({ "a.md": hex });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a\.md:2:\d+ brand-hex/);
  assert.equal(run({ "a.md": `\`a ${cp(0x2014)} b\`\n` }).status, 1);
});

test("exclaim in code strings and JSON message keys", () => {
  assert.equal(run({ "a.ts": `export const m = "done` + `!";\n` }).status, 1);
  assert.equal(run({ "a.ts": "export const ok = a !== b && !c;\n" }).status, 0);
  assert.equal(run({ "a.json": `{ "message": "saved` + `!" }\n` }).status, 1);
  assert.equal(run({ "a.json": `{ "regex": "a!b" }\n` }).status, 0);
});

test("files that are not valid UTF-8 are skipped", () => {
  const d = fixtureDir({});
  writeFileSync(join(d, "bin.txt"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const r = spawnSync(process.execPath, [lint, "bin.txt"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /0 files/);
});

test("stdin commit drops comment lines", () => {
  assert.equal(stdin("add the coupon card\n", "commit").status, 0);
  assert.equal(stdin(`add the coupon card\n# ${cp(0x2014)} git comment\n`, "commit").status, 0);
  assert.equal(stdin(`add the coupon card ${cp(0x2014)} now\n`, "commit").status, 1);
  assert.equal(stdin("Sim" + "ply add it\n", "dom").status, 1);
  assert.equal(stdin("x\n", "nope").status, 2);
});

test("staged mode reads the staged blob", () => {
  const d = fixtureDir({ "a.md": `bad ${cp(0x2014)}\n` });
  const git = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  git("add", "a.md");
  writeFileSync(join(d, "a.md"), "clean now\n");
  const r = spawnSync(process.execPath, [lint, "--staged"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /a\.md:1:5 dash/);
});

function rulesLanguage() {
  const text = readFileSync(join(root, "RULES.md"), "utf8").replace(/\s+/g, " ");
  return {
    marketing: text.match(/marketing adjectives: ([^.]*?), and kin\./)[1].split(", "),
    filler: text.match(/filler vocabulary: ([^.]*)\./)[1].split(", "),
    opener: [...text.match(/filler openers \(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  };
}

test("word lists equal RULES.md Language", () => {
  const want = rulesLanguage();
  assert.deepEqual([...MARKETING].sort(), [...want.marketing].sort());
  assert.deepEqual([...FILLER].sort(), [...want.filler].sort());
  assert.deepEqual(OPENERS, want.opener);
});

test("word lists equal the M-1-T03 rule table", (t) => {
  const card = join(root, "docs", "plan", "milestones", "M-1-housekeeping.md");
  if (!existsSync(card)) return t.skip("docs/plan lands at M-1-T13");
  const rows = readFileSync(card, "utf8").split("\n");
  const row = (id) => {
    const line = rows.find((l) => l.trimStart().startsWith(`| ${id} | block |`));
    assert.ok(line, `rule table row ${id} not found in the M-1-T03 card`);
    return [...line.split("|")[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };
  assert.deepEqual([...row("marketing")].sort(), [...MARKETING].sort());
  assert.deepEqual([...row("filler")].sort(), [...FILLER].sort());
  assert.deepEqual(row("opener"), OPENERS);
});


test("emoji presentation characters outside the dingbat block block", () => {
  for (const c of [0x2b50, 0x23f0, 0x203c, 0x2b1b, 0x2049, 0x231a, 0x1fae8]) {
    const r = run({ "a.md": `x ${cp(c)} y\n` });
    assert.equal(r.status, 1, `U+${c.toString(16)} ${r.stdout}`);
    assert.match(r.stdout, / emoji /);
  }
  // a keycap and a joined sequence
  assert.equal(run({ "a.md": `x 1${cp(0x20e3)}\n` }).status, 1);
  assert.equal(run({ "a.md": `x a${cp(0x200d)}b\n` }).status, 1);
  assert.equal(run({ "a.ts": `export const s = "${BS}u2b50";\n` }).status, 1);
  // text-presentation arrows the clasp marks use pass
  for (const c of [0x2194, 0x25b6, 0x25c0]) assert.equal(run({ "a.md": `x ${cp(c)} y\n` }).status, 0, `U+${c.toString(16)}`);
});

test("the extra dash forms block", () => {
  for (const c of [0x2e3a, 0x2e3b, 0xfe58, 0xfe63, 0xfe31, 0xfe32, 0xff0d]) {
    const r = run({ "a.md": `a ${cp(c)} b\n` });
    assert.equal(r.status, 1, `U+${c.toString(16)}`);
    assert.match(r.stdout, / dash /);
  }
  assert.equal(run({ "a.ts": `export const s = "${BS}u2e3a";\n` }).status, 1);
});

test("an exclamation mark in prose blocks wherever it stands", () => {
  for (const text of ["wrong " + "!\n", "wrong" + "!.\n", "(wrong" + "!)\n", "x" + "!y\n"]) {
    assert.equal(run({ "a.md": text }).status, 1, text);
  }
  assert.equal(stdin("add x\n\nwrong " + "!\n", "commit").status, 1);
  // a Markdown image, an HTML comment and a comparison are not exclamations
  for (const text of ["see ![alt](a.png)\n", "<" + "!-- note -->\n", "a != b\n"]) assert.equal(run({ "a.md": text }).status, 0, text);
});

test("ai credit in a commit message blocks, a file or a scope naming a tool passes", () => {
  const rejects = [
    "Paired with Claude Code on this change.",
    "Model: Claude Opus 4.5",
    "Drafted by Sonnet 4.5",
    "Drafted by GPT-4",
    "Change made via Claude.",
    "AI: Claude Code",
    "Written with AI.",
  ];
  for (const body of rejects) {
    const r = stdin(`add walking skeleton\n\n${body}\n`, "commit");
    assert.equal(r.status, 1, body);
    assert.match(r.stdout, / ai-credit /, body);
  }
  const passes = [
    "update CLAUDE.md with the new rules",
    "settings: empty the claude attribution keys",
    "hooks: reject claude trailers in commit-msg",
    "settings: add the claude settings helper",
    "lint: share one ai name list with the hook",
    "model: read the cap with the profile row",
    "tools: read tools/ai-names.json with the linters",
  ];
  for (const subject of passes) assert.equal(stdin(`${subject}\n`, "commit").status, 0, subject);
});

test("text inside a zip or 3mf is scanned, a legacy archive only warns", async () => {
  const JSZip = (await import("node:module")).createRequire(new URL("../../js/package.json", import.meta.url))("jszip");
  const z = new JSZip();
  z.file("README.md", `# title ${cp(0x2014)} sub\n`);
  z.file("pic.png", Buffer.from([0x89, 0x50]));
  const bytes = await z.generateAsync({ type: "nodebuffer" });
  const d = fixtureDir({});
  writeFileSync(join(d, "a.zip"), bytes);
  writeFileSync(join(d, "b.3mf"), bytes);
  const r = spawnSync(process.execPath, [lint, "a.zip", "b.3mf"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^a\.zip!README\.md:1:9 dash /m);
  assert.match(r.stdout, /^b\.3mf!README\.md:1:9 dash /m);
  const allow = [{ path: "a.zip", rules: ["legacy-archive"], reason: "kept byte-identical" }];
  writeFileSync(join(d, "tools", "lint-voice.allow.json"), JSON.stringify(allow));
  const w = spawnSync(process.execPath, [lint, "a.zip"], { cwd: d, encoding: "utf8" });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /^a\.zip!README\.md:1:9 dash \(warn\)/m);
});
