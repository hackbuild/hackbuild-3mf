// The print card (seed orca3mf.js printCard): what to load, on which
// slot, and the fallback when the filament list imports as one. It is
// regenerated with every export and carries no tool or author credit.

import type { BodyAdjacency } from "../contracts.js";
import { overridesOf } from "../overrides.js";
import type { WriterFilament, WriterObject, WriterPart } from "./model.js";
import type { WriterPrinter } from "./settings.js";
import type { SlicerMaterials } from "./template.js";

/** Signed volume of a closed part, mm3; positive when wound counter-clockwise from outside. */
export function signedVolume(part: WriterPart): number {
  const p = part.positions;
  const ix = part.indices;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3, b = ix[i + 1]! * 3, c = ix[i + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export interface CardInput {
  readonly filaments: readonly WriterFilament[];
  readonly printer: WriterPrinter;
  /** Preset layer height, mm. */
  readonly layerHeight?: number;
  readonly objects: readonly WriterObject[];
  readonly materials: SlicerMaterials;
  /** Part IR body adjacency, for the per-object overrides (src/overrides.ts). */
  readonly adjacency?: readonly BodyAdjacency[];
  /** Preset line width, mm, for the thin-wall row (src/overrides.ts). */
  readonly lineWidthMm?: number;
}

export function printCard(cfg: CardInput): string {
  const L: string[] = [
    "print card", "========================================",
    `printer  : ${cfg.printer.printer_settings_id ?? "(unchanged)"}`,
    `process  : ${cfg.printer.print_settings_id ?? "(unchanged)"}`,
    `plate    : ${cfg.printer.curr_bed_type ?? "(unchanged)"}`,
    `layer    : ${cfg.layerHeight === undefined ? "(preset)" : `${cfg.layerHeight.toFixed(2)} mm, preset`}`,
    "",
  ];
  const vol = new Map<number, number>();
  for (const o of cfg.objects) {
    const instances = o.positions !== undefined && o.positions.length > 0 ? o.positions.length : 1;
    for (const part of o.parts) vol.set(part.slot, (vol.get(part.slot) ?? 0) + Math.abs(signedVolume(part)) * instances);
  }
  cfg.filaments.forEach((f, i) => {
    const density = cfg.materials[f.type]?.density ?? 0;
    const grams = ((vol.get(i + 1) ?? 0) / 1000) * density;
    L.push(`slot ${i + 1}   : ${f.color.toUpperCase()} ${f.type}   ${f.name ?? ""}   ${grams.toFixed(1)} g computed from volume and vendor density`);
  });
  L.push("");
  for (const o of cfg.objects) {
    const instances = o.positions !== undefined && o.positions.length > 0 ? o.positions.length : 1;
    L.push(`object ${o.name} x${instances}: ${o.parts.map((p) => `${p.name}(slot ${p.slot})`).join(", ")}`);
  }
  // Whether Flash Studio honours these from model_settings.config is open
  // until the owner opens an export in it (M05-T20 open item), so the card
  // lists each one for the person to confirm in the slicer.
  const overrides = overridesOf(cfg.objects, cfg.adjacency, cfg.lineWidthMm).flatMap((ov, k) => {
    const o = cfg.objects[k]!;
    const set = (rec: Readonly<Record<string, string>>): string => Object.entries(rec).map(([key, v]) => `${key} ${v}`).join(", ");
    return [
      ...(Object.keys(ov.object).length === 0 ? [] : [`object ${o.name}: ${set(ov.object)}`]),
      ...ov.parts.flatMap((rec, i) => (Object.keys(rec).length === 0 ? [] : [`part ${o.parts[i]!.name} of ${o.name}: ${set(rec)}`])),
    ];
  });
  if (overrides.length > 0) {
    L.push("", "per-object settings written to the file; confirm each in the slicer object list before slicing:", ...overrides);
  }
  L.push("", "fallback if the filament list imports as one: open all per part STLs at once, answer yes to",
    "'load as a single object with multiple parts', then set the filament per part.");
  return `${L.join("\n")}\n`;
}
