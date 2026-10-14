// Export completeness on exported bytes (plan-deltas R50, CHECKS.md CHK-ART-01,
// known in M00 as export-completeness; M00-T09 step 5). The writer runs the
// same check on its input objects before any byte is written
// (../writer/completeness.ts); this one reads the names back out of
// Metadata/model_settings.config, or out of the model when a core export has
// no settings, and compares the STL zip members the caller passes. The
// validator never guesses a sibling STL zip.

import type { CheckResult } from "../contracts.js";
import { COMPLETENESS_ALIAS, COMPLETENESS_ID } from "../writer/completeness.js";
import { entryText, MODEL_SETTINGS, ROOT_MODEL, scanTags, type EntryMap, type ModelPart } from "./paths.js";
import { booleanResult, type ResultSink } from "./rules.js";

/** A name that came from an unresolved lookup or a failed number (writer rule). */
const UNRESOLVED = /(^|[^A-Za-z])(undefined|null|NaN)([^A-Za-z]|$)/;

function nameProblem(v: string | undefined): string | undefined {
  if (v === undefined) return "is missing";
  if (v.trim() === "") return "is empty";
  if (UNRESOLVED.test(v)) return "holds an unresolved token";
  return undefined;
}

interface NamedObject {
  readonly name: string | undefined;
  readonly parts: readonly (string | undefined)[];
}

function namesFromSettings(xml: string): NamedObject[] {
  const out: { name: string | undefined; parts: (string | undefined)[] }[] = [];
  let depth: "none" | "object" | "part" = "none";
  for (const t of scanTags(xml)) {
    if (t.close) {
      if (t.name === "part" && depth === "part") depth = "object";
      else if (t.name === "object") depth = "none";
      continue;
    }
    if (t.name === "object" && depth === "none") {
      out.push({ name: undefined, parts: [] });
      depth = t.selfClosing ? "none" : "object";
    } else if (t.name === "part" && depth === "object") {
      out[out.length - 1]!.parts.push(undefined);
      depth = t.selfClosing ? "object" : "part";
    } else if (t.name === "metadata" && t.attrs["key"] === "name") {
      const o = out[out.length - 1]!;
      if (depth === "object" && o.name === undefined) o.name = t.attrs["value"];
      else if (depth === "part" && o.parts[o.parts.length - 1] === undefined) o.parts[o.parts.length - 1] = t.attrs["value"];
    }
  }
  return out;
}

function namesFromModel(root: ModelPart): NamedObject[] {
  return [...root.objects.values()]
    .filter((o) => o.components.length > 0)
    .map((o) => ({ name: o.name, parts: o.components.map((c) => root.objects.get(c.objectid)?.name) }));
}

/** CHK-ART-01: names resolve and are unique; with stlMembers, one member per part and unique member names. */
export function checkCompleteness(sink: ResultSink, entries: EntryMap, root: ModelPart, stlMembers?: readonly string[]): CheckResult {
  const xml = entryText(entries, MODEL_SETTINGS);
  const objects = xml !== undefined ? namesFromSettings(xml) : namesFromModel(root);
  const bad: string[] = [];
  const seen = new Map<string, number>();
  let parts = 0;
  objects.forEach((o, i) => {
    const p = nameProblem(o.name);
    if (p !== undefined) bad.push(`object ${i} name ${JSON.stringify(o.name ?? null)} ${p}`);
    const key = String(o.name ?? null);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    o.parts.forEach((pn, j) => {
      parts += 1;
      const q = nameProblem(pn);
      if (q !== undefined) bad.push(`object ${i} part ${j} name ${JSON.stringify(pn ?? null)} ${q}`);
    });
  });
  for (const [name, k] of seen) if (k > 1) bad.push(`object name ${JSON.stringify(name)} used ${k} times`);
  const extra: Record<string, number | string> = { alias: COMPLETENESS_ALIAS, objects: objects.length, parts };
  if (stlMembers !== undefined) {
    const members = stlMembers.filter((m) => !m.endsWith("/"));
    extra["stlMembers"] = members.length;
    if (members.length !== parts) bad.push(`stl zip holds ${members.length} members for ${parts} parts`);
    const unique = new Set(members).size;
    if (unique !== members.length) bad.push(`stl zip holds ${unique} unique names for ${members.length} members`);
  }
  if (bad.length > 0) extra["first"] = bad.slice(0, 5).join("; ");
  return sink.push(booleanResult(sink, COMPLETENESS_ID, bad.length === 0,
    "every object and part name resolves, object names are unique, the stl zip holds one member per part (plan-deltas R50)",
    xml !== undefined ? MODEL_SETTINGS : ROOT_MODEL, extra));
}
