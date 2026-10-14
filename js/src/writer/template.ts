// The per-filament key template and the preset rows that fill it (D-159,
// C-07). The template is the 127 per-filament keys of the gold save; a
// slot takes each non-computed key from the preset row its
// filament_settings_id names, and rows come from slicer saves only
// (packages/3mf/scripts/harvest-presets.mjs). The writer reads both JSON
// files directly; no copy of them lives in code.

import type { BuildWarning, CommandError, ThrownCommandError, Tier } from "../contracts.js";
import templateJson from "../../data/filament_template.json" with { type: "json" };
import presetsJson from "../../data/filament_presets.json" with { type: "json" };
import materialsJson from "../../seed/materials.json" with { type: "json" };
import { didYouMean } from "./suggest.js";

export function exportError(hbf: CommandError): ThrownCommandError {
  return Object.assign(new Error(hbf.hint), { hbf });
}

/** The harvested filament template (packages/3mf/data/filament_template.json, D-159). */
export interface FilamentTemplate {
  /** Filaments in the slicer save the template was harvested from, count. */
  readonly filamentCount: number;
  /** Every per-filament key with one value per harvested slot. */
  readonly keys: Readonly<Record<string, readonly string[]>>;
  /** Keys the writer computes per filament from the material row and the filament. */
  readonly computed: readonly string[];
}

/**
 * Slicer defaults per filament type (packages/3mf/seed/materials.json):
 * temperatures in C, density g/cm3, cost per kg, max volumetric speed
 * mm3/s, fan speeds percent. Vendor ballparks from the Orca Generic
 * profiles; the slicer preset named by filament_settings_id governs.
 */
export interface SlicerMaterialRow {
  readonly tray: string;
  readonly nozzle: number;
  readonly nozzle_first: number;
  readonly bed: number;
  readonly bed_first: number;
  readonly density: number;
  readonly cost: number;
  readonly vitrification: number;
  readonly maxvol: number;
  readonly fan_max: number;
  readonly fan_min: number;
  readonly overhang_fan: number;
  readonly flow: number;
  readonly range_low: number;
  readonly range_high: number;
}

export type SlicerMaterials = Readonly<Record<string, SlicerMaterialRow>>;

/** One slicer preset column: every template key as the slicer saved it. */
export interface PresetRow {
  /** Repo path or absolute path of the slicer save the row came from. */
  readonly source: string;
  /** 1 based slot of the save the row was read from. */
  readonly slot: number;
  readonly tier: Tier;
  readonly values: Readonly<Record<string, string>>;
}

/** Preset rows by filament_settings_id. */
export type PresetTable = Readonly<Record<string, PresetRow>>;

/** The column a TPU slot borrows until a slicer save holds Generic TPU @FF C5P (PROFILE.md 8.1). */
export const TPU_FALLBACK_PRESET = "Generic PETG @FF C5P";

/** Parse the harvested template JSON, refusing a template the writer cannot honour. */
export function filamentTemplate(json: unknown): FilamentTemplate {
  const bad = (path: string, hint: string): ThrownCommandError => exportError({ code: "E_SCHEMA", path, hint, record: "3mf-dialect" });
  if (typeof json !== "object" || json === null) throw bad("", "filament template is not an object");
  const t = json as Record<string, unknown>;
  const count = t["filamentCount"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) throw bad("/filamentCount", "filamentCount must be a positive integer");
  const keys = t["keys"];
  if (typeof keys !== "object" || keys === null) throw bad("/keys", "keys must be an object of string arrays");
  for (const [k, v] of Object.entries(keys)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw bad(`/keys/${k}`, "every template value must be a string");
  }
  const computed = t["computed"];
  if (!Array.isArray(computed) || !computed.every((x) => typeof x === "string")) throw bad("/computed", "computed must be a list of key names");
  return { filamentCount: count, keys: keys as Record<string, string[]>, computed: computed as string[] };
}

/** Parse the seed material table (packages/3mf/seed/materials.json); keys starting "_" are notes. */
export function slicerMaterials(json: unknown): SlicerMaterials {
  if (typeof json !== "object" || json === null) {
    throw exportError({ code: "E_SCHEMA", path: "", hint: "material table is not an object" });
  }
  const out: Record<string, SlicerMaterialRow> = {};
  const fields: readonly (keyof SlicerMaterialRow)[] = [
    "nozzle", "nozzle_first", "bed", "bed_first", "density", "cost", "vitrification", "maxvol", "fan_max", "fan_min",
    "overhang_fan", "flow", "range_low", "range_high",
  ];
  for (const [type, row] of Object.entries(json as Record<string, unknown>)) {
    if (type.startsWith("_")) continue;
    const r = row as Record<string, unknown>;
    if (typeof r["tray"] !== "string") throw exportError({ code: "E_SCHEMA", path: `/${type}/tray`, hint: "every material row needs a tray id" });
    for (const f of fields) {
      if (typeof r[f] !== "number") throw exportError({ code: "E_SCHEMA", path: `/${type}/${f}`, hint: `material row ${type} needs a numeric ${f}` });
    }
    out[type] = r as unknown as SlicerMaterialRow;
  }
  return out;
}

/** Parse packages/3mf/data/filament_presets.json. */
export function presetTable(json: unknown): PresetTable {
  const bad = (path: string, hint: string): ThrownCommandError => exportError({ code: "E_SCHEMA", path, hint, record: "3mf-dialect" });
  if (typeof json !== "object" || json === null) throw bad("", "preset table is not an object");
  const rows = (json as Record<string, unknown>)["rows"];
  if (typeof rows !== "object" || rows === null) throw bad("/rows", "rows must be an object keyed by filament_settings_id");
  for (const [id, row] of Object.entries(rows as Record<string, unknown>)) {
    const r = row as Record<string, unknown>;
    if (typeof r["source"] !== "string" || typeof r["slot"] !== "number" || typeof r["tier"] !== "string") {
      throw bad(`/rows/${id}`, "a preset row needs source, slot and tier");
    }
    const values = r["values"];
    if (typeof values !== "object" || values === null || !Object.values(values).every((v) => typeof v === "string")) {
      throw bad(`/rows/${id}/values`, "every preset value must be a string");
    }
  }
  return rows as PresetTable;
}

export const DEFAULT_TEMPLATE: FilamentTemplate = filamentTemplate(templateJson);
export const DEFAULT_PRESETS: PresetTable = presetTable(presetsJson);
export const DEFAULT_MATERIALS: SlicerMaterials = slicerMaterials(materialsJson);

export interface ResolvedPreset {
  readonly id: string;
  readonly row: PresetRow;
  readonly warning?: BuildWarning;
}

/**
 * The preset row a slot writes. A TPU slot with no harvested row borrows
 * the Generic PETG column at tier inferred and raises a warning; any other
 * missing row is refused, since a guessed row would reach the printer.
 */
export function resolvePreset(settingsId: string, type: string, presets: PresetTable, at: string): ResolvedPreset {
  const row = presets[settingsId];
  if (row !== undefined) return { id: settingsId, row };
  const fallback = presets[TPU_FALLBACK_PRESET];
  if (type === "TPU" && fallback !== undefined) {
    return {
      id: settingsId,
      row: { ...fallback, tier: "inferred" },
      warning: {
        code: "PRESET_INFERRED",
        text: `TPU preset row inferred: ${settingsId} takes the ${TPU_FALLBACK_PRESET} column until a slicer save holds it`,
        param: at,
      },
    };
  }
  throw exportError({
    code: "E_REF", path: at, got: settingsId, didYouMean: didYouMean(settingsId, Object.keys(presets)),
    hint: `no harvested preset row for ${settingsId}; save a project with it in the slicer and rerun packages/3mf/scripts/harvest-presets.mjs`,
    record: "3mf-dialect",
  });
}
