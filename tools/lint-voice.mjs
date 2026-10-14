// lint-voice: RULES.md Language and the wrong brand hexes as code (D-004).
// Rule table: docs/plan/milestones/M-1-housekeeping.md, card M-1-T03.
// Banned characters are built from code points, so this file passes its own dash, emoji and sparkle rules.
// Text inside a .zip or .3mf is read through the packages/3mf reader (D-166
// limits) and held to the same rules; a finding in an archive an allow row
// marks legacy-archive is a warning, since its bytes are fixed (D-142).
// Usage:
//   node tools/lint-voice.mjs                      every git-listed file (tracked plus untracked, not ignored)
//   node tools/lint-voice.mjs <path>...            those files or directories
//   node tools/lint-voice.mjs --staged             the staged blobs of added, copied and modified files
//   node tools/lint-voice.mjs --stdin --kind commit|text|dom
// Exit 0 when no block finding remains, 1 on a block finding, 2 on a usage or allow-file error.
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, extname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { aiCredit } from "./ai-names.mjs";

export const EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs", "vue", "md", "html", "css", "json", "yaml", "yml", "toml", "py", "svg", "txt", "ino", "scad", "sh", "jsonl", "c", "cpp", "h", "hpp", "gcode", "xml", "cfg", "model", "rels", "config"];
const EXT = new Set(EXTENSIONS);
/** Archives whose text entries are read and scanned. */
export const ARCHIVES = ["zip", "3mf"];

// The rules exist once (D-004): the word lists, the banned character
// patterns, maskMarkdown and lintText are packages/checks/voice/rules.mjs,
// read through @hackbuild/checks/voice, the specifier CHK-LNT-01 and -02
// read. That file is plain ESM with no build step, so the hooks run before
// tsc. This file keeps the CLI, the file walk, the allow file and the
// archive reader, and adds the ai-credit rule to commit messages.
import * as rules from "./voice-rules.mjs";
export {
  ALLOWABLE_RULES, BRAND_HEX, CHAR_RULES, EXTRA_DASHES, EXTRA_EMOJI, FILLER, JSON_MESSAGE_KEYS, KINDS, MARKETING, OPENERS,
  WORD_RULES, lintText, maskMarkdown,
} from "./voice-rules.mjs";
const { ALLOWABLE_RULES, CHAR_RULES, KINDS, lintText } = rules;

/** A commit message's hits: the voice rules for kind commit plus AI credit (tools/ai-names.json, D-001). */
export function lintCommit(path, text) {
  const found = lintText(path, text, "commit");
  for (const c of aiCredit(text)) found.push({ path, line: c.line, col: c.index + 1, rule: "ai-credit", severity: "block", text: c.text.slice(0, 48) });
  return found.sort((a, b) => a.line - b.line || a.col - b.col);
}

export function globToRegExp(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        s += "(?:.*/)?";
      } else s += ".*";
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`);
}

export class AllowError extends Error {}

export function parseAllow(rows) {
  if (!Array.isArray(rows)) throw new AllowError("allow file must hold a list of {path, rules, reason}");
  return rows.map((row, i) => {
    if (!row || typeof row.path !== "string" || !Array.isArray(row.rules) || typeof row.reason !== "string" || !row.reason.trim()) {
      throw new AllowError(`allow entry ${i} needs path, rules and a reason`);
    }
    for (const rule of row.rules) {
      if (CHAR_RULES.includes(rule)) throw new AllowError(`allow entry ${row.path} names ${rule}; dash, emoji and sparkle can never be allowed`);
      if (!ALLOWABLE_RULES.includes(rule)) throw new AllowError(`allow entry ${row.path} names unknown rule ${rule}`);
    }
    return { path: row.path, re: globToRegExp(row.path), rules: new Set(row.rules) };
  });
}

export function loadAllow(root) {
  const f = join(root, "tools", "lint-voice.allow.json");
  if (!existsSync(f)) return [];
  let rows;
  try {
    rows = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new AllowError(`allow file does not parse: ${e.message}`);
  }
  return parseAllow(rows);
}

function gitLines(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function walk(p, out) {
  let s;
  try {
    s = statSync(p);
  } catch {
    return;
  }
  if (s.isDirectory()) {
    for (const n of readdirSync(p).sort()) {
      if (n === "node_modules" || n === ".git" || n === "dist" || n === ".venv" || n === "__pycache__") continue;
      walk(join(p, n), out);
    }
  } else if (s.isFile()) out.push(p);
}

/** Every text file is scanned: the listed extensions and files with no extension (hook scripts, LICENSE, SHA256SUMS). */
export function scanned(path) {
  const p = path.split("\\").join("/");
  const ext = extname(p).slice(1).toLowerCase();
  return ext === "" || EXT.has(ext);
}

export const isArchive = (path) => ARCHIVES.includes(extname(path).slice(1).toLowerCase());

let reader;
/** The packages/3mf zip reader of this checkout, loaded on first use; null when the packages are not built. */
async function zipReader() {
  if (reader !== undefined) return reader;
  try {
    reader = (await import("../js/dist/index.js")).readEntries;
  } catch {
    reader = null;
  }
  return reader;
}

/** [name, text] for every scannable text entry of an archive, read under the D-166 limits. */
export async function archiveTexts(bytes) {
  const read = await zipReader();
  if (read === null) throw new Error("the packages/3mf reader is not built (run npm run build --prefix js)");
  const out = [];
  for (const [name, data] of Object.entries(await read(bytes))) {
    if (!scanned(name)) continue;
    const text = typeof data === "string" ? data : decode(data);
    if (text !== null) out.push([name, text]);
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decode(buf) {
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

function usage(msg) {
  console.error(`lint-voice: ${msg}`);
  console.error("usage: lint-voice.mjs [--staged | --stdin --kind commit|text|dom | <path>...]");
  process.exit(2);
}

async function main(argv) {
  const root = process.cwd();
  let allow;
  try {
    allow = loadAllow(root);
  } catch (e) {
    if (e instanceof AllowError) {
      console.error(`lint-voice: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const findings = [];
  let files = 0;
  if (argv.includes("--stdin")) {
    const k = argv.indexOf("--kind");
    const kind = k >= 0 ? argv[k + 1] : "text";
    if (!KINDS.includes(kind)) usage(`unknown kind ${kind}`);
    let text = readFileSync(0, "utf8");
    if (kind === "commit") text = text.split("\n").filter((l) => !l.startsWith("#")).join("\n");
    findings.push(...(kind === "commit" ? lintCommit(`<stdin:${kind}>`, text) : lintText(`<stdin:${kind}>`, text, kind)));
    files = 1;
  } else {
    const staged = argv.includes("--staged");
    const paths = argv.filter((a) => !a.startsWith("--"));
    const unknown = argv.filter((a) => a.startsWith("--") && a !== "--staged");
    if (unknown.length) usage(`unknown option ${unknown[0]}`);
    let list;
    if (staged) list = gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACM"], root);
    else if (paths.length) {
      list = [];
      for (const p of paths) walk(p, list);
    } else list = gitLines(["ls-files", "--cached", "--others", "--exclude-standard"], root);
    for (const f of [...new Set(list)]) {
      if (!scanned(f) && !isArchive(f)) continue;
      let buf;
      try {
        buf = staged ? execFileSync("git", ["show", `:${f}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }) : readFileSync(f);
      } catch {
        continue;
      }
      const rel = relative(root, resolve(root, f)).split("\\").join("/");
      const allowed = new Set(allow.filter((a) => a.re.test(rel)).flatMap((a) => [...a.rules]));
      if (isArchive(f)) {
        let entries;
        try {
          entries = await archiveTexts(buf);
        } catch (e) {
          findings.push({ path: rel, line: 0, col: 0, rule: "archive", severity: "block", text: `not scanned: ${e.message ?? e}`.slice(0, 120) });
          continue;
        }
        files++;
        const legacy = allowed.has("legacy-archive");
        for (const [name, text] of entries) {
          for (const x of lintText(`${rel}!${name}`, text).filter((y) => !allowed.has(y.rule))) findings.push(legacy ? { ...x, severity: "warn" } : x);
        }
        continue;
      }
      const text = decode(buf);
      if (text === null) continue;
      files++;
      findings.push(...lintText(rel, text).filter((x) => !allowed.has(x.rule)));
    }
  }
  for (const x of findings) console.log(`${x.path}:${x.line}:${x.col} ${x.rule}${x.severity === "warn" ? " (warn)" : ""} ${x.text}`);
  const block = findings.filter((x) => x.severity === "block").length;
  console.log(`lint-voice: ${files} files, ${block} block, ${findings.length - block} warn`);
  process.exit(block ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
