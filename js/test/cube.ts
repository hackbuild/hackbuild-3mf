// A closed box on the 1/1024 mm grid, wound counter-clockwise from outside;
// the writer tests need whole triangles, not a particular shape.

import type { WriterPart } from "../src/index.js";

export function box(name: string, slot: number, [x0, y0, z0]: readonly [number, number, number], [sx, sy, sz]: readonly [number, number, number]): WriterPart {
  const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  const positions = Float64Array.from([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { name, slot, positions, indices };
}

/** SOURCE_DATE_EPOCH of the acceptance runs: 2026-10-04T00:00:00Z, s. */
export const EPOCH = 1791072000;
