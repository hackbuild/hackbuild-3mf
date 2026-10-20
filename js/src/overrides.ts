// Per-object and per-part slicer overrides from body roles (M05-T20, D-159
// per-object overrides; research/3dp-landscape.md section 9 gap 3, section
// 10 item 2 and section 11 idea 8). Interlocking beams interleave two
// filaments up to `interlocking_depth` cells from their boundary, which eats
// a conductor's cross section, and a conductor's resistance assumes a solid
// section (CHK-NET-05). So a part whose body role is a conductor gets solid
// infill, and every object that holds a conductor part or shares a face with
// one gets `interlocking_beam` 0. Both go into Metadata/model_settings.config
// as part and object metadata: they are process keys, and CHK-3MF-03 keeps
// refusing them in project_settings.config.
//
// The same table yields the conductor record the writer puts in
// Metadata/hackbuild_chase.json, which CHK-3MF-08 reads (src/validate/chk-3mf-08.ts
// and tools/py/checks/chk_3mf_08.py), so the writer and the check name the
// same objects. Body roles and adjacency come from Part IR (spec/part-ir.ts
// Body.role, Part.bodyAdjacency).
//
// A click spring beam drawn under 1.5 line widths thick prints as one line,
// and the classic wall generator drops such a wall unless thin-wall
// detection is on (pip RECORD 5.2 "Print"; haft model.js line 540). The
// Flashforge profile 02.01.01.02 bundled with Flash Studio 1.7.14 gives
// process "0.24mm Standard @FF C5" wall_generator classic (from
// fdm_process_flashforge_common) and detect_thin_wall 0 (from
// fdm_process_common), vendor, read from the app's profiles. So every
// object holding such a beam gets `detect_thin_wall` 1. CHK-KEY-04 gates
// the beam's force on its drawn t, which holds only if the beam prints.

import type { BodyAdjacency, BodyRole, CheckId } from "./contracts.js";
import type { WriterObject, WriterPart } from "./writer/model.js";

export const INTERLOCKING_BEAM = "interlocking_beam";
export const INTERLOCKING_BEAM_WIDTH = "interlocking_beam_width";
export const INTERLOCKING_DEPTH = "interlocking_depth";
export const SPARSE_INFILL_DENSITY = "sparse_infill_density";
export const DETECT_THIN_WALL = "detect_thin_wall";
/** A spring beam thinner than this many line widths is one line (PIP RECORD 5.2; brief R1-flagship-access-switch-07). */
export const THIN_WALL_LINES = 1.5;
/** Key of the conductor record in Metadata/hackbuild_chase.json. */
export const CONDUCTOR_RECORD = "conductors";

/** Body roles that carry current: their parts get solid infill and their objects no beams. */
export const CONDUCTOR_ROLES: readonly BodyRole[] = ["conductor", "flex-conductor"];
export const isConductorRole = (role: BodyRole | undefined): boolean => role !== undefined && CONDUCTOR_ROLES.includes(role);

/** One row of the override table (M05-T20 step 2). */
export interface OverrideRow {
  readonly appliesTo: string;
  readonly scope: "part" | "object";
  readonly key: string;
  readonly value: string;
  /** The check that wants the value; null when no check asks yet. */
  readonly wantedBy: CheckId | null;
  /** False: the row is recorded and the writer does not write it. */
  readonly written: boolean;
}

/**
 * The override table. The TPU row waits for a fit check that asks for the
 * beam, so it stays off in M05. A conductor row wins over any other row for
 * the same object.
 */
export const OVERRIDE_ROWS: readonly OverrideRow[] = [
  {
    appliesTo: "part whose body role is conductor or flex-conductor", scope: "part",
    key: SPARSE_INFILL_DENSITY, value: "100%", wantedBy: "CHK-NET-05", written: true,
  },
  {
    appliesTo: "object holding a conductor part, or sharing a face with one", scope: "object",
    key: INTERLOCKING_BEAM, value: "0", wantedBy: "CHK-3MF-08", written: true,
  },
  {
    appliesTo: "object holding a TPU body bonded to PETG with no conductor adjacency", scope: "object",
    key: INTERLOCKING_BEAM, value: "1", wantedBy: null, written: false,
  },
  {
    appliesTo: "object holding a body with a spring feature whose t is under 1.5 line widths", scope: "object",
    key: DETECT_THIN_WALL, value: "1", wantedBy: "CHK-KEY-04", written: true,
  },
];

const row = (key: string, scope: OverrideRow["scope"]): OverrideRow => OVERRIDE_ROWS.find((r) => r.key === key && r.scope === scope && r.written)!;

/** A conductor part of an object, as the record names it. */
export interface ConductorPart {
  /** Part name in model_settings. */
  readonly part: string;
  /** Body id in Part IR. */
  readonly body: string;
  readonly role: BodyRole;
  /** Declared conductor width, mm, where a conductor feature declares one. */
  readonly widthMm?: number;
}

/** A part of an object that shares a face with a conductor body, in this object or another. */
export interface ConductorTouch {
  readonly part: string;
  readonly body: string;
  /** The conductor body it touches. */
  readonly conductor: string;
  /** Shared area, mm2 (Part.bodyAdjacency, computed). */
  readonly areaMm2: number;
}

/** One object that must print without interlocking beams. */
export interface ConductorObject {
  readonly object: string;
  readonly conductors: readonly ConductorPart[];
  readonly touches: readonly ConductorTouch[];
}

/**
 * The objects that hold a conductor part or share a face with one, in
 * object order: each conductor part, then each other part of the object that
 * touches a conductor body. Adjacency rows naming a body no part carries are
 * ignored, so a caller may pass the part's whole list.
 */
export function conductorObjects(objects: readonly WriterObject[], adjacency: readonly BodyAdjacency[] = []): ConductorObject[] {
  const roleOf = new Map<string, BodyRole | undefined>();
  for (const o of objects) for (const p of o.parts) if (p.body !== undefined) roleOf.set(p.body, p.role);
  const conductor = (body: string): boolean => isConductorRole(roleOf.get(body));
  const out: ConductorObject[] = [];
  for (const o of objects) {
    const conductors: ConductorPart[] = o.parts.flatMap((p) => (p.body !== undefined && isConductorRole(p.role)
      ? [{ part: p.name, body: p.body, role: p.role!, ...(p.widthMm === undefined ? {} : { widthMm: p.widthMm }) }]
      : []));
    const touches: ConductorTouch[] = [];
    for (const p of o.parts) {
      if (p.body === undefined || isConductorRole(p.role)) continue;
      for (const r of adjacency) {
        const other = r.a === p.body ? r.b : r.b === p.body ? r.a : undefined;
        if (other !== undefined && conductor(other)) touches.push({ part: p.name, body: p.body, conductor: other, areaMm2: r.areaMm2 });
      }
    }
    if (conductors.length > 0 || touches.length > 0) out.push({ object: o.name, conductors, touches });
  }
  return out;
}

/** The metadata one object and each of its parts carry, keys in write order. */
export interface ObjectOverrides {
  readonly object: Readonly<Record<string, string>>;
  readonly parts: readonly Readonly<Record<string, string>>[];
}

/**
 * True when a part carries a spring beam that prints as one line: its
 * thinnest spring t under THIN_WALL_LINES line widths. No line width, no
 * test, so a caller without a preset writes no thin-wall row.
 */
export const isOneLineBeam = (part: WriterPart, lineWidthMm: number | undefined): boolean =>
  part.springTMm !== undefined && lineWidthMm !== undefined && part.springTMm < THIN_WALL_LINES * lineWidthMm;

/**
 * Overrides per object, in object order (M05-T20 step 2). An object no row
 * applies to gets empty records. lineWidthMm is the preset line width the
 * thin-wall row compares spring t against.
 */
export function overridesOf(objects: readonly WriterObject[], adjacency: readonly BodyAdjacency[] = [], lineWidthMm?: number): ObjectOverrides[] {
  const beamFree = new Set(conductorObjects(objects, adjacency).map((c) => c.object));
  const infill = row(SPARSE_INFILL_DENSITY, "part");
  const beam = row(INTERLOCKING_BEAM, "object");
  const thin = row(DETECT_THIN_WALL, "object");
  return objects.map((o) => ({
    object: {
      ...(beamFree.has(o.name) ? { [beam.key]: beam.value } : {}),
      ...(o.parts.some((p) => isOneLineBeam(p, lineWidthMm)) ? { [thin.key]: thin.value } : {}),
    },
    parts: o.parts.map((p) => (isConductorRole(p.role) ? { [infill.key]: infill.value } : {})),
  }));
}

/**
 * Bodies of a Part IR that must sit in a beam-free object: every conductor
 * body and every body sharing a face with one, sorted. CHK-3MF-08 holds a
 * package's record against this when the build is at hand.
 */
export function beamFreeBodies(bodies: readonly { readonly id: string; readonly role: BodyRole }[], adjacency: readonly BodyAdjacency[] = []): string[] {
  const conductors = new Set(bodies.filter((b) => isConductorRole(b.role)).map((b) => b.id));
  const out = new Set(conductors);
  for (const r of adjacency) {
    if (conductors.has(r.a)) out.add(r.b);
    if (conductors.has(r.b)) out.add(r.a);
  }
  return [...out].sort();
}
