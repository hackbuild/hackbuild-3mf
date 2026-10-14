// M00-T07 step 9 (plan-deltas R50): target core is plain 3MF Core with a
// Materials colorgroup, one entry per filament, triangles pointing at it,
// and no Metadata/*.config entry.

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { build, type BuildConfig } from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const CFG: BuildConfig = {
  title: "coin", target: "core", chase: "collar-coin", buildHash: "c".repeat(64), sourceDateEpoch: EPOCH,
  filaments: [{ color: "#1a1a1a", type: "PETG" }, { color: "#FE0386", type: "PETG" }, { color: "#FFFFFF", type: "PLA" }],
  objects: [
    { name: "coin", positions: [[128, 128, 0]], parts: [box("body", 1, [0, 0, 0], [10, 10, 2]), box("ring", 3, [0, 0, 2], [10, 10, 0.5])] },
    { name: "tag", parts: [box("tag", 2, [0, 0, 0], [5, 5, 1])] },
  ],
};

describe("target core (M00-T07 step 9)", async () => {
  const b = build(CFG);
  if (!b.ok) throw new Error("completeness failed");
  const model = b.entries["3D/3dmodel.model"]!;

  it("writes the core entries and no slicer config", () => {
    expect(Object.keys(b.entries)).toEqual(["3D/3dmodel.model", "Metadata/hackbuild_chase.json", "[Content_Types].xml", "_rels/.rels"]);
    expect(Object.keys(b.entries).some((n) => /^Metadata\/.*\.config$/.test(n))).toBe(false);
    expect(model).not.toMatch(/BambuStudio|p:UUID|requiredextensions/);
    expect(b.warnings).toEqual([]);
  });

  it("declares one colorgroup entry per filament", () => {
    expect(model).toContain('xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"');
    const colours = [...model.matchAll(/<m:color color="(#[0-9A-F]{8})"\/>/g)].map((m) => m[1]);
    expect(colours).toEqual(["#1A1A1AFF", "#FE0386FF", "#FFFFFFFF"]);
  });

  it("points every triangle at its part's slot", () => {
    const objects = [...model.matchAll(/<object id="(\d+)" type="model" name="([^"]+)" pid="1" pindex="(\d+)">([^]*?)<\/object>/g)];
    expect(objects.map((m) => [m[2], m[3]])).toEqual([["body", "0"], ["ring", "2"], ["tag", "1"]]);
    for (const m of objects) {
      const tris = [...m[4]!.matchAll(/<triangle [^>]*\/>/g)].map((t) => t[0]);
      expect(tris).toHaveLength(12);
      for (const t of tris) expect(t).toContain(`pid="1" p1="${m[3]}"`);
    }
    expect([...model.matchAll(/<triangle (?![^>]*pid="1")/g)]).toHaveLength(0);
  });

  it("keeps resource ids unique and builds one item per instance", async () => {
    const ids = [...model.matchAll(/ id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...model.matchAll(/<item objectid=/g)]).toHaveLength(2);
    const zip = await JSZip.loadAsync(await b.zip());
    expect(Object.keys(zip.files)).toEqual(Object.keys(b.entries));
  });
});
