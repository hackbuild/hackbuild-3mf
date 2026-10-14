#!/usr/bin/env node
// CI job house-rules: authorship of record carries no AI credit (D-001, D-002).
// Reads tracked files only: every package.json and pyproject.toml, every
// CHANGELOG*.md and the 3D/*.model metadata of every .3mf. The 3MF
// Application field is a slicer id and is not checked. A 3MF is read under
// the D-166 zip limits: at most 4096 entries and 256 MiB inflated. A
// package.json under a legacy/ folder is a byte copy of an original (D-222),
// so its author stays as shipped; it still names no ai tool.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { AI_IDENTITY } from "./ai-names.mjs";

export const OWNER = "Moheeb Zara <hackbuildvideo@gmail.com>";
/** tools/ai-names.json, as lint-commits, lint-voice and tools/py/orca3mf.py read it. */
export const AI_NAME = AI_IDENTITY;
/** D-166 plan budgets (inferred), as packages/3mf READER_LIMITS. */
export const ZIP_LIMITS = { entries: 4096, inflatedBytes: 256 * 2 ** 20 };
// Same reach as .githooks/commit-msg: any -by: or -with: trailer, indented or not.
export const TRAILER = /^\s*[A-Za-z-]+-(by|with):/i;
export const GENERATED = /co-authored|generated[- ](with|by)|noreply@anthropic|ai-generated/i;
const MODEL_FIELDS = ["Designer", "DesignerUserId", "Copyright", "Description", "Origin"];

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

function personString(p) {
  if (typeof p === "string") return p.trim();
  if (p && typeof p === "object") return p.email ? `${p.name ?? ""} <${p.email}>`.trim() : String(p.name ?? "");
  return "";
}

/** A tracked path inside a legacy/ folder: an original kept byte for byte (D-222). */
export const isLegacy = (path) => path.split("/").slice(0, -1).includes("legacy");

export function packageFails(path, text) {
  const fails = [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    return [`${path}: not valid json, ${err.message}`];
  }
  const author = personString(pkg.author);
  if (AI_NAME.test(author)) fails.push(`${path}: author names an ai tool (${author}), legal is "${OWNER}"`);
  else if (author !== OWNER && !isLegacy(path)) fails.push(`${path}: author is "${author}", legal is "${OWNER}"`);
  for (const key of ["contributors", "maintainers"]) {
    if (pkg[key] === undefined) continue;
    const list = Array.isArray(pkg[key]) ? pkg[key] : [pkg[key]];
    for (const p of list) {
      const who = typeof p === "string" ? p : JSON.stringify(p);
      if (AI_NAME.test(who)) fails.push(`${path}: ${key} names an ai tool (${who}), legal is people only`);
    }
  }
  return fails;
}

/** The people of a pyproject.toml [project] table: authors and maintainers as "Name <email>". */
export function pyprojectPeople(text) {
  const project = text.split(/^\[/m).find((t) => t.startsWith("project]")) ?? "";
  const out = {};
  for (const key of ["authors", "maintainers"]) {
    const m = project.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, "m"));
    if (!m) continue;
    out[key] = [...m[1].matchAll(/\{([^}]*)\}/g)].map((t) => {
      const name = t[1].match(/name\s*=\s*"([^"]*)"/)?.[1] ?? "";
      const email = t[1].match(/email\s*=\s*"([^"]*)"/)?.[1];
      return email ? `${name} <${email}>` : name;
    });
  }
  return out;
}

export function pyprojectFails(path, text) {
  const fails = [];
  const people = pyprojectPeople(text);
  if (!people.authors?.length) fails.push(`${path}: [project] authors is missing, legal is "${OWNER}"`);
  for (const [key, list] of Object.entries(people)) {
    for (const who of list) {
      if (AI_NAME.test(who)) fails.push(`${path}: ${key} names an ai tool (${who}), legal is people only`);
      else if (key === "authors" && who !== OWNER) fails.push(`${path}: author is "${who}", legal is "${OWNER}"`);
    }
  }
  return fails;
}

export function changelogFails(path, text) {
  const fails = [];
  text.split("\n").forEach((line, i) => {
    if (TRAILER.test(line)) fails.push(`${path}:${i + 1}: trailer line, legal is none`);
    else if (GENERATED.test(line)) fails.push(`${path}:${i + 1}: generated-with or co-author line, legal is none`);
  });
  return fails;
}

function checkChangelog(path, fails) {
  fails.push(...changelogFails(path, readFileSync(path, "utf8")));
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function check3mf(path, fails) {
  let all;
  try {
    all = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
  } catch (err) {
    fails.push(`${path}: unzip could not list the archive, ${err.message.split("\n")[0]}`);
    return;
  }
  if (all.length > ZIP_LIMITS.entries) {
    fails.push(`${path}: ${all.length} zip entries, legal is at most ${ZIP_LIMITS.entries} (D-166)`);
    return;
  }
  const entries = all.filter((e) => /^3D\/[^/]+\.model$/.test(e));
  let inflated = 0;
  for (const entry of entries) {
    let xml;
    try {
      // the buffer cap stops an entry that inflates past what is left of the budget
      xml = execFileSync("unzip", ["-p", path, entry], { encoding: "utf8", maxBuffer: ZIP_LIMITS.inflatedBytes - inflated });
    } catch (err) {
      fails.push(`${path} ${entry}: not read within ${ZIP_LIMITS.inflatedBytes} inflated bytes (D-166), ${err.code ?? err.message.split("\n")[0]}`);
      return;
    }
    inflated += Buffer.byteLength(xml);
    for (const field of MODEL_FIELDS) {
      const rx = new RegExp(`<metadata\\b[^>]*\\bname="${field}"[^>]*?(?:/>|>([\\s\\S]*?)</metadata>)`, "g");
      for (const m of xml.matchAll(rx)) {
        const value = decodeXml(m[1] ?? "").trim();
        if (AI_NAME.test(value)) fails.push(`${path} ${entry}: ${field} is "${value}", legal names no ai tool`);
      }
    }
  }
}

function main() {
  const files = tracked();
  const fails = [];
  const counted = { pkg: 0, pyproject: 0, changelog: 0, threemf: 0 };
  for (const path of files) {
    const name = basename(path);
    if (name === "package.json") {
      counted.pkg++;
      fails.push(...packageFails(path, readFileSync(path, "utf8")));
    } else if (name === "pyproject.toml") {
      counted.pyproject++;
      fails.push(...pyprojectFails(path, readFileSync(path, "utf8")));
    } else if (/^CHANGELOG.*\.md$/i.test(name)) {
      counted.changelog++;
      checkChangelog(path, fails);
    } else if (/\.3mf$/i.test(name)) {
      counted.threemf++;
      check3mf(path, fails);
    }
  }
  for (const f of fails) console.error(`lint-authors: ${f}`);
  const summary = `${counted.pkg} package.json, ${counted.pyproject} pyproject.toml, ${counted.changelog} changelog, ${counted.threemf} 3mf`;
  if (fails.length > 0) {
    console.error(`lint-authors: ${fails.length} failure(s) over ${summary}`);
    return 1;
  }
  console.log(`lint-authors: clean over ${summary}`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) process.exitCode = main();
