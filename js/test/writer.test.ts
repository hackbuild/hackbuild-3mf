// M00-T07 steps 1, 3, 5, 6, 7, 10, 11: package entries for target bbs,
// the coordinate format, artifactHash, the chase record and the refusals.

import { describe, expect, it } from "vitest";
import { isThrownCommandError } from "../src/contracts.js";
import { sha256Hex } from "../src/contracts.js";
import {
  assertSettings, artifactHash, build, didYouMean, fmt, printCard, stl, DEFAULT_MATERIALS, DEFAULT_PRESET, printerOf,
  type BuildConfig, type Built,
} from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const CFG: BuildConfig = {
  title: "coin",
  chase: "collar-coin",
  buildHash: "b".repeat(64),
  sourceDateEpoch: EPOCH,
  filaments: [{ color: "#1a1a1a", type: "PETG", name: "black" }, { color: "#FE0386", type: "PETG" }],
  printer: printerOf(DEFAULT_PRESET.slicer),
  layerHeight: 0.24,
  objects: [
    { name: "coin", positions: [[128, 128, 0]], parts: [box("body", 1, [0, 0, 0], [10, 10, 2]), box("inlay", 2, [2, 2, 2], [6, 6, 0.5])] },
    { name: "tag", positions: [[60, 60, 0], [90, 60, 0]], parts: [box("tag", 2, [0, 0, 0], [5, 5, 1])] },
  ],
};

const ok = (cfg: BuildConfig = CFG): Built => {
  const b = build(cfg);
  if (!b.ok) throw new Error(`completeness failed: ${String(b.completeness.extra?.["first"])}`);
  return b;
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isThrownCommandError(e) ? e.hbf.code : `not a command error: ${String(e)}`;
  }
  return undefined;
}

describe("bbs package entries (M00-T07 step 3)", () => {
  const b = ok();
  const model = b.entries["3D/3dmodel.model"]!;

  it("writes exactly the eight bbs entries in sorted order", () => {
    expect(Object.keys(b.entries)).toEqual([
      "3D/3dmodel.model", "Metadata/filament_sequence.json", "Metadata/hackbuild_chase.json", "Metadata/model_settings.config",
      "Metadata/project_settings.config", "Metadata/slice_info.config", "[Content_Types].xml", "_rels/.rels",
    ]);
  });

  it("keeps meshes in the root model with p:UUIDs and no p:path", () => {
    expect(model).not.toContain("p:path");
    const objects = [...model.matchAll(/<object id="(\d+)" p:UUID="([0-9a-f-]{36})"/g)];
    expect(objects).toHaveLength(5);
    expect([...model.matchAll(/<component objectid="\d+" p:UUID="[0-9a-f-]{36}"/g)]).toHaveLength(3);
    expect(model).toMatch(/<build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">/);
    const items = [...model.matchAll(/<item [^>]*\/>/g)].map((m) => m[0]);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toMatch(/p:UUID="[0-9a-f]{8}-b1ec-4553-aec9-835e5b724bb4"/);
      expect(item).toContain('printable="1"');
      expect(item).toContain('auto_drop="1"');
    }
  });

  it("writes the gold filament_sequence bytes and the plate filament map", () => {
    expect(b.entries["Metadata/filament_sequence.json"]).toBe('{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}');
    const ms = b.entries["Metadata/model_settings.config"]!;
    expect(ms).toContain('<metadata key="filament_map_mode" value="Auto For Flush"/>');
    expect(ms).toContain('<metadata key="filament_maps" value="1 1"/>');
    expect([...ms.matchAll(/key="identify_id" value="(\d+)"/g)].map((m) => m[1])).toEqual(["401", "402", "403"]);
  });

  it("dates the model from the epoch and leaves the credit fields empty (D-001, D-052)", () => {
    expect(model).toContain('<metadata name="CreationDate">2026-10-04</metadata>');
    expect(model).toContain('<metadata name="ModificationDate">2026-10-04</metadata>');
    for (const k of ["Designer", "DesignerUserId", "Copyright"]) expect(model).toContain(`<metadata name="${k}"></metadata>`);
    const all = Object.values(b.entries).join("\n") + b.card();
    expect(all).not.toMatch(/claude|anthropic|openai|chatgpt|copilot|generated with|co-authored/i);
  });

  it("writes the chase record as canonical JSON with chase and buildHash only (step 7)", () => {
    expect(b.entries["Metadata/hackbuild_chase.json"]).toBe(`{"buildHash":"${"b".repeat(64)}","chase":"collar-coin"}`);
  });
});

describe("coordinate format (step 5, D-054)", () => {
  it("prints grid values exactly, strips zeros and writes -0 as 0", () => {
    expect(fmt(0)).toBe("0");
    expect(fmt(-0)).toBe("0");
    expect(fmt(128)).toBe("128");
    expect(fmt(1 / 1024)).toBe("0.0009765625");
    expect(fmt(-3 / 1024)).toBe("-0.0029296875");
    expect(fmt(2.5)).toBe("2.5");
    expect(fmt(-1e-12)).toBe("0");
    expect(() => fmt(Number.NaN)).toThrow();
  });

  it("refuses a non-finite coordinate with the fields the Python writer uses", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: unknown;
      try { fmt(v); } catch (e) { caught = e; }
      expect(isThrownCommandError(caught)).toBe(true);
      if (!isThrownCommandError(caught)) continue;
      expect(caught.hbf).toMatchObject({ code: "E_SCHEMA", path: "/objects/mesh/positions", got: String(v), expected: "a finite coordinate, mm" });
    }
  });

  it("writes every vertex in that format", () => {
    const b = ok({ ...CFG, objects: [{ name: "o", parts: [box("p", 1, [-1 / 1024, 0, 0], [10 + 1 / 512, 1, 1])] }] });
    const xs = [...b.entries["3D/3dmodel.model"]!.matchAll(/<vertex x="([^"]+)"/g)].map((m) => m[1]);
    expect(xs).toContain("-0.0009765625");
    expect(xs).toContain("10.0009765625");
  });
});

describe("artifactHash (step 6)", () => {
  it("is sha256 of name NUL sha256 LF over sorted entries with the model dates blanked", () => {
    const b = ok();
    const lines = Object.keys(b.entries).sort().map((name) => {
      let text = b.entries[name]!;
      if (name === "3D/3dmodel.model") text = text.replace(/(<metadata name="(?:CreationDate|ModificationDate)">)[^<]*/g, "$1");
      return `${name}\u0000${sha256Hex(new TextEncoder().encode(text))}\n`;
    });
    expect(b.artifactHash).toBe(sha256Hex(new TextEncoder().encode(lines.join(""))));
    expect(artifactHash(b.entries)).toBe(b.artifactHash);
  });

  it("holds across epochs and moves with the geometry", () => {
    expect(ok({ ...CFG, sourceDateEpoch: EPOCH + 86400 * 40 }).artifactHash).toBe(ok().artifactHash);
    const moved = { ...CFG, objects: [{ ...CFG.objects[0]!, parts: [box("body", 1, [0, 0, 0], [10, 10, 2.5])] }] };
    expect(ok(moved).artifactHash).not.toBe(ok().artifactHash);
  });
});

describe("refusals (step 11)", () => {
  const obj = CFG.objects[0]!;
  it("refuses a slot out of range", () => {
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, parts: [box("body", 3, [0, 0, 0], [1, 1, 1])] }] }))).toBe("E_SCHEMA");
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, parts: [box("body", 0, [0, 0, 0], [1, 1, 1])] }] }))).toBe("E_SCHEMA");
  });

  it("refuses a NaN vertex with E_SCHEMA", () => {
    const part = box("body", 1, [0, 0, 0], [1, 1, 1]);
    const positions = Float64Array.from(part.positions);
    positions[4] = Number.NaN;
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, parts: [{ ...part, positions }] }] }))).toBe("E_SCHEMA");
  });

  it("refuses a part with no triangles", () => {
    const empty = { name: "body", slot: 1, positions: new Float64Array(0), indices: new Uint32Array(0) };
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, parts: [empty] }] }))).toBe("E_SCHEMA");
  });

  it("refuses a per-filament vector of the wrong length and extruder_variant_list", () => {
    expect(codeOf(() => assertSettings({ filament_colour: ["#000000"] }, 2))).toBe("E_SCHEMA");
    expect(codeOf(() => assertSettings({ extruder_variant_list: ["Direct Drive Standard"] }, 1))).toBe("E_SCHEMA");
    expect(codeOf(() => assertSettings({ layer_height: "0.2" }, 1))).toBe("E_SCHEMA");
    expect(codeOf(() => assertSettings({ filament_colour: ["#000000", "#FFFFFF"], version: "01.10.01.50" }, 2))).toBeUndefined();
  });

  it("refuses an app tag the slicer reads as geometry only and a type with no material row", () => {
    expect(codeOf(() => build({ ...CFG, printer: { ...CFG.printer, app: "Cura-5" } }))).toBe("E_SCHEMA");
    expect(codeOf(() => build({ ...CFG, filaments: [{ color: "#000000", type: "PETGX" }, CFG.filaments[1]!] }))).toBe("E_REF");
  });

  it("refuses a type with a material row but no harvested preset row", () => {
    expect(codeOf(() => build({ ...CFG, filaments: [{ color: "#000000", type: "ABS" }, CFG.filaments[1]!] }))).toBe("E_REF");
  });
});

function hbfOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    if (isThrownCommandError(e)) return e.hbf as unknown as Record<string, unknown>;
    throw e;
  }
  throw new Error("no refusal");
}

describe("didYouMean ranks by edit distance (spec/errors.ts)", () => {
  it("puts the nearest id first, keeps table order on ties and leaves out got", () => {
    expect(didYouMean("PTEG", ["ABS", "ASA", "PLA", "PETG", "TPU"])).toEqual(["PETG", "PLA", "TPU"]);
    expect(didYouMean("PLA", ["ABS", "PLA", "PETG"])).toEqual(["ABS", "PETG"]);
    expect(didYouMean(undefined, ["PLA", "ABS", "TPU", "PETG"])).toEqual(["PLA", "ABS", "TPU"]);
  });

  it("suggests the intended filament type and preset id, not the first table keys", () => {
    const type = hbfOf(() => build({ ...CFG, filaments: [{ color: "#000000", type: "PTEG" }, CFG.filaments[1]!] }));
    expect(type["code"]).toBe("E_REF");
    expect((type["didYouMean"] as string[])[0]).toBe("PETG");
    const preset = hbfOf(() => build({ ...CFG, presetPattern: "Generic PTEG @FF C5P" }));
    expect(preset["code"]).toBe("E_REF");
    expect((preset["didYouMean"] as string[])[0]).toBe("Generic PETG @FF C5P");
  });
});

describe("a build with no printer writes the default machine preset", () => {
  it("equals the build on printerOf(DEFAULT_PRESET.slicer), plate and nozzle included", () => {
    const { printer: _p, ...bare } = CFG;
    const none = ok(bare);
    const named = ok({ ...bare, printer: printerOf(DEFAULT_PRESET.slicer), presetPattern: DEFAULT_PRESET.slicer.filament, nozzleMm: DEFAULT_PRESET.nozzle });
    expect(none.entries).toEqual(named.entries);
    const ps = JSON.parse(none.entries["Metadata/project_settings.config"]!) as Record<string, unknown>;
    expect(ps["curr_bed_type"]).toBe(DEFAULT_PRESET.slicer.bedType);
    expect(ps["printer_settings_id"]).toBe(DEFAULT_PRESET.slicer.printer);
  });
});

describe("stl and print card (step 1)", () => {
  it("writes a binary STL of 84 + 50 n bytes with the part name in the header", () => {
    const part = box("body", 1, [0, 0, 0], [10, 10, 2]);
    const bytes = stl(part);
    expect(bytes.length).toBe(84 + 12 * 50);
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(12);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("body");
  });

  it("prints each slot with grams computed from volume and density", () => {
    const card = printCard({ filaments: CFG.filaments, printer: CFG.printer!, layerHeight: 0.24, objects: CFG.objects, materials: DEFAULT_MATERIALS });
    // slot 1: 10 x 10 x 2 mm = 200 mm3 at 1.27 g/cm3 vendor = 0.254 g, computed.
    expect(card).toContain("slot 1   : #1A1A1A PETG   black   0.3 g computed");
    // slot 2: 6 x 6 x 0.5 + 2 instances x 5 x 5 x 1 = 68 mm3, 0.0864 g, computed.
    expect(card).toContain("slot 2   : #FE0386 PETG      0.1 g computed");
    expect(card).toContain("layer    : 0.24 mm, preset");
    expect(card).toContain("object tag x2: tag(slot 2)");
    expect(card).toContain("plate    : Textured PEI Plate");
  });
});
