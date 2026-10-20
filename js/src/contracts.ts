// Contracts shared with hackbuild-fab @hackbuild/spec (MIT, same author),
// copied as the subset this package reads: check results, build warnings,
// command errors, tiers and the slicer block of a machine preset.

declare const brand: unique symbol;
/** Nominal tag on a primitive. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
/** Lowercase hex sha256, 64 characters. */
export type Hash = Brand<string, "Hash">;
/** sha256 over sorted (entry name, sha256 of uncompressed bytes) for an export (D-052). */
export type ArtifactHash = Hash;
/** Length in millimetres. */
export type Mm = number;
/** 3D point or vector, all components in mm. */
export type Vec3 = readonly [x: Mm, y: Mm, z: Mm];
/** A quarter turn about +z, deg (spec/nest.ts; the plate layout of M07-T02). */
export type QuarterTurn = 0 | 90 | 180 | 270;
/** Body roles of hackbuild-fab Part IR (spec/part-ir.ts); a conductor role sets the M05-T20 overrides. */
export type BodyRole =
  | "body" | "structure" | "conductor" | "flex" | "flex-conductor" | "art" | "backer" | "mask" | "sheet";
/** Two bodies with a coincident face and its area, mm2 (spec/part-ir.ts Part.bodyAdjacency, M05-T20). */
export interface BodyAdjacency {
  readonly a: string;
  readonly b: string;
  readonly areaMm2: number;
}
/** Calendar date, YYYY-MM-DD. */
export type IsoDate = string;
/** Grid steps per mm for the D-054 vertex snap; unitless count per mm. */
export const MESH_GRID_PER_MM = 1024;

export type Verdict = "pass" | "warn" | "fail" | "skip";
export const SEVERITIES = ["block", "warn", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const TIERS = ["verified", "measured", "vendor", "community", "inferred"] as const;
export type Tier = (typeof TIERS)[number];

export const CHECK_AREAS = [
  "PRT", "FIT", "ASM", "SHT", "NET", "BRD", "MOT", "3MF", "INL", "LNT", "SHP", "KEY", "UI", "ART", "DEV", "CLAIM",
] as const;
export type CheckArea = (typeof CHECK_AREAS)[number];
/** CHK-<AREA>-NN, for example "CHK-3MF-06". */
export type CheckId = `CHK-${CheckArea}-${string}`;
/** hbf://check/<id>: definition, origin record, legal-value derivation. */
export type CheckUri = `hbf://check/${string}`;

export type LegalValues =
  /** An open end is null, never Infinity (hackbuild-fab CHECKS.md 7.1, D-225). */
  | { readonly kind: "interval"; readonly lo: number | null; readonly hi: number | null; readonly unit: string; readonly nearest: number }
  | { readonly kind: "set"; readonly values: readonly (number | string)[]; readonly unit?: string; readonly nearest?: number | string }
  | { readonly kind: "multipleOf"; readonly base: number; readonly offset?: number; readonly unit: string; readonly nearest: readonly [number, number] }
  | { readonly kind: "boolean"; readonly must: boolean }
  | { readonly kind: "exactSet"; readonly values: readonly string[] }
  | { readonly kind: "none" };

/** Where a result points. This package emits artifact targets only. */
export type SingleTarget =
  | { readonly level: "part"; readonly part: string; readonly at?: Vec3 }
  | { readonly level: "body"; readonly part: string; readonly body: string; readonly at?: Vec3 }
  | { readonly level: "feature"; readonly part: string; readonly feature: string; readonly at?: Vec3 }
  | { readonly level: "assembly"; readonly assembly: string; readonly part?: string; readonly at?: Vec3 }
  | { readonly level: "sheet"; readonly sheet: string; readonly part?: string; readonly at?: Vec3 }
  | { readonly level: "net"; readonly part: string; readonly net: string; readonly at?: Vec3 }
  | { readonly level: "artifact"; readonly artifact: string; readonly path?: string }
  | { readonly level: "source"; readonly path: string }
  | { readonly level: "page"; readonly path: string }
  | { readonly level: "project"; readonly path?: string };
export type ResultTarget =
  | SingleTarget
  | { readonly level: "pair"; readonly a: SingleTarget; readonly b: SingleTarget; readonly at?: Vec3 };

export type Evidence =
  | { readonly legal: Extract<LegalValues, { kind: "interval" | "multipleOf" }>; readonly measured: number }
  | { readonly legal: Extract<LegalValues, { kind: "set" }>; readonly measured: number | string }
  | { readonly legal: Extract<LegalValues, { kind: "boolean" }>; readonly measured: boolean }
  | { readonly legal: Extract<LegalValues, { kind: "exactSet" }>; readonly measured: readonly string[] }
  | { readonly legal: Extract<LegalValues, { kind: "none" }>; readonly measured: number | string | boolean };

/** A one-param fix; this package never proposes one, the field keeps the shape. */
export interface Fix {
  readonly param: string;
  readonly set: number | string | boolean;
  readonly paramLegal: readonly [number, number];
  readonly predicts: { readonly measured: number | string; readonly verdict: Verdict };
  readonly patch?: unknown;
}

export interface CheckResultBase {
  readonly id: CheckId;
  /** Check version that produced this result, semver. */
  readonly version: string;
  readonly verdict: Verdict;
  readonly severity: Severity;
  readonly target: ResultTarget;
  /** One line, the reason the legal values are what they are. */
  readonly constraint: string;
  readonly origin: CheckUri;
  readonly fix?: Fix;
  readonly waived?: { readonly reason: string; readonly until?: IsoDate };
  /** Extras; numbers carry their unit in the key suffix. */
  readonly extra?: Readonly<Record<string, number | string>>;
}
/** The result contract (D-064): base fields plus measured and legal, correlated by legal.kind. */
export type CheckResult = CheckResultBase & Evidence;

/** A non-fatal build fact, for example a borrowed preset row. */
export interface BuildWarning {
  /** Upper snake code. */
  readonly code: string;
  /** One line, lowercase. */
  readonly text: string;
  readonly param?: string;
  readonly bound?: unknown;
}

export const ERROR_CODES = [
  "E_SCHEMA", "E_REF", "E_UNSAT", "E_HANDLE", "E_STALE", "E_PROVENANCE",
  "E_GATE", "E_GATE_UNAVAILABLE", "E_REPEAT", "E_KERNEL", "E_PARAM_MISSING",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface CommandError {
  readonly code: ErrorCode;
  readonly path?: string;
  readonly got?: unknown;
  readonly expected?: string;
  readonly didYouMean?: readonly string[];
  /** One line, lowercase, imperative, names the failure. */
  readonly hint: string;
  readonly record?: string;
  readonly chase?: string;
  readonly personRuns?: string;
}
export interface ThrownCommandError extends Error {
  readonly hbf: CommandError;
}
/** Structural guard, so it holds when two copies of the package are loaded. */
export function isThrownCommandError(e: unknown): e is ThrownCommandError {
  if (!(e instanceof Error) || !("hbf" in e)) return false;
  const h = (e as { hbf: unknown }).hbf;
  return typeof h === "object" && h !== null && (ERROR_CODES as readonly unknown[]).includes((h as { code?: unknown }).code);
}

/** The slicer block of a dated machine preset (MachinePreset.slicer in hackbuild-fab). */
export interface SlicerPreset {
  /** Application string written to 3MF, for example "BambuStudio-01.10.01.50". */
  readonly app: string;
  readonly printer: string;
  readonly process: string;
  readonly filament: string;
  /** Build plate written as project_settings curr_bed_type, an OrcaSlicer enum string. */
  readonly bedType?: string;
}

/** RFC 8785 canonicalize and sha256Hex: spec/jcs.ts of hackbuild-fab, the one copy (D-206). */
export { CanonicalizeError, canonicalize, sha256Hex, utf8Bytes } from "./jcs.js";
