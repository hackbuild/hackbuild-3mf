// M00-T09: the TypeScript validator mirror and CHK-3MF-04.
// Steps 1 to 3, 5 and 8: the mirror passes the gold save under --roundtrip,
// fails each known-bad fixture with the named check, passes the writer's own
// export, and reaches the Python validator's verdict on every corpus row.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { canonicalize } from "../src/contracts.js";
import type { CheckResult } from "../src/contracts.js";
import {
  CHECK_META, build, readEntries, validateEntries, validateZip, DEFAULT_PRESET, printerOf,
  type BuildConfig, type ValidateMode, type ValidateReport,
} from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = join(REPO, "corpus");
const GOLD = join(CORPUS, "gold/hackbuild-coin-nfc.3mf");
const KNOWN_BAD = join(CORPUS, "known-bad");
// Tracked corpus files (M00-T10); a missing one fails the case that reads it.
const CASK = join(KNOWN_BAD, "cask-empty-plate.3mf");
const TENON = [join(KNOWN_BAD, "tenon-undefined.3mf"), join(KNOWN_BAD, "tenon-stl.zip")] as const;

const fails = (r: ValidateReport): string[] => r.results.filter((x) => x.verdict === "fail").map((x) => x.id + (x.extra?.["rule"] !== undefined ? `[${String(x.extra["rule"])}]` : ""));
const firstOf = (r: ValidateReport, id: string): string => String(r.results.find((x) => x.id === id && x.verdict === "fail")?.extra?.["first"] ?? "");

async function goldEntries(): Promise<Record<string, string | Uint8Array>> {
  return readEntries(new Uint8Array(readFileSync(GOLD)));
}

function withSettings(e: Record<string, string | Uint8Array>, edit: (ps: Record<string, unknown>) => void): Record<string, string | Uint8Array> {
  const ps = JSON.parse(e["Metadata/project_settings.config"] as string) as Record<string, unknown>;
  edit(ps);
  return { ...e, "Metadata/project_settings.config": JSON.stringify(ps, null, 4) };
}

const CFG: BuildConfig = {
  title: "coin", chase: "collar-coin", buildHash: "b".repeat(64), sourceDateEpoch: EPOCH,
  filaments: [{ color: "#1a1a1a", type: "PETG" }, { color: "#FE0386", type: "PETG" }],
  printer: printerOf(DEFAULT_PRESET.slicer),
  objects: [
    { name: "coin", positions: [[128, 128, 0]], parts: [box("body", 1, [0, 0, 0], [10, 10, 2]), box("inlay", 2, [2, 2, 2], [6, 6, 0.5])] },
    { name: "tag", positions: [[60, 60, 0]], parts: [box("tag", 2, [0, 0, 0], [5, 5, 1])] },
  ],
};

function writerEntries(cfg: BuildConfig = CFG): Record<string, string> {
  const b = build(cfg);
  if (!b.ok) throw new Error("completeness failed");
  return { ...b.entries };
}

describe("check metadata", () => {
  it("equals the seeded registry rows for every id the validator emits", () => {
    const seed = JSON.parse(readFileSync(join(REPO, "py/hackbuild_3mf/data/checks.seed.json"), "utf8")) as { checks: { id: string; version: string; severity: string }[] };
    const rows = new Map(seed.checks.map((c) => [c.id, c]));
    for (const [id, meta] of Object.entries(CHECK_META)) {
      const row = rows.get(id);
      expect({ id, version: row?.version, severity: row?.severity }).toEqual({ id, ...meta });
    }
  });
});

describe("gold and known-bad (steps 2, 3)", () => {
  it("passes the gold Flash Studio save under --roundtrip", async () => {
    const r = validateEntries(await goldEntries(), { mode: "roundtrip", artifact: "hackbuild-coin-nfc.3mf" });
    expect(fails(r)).toEqual([]);
    expect(r.keySet?.present).toBe(127);
    expect(r.keySet?.templateLengths).toEqual({ "3": 127 });
    const skips = r.results.filter((x) => x.verdict === "skip").map((x) => x.id);
    // The gold save carries no Metadata/hackbuild_chase.json, so CHK-3MF-08 has no body roles to read (M05-T20).
    expect(skips).toEqual(["CHK-3MF-03", "CHK-3MF-08", "CHK-PRT-01"]);
    expect(r.results.find((x) => x.id === "CHK-3MF-08")?.constraint).toMatch(/^not run: no Metadata\/hackbuild_chase\.json/);
  });

  it("fails a p:path to a missing part with CHK-3MF-06", async () => {
    const e = await goldEntries();
    const model = (e["3D/3dmodel.model"] as string).replace(/p:path="[^"]*"/g, 'p:path="/3D/Objects/missing.model"');
    const r = validateEntries({ ...e, "3D/3dmodel.model": model }, { mode: "roundtrip" });
    expect(fails(r)).toContain("CHK-3MF-06");
    expect(firstOf(r, "CHK-3MF-06")).toMatch(/missing part/);
  });

  it("fails a self-referential p:path with CHK-3MF-06", async () => {
    const e = await goldEntries();
    const model = (e["3D/3dmodel.model"] as string).replace(/p:path="[^"]*"/g, 'p:path="/3D/3dmodel.model"');
    const r = validateEntries({ ...e, "3D/3dmodel.model": model }, { mode: "roundtrip" });
    expect(firstOf(r, "CHK-3MF-06")).toMatch(/self-reference/);
  });

  it("fails overhang_fan_threshold as JSON numbers or bare strings with CHK-3MF-07", async () => {
    const e = await goldEntries();
    for (const v of [[95, 10, 10], ["95", "10", "10"], ["nil", "nil", "nil"]]) {
      const r = validateEntries(withSettings(e, (ps) => { ps["overhang_fan_threshold"] = v; }), { mode: "roundtrip" });
      expect(fails(r)).toEqual(["CHK-3MF-07"]);
      expect(firstOf(r, "CHK-3MF-07")).toMatch(/^overhang_fan_threshold slot 0/);
    }
  });

  it("passes printer-scoped length-4 vectors the slicer wrote, and length checks stay on template keys", async () => {
    const e = await goldEntries();
    const ps = JSON.parse(e["Metadata/project_settings.config"] as string) as Record<string, unknown[]>;
    expect(ps["nozzle_diameter"]).toHaveLength(4);
    expect(ps["extruder_variant_list"]).toBeDefined();
    const r = validateEntries(withSettings(e, (p) => { p["fan_max_speed"] = ["50", "70"]; }), { mode: "roundtrip" });
    expect(fails(r)).toEqual(["CHK-3MF-02"]);
  });

  it("fails the CASK Sep 5 original with CHK-3MF-06 and CHK-3MF-07", async () => {
    const r = await validateZip(new Uint8Array(readFileSync(CASK)), { mode: "roundtrip" });
    expect(fails(r)).toEqual(["CHK-3MF-06", "CHK-3MF-07"]);
    expect(firstOf(r, "CHK-3MF-06")).toMatch(/self-reference/);
    expect(firstOf(r, "CHK-3MF-07")).toMatch(/Overhang_threshold_bridge/);
  });

  it("fails the TENON export on completeness with its STL zip", async () => {
    const [model, stl] = TENON;
    const r = await validateZip(new Uint8Array(readFileSync(model)), { mode: "export", stlZip: new Uint8Array(readFileSync(stl)) });
    const c = r.results.find((x) => x.id === "CHK-ART-01")!;
    expect(c.verdict).toBe("fail");
    expect(c.extra).toMatchObject({ alias: "export-completeness", parts: 11, stlMembers: 7 });
    expect(String(c.extra?.["first"])).toMatch(/tenon-undefined/);
  }, 60_000); // unzips and audits every part of the export; over 5 s under the root run's parallel load
});

describe("writer exports (steps 1, 5)", () => {
  it("passes the writer's bbs export under --export, every template key at N", () => {
    const r = validateEntries(writerEntries(), { mode: "export", artifact: "coin.3mf" });
    expect(fails(r)).toEqual([]);
    expect(r.keySet).toMatchObject({ present: 127, absent: [], templateLengths: { "2": 127 } });
    expect(r.keySet?.nonTemplate).toContain("printer_model");
    expect(r.keySet?.nonTemplate).toContain("curr_bed_type");
    expect(r.results.filter((x) => x.id === "CHK-PRT-01" && x.verdict === "pass")).toHaveLength(3);
  });

  it("fails a key outside the template, extruder_variant_list, and a dropped kept key", () => {
    const e = writerEntries();
    const r1 = validateEntries(withSettings(e, (ps) => { ps["layer_height"] = "0.2"; ps["extruder_variant_list"] = ["Direct Drive Standard"]; }), { mode: "export" });
    expect(fails(r1)).toEqual(["CHK-3MF-03"]);
    expect(firstOf(r1, "CHK-3MF-03")).toMatch(/extruder_variant_list.*layer_height/);
    const r2 = validateEntries(withSettings(e, (ps) => { delete ps["filament_map"]; }), { mode: "export" });
    expect(fails(r2)).toEqual(["CHK-3MF-02", "CHK-3MF-07"]);
    expect(firstOf(r2, "CHK-3MF-07")).toMatch(/filament_map missing/);
  });

  it("puts missing template keys and non-template keys in the key-set note under --legacy", () => {
    const e = withSettings(writerEntries(), (ps) => { delete ps["filament_shrink"]; ps["filament_scarf_gap"] = ["0%", "0%"]; });
    const r = validateEntries(e, { mode: "legacy" });
    expect(fails(r)).toEqual([]);
    expect(r.keySet?.absent).toEqual(["filament_shrink"]);
    expect(r.notes[0]).toMatch(/^key-set: 126 of 127 template keys present, 1 absent/);
    const bad = validateEntries(withSettings(e, (ps) => { ps["extruder_variant_list"] = ["a"]; }), { mode: "legacy" });
    expect(fails(bad)).toEqual(["CHK-3MF-03"]);
  });

  it("fails names with undefined and a short STL zip on completeness", () => {
    const e = writerEntries();
    const ms = (e["Metadata/model_settings.config"] as string).replace('value="tag"', 'value="tenon-undefined"');
    const r = validateEntries({ ...e, "Metadata/model_settings.config": ms }, { mode: "export", stlMembers: ["coin-body.stl", "coin-inlay.stl"] });
    expect(fails(r)).toEqual(["CHK-ART-01"]);
    expect(firstOf(r, "CHK-ART-01")).toMatch(/tenon-undefined.*stl zip holds 2 members for 3 parts/);
  });

  it("passes a core export under --target core and fails a colour index out of range", () => {
    const e = writerEntries({ ...CFG, target: "core" });
    expect(fails(validateEntries(e, { mode: "export", target: "core" }))).toEqual([]);
    const bad = (e["3D/3dmodel.model"])!.replace(/pindex="1"/, 'pindex="7"');
    const r = validateEntries({ ...e, "3D/3dmodel.model": bad }, { mode: "export", target: "core" });
    expect(fails(r)).toEqual(["CHK-3MF-06[materials]"]);
  });

  it("fails an open mesh with CHK-PRT-01", () => {
    const e = writerEntries();
    const model = e["3D/3dmodel.model"]!.replace(/<triangle [^>]*\/>\s*/, "");
    expect(fails(validateEntries({ ...e, "3D/3dmodel.model": model }, { mode: "export" }))).toContain("CHK-PRT-01[topology]");
  });
});

// ---------------------------------------------------------------- agreement with the Python validator
const UV = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

interface Row { readonly file: string; readonly mode: ValidateMode; readonly target: "bbs" | "core"; readonly stlZip?: string }

function modeOf(v: unknown): ValidateMode | undefined {
  const s = String(v ?? "").replace(/^--/, "");
  return s === "export" || s === "legacy" || s === "roundtrip" ? s : undefined;
}

const MANIFEST = join(CORPUS, "manifest.json");

/** Every row of tools/corpus/3mf/manifest.json (M00-T10). A row naming a missing file throws; no row is dropped. */
function corpusRows(): Row[] {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as { rows: Record<string, unknown>[] };
  return m.rows.map((r) => {
    const p = String(r["path"] ?? "");
    const file = p.startsWith("/") ? p : join(CORPUS, p);
    if (p === "" || !existsSync(file) || !statSync(file).isFile()) throw new Error(`manifest row ${String(r["id"])} names a missing file: ${file}`);
    const mode = String(r["mode"] ?? "").split(/\s+/).map(modeOf).find((x) => x !== undefined) ?? "export";
    const target = r["target"] === "core" ? "core" as const : "bbs" as const;
    const stl = r["stlZip"];
    let stlZip: string | undefined;
    if (typeof stl === "string") {
      stlZip = stl.startsWith("/") ? stl : join(CORPUS, stl);
      if (!existsSync(stlZip)) throw new Error(`manifest row ${String(r["id"])} names a missing stl zip: ${stlZip}`);
    }
    return { file, mode, target, ...(stlZip !== undefined ? { stlZip } : {}) };
  });
}

describe("corpus manifest (M00-T10)", () => {
  it("resolves every manifest row to a file, dropping none", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as { rows: unknown[] };
    expect(m.rows.length).toBeGreaterThan(0);
    expect(corpusRows()).toHaveLength(m.rows.length);
  });
});

// Every temp folder this file makes is removed when its tests end.
const TEMPS: string[] = [];
afterAll(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
});

/** Rows the agreement covers besides the corpus: synthetic known-bad and writer exports, written to a temp dir. */
async function syntheticRows(): Promise<Row[]> {
  const dir = mkdtempSync(join(tmpdir(), "hbf-validate-"));
  TEMPS.push(dir);
  const e = await goldEntries();
  const put = async (name: string, entries: Record<string, string | Uint8Array>): Promise<string> => {
    const zip = new JSZip();
    for (const [k, v] of Object.entries(entries)) zip.file(k, v);
    const p = join(dir, name);
    writeFileSync(p, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    return p;
  };
  const model = e["3D/3dmodel.model"] as string;
  const rows: Row[] = [
    { file: await put("gold-missing-part.3mf", { ...e, "3D/3dmodel.model": model.replace(/p:path="[^"]*"/g, 'p:path="/3D/Objects/missing.model"') }), mode: "roundtrip", target: "bbs" },
    { file: await put("overhang-numeric.3mf", withSettings(e, (ps) => { ps["overhang_fan_threshold"] = [95, 10, 10]; })), mode: "roundtrip", target: "bbs" },
    { file: await put("overhang-bare.3mf", withSettings(e, (ps) => { ps["overhang_fan_threshold"] = ["95", "10", "10"]; })), mode: "roundtrip", target: "bbs" },
  ];
  const b = build(CFG);
  const c = build({ ...CFG, target: "core" });
  if (!b.ok || !c.ok) throw new Error("completeness failed");
  const bp = join(dir, "writer-bbs.3mf");
  writeFileSync(bp, await b.zip());
  const sp = join(dir, "writer-bbs-stl.zip");
  writeFileSync(sp, await b.stlZip());
  const cp = join(dir, "writer-core.3mf");
  writeFileSync(cp, await c.zip());
  rows.push({ file: bp, mode: "export", target: "bbs", stlZip: sp }, { file: bp, mode: "legacy", target: "bbs" }, { file: cp, mode: "export", target: "core" });
  rows.push({ file: await put("writer-seed-keys.3mf", withSettings(b.entries, (ps) => { delete ps["filament_map"]; ps["filament_scarf_gap"] = ["0%", "0%"]; })), mode: "export", target: "bbs" });
  return rows;
}

/** Results keyed by id, rule and path, skips dropped; the mirror leaves the lib3mf read and CHK-PRT-03 to Python. */
function verdicts(results: readonly Pick<CheckResult, "id" | "verdict" | "target" | "extra">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results) {
    if (r.verdict === "skip" || r.id === "CHK-PRT-03" || r.extra?.["rule"] === "lib3mf") continue;
    const path = "path" in r.target ? String(r.target.path ?? "") : "";
    const key = `${r.id}[${String(r.extra?.["rule"] ?? "")}]${path}`;
    out.set(key, out.get(key) === "fail" ? "fail" : r.verdict);
  }
  return out;
}

// CI installs uv (setup-uv); there a missing uv fails the suite instead of skipping it.
describe.skipIf(!UV && process.env["CI"] === undefined)("agreement with py/hackbuild_3mf/validate_3mf.py (step 8)", async () => {
  it("finds uv", () => expect(UV, "uv is on PATH").toBe(true));
  const rows = [...corpusRows(), ...(await syntheticRows())];
  it.each(rows.map((r) => [`${relative(REPO, r.file)} --${r.mode} --target ${r.target}`, r] as const))("%s", async (_, row) => {
    const args = ["run", "--project", "py", "validate-3mf", `--${row.mode}`, "--target", row.target, "--json", row.file];
    if (row.stlZip !== undefined) args.splice(4, 0, "--stl-zip", row.stlZip);
    const py = spawnSync("uv", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect([0, 1], py.stderr).toContain(py.status);
    const pr = JSON.parse(py.stdout) as { verdict: string; results: CheckResult[] };
    const ts = await validateZip(new Uint8Array(readFileSync(row.file)), {
      mode: row.mode, target: row.target, ...(row.stlZip !== undefined ? { stlZip: new Uint8Array(readFileSync(row.stlZip)) } : {}),
    });
    expect(Object.fromEntries(verdicts(ts.results))).toEqual(Object.fromEntries(verdicts(pr.results)));
    expect(ts.keySet?.present ?? null).toEqual((pr as unknown as { keySet: { present: number } | null }).keySet?.present ?? null);
  }, 120_000);
});

