// M00-T07 step 8 (plan-deltas R50, CHK-ART-01 known as export-completeness).
// TENON's node exporter (tenon-src.zip, export_default.js) looked names up
// in a LABEL map written for the six-part bench and never extended for
// upper, tray, puckA, puckB and spacer: five objects named tenon-undefined,
// and a 7-member STL zip for 11 parts. The export must fail before any byte.

import { describe, expect, it } from "vitest";
import { isThrownCommandError } from "../src/contracts.js";
import { build, write3mf, filamentTemplate, slicerMaterials, DEFAULT_MATERIALS, DEFAULT_TEMPLATE, type WriterObject } from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const ORDER = ["bulb", "neck", "handle", "throat", "knob", "tip", "upper", "tray", "puckA", "puckB", "spacer"] as const;
const LABEL: Readonly<Record<string, string>> = { bulb: "body", neck: "neck", handle: "handle", throat: "throat", knob: "knob", tip: "tip" };

/** The objects export_default.js built: name 'tenon-' + LABEL[n], one part named LABEL[n]. */
const tenon = (label: (n: string) => string | undefined): WriterObject[] => ORDER.map((n, i) => ({
  name: `tenon-${String(label(n))}`,
  positions: [[20 + i * 20, 100, 0]],
  parts: [{ ...box("x", 1, [0, 0, 0], [10, 10, 10]), name: label(n) as string }],
}));

const cfg = (objects: WriterObject[]) => ({
  title: "tenon", sourceDateEpoch: EPOCH, filaments: [{ color: "#1A1A1A", type: "PETG" }], objects,
});

describe("export completeness (M00-T07 step 8)", () => {
  it("fails the TENON name set and writes nothing", () => {
    const out = build(cfg(tenon((n) => LABEL[n])));
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty("entries");
    expect(out).not.toHaveProperty("zip");
    const r = out.completeness;
    expect(r.id).toBe("CHK-ART-01");
    expect(r.extra?.["alias"]).toBe("export-completeness");
    expect(r.verdict).toBe("fail");
    expect(r.severity).toBe("block");
    expect(r.target).toEqual({ level: "artifact", artifact: "tenon.3mf" });
    expect(r.legal).toEqual({ kind: "boolean", must: true });
    expect(r.measured).toBe(false);
    expect(r.origin).toBe("hbf://check/CHK-ART-01");
    expect(r.constraint.length).toBeGreaterThan(0);
    // 11 parts, 7 unique STL member names: the six labelled parts plus one tenon-undefined.
    expect(r.extra?.["stlMembers"]).toBe(11);
    expect(r.extra?.["stlUniqueNames"]).toBe(7);
    expect(String(r.extra?.["first"])).toContain("tenon-undefined");
  });

  it("throws from write3mf with the check named, before any byte", async () => {
    const objects = tenon((n) => LABEL[n]);
    const err = await write3mf({
      title: "tenon", chase: "tenon", buildHash: "", sourceDateEpoch: EPOCH,
      slicer: { app: "BambuStudio-01.10.01.50", printer: "", process: "", filament: "Generic {TYPE} @FF C5P" }, nozzleMm: 0.4,
      template: filamentTemplate(DEFAULT_TEMPLATE), materials: slicerMaterials(DEFAULT_MATERIALS),
      filaments: [{ colour: "#1A1A1A", type: "PETG", material: "petg" }],
      objects: objects.map((o) => ({ name: o.name, position: [0, 0, 0], bodies: o.parts.map((p) => ({ name: p.name, slot: 1, mesh: { positions: Float64Array.from(p.positions), triangles: Uint32Array.from(p.indices) } })) })),
    }).then(() => undefined, (e: unknown) => e);
    expect(isThrownCommandError(err) && err.hbf.record).toBe("CHK-ART-01");
  });

  it("fails null, NaN and empty names and a repeated object name", () => {
    const one = (name: string, part = "p"): WriterObject => ({ name, parts: [{ ...box(part, 1, [0, 0, 0], [1, 1, 1]) }] });
    for (const objects of [[one("a-null")], [one("a", "NaN")], [one(" ")], [one("a"), one("a")], [one("a", "p"), { ...one("a-p"), name: "a" }]]) {
      const out = build(cfg(objects));
      expect(out.ok, JSON.stringify(objects.map((o) => o.name))).toBe(false);
    }
  });

  it("passes the known-good twin: 11 unique resolved names", () => {
    const out = build(cfg(tenon((n) => n)));
    expect(out.ok).toBe(true);
    expect(out.completeness.verdict).toBe("pass");
    expect(out.completeness.measured).toBe(true);
    expect(out.completeness.extra?.["stlUniqueNames"]).toBe(11);
  });

  it("does not take a name that only contains the letters for a token", () => {
    const out = build(cfg([{ name: "annullable-nanoset", parts: [box("nullify", 1, [0, 0, 0], [1, 1, 1])] }]));
    expect(out.ok).toBe(true);
  });
});
