// The multi-filament 3MF writer, ported from the seed orca3mf.js with its
// public shape: build({filaments, printer, presetPattern, writeFilaments,
// layerHeight, title, objects}) returning {entries, zip()}, plus stl() and
// printCard(). Target bbs is the Orca and Bambu dialect Flash Studio reads
// (D-159); target core is plain 3MF with a Materials colorgroup.
//
// Export completeness (CHK-ART-01) runs before any byte is written; a fail
// returns the CheckResult and no entries. Every other refusal throws a
// command error naming the field. The writer repairs nothing: overlap,
// watertightness and slicer compatibility are proven by the validator.

import type { ArtifactHash, BodyAdjacency, BodyRole, BuildWarning, CheckResult, SlicerPreset, QuarterTurn, Vec3 } from "../contracts.js";
import { canonicalize } from "../contracts.js";
import type { MeshData } from "../mesh.js";
import { attribution } from "../metadata.js";
import { CONDUCTOR_RECORD, conductorObjects, overridesOf } from "../overrides.js";
import { printCard } from "./card.js";
import { exportCompleteness } from "./completeness.js";
import { CORE_CONTENT_TYPES, coreModelXml } from "./core.js";
import { clampEpoch, num } from "./fmt.js";
import { artifactHash, type Entries } from "./hash.js";
import {
  CONTENT_TYPES, FILAMENT_SEQUENCE, RELS, TURN, modelSettingsXml, modelXml, plan, sliceInfoXml,
  type WriterFilament, type WriterInstance, type WriterObject,
} from "./model.js";
import { appVersion, projectSettings, type WriterPrinter } from "./settings.js";
import { stlEntries } from "./stl.js";
import {
  DEFAULT_MATERIALS, DEFAULT_PRESETS, DEFAULT_TEMPLATE, exportError,
  type FilamentTemplate, type PresetTable, type SlicerMaterials,
} from "./template.js";
import { zipEntries } from "./zip.js";
import { didYouMean } from "./suggest.js";
import defaultPresetJson from "../../data/default_preset.json" with { type: "json" };

export { artifactHash, type Entries, type Members } from "./hash.js";
export { exportCompleteness, COMPLETENESS_ALIAS, COMPLETENESS_ID } from "./completeness.js";
export { fmt, num, DOS_EPOCH, clampEpoch, isoDay } from "./fmt.js";
export { printCard, signedVolume, type CardInput } from "./card.js";
export { stl, stlEntries, stlMemberNames } from "./stl.js";
export { zipEntries, sortedNames, wellFormedName, DEFLATE_LEVEL } from "./zip.js";
export { didYouMean, editDistance } from "./suggest.js";
export { FORBIDDEN_KEYS, SCALAR_KEYS, assertSettings, printerParts, projectSettings, type WriterPrinter } from "./settings.js";
export type { WriterFilament, WriterInstance, WriterObject, WriterPart } from "./model.js";
export { instanceTransform } from "./model.js";
export {
  DEFAULT_MATERIALS, DEFAULT_PRESETS, DEFAULT_TEMPLATE, TPU_FALLBACK_PRESET, filamentTemplate, presetTable, resolvePreset,
  slicerMaterials, type FilamentTemplate, type PresetRow, type PresetTable, type SlicerMaterialRow, type SlicerMaterials,
} from "./template.js";

/** Application tag of the gold save (D-159). */
export const DEFAULT_APP = "BambuStudio-01.10.01.50";

/** The machine preset slice a build with no printer writes (packages/3mf/data/default_preset.json). */
export interface DefaultPreset {
  readonly machine: string;
  readonly id: string;
  /** Nozzle diameter, mm. */
  readonly nozzle: number;
  readonly slicer: SlicerPreset;
}

/**
 * One row of packages/profile/data/machines.json, copied as data so the
 * package stands alone (D-027); tools/py/test/test_agreement.py holds it
 * equal to that row, and the Python writer defaults to the same row.
 */
export const DEFAULT_PRESET: DefaultPreset = defaultPresetJson;

/** Writer printer fields from MachinePreset.slicer: names, app and plate. */
export function printerOf(slicer: SlicerPreset): WriterPrinter {
  return {
    printer_settings_id: slicer.printer, print_settings_id: slicer.process, app: slicer.app,
    ...(slicer.bedType === undefined ? {} : { curr_bed_type: slicer.bedType }),
  };
}
const APP_PREFIXES = ["BambuStudio-", "OrcaSlicer-"] as const;

export type ExportTarget = "bbs" | "core";

export interface BuildConfig {
  readonly filaments: readonly WriterFilament[];
  /** Absent, printerOf(DEFAULT_PRESET.slicer), plate included. */
  readonly printer?: WriterPrinter;
  /** filament_settings_id per slot, "{TYPE}" replaced by the slot type. Absent, DEFAULT_PRESET.slicer.filament. */
  readonly presetPattern?: string;
  /** false keeps the machine's tuned presets and writes only the slot identity. */
  readonly writeFilaments?: boolean;
  /** Preset layer height, mm; the print card shows it, project_settings never carries it. */
  readonly layerHeight?: number;
  readonly title?: string;
  readonly objects: readonly WriterObject[];
  /** Seconds since 1970-01-01 UTC; fixes the model dates and the zip mtimes (D-052). */
  readonly sourceDateEpoch: number;
  /** Chase id and build hash, written to Metadata/hackbuild_chase.json (D-159). */
  readonly chase?: string;
  readonly buildHash?: string;
  /**
   * Part IR body adjacency (Part.bodyAdjacency) over the part `body` ids:
   * an object sharing a face with a conductor in another object gets no
   * interlocking beams (src/overrides.ts, M05-T20). Absent, only the
   * objects that hold a conductor part do.
   */
  readonly adjacency?: readonly BodyAdjacency[];
  /** SPDX id of the chase (ChaseMeta.license); the bbs License and the core LicenseTerms. Absent, empty. */
  readonly license?: string;
  /** Name part of the workspace root package.json author (authorName); Designer and Copyright. Absent, both empty. */
  readonly designer?: string;
  /** Preset nozzle diameter, mm; slice_info only. Absent, DEFAULT_PRESET.nozzle with no printer, else printer_variant. */
  readonly nozzleMm?: number;
  /** Preset line width, mm; the thin-wall row compares spring t against it (src/overrides.ts). Absent, no thin-wall row. */
  readonly lineWidthMm?: number;
  readonly target?: ExportTarget;
  readonly template?: FilamentTemplate;
  readonly presets?: PresetTable;
  readonly materials?: SlicerMaterials;
}

export interface Built {
  readonly ok: true;
  readonly target: ExportTarget;
  readonly entries: Entries;
  readonly warnings: readonly BuildWarning[];
  readonly completeness: CheckResult;
  readonly artifactHash: ArtifactHash;
  /** The .3mf bytes; equal for equal input and epoch. */
  zip(): Promise<Uint8Array>;
  /** The per-part STL fallback zip. */
  stlZip(): Promise<Uint8Array>;
  /** The print card text. */
  card(): string;
}

export interface Refused {
  readonly ok: false;
  readonly completeness: CheckResult;
}

/** Refuse what the slicer would load wrong or not at all, with the field named (step 11). */
function validate(cfg: BuildConfig, app: string, materials: SlicerMaterials): void {
  if (!APP_PREFIXES.some((p) => app.startsWith(p))) {
    throw exportError({ code: "E_SCHEMA", path: "/printer/app", got: app, expected: "BambuStudio- or OrcaSlicer- prefix",
      hint: "set the preset app tag; any other tag loads geometry only and drops the colours", record: "CHK-3MF-01" });
  }
  if (!Number.isInteger(cfg.sourceDateEpoch) || cfg.sourceDateEpoch < 0) {
    throw exportError({ code: "E_SCHEMA", path: "/sourceDateEpoch", got: cfg.sourceDateEpoch,
      expected: "whole seconds since 1970-01-01 UTC", hint: "pass SOURCE_DATE_EPOCH as an integer" });
  }
  const n = cfg.filaments.length;
  if (n < 1) throw exportError({ code: "E_SCHEMA", path: "/filaments", got: 0, expected: "at least one filament", hint: "load a filament" });
  cfg.filaments.forEach((f, i) => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(f.color)) {
      throw exportError({ code: "E_SCHEMA", path: `/filaments/${i}/color`, got: f.color, expected: "#RRGGBB", hint: "give the slot colour as six hex digits" });
    }
    if (materials[f.type] === undefined) {
      const known = Object.keys(materials);
      throw exportError({ code: "E_REF", path: `/filaments/${i}/type`, got: f.type, didYouMean: didYouMean(f.type, known),
        hint: `name a slicer type the material table holds: ${known.join(", ")}` });
    }
  });
  if (cfg.objects.length === 0) {
    throw exportError({ code: "E_SCHEMA", path: "/objects", got: 0, expected: "at least one object", hint: "export at least one object" });
  }
  cfg.objects.forEach((o, i) => {
    if (o.positions !== undefined && o.instances !== undefined) {
      throw exportError({ code: "E_SCHEMA", path: `/objects/${i}/instances`, got: o.instances.length, expected: "positions or instances, not both",
        hint: `object ${o.name} gives both; a plate layout writes instances only` });
    }
    (o.instances ?? []).forEach((inst, k) => {
      if (!Object.hasOwn(TURN, inst.rotZ)) {
        throw exportError({ code: "E_SCHEMA", path: `/objects/${i}/instances/${k}/rotZ`, got: inst.rotZ, expected: "0, 90, 180 or 270",
          hint: "turn an instance by a quarter turn about z" });
      }
      if (!inst.at.every(Number.isFinite)) {
        throw exportError({ code: "E_SCHEMA", path: `/objects/${i}/instances/${k}/at`, got: inst.at.join(" "), expected: "three finite mm values",
          hint: `instance ${k} of ${o.name} has no bed offset` });
      }
    });
    if (o.parts.length === 0) {
      throw exportError({ code: "E_SCHEMA", path: `/objects/${i}/parts`, got: 0, expected: "at least one part", hint: "give the object a part" });
    }
    o.parts.forEach((p, j) => {
      const at = `/objects/${i}/parts/${j}`;
      if (!Number.isInteger(p.slot) || p.slot < 1 || p.slot > n) {
        throw exportError({ code: "E_SCHEMA", path: `${at}/slot`, got: p.slot, expected: `slot 1 to ${n}`, hint: "assign the part to a loaded filament slot" });
      }
      const tris = p.indices.length;
      if (tris === 0 || tris % 3 !== 0 || p.positions.length % 3 !== 0) {
        throw exportError({ code: "E_SCHEMA", path: `${at}/indices`, got: tris, expected: "whole triangles, at least one",
          hint: `part ${p.name} has no triangles; build it before export` });
      }
      const nVert = p.positions.length / 3;
      for (let k = 0; k < tris; k += 1) {
        const ix = p.indices[k]!;
        if (!Number.isInteger(ix) || ix < 0 || ix >= nVert) {
          throw exportError({ code: "E_SCHEMA", path: `${at}/indices/${k}`, got: ix, expected: `index below ${nVert}`, hint: `part ${p.name} has an index out of range` });
        }
      }
    });
  });
}

/** Every package entry for one export, or the completeness fail and nothing else. */
export function build(cfg: BuildConfig): Built | Refused {
  const target = cfg.target ?? "bbs";
  const title = cfg.title ?? cfg.objects[0]?.name ?? "model";
  const completeness = exportCompleteness(`${title}.3mf`, cfg.objects);
  if (completeness.verdict === "fail") return { ok: false, completeness };

  const printer = cfg.printer ?? printerOf(DEFAULT_PRESET.slicer);
  const app = printer.app ?? DEFAULT_APP;
  const materials = cfg.materials ?? DEFAULT_MATERIALS;
  validate(cfg, app, materials);
  const P = plan(cfg.objects);
  const epoch = clampEpoch(cfg.sourceDateEpoch);
  // The conductor record goes in only when an object holds or touches a
  // conductor, so a package with none keeps its bytes (CHK-3MF-08 reads it).
  const conductors = conductorObjects(cfg.objects, cfg.adjacency);
  const chase = canonicalize({ chase: cfg.chase ?? "", buildHash: cfg.buildHash ?? "", ...(conductors.length === 0 ? {} : { [CONDUCTOR_RECORD]: conductors }) });
  const attr = attribution(cfg.designer, cfg.license, epoch);

  let entries: Record<string, string>;
  let warnings: readonly BuildWarning[] = [];
  if (target === "core") {
    entries = {
      "3D/3dmodel.model": coreModelXml(title, epoch, P, cfg.filaments, attr),
      "Metadata/hackbuild_chase.json": chase,
      "[Content_Types].xml": CORE_CONTENT_TYPES,
      "_rels/.rels": RELS,
    };
  } else {
    const ps = projectSettings({
      app, printer, presetPattern: cfg.presetPattern ?? DEFAULT_PRESET.slicer.filament, writeFilaments: cfg.writeFilaments ?? true,
      filaments: cfg.filaments, template: cfg.template ?? DEFAULT_TEMPLATE, presets: cfg.presets ?? DEFAULT_PRESETS, materials,
    });
    warnings = ps.warnings;
    const nozzle = cfg.nozzleMm !== undefined ? num(cfg.nozzleMm)
      : cfg.printer === undefined ? num(DEFAULT_PRESET.nozzle)
      // An empty variant reads as absent, as projectSettings and tools/py/orca3mf.py read it.
      : (printer.printer_variant === undefined || printer.printer_variant === "" ? "0.4" : printer.printer_variant);
    entries = {
      "3D/3dmodel.model": modelXml(app, title, epoch, P, attr),
      "Metadata/filament_sequence.json": FILAMENT_SEQUENCE,
      "Metadata/hackbuild_chase.json": chase,
      "Metadata/model_settings.config": modelSettingsXml(cfg.filaments.length, P, overridesOf(cfg.objects, cfg.adjacency, cfg.lineWidthMm)),
      "Metadata/project_settings.config": JSON.stringify(ps.settings, null, 4),
      "Metadata/slice_info.config": sliceInfoXml(appVersion(app), nozzle, P,
        cfg.filaments.map((f) => ({ tray: materials[f.type]!.tray, type: f.type, color: f.color.toUpperCase() }))),
      "[Content_Types].xml": CONTENT_TYPES,
      "_rels/.rels": RELS,
    };
  }
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(entries).sort()) sorted[k] = entries[k]!;
  return {
    ok: true,
    target,
    entries: sorted,
    warnings,
    completeness,
    artifactHash: artifactHash(sorted),
    zip: () => zipEntries(sorted, epoch),
    stlZip: () => zipEntries(stlEntries(cfg.objects), epoch),
    card: () => printCard({
      filaments: cfg.filaments, printer, ...(cfg.layerHeight === undefined ? {} : { layerHeight: cfg.layerHeight }), objects: cfg.objects, materials,
      ...(cfg.adjacency === undefined ? {} : { adjacency: cfg.adjacency }),
      ...(cfg.lineWidthMm === undefined ? {} : { lineWidthMm: cfg.lineWidthMm }),
    }),
  };
}

// ---- typed input for core: Part IR bodies on a machine preset ----

/** One loaded filament. slot n of a body is filaments[n - 1]. */
export interface FilamentSlot {
  /** "#RRGGBB". */
  readonly colour: string;
  /** Slicer filament type, a key of the material table, for example "PETG". */
  readonly type: string;
  /** Profile material id the slot carries, for example "cpla". */
  readonly material: string;
}

export interface BodyEntry {
  readonly name: string;
  /** 1 based filament slot. */
  readonly slot: number;
  /** Part IR body id and role; a conductor role sets the M05-T20 overrides (src/overrides.ts). */
  readonly body?: string;
  readonly role?: BodyRole;
  /** Declared conductor width, mm, for the CHK-3MF-08 loss quote. */
  readonly widthMm?: number;
  /** Thinnest t of the spring features on this body, mm, for the thin-wall row. */
  readonly springTMm?: number;
  /** Part coordinates, mm, bed at z = 0, triangles counter-clockwise from outside. */
  readonly mesh: MeshData;
}

export interface ObjectEntry {
  readonly name: string;
  /** Bed offset, mm; travels as the build item transform so vertices stay small. A plate layout replaces it. */
  readonly position: Vec3;
  readonly bodies: readonly BodyEntry[];
}

/** One placed copy of an object on a plate, from a nest Placement (M07-T08). */
export interface PlateInstance {
  /** Bed offset of the object origin after the turn, mm. */
  readonly at: Vec3;
  /** Counter-clockwise turn about +z seen from above, deg. */
  readonly rotZ: QuarterTurn;
}

/**
 * The instances of one plate, keyed by ObjectEntry name (M07-T02). Every
 * object of the export is named and has at least one instance; an object
 * the export lacks is refused, so no copy lands at an unplanned origin.
 */
export interface PlateLayout {
  readonly instances: Readonly<Record<string, readonly PlateInstance[]>>;
}

export interface ThreeMfInput {
  readonly title: string;
  readonly chase: string;
  readonly buildHash: string;
  /** ChaseMeta.license; absent, License stays empty. */
  readonly license?: string;
  /** authorName of the workspace root package.json author; absent, Designer and Copyright stay empty. */
  readonly designer?: string;
  readonly sourceDateEpoch: number;
  /** Preset slicer names; printer, process and plate are written as names only. */
  readonly slicer: SlicerPreset;
  /** Preset nozzle diameter, mm; written to slice_info only. */
  readonly nozzleMm: number;
  /** Preset line width, mm; absent, no thin-wall row. */
  readonly lineWidthMm?: number;
  readonly template: FilamentTemplate;
  readonly materials: SlicerMaterials;
  /** Absent, packages/3mf/data/filament_presets.json. */
  readonly presets?: PresetTable;
  readonly filaments: readonly FilamentSlot[];
  readonly objects: readonly ObjectEntry[];
  /** One plate's instances (M07-T02); absent, each object is written once at its position. */
  readonly plate?: PlateLayout;
  /** Part.bodyAdjacency of the build, over BodyEntry.body ids (M05-T20). */
  readonly adjacency?: readonly BodyAdjacency[];
  readonly target?: ExportTarget;
}

/** The instances a plate layout gives one object; refuses a layout that misses or invents an object. */
function plateInstances(plate: PlateLayout, objects: readonly ObjectEntry[]): ReadonlyMap<string, readonly WriterInstance[]> {
  const names = objects.map((o) => o.name);
  for (const key of Object.keys(plate.instances)) {
    if (!names.includes(key)) {
      throw exportError({ code: "E_REF", path: `/plate/instances/${key}`, got: key, didYouMean: didYouMean(key, names),
        hint: `name an object of this export: ${names.join(", ")}` });
    }
  }
  const out = new Map<string, readonly WriterInstance[]>();
  for (const name of names) {
    const list = Object.hasOwn(plate.instances, name) ? plate.instances[name]! : [];
    if (list.length === 0) {
      throw exportError({ code: "E_SCHEMA", path: `/plate/instances/${name}`, got: 0, expected: "at least one instance",
        hint: `place ${name} on the plate or leave it out of this export` });
    }
    out.set(name, list.map((p) => ({ at: p.at, rotZ: p.rotZ })));
  }
  return out;
}

export function configOf(inp: ThreeMfInput): BuildConfig {
  const placed = inp.plate === undefined ? undefined : plateInstances(inp.plate, inp.objects);
  return {
    title: inp.title, chase: inp.chase, buildHash: inp.buildHash, sourceDateEpoch: inp.sourceDateEpoch, nozzleMm: inp.nozzleMm,
    printer: printerOf(inp.slicer),
    presetPattern: inp.slicer.filament,
    template: inp.template, materials: inp.materials,
    ...(inp.presets === undefined ? {} : { presets: inp.presets }),
    ...(inp.target === undefined ? {} : { target: inp.target }),
    ...(inp.license === undefined ? {} : { license: inp.license }),
    ...(inp.designer === undefined ? {} : { designer: inp.designer }),
    ...(inp.adjacency === undefined ? {} : { adjacency: inp.adjacency }),
    ...(inp.lineWidthMm === undefined ? {} : { lineWidthMm: inp.lineWidthMm }),
    filaments: inp.filaments.map((f) => ({ color: f.colour, type: f.type, material: f.material })),
    objects: inp.objects.map((o) => ({
      name: o.name, ...(placed === undefined ? { positions: [o.position] } : { instances: placed.get(o.name)! }),
      parts: o.bodies.map((b) => ({
        name: b.name, slot: b.slot, positions: b.mesh.positions, indices: b.mesh.triangles,
        ...(b.body === undefined ? {} : { body: b.body }), ...(b.role === undefined ? {} : { role: b.role }),
        ...(b.widthMm === undefined ? {} : { widthMm: b.widthMm }),
        ...(b.springTMm === undefined ? {} : { springTMm: b.springTMm }),
      })),
    })),
  };
}

function built(inp: ThreeMfInput): Built {
  const out = build(configOf(inp));
  if (!out.ok) {
    throw exportError({ code: "E_SCHEMA", path: "/objects", got: String(out.completeness.extra?.["first"] ?? ""),
      expected: "resolved, unique object and part names", hint: "name every object and part once before export", record: out.completeness.id });
  }
  return out;
}

/** Every package entry, keyed by path, in sorted order. Throws on a completeness fail. */
export function threeMfEntries(inp: ThreeMfInput): Entries {
  return built(inp).entries;
}

/** Entries, bytes, artifactHash and warnings in one call. */
export async function write3mf(inp: ThreeMfInput): Promise<{
  readonly entries: Entries; readonly bytes: Uint8Array; readonly artifactHash: ArtifactHash; readonly warnings: readonly BuildWarning[];
}> {
  const b = built(inp);
  return { entries: b.entries, bytes: await b.zip(), artifactHash: b.artifactHash, warnings: b.warnings };
}
