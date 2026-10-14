// M00-T07 step 4: the writer reads no clock. Bytes come from
// SOURCE_DATE_EPOCH alone, so Date.now and an argumentless new Date are
// refused anywhere in packages/3mf/src.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(ts|js|mjs)$/.test(d.name) ? [p] : [];
  });
}

const CLOCK = /Date\.now\b|new\s+Date\s*\(\s*\)/;

describe("no clock in packages/3mf/src (M00-T07 step 4)", () => {
  const found = files(SRC);

  it("scans the writer sources", () => {
    expect(found.length).toBeGreaterThanOrEqual(11);
  });

  it("finds no Date.now and no argumentless new Date", () => {
    const hits = found.flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (CLOCK.test(line) ? [`${path.relative(SRC, f)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("catches the seed's date stamp", () => {
    expect(CLOCK.test("const today = new Date().toISOString().slice(0, 10);")).toBe(true);
    expect(CLOCK.test("const t = Date.now();")).toBe(true);
    expect(CLOCK.test("new Date(epoch * 1000)")).toBe(false);
  });
});
