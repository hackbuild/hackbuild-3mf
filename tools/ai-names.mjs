// Regexes built from tools/ai-names.json, the one list of AI tool names and
// credit wording (D-001, D-002). tools/py/orca3mf.py reads the same file.
import { readFileSync } from "node:fs";

export const AI_NAMES = JSON.parse(readFileSync(new URL("./ai-names.json", import.meta.url), "utf8"));

const alt = (list) => list.join("|");
const word = (list) => `(?<![\\p{L}\\p{N}])(?:${alt(list)})(?![\\p{L}\\p{N}])`;

/** A tool name anywhere, for author, committer, package.json people and 3MF metadata. */
export const AI_IDENTITY = new RegExp(word([...AI_NAMES.tools, ...AI_NAMES.identityOnly]), "iu");

const TOOL = new RegExp(word(AI_NAMES.tools), "iu");
const GENERIC = new RegExp(word(AI_NAMES.generic), "iu");
const STRONG = new RegExp(word(AI_NAMES.creditStrong), "iu");
const WEAK = new RegExp(word(AI_NAMES.creditWeak), "iu");
const KEY_ALL = new RegExp(`^\\s*(?:${alt(AI_NAMES.creditKeys)})\\s*:(.*)$`, "iu");
/** Keys the subject line may open with as a package scope, so only a body line is held to them. */
const SCOPE_KEYS = new Set(["model", "ai", "agent", "tool"]);

/** A file or folder name such as CLAUDE.md or tools/ai-names.json names a file, never a tool. */
function maskPaths(line) {
  return line.replace(/[\w.@-]*[\w-]\.(?:md|json|mjs|ts|py|txt|toml|ya?ml)\b|\S*\/\S*/giu, (s) => " ".repeat(s.length));
}

/**
 * AI credit in a commit message: a tool name and a credit word in one
 * sentence (a weak word such as with or via only beside a tool's own name,
 * never the bare word ai), or a credit key such as Author: or Model: naming
 * one. Returns [{ line, index, text }] with 1-based lines.
 */
export function aiCredit(message) {
  const out = [];
  message.split("\n").forEach((raw, i) => {
    const line = maskPaths(raw);
    const key = line.match(KEY_ALL);
    if (key) {
      const k = line.trim().split(":")[0].trim().toLowerCase();
      if ((i > 0 || !SCOPE_KEYS.has(k)) && (TOOL.test(key[1]) || GENERIC.test(key[1]))) {
        out.push({ line: i + 1, index: 0, text: raw.trim() });
        return;
      }
    }
    let at = 0;
    for (const sentence of line.split(/\.(?=\s|$)/)) {
      const tool = TOOL.test(sentence);
      const named = tool || GENERIC.test(sentence);
      if ((named && STRONG.test(sentence)) || (tool && WEAK.test(sentence))) {
        out.push({ line: i + 1, index: at, text: raw.slice(at, at + sentence.length).trim() });
      }
      at += sentence.length + 1;
    }
  });
  return out;
}
