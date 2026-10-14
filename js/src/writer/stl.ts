// Binary STL of one part and the per-part STL fallback zip (seed
// orca3mf.js stl). The fallback is what the print card tells a person to
// load when the filament list imports as one.

import type { WriterObject, WriterPart } from "./model.js";

/** Binary STL, little endian, facet normals from the winding. */
export function stl(part: WriterPart, name?: string): Uint8Array {
  const pos = part.positions;
  const ix = part.indices;
  const n = ix.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const hdr = name ?? part.name;
  for (let i = 0; i < 80; i += 1) dv.setUint8(i, i < hdr.length ? hdr.charCodeAt(i) & 0x7f : 0);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3;
    const b = ix[i + 1]! * 3;
    const c = ix[i + 2]! * 3;
    const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const k of [a, b, c]) {
      dv.setFloat32(o, pos[k]!, true); dv.setFloat32(o + 4, pos[k + 1]!, true); dv.setFloat32(o + 8, pos[k + 2]!, true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/** The fallback zip member of each part, in object then part order: "<object>-<part>.stl". */
export function stlMemberNames(objects: readonly WriterObject[]): string[] {
  return objects.flatMap((o) => o.parts.map((p) => `${String(o.name)}-${String(p.name)}.stl`));
}

/** The fallback entries, one member per part; completeness has already proved the names unique. */
export function stlEntries(objects: readonly WriterObject[]): Record<string, Uint8Array> {
  const names = stlMemberNames(objects);
  const parts = objects.flatMap((o) => o.parts);
  const out: Record<string, Uint8Array> = {};
  parts.forEach((p, i) => { out[names[i]!] = stl(p); });
  return out;
}
