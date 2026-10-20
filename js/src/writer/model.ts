// The bbs package entries other than project_settings: the root model,
// model_settings, slice_info, content types and relationships. Ported from
// the seed orca3mf.js (modelXml, modelSettingsXml, sliceInfoXml) with the
// gold's build item attributes and the D-054 coordinate format.

import type { BodyRole, QuarterTurn, Vec3 } from "../contracts.js";
import type { Attribution } from "../metadata.js";
import type { ObjectOverrides } from "../overrides.js";
import { esc, fmt, isoDay } from "./fmt.js";

/** One part: mm, part local, bed at z = 0, triangles counter-clockwise from outside. */
export interface WriterPart {
  readonly name: string;
  /** 1 based filament slot. */
  readonly slot: number;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Part IR body id this part carries; the overrides and the conductor record name it (M05-T20). */
  readonly body?: string;
  /** Part IR body role; a conductor role gets solid infill and a beam-free object (src/overrides.ts). */
  readonly role?: BodyRole;
  /** Declared conductor width, mm, from the conductor feature of the same id; the CHK-3MF-08 loss quote reads it. */
  readonly widthMm?: number;
  /** Thinnest t of the spring features on this body, mm; the thin-wall row reads it (src/overrides.ts). */
  readonly springTMm?: number;
}

/**
 * One placed instance: the object turned about the bed normal at its own
 * origin, then moved by `at`. A plate layout (M07-T02) writes these.
 */
export interface WriterInstance {
  /** Bed offset, mm. */
  readonly at: Vec3;
  /** Counter-clockwise turn about +z seen from above, deg. */
  readonly rotZ: QuarterTurn;
}

export interface WriterObject {
  readonly name: string;
  /** One bed offset per instance, mm; absent, one instance at the origin. */
  readonly positions?: readonly Vec3[];
  /** Placed instances with a turn; give this or positions, never both. */
  readonly instances?: readonly WriterInstance[];
  readonly parts: readonly WriterPart[];
}

/** One loaded filament; slot n of a part is filaments[n - 1]. */
export interface WriterFilament {
  /** "#RRGGBB". */
  readonly color: string;
  /** Slicer filament type, a key of the material table, for example "PETG". */
  readonly type: string;
  /** filament_settings_id of this slot; absent, the preset pattern with the slot type. */
  readonly preset?: string;
  /** Spool label for the print card. */
  readonly name?: string;
  /** Profile material id, written to the chase record. */
  readonly material?: string;
}

export interface Planned {
  readonly obj: WriterObject;
  readonly meshIds: readonly number[];
  readonly objId: number;
  readonly pos: readonly WriterInstance[];
}

/** Fixed p:UUID suffixes and the build UUID (seed orca3mf.js SUF, BUILD_UUID); lib3mf warns 32944 without them. */
const SUF = {
  object: "-61cb-4c03-9d28-80fed5dfa1dc",
  sub: "-81cb-4c03-9d28-80fed5dfa1dc",
  comp: "-b206-40ff-9872-83e8017abed1",
  item: "-b1ec-4553-aec9-835e5b724bb4",
} as const;
const BUILD_UUID = "2c7c17d8-22b5-4d84-8835-1976022ea369";
/** identify_id the slicer gives the first instance on plate 1. */
const FIRST_IDENTIFY_ID = 401;

const uuid = (n: number, suffix: string): string => (n >>> 0).toString(16).padStart(8, "0") + suffix;

/**
 * The 3x3 part of a 3MF transform for a quarter turn, as written: m00 m01
 * m02 m10 m11 m12 m20 m21 m22, applied to a row vector (3MF Core, 3D Matrices), so
 * 90 maps (x, y) to (-y, x). Literal rows keep -0 and rounding out of the bytes.
 */
export const TURN: Readonly<Record<QuarterTurn, string>> = {
  0: "1 0 0 0 1 0 0 0 1",
  90: "0 1 0 -1 0 0 0 0 1",
  180: "-1 0 0 0 -1 0 0 0 1",
  270: "0 -1 0 1 0 0 0 0 1",
};

/** The transform attribute of one instance; a turn of 0 writes the identity as before. */
export function instanceTransform(inst: WriterInstance): string {
  const [x, y, z] = inst.at;
  return `${TURN[inst.rotZ]} ${fmt(x)} ${fmt(y)} ${fmt(z)}`;
}

export function plan(objects: readonly WriterObject[]): Planned[] {
  let next = 1;
  return objects.map((obj) => {
    const meshIds = obj.parts.map(() => next++);
    const pos: readonly WriterInstance[] = obj.instances !== undefined && obj.instances.length > 0 ? obj.instances
      : obj.positions !== undefined && obj.positions.length > 0 ? obj.positions.map((at) => ({ at, rotZ: 0 }))
      : [{ at: [0, 0, 0], rotZ: 0 }];
    return { obj, meshIds, objId: next++, pos };
  });
}

export function meshXml(part: WriterPart, triangleAttr: (k: number) => string): string {
  const out: string[] = ["   <mesh>\n    <vertices>\n"];
  const p = part.positions;
  for (let k = 0; k < p.length; k += 3) {
    out.push(`     <vertex x="${fmt(p[k]!)}" y="${fmt(p[k + 1]!)}" z="${fmt(p[k + 2]!)}"/>\n`);
  }
  out.push("    </vertices>\n    <triangles>\n");
  const ix = part.indices;
  for (let k = 0; k < ix.length; k += 3) {
    out.push(`     <triangle v1="${ix[k]!}" v2="${ix[k + 1]!}" v3="${ix[k + 2]!}"${triangleAttr(k / 3)}/>\n`);
  }
  out.push("    </triangles>\n   </mesh>\n");
  return out.join("");
}

export function modelXml(app: string, title: string, epoch: number, P: readonly Planned[], attr: Attribution): string {
  const day = isoDay(epoch);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n',
  ];
  // License, Designer and Copyright per LICENSING.md 1.4 (src/metadata.ts); DesignerUserId, Origin and DesignerCover stay empty.
  const meta: readonly (readonly [string, string])[] = [
    ["Application", app], ["BambuStudio:3mfVersion", "1"], ["Copyright", attr.copyright], ["CreationDate", day],
    ["Description", ""], ["Designer", attr.designer], ["DesignerCover", ""], ["DesignerUserId", ""], ["License", attr.license],
    ["ModificationDate", day], ["Origin", ""], ["Title", title],
  ];
  for (const [k, v] of meta) out.push(` <metadata name="${k}">${esc(v)}</metadata>\n`);
  out.push(" <resources>\n");
  for (const p of P) {
    p.obj.parts.forEach((part, i) => {
      const mid = p.meshIds[i]!;
      out.push(`  <object id="${mid}" p:UUID="${uuid(mid, SUF.sub)}" type="model">\n`, meshXml(part, () => ""), "  </object>\n");
    });
    // Root components carry no p:path: the meshes live in this part (dialect record, empty-plate bug).
    out.push(`  <object id="${p.objId}" p:UUID="${uuid(p.objId, SUF.object)}" type="model">\n   <components>\n`);
    for (const mid of p.meshIds) {
      out.push(`    <component objectid="${mid}" p:UUID="${uuid(mid, SUF.comp)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`);
    }
    out.push("   </components>\n  </object>\n");
  }
  out.push(` </resources>\n <build p:UUID="${BUILD_UUID}">\n`);
  let n = 1;
  for (const p of P) {
    for (const inst of p.pos) {
      out.push(`  <item objectid="${p.objId}" p:UUID="${uuid(n++, SUF.item)}" transform="${instanceTransform(inst)}" printable="1" auto_drop="1"/>\n`);
    }
  }
  out.push(" </build>\n</model>\n");
  return out.join("");
}

/** Metadata lines for one override record, keys in record order. */
const overrideLines = (indent: string, rec: Readonly<Record<string, string>> | undefined): string =>
  Object.entries(rec ?? {}).map(([k, v]) => `${indent}<metadata key="${esc(k)}" value="${esc(v)}"/>\n`).join("");

/**
 * Metadata/model_settings.config. `overrides` holds one record per object
 * (src/overrides.ts overridesOf): object keys follow the object extruder,
 * part keys follow the part extruder, as a slicer save writes per-object
 * settings (D-159).
 */
export function modelSettingsXml(filamentCount: number, P: readonly Planned[], overrides?: readonly ObjectOverrides[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
  for (const [k, p] of P.entries()) {
    const ov = overrides?.[k];
    out.push(`  <object id="${p.objId}">\n    <metadata key="name" value="${esc(p.obj.name)}"/>\n` +
      `    <metadata key="extruder" value="${p.obj.parts[0]!.slot}"/>\n` + overrideLines("    ", ov?.object));
    p.obj.parts.forEach((part, i) => {
      out.push(`    <part id="${p.meshIds[i]!}" subtype="normal_part">\n` +
        `      <metadata key="name" value="${esc(part.name)}"/>\n` +
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
        `      <metadata key="source_file" value="${esc(p.obj.name)}.3mf"/>\n` +
        '      <metadata key="source_object_id" value="0"/>\n' +
        `      <metadata key="source_volume_id" value="${i}"/>\n` +
        '      <metadata key="source_offset_x" value="0"/>\n      <metadata key="source_offset_y" value="0"/>\n      <metadata key="source_offset_z" value="0"/>\n' +
        `      <metadata key="extruder" value="${part.slot}"/>\n` + overrideLines("      ", ov?.parts[i]) +
        `      <mesh_stat face_count="${part.indices.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n` +
        "    </part>\n");
    });
    out.push("  </object>\n");
  }
  out.push('  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n' +
    '    <metadata key="locked" value="false"/>\n    <metadata key="filament_map_mode" value="Auto For Flush"/>\n' +
    `    <metadata key="filament_maps" value="${Array.from({ length: filamentCount }, () => "1").join(" ")}"/>\n`);
  let ident = FIRST_IDENTIFY_ID;
  for (const p of P) {
    p.pos.forEach((_, i) => {
      out.push(`    <model_instance>\n      <metadata key="object_id" value="${p.objId}"/>\n      <metadata key="instance_id" value="${i}"/>\n` +
        `      <metadata key="identify_id" value="${ident++}"/>\n    </model_instance>\n`);
    });
  }
  out.push("  </plate>\n  <assemble>\n");
  for (const p of P) {
    p.pos.forEach((inst, i) => {
      out.push(`   <assemble_item object_id="${p.objId}" instance_id="${i}" transform="${instanceTransform(inst)}" offset="0 0 0" />\n`);
    });
  }
  out.push("  </assemble>\n</config>\n");
  return out.join("");
}

export interface SliceFilament {
  readonly tray: string;
  readonly type: string;
  readonly color: string;
}

export function sliceInfoXml(version: string, nozzle: string, P: readonly Planned[], filaments: readonly SliceFilament[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    `    <header_item key="X-BBL-Client-Version" value="${esc(version)}"/>\n  </header>\n  <plate>\n`];
  const meta: readonly (readonly [string, string])[] = [
    ["index", "1"], ["printer_model_id", ""], ["nozzle_diameters", nozzle], ["timelapse_type", "0"], ["prediction", "0"],
    ["weight", "0"], ["outside", "false"], ["support_used", "false"], ["label_object_enabled", "false"],
  ];
  for (const [k, v] of meta) out.push(`    <metadata key="${k}" value="${esc(v)}"/>\n`);
  let ident = FIRST_IDENTIFY_ID;
  for (const p of P) p.pos.forEach(() => out.push(`    <object identify_id="${ident++}" name="${esc(p.obj.name)}" skipped="false" />\n`));
  filaments.forEach((f, i) => {
    out.push(`    <filament id="${i + 1}" tray_info_idx="${esc(f.tray)}" type="${esc(f.type)}" color="${esc(f.color)}" used_m="0" used_g="0" />\n`);
  });
  out.push("  </plate>\n</config>\n");
  return out.join("");
}

export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  ' <Default Extension="png" ContentType="image/png"/>\n</Types>\n';

export const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';

/** The gold's bytes for this entry; the seed never wrote it. */
export const FILAMENT_SEQUENCE = '{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}';
