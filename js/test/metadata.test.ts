// LICENSING.md 1.4: License carries ChaseMeta.license, Designer the name
// part of the js/package.json author, Copyright "Copyright (c) <year of
// sourceDateEpoch> <Designer>"; the core target writes LicenseTerms. No
// tool, model or AI name goes in (D-001).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isThrownCommandError } from "../src/contracts.js";
import { authorMeta, authorName, build, configOf, type BuildConfig } from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const ROOT_AUTHOR = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { author: unknown }).author;

const CFG: BuildConfig = {
  title: "coin", chase: "collar-coin", buildHash: "b".repeat(64), sourceDateEpoch: EPOCH,
  filaments: [{ color: "#1a1a1a", type: "PETG" }],
  objects: [{ name: "coin", parts: [box("body", 1, [0, 0, 0], [10, 10, 2])] }],
};

function meta(cfg: BuildConfig): Record<string, string> {
  const b = build(cfg);
  if (!b.ok) throw new Error("completeness failed");
  const model = b.entries["3D/3dmodel.model"]!;
  return Object.fromEntries([...model.matchAll(/<metadata name="([^"]+)">([^<]*)<\/metadata>/g)].map((m) => [m[1]!, m[2]!]));
}

describe("licence and authorship metadata (LICENSING.md 1.4)", () => {
  it("reads the person name from the js/package.json author", () => {
    expect(authorName(ROOT_AUTHOR)).toBe("Moheeb Zara");
    expect(authorName({ name: "Moheeb Zara", email: "hackbuildvideo@gmail.com" })).toBe("Moheeb Zara");
    expect(authorName("A Person <a@b.c> (https://x.y)")).toBe("A Person");
    expect(authorName(undefined)).toBe("");
  });

  it("writes License, Designer and Copyright for target bbs", () => {
    const m = meta({ ...CFG, license: "CC-BY-SA-4.0", designer: authorName(ROOT_AUTHOR) });
    expect(m).toMatchObject({ License: "CC-BY-SA-4.0", Designer: "Moheeb Zara", Copyright: "Copyright (c) 2026 Moheeb Zara" });
    expect(m).toMatchObject({ DesignerUserId: "", Origin: "", DesignerCover: "" });
  });

  it("takes the Copyright year from sourceDateEpoch in UTC", () => {
    // 2024-12-31T23:30:00Z
    expect(authorMeta(ROOT_AUTHOR, 1735687800).copyright).toBe("Copyright (c) 2024 Moheeb Zara");
    expect(meta({ ...CFG, sourceDateEpoch: 1735687800, designer: "Moheeb Zara" })["Copyright"]).toBe("Copyright (c) 2024 Moheeb Zara");
  });

  it("writes License without Designer, and leaves Copyright empty when Designer is", () => {
    const m = meta({ ...CFG, license: "MIT" });
    expect(m).toMatchObject({ License: "MIT", Designer: "", Copyright: "" });
  });

  it("keeps all three empty when neither is given", () => {
    expect(meta(CFG)).toMatchObject({ License: "", Designer: "", Copyright: "" });
  });

  it("writes LicenseTerms, Designer and Copyright for target core, and no LicenseTerms without a licence", () => {
    const m = meta({ ...CFG, target: "core", license: "CC-BY-SA-4.0", designer: "Moheeb Zara" });
    expect(m).toMatchObject({ LicenseTerms: "CC-BY-SA-4.0", Designer: "Moheeb Zara", Copyright: "Copyright (c) 2026 Moheeb Zara" });
    expect(m).not.toHaveProperty("License");
    expect(meta({ ...CFG, target: "core" })).not.toHaveProperty("LicenseTerms");
  });

  it("carries license and designer through configOf", () => {
    const cfg = configOf({
      title: "t", chase: "c", buildHash: "h", sourceDateEpoch: EPOCH, license: "MIT", designer: "Moheeb Zara",
      slicer: { printer: "Flashforge Creator 5 Pro 0.4 nozzle", process: "0.24mm Standard @FF C5", filament: "Generic {TYPE} @FF C5P", app: "BambuStudio-01.10.01.50" },
      nozzleMm: 0.4, template: { filamentCount: 1, keys: {}, computed: [] }, materials: {}, filaments: [], objects: [],
    } as Parameters<typeof configOf>[0]);
    expect(cfg).toMatchObject({ license: "MIT", designer: "Moheeb Zara" });
  });

  it.each(["Claude", "OpenAI Codex", "noreply@anthropic.com", "GitHub Copilot"])("refuses designer %s (D-001)", (who) => {
    let err: unknown;
    try {
      build({ ...CFG, designer: who });
    } catch (e) {
      err = e;
    }
    expect(isThrownCommandError(err) && err.hbf).toMatchObject({ code: "E_SCHEMA", path: "/designer", record: "D-001" });
  });

  it("escapes markup in the values", () => {
    const b = build({ ...CFG, designer: "A & B <x>" });
    if (!b.ok) throw new Error("completeness failed");
    expect(b.entries["3D/3dmodel.model"]).toContain('<metadata name="Designer">A &amp; B &lt;x&gt;</metadata>');
  });
});
