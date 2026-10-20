// R1-flagship-access-switch-07: a click spring beam drawn under 1.5 line
// widths prints as one line, and the bundled Flash Studio process uses the
// classic wall generator with detect_thin_wall 0, so the object holding the
// beam carries detect_thin_wall 1 in model_settings.config (pip RECORD.md
// line 350; haft model.js line 540). The line width is the ffc5p preset's
// in py/hackbuild_3mf/data/machines.json; the beam t of 0.55 mm is the PIP
// default (RECORD.md line 350). model_settings is read back with its own
// scanner, never through src/overrides.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATERIALS, DEFAULT_TEMPLATE, build, configOf, type ThreeMfInput } from "../src/index.js";
import { box } from "./cube.js";

const machines = (JSON.parse(readFileSync(new URL("../../py/hackbuild_3mf/data/machines.json", import.meta.url), "utf8")) as {
  machines: { id: string; presets: { id: string; nozzle: number; lineWidth: number; slicer: ThreeMfInput["slicer"] }[] }[];
}).machines;
const preset = machines.find((m) => m.id === "ffc5p")!.presets.find((p) => p.id === "ffc5p_20260819")!;
const PIP_T = 0.55;

interface Spec { springTMm?: number }

/** lineWidthMm null writes no line width into the input. */
function entries(objects: Record<string, Spec>, lineWidthMm: number | null = preset.lineWidth): Record<string, string> {
  const out = build(configOf({
    title: "thin wall", chase: "thin-wall", buildHash: "0".repeat(64), sourceDateEpoch: 315532800,
    slicer: preset.slicer, nozzleMm: preset.nozzle, ...(lineWidthMm === null ? {} : { lineWidthMm }),
    template: DEFAULT_TEMPLATE, materials: DEFAULT_MATERIALS,
    filaments: [{ colour: "#202020", type: "PETG", material: "petg" }],
    objects: Object.entries(objects).map(([name, s], i) => {
      const b = box(name, 1, [0, 0, 0], [24, 4, 2]);
      return {
        name, position: [20 + 30 * i, 20, 0] as const,
        bodies: [{ name: b.name, slot: 1, body: name, mesh: { positions: b.positions as Float64Array, triangles: b.indices as Uint32Array },
          ...(s.springTMm === undefined ? {} : { springTMm: s.springTMm }) }],
      };
    }),
  }));
  if (!out.ok) throw new Error(JSON.stringify(out.completeness));
  return out.entries as Record<string, string>;
}

/** Object metadata (parts stripped) of model_settings.config by object name. */
function objectMeta(xml: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const o of xml.matchAll(/<object id="\d+">([\s\S]*?)<\/object>/g)) {
    const bare = o[1]!.replace(/<part [\s\S]*?<\/part>/g, "");
    const meta = Object.fromEntries([...bare.matchAll(/<metadata key="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1]!, m[2]!]));
    out.set(meta["name"]!, meta);
  }
  return out;
}

describe("thin-wall handling for one-line spring beams", () => {
  it("reads a preset line width that makes the PIP beam one line", () => {
    expect(PIP_T).toBeLessThan(1.5 * preset.lineWidth);
  });

  const e = entries({ spring: { springTMm: PIP_T }, frame: {}, thick: { springTMm: 1.5 * preset.lineWidth } });
  const meta = objectMeta(e["Metadata/model_settings.config"]!);

  it("writes detect_thin_wall 1 on the object holding a spring under 1.5 line widths", () => {
    expect(meta.get("spring")?.["detect_thin_wall"]).toBe("1");
  });

  it("writes no thin-wall key on an object without a spring, or with a beam of 1.5 line widths", () => {
    expect(meta.get("frame")).toBeDefined();
    expect(meta.get("frame")!["detect_thin_wall"]).toBeUndefined();
    expect(meta.get("thick")!["detect_thin_wall"]).toBeUndefined();
  });

  it("keeps the process key out of project_settings (CHK-3MF-03)", () => {
    expect(e["Metadata/project_settings.config"]!).not.toContain("detect_thin_wall");
  });

  it("writes no thin-wall key without a line width to compare against", () => {
    const bare = objectMeta(entries({ spring: { springTMm: PIP_T } }, null)["Metadata/model_settings.config"]!);
    expect(bare.get("spring")!["detect_thin_wall"]).toBeUndefined();
  });
});
