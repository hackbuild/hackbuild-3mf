// M00-T07 step 2 (D-159, C-07): the per-filament key set equals the 127
// keys of the gold save, each slot takes the values of the preset its
// filament_settings_id names, and only the named scalar keys go in beside.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { build, DEFAULT_PRESETS, DEFAULT_TEMPLATE, SCALAR_KEYS, type BuildConfig, type WriterFilament } from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const GOLD = new URL("../../corpus/gold/hackbuild-coin-nfc.3mf", import.meta.url);
const gold = JSON.parse(await (await JSZip.loadAsync(readFileSync(GOLD))).file("Metadata/project_settings.config")!.async("string")) as Record<string, unknown>;
const goldN = (gold["filament_colour"] as string[]).length;
/** Per-filament keys of the gold, counted from the gold: array values of the filament count that are not extruder keys. */
const goldPerFilament = Object.keys(gold).filter((k) => Array.isArray(gold[k]) && (gold[k] as unknown[]).length === goldN && DEFAULT_TEMPLATE.keys[k] !== undefined);
const goldIds = gold["filament_settings_id"] as string[];

const PRINTER = {
  printer_settings_id: "Flashforge Creator 5 Pro 0.4 nozzle", print_settings_id: "0.24mm Standard @FF C5", curr_bed_type: "Textured PEI Plate",
} as const;

function settingsOf(filaments: readonly WriterFilament[]): { readonly ps: Record<string, unknown>; readonly warnings: readonly string[] } {
  const cfg: BuildConfig = {
    title: "t", sourceDateEpoch: EPOCH, printer: PRINTER, filaments,
    objects: [{ name: "o", parts: filaments.map((_, i) => box(`p${i + 1}`, i + 1, [i * 12, 0, 0], [10, 10, 1])) }],
  };
  const b = build(cfg);
  if (!b.ok) throw new Error("completeness failed");
  return { ps: JSON.parse(b.entries["Metadata/project_settings.config"]!) as Record<string, unknown>, warnings: b.warnings.map((w) => w.text) };
}

const three: readonly WriterFilament[] = [
  { color: "#1A1A1A", type: "PETG" }, { color: "#FFFFFF", type: "PLA" }, { color: "#FB02FF", type: "PETG" },
];

describe("filament template (M00-T07 step 2)", () => {
  it("counts 127 per-filament keys in the gold, 29 of them computed", () => {
    expect(goldPerFilament.length).toBe(Object.keys(DEFAULT_TEMPLATE.keys).length);
    expect(goldPerFilament.length).toBe(127);
    expect(DEFAULT_TEMPLATE.computed.every((k) => goldPerFilament.includes(k))).toBe(true);
    expect(DEFAULT_TEMPLATE.computed.length).toBe(29);
  });

  it("writes exactly the 127 gold keys per filament for a 3-filament export", () => {
    const { ps } = settingsOf(three);
    const perFilament = Object.keys(ps).filter((k) => Array.isArray(ps[k]));
    expect(new Set(perFilament)).toEqual(new Set(goldPerFilament));
    for (const k of perFilament) expect((ps[k] as unknown[]).length, k).toBe(3);
  });

  it("keeps filament_map, filament_self_index and filament_extruder_variant as the gold does", () => {
    const { ps } = settingsOf(three);
    expect(ps["filament_map"]).toEqual(["1", "1", "1"]);
    expect(ps["filament_self_index"]).toEqual(["1", "2", "3"]);
    expect(ps["filament_extruder_variant"]).toEqual(["Direct Drive Standard", "Direct Drive Standard", "Direct Drive Standard"]);
  });

  it("writes no printer- or process-scoped key", () => {
    const { ps } = settingsOf(three);
    expect(ps).not.toHaveProperty("extruder_variant_list");
    expect(ps).not.toHaveProperty("layer_height");
  });

  it("writes outside the template only the nine scalar keys of step 2 (D-226)", () => {
    const { ps } = settingsOf(three);
    const outside = Object.keys(ps).filter((k) => DEFAULT_TEMPLATE.keys[k] === undefined).sort();
    expect(outside).toEqual([...SCALAR_KEYS].sort());
    expect(outside).toHaveLength(9);
    expect(Object.keys(ps)).toHaveLength(Object.keys(DEFAULT_TEMPLATE.keys).length + 9);
    expect(ps).toMatchObject({
      version: "01.10.01.50", from: "project", name: "project_settings", printer_settings_id: PRINTER.printer_settings_id,
      print_settings_id: PRINTER.print_settings_id, printer_model: "Flashforge Creator 5 Pro", printer_variant: "0.4",
      printer_technology: "FFF", curr_bed_type: "Textured PEI Plate",
    });
    // The gold names High Temp Plate; curr_bed_type follows the machine preset (D-226).
    for (const k of outside.filter((x) => x !== "curr_bed_type")) expect(ps[k], k).toBe(gold[k]);
  });

  it("gives each slot the non-computed values of the preset it names, matching the gold column by column", () => {
    const filaments = goldIds.map((id, i) => ({ color: (gold["filament_colour"] as string[])[i]!, type: "PETG", preset: id }));
    const { ps } = settingsOf(filaments);
    const computed = new Set(DEFAULT_TEMPLATE.computed);
    const nonComputed = goldPerFilament.filter((k) => !computed.has(k));
    expect(nonComputed.length).toBe(98);
    for (const k of nonComputed) expect(ps[k], k).toEqual(gold[k]);
  });

  it("computes each of the 29 computed keys from the seed material row, slot by slot", () => {
    // Expected values come from seed/materials.json read here, never through the writer's computedValues().
    type Row = Record<"tray" | "nozzle" | "nozzle_first" | "bed" | "bed_first" | "density" | "cost" | "vitrification" | "maxvol" | "fan_max" | "fan_min" | "overhang_fan" | "flow" | "range_low" | "range_high", string | number>;
    const seed = JSON.parse(readFileSync(new URL("../seed/materials.json", import.meta.url), "utf8")) as Record<string, Row>;
    const slots: readonly WriterFilament[] = [{ color: "#1a1a1a", type: "PETG" }, { color: "#ffffff", type: "PLA" }, { color: "#80aB40", type: "TPU" }];
    // The mutation M4 of the 2026-10-05 audit (nozzle_first written as nozzle) stays visible only while the rows differ.
    for (const t of ["PETG", "PLA", "TPU"]) expect(seed[t]!.nozzle_first, t).not.toBe(seed[t]!.nozzle);
    const expected = (f: WriterFilament): Record<string, string> => {
      const r = seed[f.type]!;
      const s = (k: keyof Row): string => String(r[k]);
      const plates = ["hot", "cool", "eng", "textured", "textured_cool", "supertack"];
      return {
        filament_colour: f.color.toUpperCase(), filament_type: f.type, filament_vendor: "Generic", filament_ids: s("tray"),
        filament_settings_id: `Generic ${f.type} @FF C5P`, filament_density: s("density"), filament_cost: s("cost"),
        filament_flow_ratio: s("flow"), filament_max_volumetric_speed: s("maxvol"),
        nozzle_temperature: s("nozzle"), nozzle_temperature_initial_layer: s("nozzle_first"),
        nozzle_temperature_range_low: s("range_low"), nozzle_temperature_range_high: s("range_high"),
        ...Object.fromEntries(plates.flatMap((p) => [[`${p}_plate_temp`, s("bed")], [`${p}_plate_temp_initial_layer`, s("bed_first")]])),
        temperature_vitrification: s("vitrification"), fan_max_speed: s("fan_max"), fan_min_speed: s("fan_min"),
        overhang_fan_speed: s("overhang_fan"),
      };
    };
    expect(Object.keys(expected(slots[0]!)).sort()).toEqual([...DEFAULT_TEMPLATE.computed].sort());
    const { ps } = settingsOf(slots);
    slots.forEach((f, i) => {
      for (const [k, v] of Object.entries(expected(f))) expect((ps[k] as string[])[i], `${f.type} ${k}`).toBe(v);
    });
  });

  it("takes the PLA slot from the harvested Generic PLA @FF C5P row", () => {
    const { ps, warnings } = settingsOf(three);
    const pla = DEFAULT_PRESETS["Generic PLA @FF C5P"]!;
    expect(pla.source).toMatch(/facewithbuttons\.3mf$/);
    expect((ps["pressure_advance"] as string[])[1]).toBe(pla.values["pressure_advance"]);
    expect((ps["filament_settings_id"] as string[])[1]).toBe("Generic PLA @FF C5P");
    expect(warnings).toEqual([]);
  });

  it("raises TPU preset row inferred and borrows the Generic PETG column for a TPU slot", () => {
    const { ps, warnings } = settingsOf([...three.slice(0, 2), { color: "#808080", type: "TPU" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^TPU preset row inferred/);
    const petg = DEFAULT_PRESETS["Generic PETG @FF C5P"]!;
    expect((ps["filament_start_gcode"] as string[])[2]).toBe(petg.values["filament_start_gcode"]);
    expect((ps["filament_settings_id"] as string[])[2]).toBe("Generic TPU @FF C5P");
    expect((ps["filament_type"] as string[])[2]).toBe("TPU");
  });
});
