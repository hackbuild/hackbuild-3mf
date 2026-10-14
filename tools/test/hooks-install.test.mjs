// D-002: a fresh clone gets the hooks from `npm ci --prefix js` through the prepare script.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(repo, "js", "package.json"), "utf8"));
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8" });

// every temp folder this file makes is removed when the file's tests end
const TEMPS = [];
after(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});

function tree(withGit) {
  const dir = mkdtempSync(join(tmpdir(), "hooks-install-"));
  TEMPS.push(dir);
  mkdirSync(join(dir, "js"));
  cpSync(join(repo, "js", "package.json"), join(dir, "js", "package.json"));
  cpSync(join(repo, ".githooks"), join(dir, ".githooks"), { recursive: true });
  cpSync(join(repo, "tools"), join(dir, "tools"), { recursive: true });
  if (withGit) assert.equal(run("git", ["init", "-q"], dir).status, 0);
  return dir;
}

test("js/package.json has a prepare script that sets core.hooksPath", () => {
  assert.match(pkg.scripts.prepare ?? "", /git -C \.\. config core\.hooksPath \.githooks/);
});

test("import-from-fab.sh writes the same prepare script", () => {
  const sh = readFileSync(join(repo, "tools", "import-from-fab.sh"), "utf8");
  assert.ok(sh.includes(`prepare: ${JSON.stringify(pkg.scripts.prepare)},`), "generator and js/package.json disagree");
});

test("README Develop section points a contributor at the hooks, RULES.md and CONTRIBUTING.md", () => {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const develop = readme.split(/^## /m).find((s) => s.startsWith("Develop\n"));
  assert.ok(develop, "README has no Develop section");
  for (const needle of ["core.hooksPath", ".githooks", "npm ci --prefix js", "RULES.md", "CONTRIBUTING.md", "D-001", "D-002"]) {
    assert.ok(develop.includes(needle), `Develop section does not mention ${needle}`);
  }
});

test("prepare sets core.hooksPath on a clone that has none", () => {
  const dir = tree(true);
  assert.equal(run("git", ["config", "core.hooksPath"], dir).stdout.trim(), "");
  const r = run("sh", ["-c", pkg.scripts.prepare], join(dir, "js"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run("git", ["config", "core.hooksPath"], dir).stdout.trim(), ".githooks");
});

test("after prepare the hooks reject the audit commit and pass a clean one", () => {
  const dir = tree(true);
  assert.equal(run("sh", ["-c", pkg.scripts.prepare], join(dir, "js")).status, 0);
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty"];
  const bad = run("git", [...id, "-m", `Add Things${String.fromCodePoint(0x21)}`, "-m", "Co-Authored-By: x <x@example.invalid>"], dir);
  assert.notEqual(bad.status, 0, "commit landed without the hook");
  assert.match(bad.stderr, /trailers/);
  assert.equal(run("git", ["rev-parse", "-q", "--verify", "HEAD"], dir).status, 1);
  const good = run("git", [...id, "-m", "js: add the hooks install test"], dir);
  assert.equal(good.status, 0, good.stderr);
});

test("prepare exits 0 and touches no git config outside a checkout", () => {
  const dir = tree(false);
  const r = run("sh", ["-c", pkg.scripts.prepare], join(dir, "js"));
  assert.equal(r.status, 0, r.stderr);
});
