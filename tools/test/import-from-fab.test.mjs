// M00-T15: the split check runs from the fab checkout alone. Before the first
// fab commit the check needed a hand-made rehearsal snapshot, and a stale one
// reported drift that the tree did not have (verifier round 3, 2026-10-06).
// These tests need a hackbuild-fab checkout: HBF_FAB, or the sibling
// ../hackbuild-fab. Without one they are skipped, which counts as not run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const fab = resolve(process.env.HBF_FAB ?? join(repo, "..", "hackbuild-fab"));
const skip = existsSync(join(fab, "packages", "3mf", "package.json")) ? false : `no hackbuild-fab checkout at ${fab}`;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
const SPLIT = "split/hackbuild-3mf";
/** The rehearsal commit time, the builder pin (seconds since 1970-01-01T00:00:00Z). */
const REHEARSAL_EPOCH = "315532800";

test("--rehearse takes working-tree bytes, untracked files, and leaves out ignored and deleted ones", () => {
  // A hand-built fab with one file in each git state; needs no checkout.
  const fake = mkdtempSync(join(tmpdir(), "fake-fab-"));
  const dir = mkdtempSync(join(tmpdir(), "rehearse-"));
  try {
    const pkg = join(fake, "packages", "3mf");
    mkdirSync(pkg, { recursive: true });
    assert.equal(run("git", ["-C", fake, "init", "-q"]).status, 0);
    writeFileSync(join(fake, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(pkg, "staged.txt"), "staged bytes\n");
    writeFileSync(join(pkg, "gone.txt"), "deleted after staging\n");
    assert.equal(run("git", ["-C", fake, "add", "-A"]).status, 0);
    writeFileSync(join(pkg, "staged.txt"), "edited after staging\n");
    rmSync(join(pkg, "gone.txt"));
    writeFileSync(join(pkg, "untracked.txt"), "never staged\n");
    writeFileSync(join(pkg, "ignored.txt"), "ignored\n");

    const r = run("sh", [join(repo, "tools", "import-from-fab.sh"), "--rehearse", fake, dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(run("git", ["-C", dir, "ls-tree", "-r", "--name-only", SPLIT]).stdout.split("\n").filter(Boolean), ["staged.txt", "untracked.txt"]);
    assert.equal(run("git", ["-C", dir, "cat-file", "blob", `${SPLIT}:staged.txt`]).stdout, "edited after staging\n");
  } finally {
    rmSync(fake, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--rehearse cuts the split from the fab working tree, committed at the pinned epoch", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rehearse-"));
  try {
    const r = run("sh", [join(repo, "tools", "import-from-fab.sh"), "--rehearse", fab, dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(run("git", ["-C", dir, "log", "-1", "--format=%ct %at", SPLIT]).stdout.trim(), `${REHEARSAL_EPOCH} ${REHEARSAL_EPOCH}`);

    // Independent source: the files on disk under fab packages/3mf that git
    // does not ignore, read straight from the working tree.
    const listed = run("git", ["-C", fab, "ls-files", "-co", "--exclude-standard", "-z", "--", "packages/3mf"]).stdout.split("\0").filter(Boolean);
    const onDisk = [...new Set(listed)].filter((p) => existsSync(join(fab, p)) || isLink(join(fab, p))).map((p) => p.slice("packages/3mf/".length)).sort();
    const inSplit = run("git", ["-C", dir, "ls-tree", "-r", "-z", "--name-only", SPLIT]).stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(inSplit, onDisk);
    for (const p of onDisk) {
      const want = isLink(join(fab, "packages/3mf", p)) ? Buffer.from(readlinkSync(join(fab, "packages/3mf", p))) : readFileSync(join(fab, "packages/3mf", p));
      const got = run("git", ["-C", dir, "cat-file", "blob", `${SPLIT}:${p}`], { encoding: "buffer" }).stdout;
      assert.ok(Buffer.compare(got, want) === 0, `${p} in the split differs from the fab working tree`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check <fab> with no split repo rehearses the working tree and finds this tree fresh", { skip }, () => {
  const r = run("sh", [join(repo, "tools", "import-from-fab.sh"), "--check", fab], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /split equals a fresh import of /);
});

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
