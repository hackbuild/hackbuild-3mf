// M00-T07 step 4 (D-052, C-08): two builds of one input under one
// SOURCE_DATE_EPOCH give equal bytes whatever the host time zone; no
// directory entries; sorted names; DEFLATE level 6; the 1980 clamp.

import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { utf8Bytes } from "../src/contracts.js";
import { build, DOS_EPOCH, zipEntries, type BuildConfig, type Built } from "../src/index.js";
import { box, EPOCH } from "./cube.js";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
/** SOURCE_DATE_EPOCH from the environment when the run sets it, else the acceptance epoch, s. */
const SDE = Number(process.env["SOURCE_DATE_EPOCH"] ?? EPOCH);

const cfg = (epoch: number): BuildConfig => ({
  title: "pair", chase: "keys-flex-pair", buildHash: "a".repeat(64), sourceDateEpoch: epoch,
  printer: { printer_settings_id: "Flashforge Creator 5 Pro 0.4 nozzle", print_settings_id: "0.24mm Standard @FF C5", curr_bed_type: "Textured PEI Plate" },
  filaments: [{ color: "#1A1A1A", type: "PETG" }, { color: "#404040", type: "PLA" }, { color: "#808080", type: "TPU" }],
  objects: [{ name: "pair", positions: [[150, 150, 0]], parts: [box("pad", 1, [0, 0, 0], [60, 30, 2]), box("trace", 2, [0, 0, 2], [1.375, 15, 0.5]), box("cap", 3, [5, 5, 2], [11, 11, 3.25])] }],
});

const ok = (c: BuildConfig): Built => {
  const b = build(c);
  if (!b.ok) throw new Error("completeness failed");
  return b;
};

const TZ0 = process.env["TZ"];
function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  process.env["TZ"] = tz;
  return fn();
}
afterAll(() => {
  if (TZ0 === undefined) delete process.env["TZ"];
  else process.env["TZ"] = TZ0;
});

/** The method and name of every local file header, in file order. */
function localHeaders(bytes: Uint8Array): { readonly name: string; readonly method: number }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; method: number }[] = [];
  let o = 0;
  while (o + 30 <= bytes.length && dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const csize = dv.getUint32(o + 18, true);
    const nlen = dv.getUint16(o + 26, true);
    const xlen = dv.getUint16(o + 28, true);
    out.push({ name: String.fromCharCode(...bytes.slice(o + 30, o + 30 + nlen)), method });
    o += 30 + nlen + xlen + csize;
  }
  return out;
}

describe("reproducible bytes (M00-T07 step 4)", () => {
  it("gives equal sha256 for two builds under TZ=UTC and under TZ=America/Phoenix", async () => {
    const utc = await inZone("UTC", async () => {
      expect(new Date(SDE * 1000).getTimezoneOffset()).toBe(0);
      return [sha(await ok(cfg(SDE)).zip()), sha(await ok(cfg(SDE)).zip())];
    });
    const phx = await inZone("America/Phoenix", async () => {
      // Phoenix keeps UTC-7 all year, so the zone change is in force here.
      expect(new Date(SDE * 1000).getTimezoneOffset()).toBe(420);
      return [sha(await ok(cfg(SDE)).zip()), sha(await ok(cfg(SDE)).zip())];
    });
    expect(utc[0]).toBe(utc[1]);
    expect(phx[0]).toBe(phx[1]);
    expect(phx[0]).toBe(utc[0]);
  });

  it("holds no directory entry, keeps names in sorted byte order, deflates every entry", async () => {
    const b = ok(cfg(SDE));
    const bytes = await b.zip();
    const headers = localHeaders(bytes);
    expect(headers.map((h) => h.name)).toEqual(Object.keys(b.entries).sort());
    expect(headers.some((h) => h.name.endsWith("/"))).toBe(false);
    expect(headers.every((h) => h.method === 8)).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter((n) => n.endsWith("/"))).toEqual([]);
    for (const f of Object.values(zip.files)) expect(f.date.getTime()).toBe(SDE * 1000);
  });

  it("moves the bytes with the epoch and keeps the artifactHash", async () => {
    const a = ok(cfg(SDE));
    const b = ok(cfg(SDE + 86400));
    expect(sha(await a.zip())).not.toBe(sha(await b.zip()));
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  it("clamps an epoch below 1980-01-01T00:00:00Z to it", async () => {
    expect(DOS_EPOCH).toBe(Date.UTC(1980, 0, 1) / 1000);
    const low = ok(cfg(0));
    expect(low.entries["3D/3dmodel.model"]).toContain('<metadata name="CreationDate">1980-01-01</metadata>');
    expect(sha(await low.zip())).toBe(sha(await ok(cfg(DOS_EPOCH)).zip()));
    const zip = await JSZip.loadAsync(await low.zip());
    for (const f of Object.values(zip.files)) expect(f.date.getTime()).toBe(DOS_EPOCH * 1000);
  });

  it("reproduces the STL fallback zip too", async () => {
    expect(sha(await ok(cfg(SDE)).stlZip())).toBe(sha(await ok(cfg(SDE)).stlZip()));
  });
});

describe("one UTF-8 encoder for the zip and artifactHash (D-206)", () => {
  // A lone surrogate is the one input where encoders differ: node Buffer
  // writes U+FFFD, the JSZip fallback and the old writer/fmt.ts utf8 wrote
  // three bytes. Text and names go through spec utf8Bytes, so the hash is
  // over the bytes the zip holds and those bytes do not move with the runtime.
  const odd = "k\ud800y \u00e9 \ud834\udd1e";
  const oddCfg = (): BuildConfig => {
    const c = cfg(SDE);
    return { ...c, title: odd, objects: c.objects.map((o) => ({ ...o, name: `pair ${odd}`, parts: o.parts.map((p) => ({ ...p, name: `${String(p.name)} ${odd}` })) })) };
  };

  /** artifactHash recomputed with node crypto over the members a zip holds. */
  async function hashOfZip(bytes: Uint8Array): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const lines: string[] = [];
    for (const name of Object.keys(zip.files).sort()) {
      let b = Buffer.from(await zip.files[name]!.async("uint8array"));
      if (name === "3D/3dmodel.model") {
        b = Buffer.from(b.toString("latin1").replace(/(<metadata name="(?:CreationDate|ModificationDate)">)[^<]*/g, "$1"), "latin1");
      }
      lines.push(`${name}\u0000${sha(b)}\n`);
    }
    return sha(Buffer.from(lines.join(""), "utf8"));
  }

  it("gives an artifactHash equal to the hash of the zip bytes when names and text hold a lone surrogate", async () => {
    const b = ok(oddCfg());
    const bytes = await b.zip();
    expect(await hashOfZip(bytes)).toBe(b.artifactHash);
    expect(await hashOfZip(await ok(cfg(SDE)).zip())).toBe(ok(cfg(SDE)).artifactHash);
    const text = Buffer.from(await (await JSZip.loadAsync(bytes)).files["3D/3dmodel.model"]!.async("uint8array"));
    expect(text.includes(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false);
    expect(text.includes(Buffer.from("k\ufffdy", "utf8"))).toBe(true);
  });

  it("hands JSZip bytes, never strings, so its runtime encoder never runs on entry text", async () => {
    const b = ok(oddCfg());
    const asBytes = Object.fromEntries(Object.entries(b.entries).map(([k, v]) => [k, typeof v === "string" ? utf8Bytes(v) : v]));
    expect(sha(await zipEntries(asBytes, SDE))).toBe(sha(await b.zip()));
  });

  it("writes well-formed STL member names and refuses two that meet once replaced", async () => {
    const names = Object.keys((await JSZip.loadAsync(await ok(oddCfg()).stlZip())).files);
    expect(names.length).toBe(3);
    expect(names.every((n) => n.includes("k\ufffdy \u00e9 \ud834\udd1e"))).toBe(true);
    await expect(zipEntries({ "a\ud800.txt": "1", "a\udc00.txt": "2" }, SDE)).rejects.toThrow(/repeats/);
  });
});
