// Dialect rules of the validator mirror: CHK-3MF-01, -02, -03 and -07
// (CHECKS.md 6 and 7.3, D-069, D-159, C-07) on Metadata/project_settings.config,
// plus the result helpers every rule shares. Mirror of
// tools/py/validate_3mf.py check_project_settings; the Python validator is
// the reference (D-140). Per-filament classification is by template
// membership only: a length-N vector outside the template could be
// per-filament or per-extruder on the 4-extruder ffc5p, and the validator
// does not guess (M00-T09 step 1).

import type { CheckId, CheckResult, LegalValues, Verdict } from "../contracts.js";
import { FORBIDDEN_KEYS, SCALAR_KEYS } from "../writer/settings.js";
import type { FilamentTemplate } from "../writer/template.js";
import { COMPLETENESS_ID } from "../writer/completeness.js";

export type ValidateMode = "export" | "legacy" | "roundtrip";
export type ValidateTarget = "bbs" | "core";

/**
 * Version and severity per check id the validator emits. Equal to the rows of
 * packages/checks/seed/checks.seed.json (validate.test.ts asserts it); the
 * 3mf package sits below checks in tools/tiers.json and cannot import them.
 * CHK-ART-01 is registered under its id at M04-T12 (CHECKS.md 9.7); the
 * writer stamps the same version (writer/completeness.ts).
 */
export const CHECK_META = {
  "CHK-3MF-01": { version: "1.0.1", severity: "block" },
  "CHK-3MF-02": { version: "1.0.1", severity: "block" },
  "CHK-3MF-03": { version: "1.0.1", severity: "block" },
  "CHK-3MF-06": { version: "2.0.0", severity: "block" },
  "CHK-3MF-07": { version: "2.0.0", severity: "block" },
  "CHK-3MF-08": { version: "1.0.0", severity: "block" },
  "CHK-PRT-01": { version: "1.0.1", severity: "block" },
  "CHK-PRT-03": { version: "2.0.0", severity: "block" },
  [COMPLETENESS_ID]: { version: "1.0.0", severity: "block" },
} as const satisfies Readonly<Record<CheckId, { readonly version: string; readonly severity: "block" | "warn" | "note" }>>;

export type ValidatorCheckId = keyof typeof CHECK_META;

/** Collects results for one artifact. */
export interface ResultSink {
  readonly artifact: string;
  readonly results: CheckResult[];
  readonly notes: string[];
  push(r: CheckResult): CheckResult;
}

export function resultSink(artifact: string): ResultSink {
  const results: CheckResult[] = [];
  return { artifact, results, notes: [], push: (r) => (results.push(r), r) };
}

type Extra = Readonly<Record<string, number | string>>;

function stamp(sink: ResultSink, id: ValidatorCheckId, verdict: Verdict, constraint: string, path: string | undefined, extra: Extra | undefined) {
  const meta = CHECK_META[id];
  return {
    id, version: meta.version, verdict, severity: meta.severity,
    target: { level: "artifact" as const, artifact: sink.artifact, ...(path !== undefined ? { path } : {}) },
    constraint, origin: `hbf://check/${id}` as const,
    ...(extra !== undefined && Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

export function booleanResult(sink: ResultSink, id: ValidatorCheckId, ok: boolean, constraint: string, path?: string, extra?: Extra): CheckResult {
  return { ...stamp(sink, id, ok ? "pass" : "fail", constraint, path, extra), legal: { kind: "boolean", must: true }, measured: ok };
}

export function skipResult(sink: ResultSink, id: ValidatorCheckId, reason: string, path?: string): CheckResult {
  return { ...stamp(sink, id, "skip", reason, path, undefined), legal: { kind: "none" }, measured: "not run" };
}

export function intervalResult(sink: ResultSink, id: ValidatorCheckId, ok: boolean, constraint: string,
  legal: Extract<LegalValues, { kind: "interval" }>, measured: number, path?: string, extra?: Extra): CheckResult {
  return { ...stamp(sink, id, ok ? "pass" : "fail", constraint, path, extra), legal, measured };
}

export function setResult(sink: ResultSink, id: ValidatorCheckId, ok: boolean, constraint: string,
  legal: Extract<LegalValues, { kind: "set" }>, measured: string, path?: string): CheckResult {
  return { ...stamp(sink, id, ok ? "pass" : "fail", constraint, path, undefined), legal, measured };
}

const first = (bad: readonly string[]): Record<string, string> => (bad.length > 0 ? { first: bad.slice(0, 5).join("; ") } : {});

/** Application tag prefixes the importer reads colours from (D-159; writer DEFAULT_APP). */
export const APP_PREFIXES = ["BambuStudio-", "OrcaSlicer-"] as const;

/** CHK-3MF-01: the Application tag. */
export function checkApplication(sink: ResultSink, app: string, path: string): CheckResult {
  const ok = APP_PREFIXES.some((p) => app.startsWith(p));
  return sink.push(setResult(sink, "CHK-3MF-01", ok, "the importer reads colours only from an Application tag starting BambuStudio- or OrcaSlicer-",
    { kind: "set", values: [...APP_PREFIXES], nearest: APP_PREFIXES[0] }, app, path));
}

/** The writer must keep these three, which the seed template dropped (C-07, CHECKS.md 7.3 rule 5). */
export const KEPT_KEYS = ["filament_map", "filament_self_index", "filament_extruder_variant"] as const;
const OVERHANG_KEY = "overhang_fan_threshold";
const OVERHANG_RE = /^[0-9]+%$/;
const PERCENT_RE = /^-?[0-9]+(\.[0-9]+)?%$/;
const NUMBER_RE = /^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/;

export type SlotKind = "percent" | "number" | "string" | "any";

/** The per-slot type of a template key, read from its template values. */
export function slotKind(values: readonly string[]): { readonly kind: SlotKind; readonly nullable: boolean } {
  const nonNil = values.filter((v) => v !== "nil");
  const nullable = nonNil.length < values.length;
  if (nonNil.length === 0) return { kind: "any", nullable: true };
  if (nonNil.every((v) => PERCENT_RE.test(v))) return { kind: "percent", nullable };
  // Integer and float strings share one class: the gold writes filament_flow_ratio "1" where other presets write "0.98".
  if (nonNil.every((v) => NUMBER_RE.test(v))) return { kind: "number", nullable };
  return { kind: "string", nullable };
}

function elementProblem(key: string, kind: SlotKind, nullable: boolean, x: unknown): string | undefined {
  if (typeof x !== "string") return `is a JSON ${x === null ? "null" : typeof x}, not a string`;
  if (key === OVERHANG_KEY) return OVERHANG_RE.test(x) ? undefined : "does not match ^[0-9]+%$";
  if (x === "nil") return nullable ? undefined : "is nil where the template has no nil";
  if (kind === "percent" && !PERCENT_RE.test(x)) return "is not a percent string";
  if (kind === "number" && !NUMBER_RE.test(x)) return "is not a numeric string";
  return undefined;
}

/** What project_settings holds against the template; written in every mode. */
export interface KeySetReport {
  readonly templateKeys: number;
  readonly present: number;
  readonly absent: readonly string[];
  readonly nonTemplate: readonly string[];
  readonly nonTemplateVectors: number;
  readonly nonTemplateVectorLengths: readonly number[];
  /** Template keys present by vector length; -1 counts scalars. */
  readonly templateLengths: Readonly<Record<string, number>>;
  readonly filaments: number | null;
}

/** CHK-3MF-02, -03 and -07 plus the key-set report; returns the filament count. */
export function checkProjectSettings(sink: ResultSink, ps: Readonly<Record<string, unknown>>, template: FilamentTemplate, mode: ValidateMode, path: string):
  { readonly n: number | undefined; readonly keySet: KeySetReport } {
  const tk = template.keys;
  const tset = new Set(Object.keys(tk));
  const colours = ps["filament_colour"];
  const n = Array.isArray(colours) ? colours.length : undefined;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(ps, k);
  const present = [...tset].filter(has).sort();
  const absent = [...tset].filter((k) => !has(k)).sort();
  const nonTemplate = Object.keys(ps).filter((k) => !tset.has(k)).sort();
  const ntVectors = nonTemplate.filter((k) => Array.isArray(ps[k]));
  const lengths: Record<string, number> = {};
  for (const k of present) {
    const v = ps[k];
    const L = String(Array.isArray(v) ? v.length : -1);
    lengths[L] = (lengths[L] ?? 0) + 1;
  }
  const keySet: KeySetReport = {
    templateKeys: tset.size, present: present.length, absent, nonTemplate, nonTemplateVectors: ntVectors.length,
    nonTemplateVectorLengths: [...new Set(ntVectors.map((k) => (ps[k] as unknown[]).length))].sort((a, b) => a - b),
    templateLengths: Object.fromEntries(Object.entries(lengths).sort(([a], [b]) => Number(a) - Number(b))), filaments: n ?? null,
  };
  sink.notes.push(`key-set: ${present.length} of ${tset.size} template keys present, ${absent.length} absent; ${nonTemplate.length} keys outside the template, ${ntVectors.length} of them vectors`);

  // CHK-3MF-02
  const bad02: string[] = [];
  let worst = n ?? 0;
  if (n === undefined) bad02.push("filament_colour is missing or not a list, so the filament count is unknown");
  else {
    for (const k of present) {
      const v = ps[k];
      if (!Array.isArray(v)) {
        bad02.push(`${k} is a scalar, not a vector`);
        worst = 1;
      } else if (v.length !== n) {
        bad02.push(`${k} has ${v.length} elements`);
        worst = v.length;
      }
    }
    for (const k of ["filament_diameter", "filament_settings_id"]) {
      if (!has(k)) {
        bad02.push(`${k} missing (the loader reads its size)`);
        worst = 0;
      }
    }
    if (mode === "export" && absent.length > 0) {
      bad02.push(`${absent.length} template keys missing, first ${absent.slice(0, 5).join(", ")}`);
      worst = 0;
    }
  }
  const N = n ?? 0;
  sink.push(intervalResult(sink, "CHK-3MF-02", bad02.length === 0,
    `every template key is a vector of one element per filament, N = len(filament_colour)${mode === "export" ? `, and all ${tset.size} template keys are present` : " (template keys present)"}`,
    { kind: "interval", lo: N, hi: N, unit: "elements", nearest: N }, worst, path, { filaments: N, checked: present.length, ...first(bad02) }));

  // CHK-3MF-03
  const scalar = new Set<string>(SCALAR_KEYS);
  if (mode === "export") {
    const extraKeys = nonTemplate.filter((k) => !scalar.has(k));
    const bad03 = extraKeys.map((k) => `${k} is outside the template and the writer's scalar keys`);
    sink.push(booleanResult(sink, "CHK-3MF-03", bad03.length === 0,
      `outside the ${tset.size} template keys only the writer's scalar keys appear: ${SCALAR_KEYS.join(", ")}`, path,
      { outside: extraKeys.length, ...first(bad03) }));
    const forbidden = FORBIDDEN_KEYS.filter(has);
    if (forbidden.length > 0) sink.notes.push(`forbidden keys present: ${forbidden.join(", ")}`);
  } else if (mode === "legacy") {
    sink.push(booleanResult(sink, "CHK-3MF-03", !has("extruder_variant_list"),
      "no extruder_variant_list, the loader asserts on it; keys outside the template go to the key-set note", path, { outside: nonTemplate.length }));
  } else {
    sink.push(skipResult(sink, "CHK-3MF-03", "not run in --roundtrip: the slicer wrote every key, including printer-scoped vectors", path));
  }

  // CHK-3MF-07
  const bad07: string[] = [];
  for (const k of present) {
    const v = ps[k];
    if (!Array.isArray(v)) continue; // a scalar template key is a CHK-3MF-02 fail
    const { kind, nullable } = slotKind(tk[k]!);
    for (let i = 0; i < v.length; i += 1) {
      const p = elementProblem(k, kind, nullable, v[i]);
      if (p !== undefined) {
        bad07.push(`${k} slot ${i} element ${JSON.stringify(v[i])} ${p}`);
        break;
      }
    }
  }
  if (mode === "export") for (const k of KEPT_KEYS) if (!has(k)) bad07.push(`${k} missing; the writer keeps it (C-07)`);
  sink.push(booleanResult(sink, "CHK-3MF-07", bad07.length === 0,
    "per-filament vectors carry the template's per-slot type; overhang_fan_threshold elements match ^[0-9]+%$ (D-069)", path,
    { checked: present.length, failures: bad07.length, ...first(bad07) }));

  if (mode !== "roundtrip") {
    for (const k of ["printer_settings_id", "print_settings_id"]) {
      if (!has(k)) sink.notes.push(`${k} not written: the slicer will invent an external preset named after the file`);
    }
    if (!has("curr_bed_type")) {
      sink.notes.push("curr_bed_type not written: the slicer opens on its default plate (cold plate in Flash Studio); set the machine preset bed type");
    }
  }
  return { n, keySet };
}
