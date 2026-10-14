// Licence and authorship in the exported model (LICENSING.md section 1.4).
// License carries ChaseMeta.license. Designer is the name part of the
// workspace root package.json author, Copyright is "Copyright (c) <year of
// sourceDateEpoch> <Designer>", and both stay empty when no author is
// given. No tool, model or AI name ever goes in (D-001); the writer refuses
// one rather than writing it. The core target writes LicenseTerms in place
// of License.

import { exportError } from "./writer/template.js";

export interface Attribution {
  readonly designer: string;
  readonly copyright: string;
  readonly license: string;
}

export const NO_ATTRIBUTION: Attribution = { designer: "", copyright: "", license: "" };

/**
 * The AI tool names refused in Designer (D-001): tools/ai-names.json `tools`
 * then `identityOnly`, the list lint-authors reads as AI_IDENTITY. The
 * package keeps a copy so it stands alone in the hackbuild-3mf split;
 * tools/test/ai-names.test.mjs holds it equal to the JSON.
 */
export const AI_NAMES: readonly string[] = ["claude", "anthropic", "chatgpt", "openai", "copilot", "gemini", "sonnet", "opus", "haiku", "codex", "gpt-?\\d[\\w.]*", "llm", "ai assistant", "cursor (?:ai|agent|ide)", "noreply@anthropic", "cursor"];
const AI_NAME = new RegExp(`(?<![\\p{L}\\p{N}])(?:${AI_NAMES.join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** The person name of an npm author field: "Name <email> (url)" or { name }. Empty when absent. */
export function authorName(author: unknown): string {
  if (typeof author === "string") return author.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (typeof author === "object" && author !== null && typeof (author as { name?: unknown }).name === "string") {
    return authorName((author as { name: string }).name);
  }
  return "";
}

function single(field: string, v: string): string {
  if (/[\r\n]/.test(v)) {
    throw exportError({ code: "E_SCHEMA", path: `/${field}`, got: v, expected: "one line", hint: `give ${field} on one line` });
  }
  return v.trim();
}

/**
 * The License, Designer and Copyright values for one export. designer is the
 * name already read from the author field (authorName), license the SPDX id
 * of the chase. epoch is the export's sourceDateEpoch in seconds.
 */
export function attribution(designer: string | undefined, license: string | undefined, epoch: number): Attribution {
  const d = single("designer", designer ?? "");
  const l = single("license", license ?? "");
  if (AI_NAME.test(d)) {
    throw exportError({ code: "E_SCHEMA", path: "/designer", got: d, expected: "a person's name",
      hint: "name the person who designed it; no tool, model or ai credit goes in exported metadata", record: "D-001" });
  }
  const year = new Date(epoch * 1000).getUTCFullYear();
  return { designer: d, copyright: d === "" ? "" : `Copyright (c) ${year} ${d}`, license: l };
}

/** attribution() from a raw npm author field. */
export function authorMeta(author: unknown, epoch: number, license?: string): Attribution {
  return attribution(authorName(author), license, epoch);
}
