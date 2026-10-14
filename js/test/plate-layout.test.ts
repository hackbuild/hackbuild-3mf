// M07-T02 step 2: the 3mf writer takes an optional plate layout, one
// placed instance per copy with a quarter turn about z. The oracle is the
// OGEE R16-P plate page's writeSTL rule (designs/ogee16/legacy/source/
// plate_template.html lines 409 to 418, sha256 prefix 59507bfae682869f):
// a part turned 90 maps (lx, ly) to (-ly + x + d, lx + y), d its depth.
// The test reads those lines from the legacy file, parses the written
// transform by the 3MF row vector rule, and compares vertex for vertex.
// The legacy file lives in hackbuild-fab only, so without a fab checkout the
// read-back test skips with that reason and the vertex test still runs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isThrownCommandError, type QuarterTurn, type Vec3 } from "../src/contracts.js";
import {
  DEFAULT_MATERIALS, DEFAULT_PRESET, DEFAULT_TEMPLATE, build, configOf, instanceTransform, printerOf, threeMfEntries,
  type BuildConfig, type Built, type ThreeMfInput,
} from "../src/index.js";
import { box, EPOCH } from "./cube.js";

// The hackbuild-fab checkout: HBF_FAB, or the sibling ../hackbuild-fab.
const FAB = resolve(process.env["HBF_FAB"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hackbuild-fab"));
const LEGACY = join(FAB, "designs/ogee16/legacy/source/plate_template.html");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isThrownCommandError(e) ? e.hbf.code : `not a command error: ${String(e)}`;
  }
  return undefined;
}

/** A 3MF transform attribute applied to a point as a row vector (3MF Core, 3D Matrices). */
function apply(transform: string, [x, y, z]: Vec3): Vec3 {
  const m = transform.split(" ").map(Number);
  expect(m).toHaveLength(12);
  return [
    x * m[0]! + y * m[3]! + z * m[6]! + m[9]!,
    x * m[1]! + y * m[4]! + z * m[7]! + m[10]!,
    x * m[2]! + y * m[5]! + z * m[8]! + m[11]!,
  ];
}

/** The legacy writeSTL placement of one vertex, R a 90 turn, part.d the part depth in y, mm. */
function legacyPlace(it: { readonly x: number; readonly y: number; readonly rot: 0 | 90 }, d: number, [lx, ly, lz]: Vec3): Vec3 {
  const R = it.rot !== 0;
  const ox = it.x + (R ? d : 0), oy = it.y;
  return [(R ? -ly : lx) + ox, (R ? lx : ly) + oy, lz];
}

const W = 20, D = 8, H = 3;
const part = box("lever", 1, [0, 0, 0], [W, D, H]);
const verts = (): Vec3[] => Array.from({ length: part.positions.length / 3 }, (_, i) => [
  part.positions[i * 3]!, part.positions[i * 3 + 1]!, part.positions[i * 3 + 2]!,
] as const);

const CFG: BuildConfig = {
  title: "plate-01", sourceDateEpoch: EPOCH, printer: printerOf(DEFAULT_PRESET.slicer),
  filaments: [{ color: "#1a1a1a", type: "PETG" }],
  objects: [{ name: "lever", instances: [{ at: [10, 10, 0], rotZ: 0 }, { at: [30 + D, 40, 0], rotZ: 90 }], parts: [part] }],
};

const ok = (cfg: BuildConfig): Built => {
  const b = build(cfg);
  if (!b.ok) throw new Error(`completeness failed: ${String(b.completeness.extra?.["first"])}`);
  return b;
};

const itemTransforms = (model: string): string[] => [...model.matchAll(/<item objectid="\d+"[^>]* transform="([^"]+)"/g)].map((m) => m[1]!);

describe("plate layout input (M07-T02)", () => {
  // skipped where designs/ogee16/legacy is absent: the hackbuild-3mf split carries no legacy designs
  it.skipIf(!existsSync(LEGACY))("ports the legacy turn rule, read from the legacy file", () => {
    const text = readFileSync(LEGACY, "utf8");
    expect(text).toContain("const R = s.it.rot, ox = s.it.x + (R ? s.it.part.d : 0), oy = s.it.y;");
    expect(text).toContain("dv.setFloat32(o,   (R ? -ly : lx) + ox, true);");
    expect(text).toContain("dv.setFloat32(o+4, (R ?  lx : ly) + oy, true);");
  });

  it("writes a 90 turn whose vertices equal the legacy plate placement", () => {
    const model = ok(CFG).entries["3D/3dmodel.model"]!;
    const [t0, t90] = itemTransforms(model);
    expect(t0).toBe("1 0 0 0 1 0 0 0 1 10 10 0");
    expect(t90).toBe("0 1 0 -1 0 0 0 0 1 38 40 0");
    for (const v of verts()) {
      expect(apply(t0!, v)).toEqual(legacyPlace({ x: 10, y: 10, rot: 0 }, D, v));
      expect(apply(t90!, v)).toEqual(legacyPlace({ x: 30, y: 40, rot: 90 }, D, v));
    }
    // the turned footprint starts at the packer's corner and swaps width and depth
    const placed = verts().map((v) => apply(t90!, v));
    expect(Math.min(...placed.map((p) => p[0]))).toBe(30);
    expect(Math.min(...placed.map((p) => p[1]))).toBe(40);
    expect(Math.max(...placed.map((p) => p[0])) - 30).toBe(D);
    expect(Math.max(...placed.map((p) => p[1])) - 40).toBe(W);
  });

  it("turns counter-clockwise by each quarter, checked against cos and sin", () => {
    for (const rotZ of [0, 90, 180, 270] as const satisfies readonly QuarterTurn[]) {
      const t = instanceTransform({ at: [0, 0, 0], rotZ });
      const c = Math.round(Math.cos((rotZ * Math.PI) / 180)), s = Math.round(Math.sin((rotZ * Math.PI) / 180));
      for (const v of verts()) {
        const [x, y, z] = apply(t, v);
        expect([x + 0, y + 0, z]).toEqual([c * v[0] - s * v[1] + 0, s * v[0] + c * v[1] + 0, v[2]]);
      }
      expect(t).not.toMatch(/-0\b/);
    }
  });

  it("carries the same transform into model_settings assemble items and the core target", () => {
    const b = ok(CFG);
    const assemble = [...b.entries["Metadata/model_settings.config"]!.matchAll(/<assemble_item [^>]*transform="([^"]+)"/g)].map((m) => m[1]);
    expect(assemble).toEqual(itemTransforms(b.entries["3D/3dmodel.model"]!));
    const core = ok({ ...CFG, target: "core" }).entries["3D/3dmodel.model"]!;
    expect([...core.matchAll(/<item [^>]*transform="([^"]+)"/g)].map((m) => m[1])).toEqual(assemble);
    expect(b.entries["Metadata/slice_info.config"]!.match(/<object identify_id=/g)).toHaveLength(2);
  });

  it("writes the same bytes for positions and for unturned instances", () => {
    const byPos = ok({ ...CFG, objects: [{ name: "lever", positions: [[10, 10, 0], [38, 40, 0]], parts: [part] }] });
    const byInst = ok({ ...CFG, objects: [{ name: "lever", instances: [{ at: [10, 10, 0], rotZ: 0 }, { at: [38, 40, 0], rotZ: 0 }], parts: [part] }] });
    expect(byInst.artifactHash).toBe(byPos.artifactHash);
    expect(ok(CFG).artifactHash).not.toBe(byPos.artifactHash);
  });

  it("refuses a turn off the quarter, both positions and instances, and a missing offset", () => {
    const obj = CFG.objects[0]!;
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, instances: [{ at: [0, 0, 0], rotZ: 45 as QuarterTurn }] }] }))).toBe("E_SCHEMA");
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, positions: [[0, 0, 0]] }] }))).toBe("E_SCHEMA");
    expect(codeOf(() => build({ ...CFG, objects: [{ ...obj, instances: [{ at: [0, Number.NaN, 0], rotZ: 0 }] }] }))).toBe("E_SCHEMA");
  });
});

describe("plate layout through ThreeMfInput", () => {
  const mesh = { positions: Float64Array.from(part.positions), triangles: Uint32Array.from(part.indices) };
  const input = (over: Partial<ThreeMfInput> = {}): ThreeMfInput => ({
    title: "plate-01", chase: "ogee16", buildHash: "b".repeat(64), sourceDateEpoch: EPOCH,
    slicer: DEFAULT_PRESET.slicer, nozzleMm: DEFAULT_PRESET.nozzle, template: DEFAULT_TEMPLATE, materials: DEFAULT_MATERIALS,
    filaments: [{ colour: "#1a1a1a", type: "PETG", material: "petg" }],
    objects: [
      { name: "lever", position: [0, 0, 0], bodies: [{ name: "lever", slot: 1, mesh }] },
      { name: "cap", position: [0, 0, 0], bodies: [{ name: "cap", slot: 1, mesh }] },
    ],
    ...over,
  });
  const plate = { instances: { lever: [{ at: [38, 40, 0] as Vec3, rotZ: 90 as const }, { at: [60, 40, 0] as Vec3, rotZ: 0 as const }], cap: [{ at: [10, 10, 0] as Vec3, rotZ: 0 as const }] } };

  it("writes every instance the layout names and ignores the object positions", () => {
    const cfg = configOf(input({ plate }));
    expect(cfg.objects.map((o) => [o.name, o.instances, o.positions])).toEqual([
      ["lever", plate.instances.lever, undefined], ["cap", plate.instances.cap, undefined],
    ]);
    expect(itemTransforms(threeMfEntries(input({ plate }))["3D/3dmodel.model"]!)).toEqual([
      "0 1 0 -1 0 0 0 0 1 38 40 0", "1 0 0 0 1 0 0 0 1 60 40 0", "1 0 0 0 1 0 0 0 1 10 10 0",
    ]);
  });

  it("keeps one instance at the object position with no layout", () => {
    expect(configOf(input()).objects.map((o) => [o.positions, o.instances])).toEqual([[[[0, 0, 0]], undefined], [[[0, 0, 0]], undefined]]);
  });

  it("refuses a layout naming an object the export lacks, and an object with no instance", () => {
    expect(codeOf(() => configOf(input({ plate: { instances: { ...plate.instances, levr: [{ at: [0, 0, 0], rotZ: 0 }] } } })))).toBe("E_REF");
    expect(codeOf(() => configOf(input({ plate: { instances: { lever: plate.instances.lever } } })))).toBe("E_SCHEMA");
    expect(codeOf(() => configOf(input({ plate: { instances: { ...plate.instances, cap: [] } } })))).toBe("E_SCHEMA");
  });
});
