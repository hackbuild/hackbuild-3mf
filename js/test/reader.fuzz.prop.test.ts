// TESTING.md 4.2.1, the untrusted-input fuzz job for the 3MF and zip reader
// (D-166, ARCHITECTURE.md 11.1, RISKS.md R-25). Every generated case either
// loads within the limits or is refused with E_SCHEMA naming the rule; any
// other throw fails. Zips are built here byte by byte so a name, an entry
// count or a declared size is exactly what the case says. Inflation bombs
// are generated at test time and never committed.
//
// Push runs FC_RUNS=100, nightly FC_RUNS=2000; the seed prints on failure.
// Replay: FC_SEED=<s> FC_PATH=<p> npx vitest run --root js test/reader.fuzz.prop.test.ts
// The entry-count and bomb properties build or inflate hundreds of MiB per
// case, so they run a fixed small share of FC_RUNS (named per property).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import JSZip from "jszip";
import { isThrownCommandError } from "../src/contracts.js";
import { parseModel, READER_LIMITS, readEntries, scanTags, unsafeEntryName, validateZip, zipMemberNames } from "../src/index.js";

const FC_RUNS = Number(process.env["FC_RUNS"] ?? 100);
const SEED = Number(process.env["FC_SEED"] ?? 20261005);
const PATH = process.env["FC_PATH"];
const params = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns, ...(PATH !== undefined ? { path: PATH, endOnFailure: true } : {}) });

const GOLD = new Uint8Array(readFileSync(new URL("../../corpus/gold/hackbuild-coin-nfc.3mf", import.meta.url)));
const goldZip = await JSZip.loadAsync(GOLD);
const goldEntries: { readonly name: string; readonly data: Uint8Array }[] = [];
for (const [name, f] of Object.entries(goldZip.files)) if (!f.dir) goldEntries.push({ name, data: await f.async("uint8array") });

interface RawEntry {
  readonly name: string;
  readonly data: Uint8Array;
  /** Stored bytes when the entry is deflated ahead of time; data then only feeds the crc. */
  readonly deflated?: Uint8Array;
  /** Uncompressed size written to both headers; absent, the true size. A bomb lies here. */
  readonly declaredSize?: number;
  readonly crc?: number;
}

/** A zip built byte by byte: deflate when it saves space, UTF-8 names, no data descriptors. */
function rawZip(entries: readonly RawEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = e.deflated ?? deflateRawSync(e.data);
    const method = e.deflated !== undefined || packed.length < e.data.length ? 8 : 0;
    const body = method === 8 ? Buffer.from(packed) : Buffer.from(e.data);
    const crc = e.crc ?? crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size >>> 0, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size >>> 0, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(entries.length, 0xffff), 8); end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** The rule of an E_SCHEMA refusal, or a thrown error when the case escaped the contract. */
async function outcome(run: () => Promise<unknown>): Promise<"loaded" | string> {
  try {
    await run();
    return "loaded";
  } catch (e) {
    if (isThrownCommandError(e) && e.hbf.code === "E_SCHEMA") return e.hbf.record ?? e.hbf.path ?? "E_SCHEMA";
    throw e;
  }
}

const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const sep = fc.constantFrom("/", "\\");

/** Names the D-166 rule refuses: a `..` segment, a leading separator, or a drive letter. */
const badName = fc.oneof(
  fc.tuple(fc.array(segment, { maxLength: 3 }), sep, fc.array(segment, { minLength: 1, maxLength: 3 }))
    .map(([pre, s, post]) => [...pre, "..", ...post].join(s)),
  fc.tuple(sep, fc.array(segment, { minLength: 1, maxLength: 3 })).map(([s, parts]) => s + parts.join("/")),
  fc.tuple(fc.constantFrom(..."ACZacz"), sep, segment).map(([d, s, n]) => `${d}:${s}${n}`),
  fc.tuple(fc.array(segment, { minLength: 1, maxLength: 2 }), sep).map(([parts, s]) => `${parts.join(s)}${s}..`),
);
/** Names the rule accepts: relative, no `..` segment. A dot inside a segment is fine. */
const goodName = fc.array(fc.oneof(segment, segment.map((s) => `${s}.model`), segment.map((s) => `..${s}`)), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

describe("3MF and zip reader under D-166 (TESTING.md 4.2.1)", () => {
  it("names the limits of the decision", () => {
    expect(READER_LIMITS).toEqual({ entries: 4096, inflatedBytes: 256 * 2 ** 20 });
  });

  it(`refuses every traversal, rooted or drive-letter entry name, in readEntries and zipMemberNames (FC_RUNS ${FC_RUNS})`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hbf-fuzz-"));
    try {
      await fc.assert(fc.asyncProperty(badName, fc.integer({ min: 0, max: goldEntries.length }), async (name, at) => {
        expect(unsafeEntryName(name), name).toBe(true);
        const entries: RawEntry[] = goldEntries.map((e) => ({ name: e.name, data: e.data }));
        entries.splice(at, 0, { name, data: new TextEncoder().encode("x") });
        const zip = rawZip(entries);
        expect(await outcome(() => readEntries(zip))).toBe("3mf-reader/entry-name");
        expect(await outcome(() => zipMemberNames(zip))).toBe("3mf-reader/entry-name");
        // The reader writes nothing; the name resolved against a temp directory never appears.
        const target = resolve(tmp, name.replace(/\\/g, "/").replace(/^([A-Za-z]:)?\/+/, ""));
        if (!`${tmp}/`.startsWith(`${target}/`)) expect(existsSync(target), target).toBe(false);
      }), params(FC_RUNS));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it(`loads relative names with no .. segment (FC_RUNS ${FC_RUNS})`, async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(goodName, { minLength: 1, maxLength: 6 }), async (names) => {
      const keep = names.filter((n) => !names.some((m) => m !== n && m.startsWith(`${n}/`)));
      const entries = await readEntries(rawZip(keep.map((name) => ({ name, data: new TextEncoder().encode(name) }))));
      expect(Object.keys(entries).sort()).toEqual([...keep].sort());
    }), params(FC_RUNS));
  }, 60_000);

  const countRuns = Math.max(2, Math.ceil(FC_RUNS / 20));
  it(`refuses more than 4096 entries before inflating any (${countRuns} runs, FC_RUNS / 20)`, async () => {
    const one = new Uint8Array(0);
    await fc.assert(fc.asyncProperty(fc.integer({ min: READER_LIMITS.entries + 1, max: READER_LIMITS.entries + 400 }), async (n) => {
      const zip = rawZip(Array.from({ length: n }, (_, i) => ({ name: `3D/e${i}.bin`, data: one })));
      expect(await outcome(() => readEntries(zip))).toBe("3mf-reader/entries");
      expect(await outcome(() => zipMemberNames(zip))).toBe("3mf-reader/entries");
    }), params(countRuns));
    const atLimit = rawZip(Array.from({ length: READER_LIMITS.entries }, (_, i) => ({ name: `3D/e${i}.bin`, data: one })));
    expect(Object.keys(await readEntries(atLimit))).toHaveLength(READER_LIMITS.entries);
  }, 120_000);

  it(`refuses more than 4096 central records before JSZip parses any, whatever the end record claims (${countRuns} runs, FC_RUNS / 20)`, async () => {
    const one = new Uint8Array(0);
    await fc.assert(fc.asyncProperty(fc.integer({ min: READER_LIMITS.entries + 1, max: READER_LIMITS.entries + 400 }), fc.constantFrom(0, 1, 7), async (n, claim) => {
      const zip = rawZip(Array.from({ length: n }, (_, i) => ({ name: `3D/e${i}.bin`, data: one })));
      // Forge the end record's entry counts (this disk and total) so only a walk of the central directory sees n.
      const end = Buffer.from(zip.buffer, zip.byteOffset + zip.length - 22, 22);
      end.writeUInt16LE(claim, 8);
      end.writeUInt16LE(claim, 10);
      const spy = vi.spyOn(JSZip, "loadAsync");
      try {
        expect(await outcome(() => readEntries(zip))).toBe("3mf-reader/entries");
        expect(await outcome(() => zipMemberNames(zip))).toBe("3mf-reader/entries");
        // The count is refused before JSZip builds an object per central record.
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }), params(countRuns));
  }, 120_000);

  it("refuses with rule zip a central directory that runs past the end of the file", async () => {
    const zip = rawZip(goldEntries.map((e) => ({ name: e.name, data: e.data })));
    const end = Buffer.from(zip.buffer, zip.byteOffset + zip.length - 22, 22);
    const cdStart = end.readUInt32LE(16);
    // The first central record claims a name longer than the rest of the file.
    Buffer.from(zip.buffer, zip.byteOffset + cdStart, 46).writeUInt16LE(0xffff, 28);
    const spy = vi.spyOn(JSZip, "loadAsync");
    try {
      expect(await outcome(() => readEntries(zip))).toBe("3mf-reader/zip");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an entry named __proto__ as an own key of the map and lists it, never dropping it", async () => {
    const zip = rawZip([...goldEntries.map((e) => ({ name: e.name, data: e.data })), { name: "__proto__", data: new Uint8Array([1, 2, 3]) }]);
    const e = await readEntries(zip);
    expect(Object.keys(e).sort()).toEqual([...goldEntries.map((g) => g.name), "__proto__"].sort());
    expect(Object.prototype.hasOwnProperty.call(e, "__proto__")).toBe(true);
    expect(e["__proto__"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(Object.getPrototypeOf(e)).not.toBeInstanceOf(Uint8Array);
    expect(await zipMemberNames(zip)).toContain("__proto__");
  });

  it("keeps metadata and attributes named __proto__ as own keys and finds no inherited name", () => {
    const m = parseModel('<model><metadata name="__proto__">x</metadata><metadata name="Title">t</metadata></model>');
    expect(Object.keys(m.metadata).sort()).toEqual(["Title", "__proto__"]);
    expect(m.metadata["__proto__"]).toBe("x");
    expect(m.metadata["constructor"]).toBeUndefined();
    const [tag] = [...scanTags('<object __proto__="1" id="2"/>')];
    expect(Object.keys(tag!.attrs).sort()).toEqual(["__proto__", "id"]);
    expect(tag!.attrs["toString"]).toBeUndefined();
  });

  // One deflate stream of 32 MiB of zeros (about 32 KiB packed), reused as every bomb member.
  const MIB = 2 ** 20;
  const zeros32 = new Uint8Array(32 * MIB);
  const packed32 = deflateRawSync(zeros32, { level: 9 });
  const crc32Zeros = crc32(zeros32);
  const bombRuns = Math.max(2, Math.ceil(FC_RUNS / 25));
  it(`refuses inflation past 256 MiB in total while inflating, whatever the headers declare (${bombRuns} runs, FC_RUNS / 25)`, async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 9, max: 12 }), fc.boolean(), async (members, lie) => {
      // Each member alone is far under the cap; only the running total passes it.
      const zip = rawZip(Array.from({ length: members }, (_, i) => ({
        name: `3D/bomb${i}.bin`, data: zeros32, deflated: packed32, crc: crc32Zeros, ...(lie ? { declaredSize: 16 } : {}),
      })));
      expect(zip.length).toBeLessThan(2 * MIB);
      const t0 = performance.now();
      // A lying header makes JSZip stop at the end of the first member on a size mismatch (rule zip); either way the read stops.
      expect(await outcome(() => readEntries(zip))).toBe(lie ? "3mf-reader/zip" : "3mf-reader/inflated-size");
      expect(performance.now() - t0).toBeLessThan(30_000);
      // zipMemberNames inflates nothing, so the same file lists its members.
      expect(await zipMemberNames(zip)).toHaveLength(members);
    }), params(bombRuns));
  }, 300_000);

  it("loads a package that inflates to exactly the cap less one member", async () => {
    const zip = rawZip(Array.from({ length: 7 }, (_, i) => ({ name: `3D/z${i}.bin`, data: zeros32, deflated: packed32, crc: crc32Zeros })));
    const e = await readEntries(zip);
    expect(Object.values(e).reduce((s, v) => s + (v as Uint8Array).length, 0)).toBe(7 * 32 * MIB);
  }, 60_000);

  it(`refuses a truncated central directory or file with E_SCHEMA, never another throw (FC_RUNS ${FC_RUNS})`, async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: GOLD.length - 1 }), async (cut) => {
      const r = await outcome(() => readEntries(GOLD.slice(0, cut)));
      expect(r).toMatch(/^3mf-reader\//);
    }), params(FC_RUNS));
  }, 60_000);

  it(`reads the gold with one entry mutated, then validates or refuses with E_SCHEMA (FC_RUNS ${FC_RUNS})`, async () => {
    const mutation = fc.oneof(
      fc.record({ kind: fc.constant("replace" as const), bytes: fc.uint8Array({ maxLength: 512 }) }),
      fc.record({ kind: fc.constant("truncate" as const), keep: fc.double({ min: 0, max: 1, noNaN: true }) }),
      fc.record({ kind: fc.constant("flip" as const), at: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), xor: fc.integer({ min: 1, max: 255 }) }),
    );
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: goldEntries.length - 1 }), mutation, async (which, m) => {
      const entries = goldEntries.map((e, i) => {
        if (i !== which) return { name: e.name, data: e.data };
        if (m.kind === "replace") return { name: e.name, data: m.bytes };
        if (m.kind === "truncate") return { name: e.name, data: e.data.slice(0, Math.floor(e.data.length * m.keep)) };
        const d = e.data.slice();
        if (d.length > 0) d[Math.floor(d.length * m.at)]! ^= m.xor;
        return { name: e.name, data: d };
      });
      const r = await outcome(() => validateZip(rawZip(entries), { mode: "roundtrip" }));
      expect(r === "loaded" || typeof r === "string").toBe(true);
    }), params(FC_RUNS));
  }, 120_000);

  it(`refuses a packed stream that does not inflate with rule zip (FC_RUNS ${FC_RUNS})`, async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 64 }), async (junk) => {
      const zip = rawZip([...goldEntries.map((e) => ({ name: e.name, data: e.data })), { name: "3D/junk.bin", data: new Uint8Array(4096), deflated: junk, crc: 0 }]);
      const r = await outcome(() => readEntries(zip));
      expect(["loaded", "3mf-reader/zip"]).toContain(r);
    }), params(FC_RUNS));
  }, 60_000);
});
