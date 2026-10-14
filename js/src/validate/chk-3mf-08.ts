// CHK-3MF-08 on a package (CHECKS.md 9.11, M05-T20 step 3): no object that
// holds a conductor body or shares a face with one has `interlocking_beam`
// on, whether set per object or inherited from the project. The beams
// interleave two filaments up to `interlocking_depth` cells from their
// boundary and eat a conductor's cross section (research/3dp-landscape.md
// section 3 and section 11 idea 8). No printed failure is on record, so the
// loss the fail quotes is an inferred upper bound.
//
// Which objects hold or touch a conductor comes from the conductor record
// the writer puts in Metadata/hackbuild_chase.json (src/overrides.ts), built
// from Part IR body roles and Part.bodyAdjacency. A caller holding the build
// passes the Part IR's beam-free bodies, and a record that misses one fails.
// tools/py/checks/chk_3mf_08.py is the Python mirror; the verdicts agree on
// every fixture (packages/checks/test/fixtures/CHK-3MF-08).

import { CONDUCTOR_RECORD, INTERLOCKING_BEAM, INTERLOCKING_BEAM_WIDTH, INTERLOCKING_DEPTH, OVERRIDE_ROWS, type ConductorObject } from "../overrides.js";

export const CHK_3MF_08 = "CHK-3MF-08" as const;
export const CHK_3MF_08_VERSION = "1.0.0";
export const CHASE_ENTRY = "Metadata/hackbuild_chase.json";
const MODEL_SETTINGS = "Metadata/model_settings.config";
const PROJECT_SETTINGS = "Metadata/project_settings.config";

/**
 * The slicer defaults an object inherits when neither it nor the project
 * sets the key: profile constants 3mf.interlockingBeamWidth and
 * 3mf.interlockingDepth (vendor, Orca PrintConfig.cpp). The caller reads
 * them from profile; this package imports none (D-027).
 */
export interface InterlockingDefaults {
  readonly beamWidthMm: number;
  readonly depthCells: number;
}

export interface Chk08Outcome {
  readonly verdict: "pass" | "fail" | "skip";
  readonly constraint: string;
  /** The entry the finding points at. */
  readonly path: string;
  readonly extra?: Readonly<Record<string, number | string>>;
}

type Entry = string | Uint8Array;

// Kernels compile without DOM or node types; TextDecoder is a runtime global in both.
declare const TextDecoder: new (label: string) => { decode(input: Uint8Array): string };
const textOf = (e: Entry | undefined): string | undefined => (e === undefined ? undefined : typeof e === "string" ? e : new TextDecoder("utf-8").decode(e));

const ATTR = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
const unxml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(tag); m !== null; m = ATTR.exec(tag)) out[m[1]!] = unxml(m[2]!);
  return out;
}

/** Object-level metadata of model_settings.config by object name; part metadata is left out. */
export function objectMetadata(xml: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const block of xml.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)) {
    const own = block[1]!.replace(/<part\b[\s\S]*?<\/part>/g, "");
    const meta: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const m of own.matchAll(/<metadata\b([^>]*)\/?>/g)) {
      const a = attrsOf(m[1]!);
      if (a["key"] !== undefined) meta[a["key"]] = a["value"] ?? "";
    }
    if (meta["name"] !== undefined) out.set(meta["name"], meta);
  }
  return out;
}

/** A slicer bool as either writer spells it. */
const truthy = (v: unknown): boolean => {
  const x = Array.isArray(v) ? v[0] : v;
  return x === true || x === 1 || (typeof x === "string" && ["1", "true"].includes(x.trim().toLowerCase()));
};
const numberOf = (v: unknown): number | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  const n = typeof x === "number" ? x : typeof x === "string" ? Number.parseFloat(x) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

function isRecord(v: unknown): v is ConductorObject[] {
  return Array.isArray(v) && v.every((o) => typeof o === "object" && o !== null && typeof (o as ConductorObject).object === "string"
    && Array.isArray((o as ConductorObject).conductors) && Array.isArray((o as ConductorObject).touches));
}

/**
 * The CHK-3MF-08 verdict on one package. `beamFree`, when given, is the
 * Part IR's list of bodies that must sit in a beam-free object
 * (overrides.ts beamFreeBodies); without it the package's record is all
 * the check reads.
 */
export function chk3mf08(entries: Readonly<Record<string, Entry>>, defaults?: InterlockingDefaults, beamFree?: readonly string[]): Chk08Outcome {
  const chaseText = textOf(entries[CHASE_ENTRY]);
  if (chaseText === undefined) {
    return { verdict: "skip", path: CHASE_ENTRY, constraint: `not run: no ${CHASE_ENTRY}, so no chase to read body roles from; body adjacency comes from Part IR` };
  }
  let chase: Record<string, unknown>;
  try {
    chase = JSON.parse(chaseText) as Record<string, unknown>;
  } catch {
    return { verdict: "skip", path: CHASE_ENTRY, constraint: `not run: ${CHASE_ENTRY} is not json` };
  }
  const raw = chase[CONDUCTOR_RECORD];
  const expected = [...(beamFree ?? [])].sort();
  if (raw === undefined) {
    if (beamFree === undefined) {
      return { verdict: "skip", path: CHASE_ENTRY, constraint: `not run: ${CHASE_ENTRY} carries no conductor record; check.run on the build reads body roles from Part IR` };
    }
    return expected.length === 0
      ? { verdict: "pass", path: CHASE_ENTRY, constraint: "no conductor body in Part IR, so no object needs interlocking_beam off", extra: { objects: 0, failing: 0 } }
      : { verdict: "fail", path: CHASE_ENTRY, constraint: `${CHASE_ENTRY} carries no conductor record while Part IR has ${expected.length} bodies that need a beam-free object, first ${expected.slice(0, 5).join(", ")}; export again so the writer sets the overrides`, extra: { objects: 0, failing: expected.length, first: expected.slice(0, 5).join("; ") } };
  }
  if (!isRecord(raw)) {
    return { verdict: "fail", path: CHASE_ENTRY, constraint: `${CHASE_ENTRY} ${CONDUCTOR_RECORD} is not a list of objects with conductors and touches; export again`, extra: { objects: 0, failing: 1 } };
  }
  const recorded = new Set(raw.flatMap((o) => [...o.conductors.map((c) => c.body), ...o.touches.map((t) => t.body)]));
  const missing = expected.filter((b) => !recorded.has(b));
  if (missing.length > 0) {
    return { verdict: "fail", path: CHASE_ENTRY, constraint: `the conductor record misses ${missing.length} Part IR bodies that need a beam-free object, first ${missing.slice(0, 5).join(", ")}; export again from this build`, extra: { objects: raw.length, failing: missing.length, first: missing.slice(0, 5).join("; ") } };
  }

  let project: Record<string, unknown> = {};
  const psText = textOf(entries[PROJECT_SETTINGS]);
  if (psText !== undefined) {
    try {
      const v = JSON.parse(psText) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) project = v as Record<string, unknown>;
    } catch {
      // CHK-3MF-03 and -07 report an unreadable project_settings; the beam then reads the slicer default.
    }
  }
  const msText = textOf(entries[MODEL_SETTINGS]);
  const objects = msText === undefined ? new Map<string, Record<string, string>>() : objectMetadata(msText);
  const widthOf = new Map(raw.flatMap((o) => o.conductors.flatMap((c) => (typeof c.widthMm === "number" ? [[c.body, c.widthMm] as const] : []))));

  const failing: string[] = [];
  const losses: number[] = [];
  const widths: number[] = [];
  for (const o of raw) {
    const meta = objects.get(o.object);
    if (meta === undefined) {
      failing.push(`${o.object} (not in ${MODEL_SETTINGS})`);
      continue;
    }
    const from = meta[INTERLOCKING_BEAM] !== undefined ? "object" : project[INTERLOCKING_BEAM] !== undefined ? "project" : "slicer default";
    const on = from === "object" ? truthy(meta[INTERLOCKING_BEAM]) : from === "project" ? truthy(project[INTERLOCKING_BEAM]) : false;
    if (!on) continue;
    const width = numberOf(meta[INTERLOCKING_BEAM_WIDTH]) ?? numberOf(project[INTERLOCKING_BEAM_WIDTH]) ?? defaults?.beamWidthMm;
    const depth = numberOf(meta[INTERLOCKING_DEPTH]) ?? numberOf(project[INTERLOCKING_DEPTH]) ?? defaults?.depthCells;
    if (width !== undefined && depth !== undefined) losses.push(round(width * depth));
    const touching = [...new Set(o.touches.map((t) => t.body))];
    const named = [
      ...(o.conductors.length === 0 ? [] : [`holding ${o.conductors.map((c) => c.body).join(", ")}`]),
      ...(touching.length === 0 ? [] : [`touching ${touching.join(", ")}`]),
    ];
    for (const b of [...o.conductors.map((c) => c.body), ...o.touches.map((t) => t.conductor)]) {
      const w = widthOf.get(b);
      if (w !== undefined) widths.push(w);
    }
    failing.push(`${o.object} (from the ${from}; ${named.join("; ")})`);
  }
  const extra = { objects: raw.length, failing: failing.length };
  if (failing.length === 0) {
    return {
      verdict: "pass", path: MODEL_SETTINGS, extra,
      constraint: `interlocking_beam off on every object that holds or touches a conductor: ${raw.map((o) => o.object).join(", ")}`,
    };
  }
  const loss = losses.length === 0 ? undefined : Math.max(...losses);
  // The fix is the writer's own row (src/overrides.ts), so the check and the writer name one value.
  const off = OVERRIDE_ROWS.find((r) => r.key === INTERLOCKING_BEAM && r.wantedBy === CHK_3MF_08)!;
  const fix = `${off.key} ${off.value}`;
  const quote = loss === undefined
    ? "loss not quoted: no interlocking_depth or interlocking_beam_width default supplied"
    : `beams cut up to ${loss} mm per shared side (interlocking_depth x interlocking_beam_width, inferred upper bound: the slicer cell size is unverified and taken as one beam width)` +
      (widths.length === 0 ? "" : ` against conductors ${Math.min(...widths)} to ${Math.max(...widths)} mm wide`);
  return {
    verdict: "fail", path: MODEL_SETTINGS,
    constraint: `interlocking_beam on for ${failing.length} of ${raw.length} objects that hold or touch a conductor: ${failing.join("; ")}; ${quote}; set ${fix} on each object`,
    extra: {
      ...extra, first: failing.slice(0, 5).join("; "), fix,
      ...(loss === undefined ? {} : { lossMm: loss }),
      ...(widths.length === 0 ? {} : { widthMinMm: Math.min(...widths), widthMaxMm: Math.max(...widths) }),
    },
  };
}
