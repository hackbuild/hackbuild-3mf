// Text forms the writer emits. The Python writer (tools/py/orca3mf.py)
// follows the same rules so the two agree entry by entry (D-052, M00-T08).

import { exportError } from "./template.js";

/**
 * A coordinate as written, mm. Meshes arrive snapped to the 1/1024 mm grid
 * (D-054), whose values print exactly in ten decimals: toFixed(10) with
 * trailing zeros and a trailing point stripped, and -0 written 0.
 */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) {
    // The same fields as tools/py/orca3mf.py fmt, so both writers refuse alike.
    throw exportError({
      code: "E_SCHEMA", path: "/objects/mesh/positions", got: String(v),
      expected: "a finite coordinate, mm", hint: "a vertex is not finite; rebuild the mesh",
    });
  }
  const s = v.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/** A slicer number as the seed wrote it: six significant digits, no exponent in these ranges. */
export const num = (v: number): string => String(+v.toPrecision(6));

/** XML attribute and text escape. */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The earliest date a zip entry can hold, 1980-01-01T00:00:00Z, s. */
export const DOS_EPOCH = 315532800;

/** SOURCE_DATE_EPOCH clamped to the zip floor, s (D-052). */
export const clampEpoch = (epoch: number): number => Math.max(epoch, DOS_EPOCH);

/** The UTC day of an epoch as YYYY-MM-DD; reads no clock. */
export function isoDay(epoch: number): string {
  return new Date(clampEpoch(epoch) * 1000).toISOString().slice(0, 10);
}
