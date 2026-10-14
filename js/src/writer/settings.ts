// Metadata/project_settings.config for target bbs (D-159, C-07, M00-T07
// step 2). Every template key is written N times, N the filament count
// (num_filaments is read from len(filament_colour)). Outside the template
// only the scalar keys that name the printer and the file go in, so Flash
// Studio matches its own presets instead of inventing an external one.

import type { BuildWarning } from "../contracts.js";
import { num } from "./fmt.js";
import type { WriterFilament } from "./model.js";
import {
  exportError, resolvePreset, type FilamentTemplate, type PresetTable, type SlicerMaterialRow, type SlicerMaterials,
} from "./template.js";

/** Printer and process names, written as names only (seed DEFAULT_PRINTER keys). */
export interface WriterPrinter {
  readonly printer_settings_id?: string;
  readonly print_settings_id?: string;
  /** Absent, read from printer_settings_id "<model> <variant> nozzle". */
  readonly printer_model?: string;
  readonly printer_variant?: string;
  /** Build plate, an OrcaSlicer enum string; MachinePreset.slicer.bedType. */
  readonly curr_bed_type?: string;
  /** Application string, for example "BambuStudio-01.10.01.50". */
  readonly app?: string;
}

/** The loader asserts on this key (knowledge/kernels/3mf-dialect.md). */
export const FORBIDDEN_KEYS = ["extruder_variant_list", "layer_height"] as const;

/** The scalar keys the writer may write besides the template, in the gold's spelling. */
export const SCALAR_KEYS = [
  "curr_bed_type", "from", "name", "print_settings_id", "printer_model", "printer_settings_id", "printer_technology",
  "printer_variant", "version",
] as const;

/** Keys that follow the loaded slot whatever preset the slot names. */
function identityValues(f: WriterFilament, slot: number): Readonly<Record<string, string>> {
  return { filament_multi_colour: f.color.toUpperCase(), filament_self_index: String(slot), filament_map: "1" };
}

/** The computed per-filament keys for one slot (seed orca3mf.js projectSettings). */
function computedValues(f: WriterFilament, m: SlicerMaterialRow, settingsId: string): Readonly<Record<string, string>> {
  const bed = num(m.bed);
  const bedFirst = num(m.bed_first);
  return {
    filament_colour: f.color.toUpperCase(), filament_type: f.type, filament_vendor: "Generic", filament_ids: m.tray,
    filament_settings_id: settingsId, filament_density: num(m.density), filament_cost: num(m.cost),
    filament_flow_ratio: num(m.flow), filament_max_volumetric_speed: num(m.maxvol),
    nozzle_temperature: num(m.nozzle), nozzle_temperature_initial_layer: num(m.nozzle_first),
    nozzle_temperature_range_low: num(m.range_low), nozzle_temperature_range_high: num(m.range_high),
    hot_plate_temp: bed, hot_plate_temp_initial_layer: bedFirst, cool_plate_temp: bed, cool_plate_temp_initial_layer: bedFirst,
    eng_plate_temp: bed, eng_plate_temp_initial_layer: bedFirst, textured_plate_temp: bed, textured_plate_temp_initial_layer: bedFirst,
    textured_cool_plate_temp: bed, textured_cool_plate_temp_initial_layer: bedFirst,
    supertack_plate_temp: bed, supertack_plate_temp_initial_layer: bedFirst,
    temperature_vitrification: num(m.vitrification), fan_max_speed: num(m.fan_max), fan_min_speed: num(m.fan_min),
    overhang_fan_speed: num(m.overhang_fan),
  };
}

/** Model and variant from an Orca printer preset name, "Flashforge Creator 5 Pro 0.4 nozzle". */
export function printerParts(settingsId: string): { readonly model: string; readonly variant: string } | undefined {
  const m = /^(.+) (\d+(?:\.\d+)?) nozzle$/.exec(settingsId);
  return m === null ? undefined : { model: m[1]!, variant: m[2]! };
}

export const appVersion = (app: string): string => app.replace(/^[^-]*-/, "");

export interface SettingsInput {
  readonly app: string;
  readonly printer: WriterPrinter;
  readonly presetPattern: string;
  readonly writeFilaments: boolean;
  readonly filaments: readonly WriterFilament[];
  readonly template: FilamentTemplate;
  readonly presets: PresetTable;
  readonly materials: SlicerMaterials;
}

/** project_settings keys plus the warnings the preset lookup raised. */
export function projectSettings(inp: SettingsInput): { readonly settings: Record<string, unknown>; readonly warnings: readonly BuildWarning[] } {
  const ps: Record<string, unknown> = { from: "project", name: "project_settings", version: appVersion(inp.app) };
  const pr = inp.printer;
  if (pr.printer_settings_id !== undefined && pr.printer_settings_id !== "") {
    const parts = printerParts(pr.printer_settings_id);
    ps["printer_settings_id"] = pr.printer_settings_id;
    ps["printer_technology"] = "FFF";
    const model = pr.printer_model ?? parts?.model;
    const variant = pr.printer_variant ?? parts?.variant;
    if (model !== undefined && model !== "") ps["printer_model"] = model;
    if (variant !== undefined && variant !== "") ps["printer_variant"] = variant;
  }
  if (pr.print_settings_id !== undefined && pr.print_settings_id !== "") ps["print_settings_id"] = pr.print_settings_id;
  if (pr.curr_bed_type !== undefined && pr.curr_bed_type !== "") ps["curr_bed_type"] = pr.curr_bed_type;

  const F = inp.filaments;
  const ids = F.map((f) => f.preset ?? inp.presetPattern.replace("{TYPE}", f.type));
  const warnings: BuildWarning[] = [];
  if (!inp.writeFilaments) {
    // The machine keeps its tuned presets; only the slot identity goes in (seed writeFilaments false).
    ps["filament_colour"] = F.map((f) => f.color.toUpperCase());
    ps["filament_settings_id"] = ids;
    ps["filament_type"] = F.map((f) => f.type);
  } else {
    const computed = new Set(inp.template.computed);
    const perSlot = F.map((f, i) => {
      const at = `/filaments/${i}/type`;
      const preset = resolvePreset(ids[i]!, f.type, inp.presets, at);
      if (preset.warning !== undefined) warnings.push(preset.warning);
      return { preset, computed: computedValues(f, inp.materials[f.type]!, ids[i]!), identity: identityValues(f, i + 1) };
    });
    for (const key of Object.keys(inp.template.keys)) {
      ps[key] = perSlot.map((s, i) => {
        if (computed.has(key)) {
          const v = s.computed[key];
          if (v === undefined) {
            throw exportError({ code: "E_SCHEMA", path: "/template/computed", got: key,
              expected: "a key the writer computes", hint: "drop the key from computed or teach the writer to compute it", record: "3mf-dialect" });
          }
          return v;
        }
        const v = s.identity[key] ?? s.preset.row.values[key];
        if (v === undefined) {
          throw exportError({ code: "E_SCHEMA", path: `/filaments/${i}`, got: key, expected: "a value in the preset row",
            hint: `preset ${s.preset.id} lacks ${key}; re-harvest the preset rows`, record: "3mf-dialect" });
        }
        return v;
      });
    }
  }
  assertSettings(ps, F.length);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(ps).sort()) sorted[k] = ps[k];
  return { settings: sorted, warnings };
}

/** Refuse a vector of the wrong length and any key the loader asserts on (M00-T07 step 11). */
export function assertSettings(ps: Readonly<Record<string, unknown>>, n: number): void {
  for (const k of FORBIDDEN_KEYS) {
    if (k in ps) {
      throw exportError({ code: "E_SCHEMA", path: `/${k}`, got: k, expected: "no printer- or process-scoped key",
        hint: `remove ${k} from the settings; the loader asserts on it or it overrides the process preset`, record: "3mf-dialect" });
    }
  }
  for (const [k, v] of Object.entries(ps)) {
    if (Array.isArray(v) && v.length !== n) {
      throw exportError({ code: "E_SCHEMA", path: `/${k}`, got: v.length, expected: `${n} values, one per filament`,
        hint: `per-filament key ${k} has the wrong length`, record: "CHK-3MF-02" });
    }
  }
}
