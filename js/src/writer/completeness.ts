// Export completeness (plan-deltas R50, CHECKS.md CHK-ART-01, known in M00
// as export-completeness). Runs before any byte is written. TENON's node
// exporter shipped five objects named tenon-undefined and a 7-member STL
// zip where five parts overwrote one name; this check refuses that export.

import type { CheckResult } from "../contracts.js";
import type { WriterObject } from "./model.js";
import { stlMemberNames } from "./stl.js";

export const COMPLETENESS_ID = "CHK-ART-01" as const;
export const COMPLETENESS_ALIAS = "export-completeness";

/** A name that came from an unresolved lookup or a failed number. */
const UNRESOLVED = /(^|[^A-Za-z])(undefined|null|NaN)([^A-Za-z]|$)/;

function nameProblem(v: unknown): string | undefined {
  if (typeof v !== "string") return `is ${v === null ? "null" : typeof v}`;
  if (v.trim() === "") return "is empty";
  if (UNRESOLVED.test(v)) return `holds an unresolved token`;
  return undefined;
}

/** CHK-ART-01 over the objects of one export; pass or a blocking fail with the names that broke it. */
export function exportCompleteness(artifact: string, objects: readonly WriterObject[]): CheckResult {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  objects.forEach((o, i) => {
    const p = nameProblem(o.name);
    if (p !== undefined) problems.push(`object ${i} name ${JSON.stringify(String(o.name))} ${p}`);
    seen.set(String(o.name), (seen.get(String(o.name)) ?? 0) + 1);
    (o.parts ?? []).forEach((part, j) => {
      const q = nameProblem(part.name);
      if (q !== undefined) problems.push(`object ${i} part ${j} name ${JSON.stringify(String(part.name))} ${q}`);
    });
  });
  const dupes = [...seen].filter(([, n]) => n > 1);
  for (const [name, n] of dupes) problems.push(`object name ${JSON.stringify(name)} used ${n} times`);
  const members = stlMemberNames(objects);
  const uniqueMembers = new Set(members).size;
  if (uniqueMembers !== members.length) problems.push(`stl fallback holds ${uniqueMembers} unique names for ${members.length} parts`);
  const ok = problems.length === 0;
  return {
    id: COMPLETENESS_ID,
    version: "1.0.0",
    verdict: ok ? "pass" : "fail",
    severity: "block",
    target: { level: "artifact", artifact },
    constraint: "every object and part name resolves, object names are unique, the stl fallback has one uniquely named member per part (plan-deltas R50)",
    origin: `hbf://check/${COMPLETENESS_ID}`,
    legal: { kind: "boolean", must: true },
    measured: ok,
    extra: {
      alias: COMPLETENESS_ALIAS,
      objects: objects.length,
      stlMembers: members.length,
      stlUniqueNames: uniqueMembers,
      problems: problems.length,
      ...(ok ? {} : { first: problems.slice(0, 5).join("; ") }),
    },
  };
}
