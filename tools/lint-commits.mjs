#!/usr/bin/env node
// CI job house-rules: runs .githooks/commit-msg over every commit in the pushed
// range and rejects AI tool identities as author or committer (D-001, D-002).
// Range: pull_request uses origin/$BASE_REF..HEAD; push uses $BEFORE..$GITHUB_SHA;
// the first push (BEFORE all zeros) and a BEFORE the clone lacks use every
// commit reachable from HEAD.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The names come from tools/ai-names.json, the one list every attribution check reads.
export { AI_IDENTITY } from "./ai-names.mjs";
import { AI_IDENTITY } from "./ai-names.mjs";
const ZERO = /^0+$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasCommit(ref) {
  try {
    git(["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function pickRange(env) {
  const head = env.GITHUB_SHA || "HEAD";
  const base = env.BASE_REF || "";
  const before = env.BEFORE || "";
  if (base !== "") return [`origin/${base}..HEAD`];
  if (before !== "" && !ZERO.test(before)) {
    if (hasCommit(before)) return [`${before}..${head}`];
    console.log(`lint-commits: ${before} is not in this clone, checking every commit reachable from ${head}`);
  }
  return [head];
}

function main() {
  if (!hasCommit("HEAD")) {
    console.log("lint-commits: no commits in this repository, nothing to check");
    return 0;
  }
  const range = pickRange(process.env);
  const shas = git(["rev-list", "--no-merges", ...range]).split("\n").filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), "lint-commits-"));
  const file = join(dir, "COMMIT_EDITMSG");
  try {
    for (const sha of shas) {
      for (const who of [git(["log", "-1", "--format=%an <%ae>", sha]).trim(), git(["log", "-1", "--format=%cn <%ce>", sha]).trim()]) {
        if (AI_IDENTITY.test(who)) {
          console.error(`lint-commits: ${sha} author or committer ${who} names an ai tool, legal is a person`);
          return 1;
        }
      }
      writeFileSync(file, git(["log", "-1", "--format=%B", sha]));
      try {
        execFileSync("sh", [".githooks/commit-msg", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        const reason = `${err.stderr || ""}${err.stdout || ""}`.trim() || `commit-msg exit ${err.status}`;
        console.error(`lint-commits: ${sha} ${reason}`);
        return 1;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`lint-commits: ${shas.length} commit(s) clean over ${range.join(" ")}`);
  return 0;
}

process.exitCode = main();
