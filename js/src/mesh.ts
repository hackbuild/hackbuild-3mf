// The mesh shape, signed volume and the CHK-PRT-01 audit the validator
// mirror runs, held here so the package imports no wasm and the subtree
// split (D-027, PACKAGES.md 5.1) stands alone without a generated copy.
// packages/mesh is tier 0 and may not import this tier 1 package
// (PACKAGES.md 3.1), so it keeps the same code in src/hash.ts and
// src/audit.ts; test/mesh-parity.test.ts fails when the two drift, in
// source text and on fixtures.
//
// Audit lineage, as in packages/mesh/src/audit.ts: edge pairing on raw
// indices is BOSS auditIndexed (boss-src/src/kernel.js lines 321 to 335);
// edge pairing keyed on coordinates is KNUCKLE K.audit (knuckle part3.js
// line 149), keyed on the D-054 1/1024 mm grid; the vertex fan check is the
// seed validator's nonmanifold_vertices (validate_3mf.py lines 36 to 66).

import { MESH_GRID_PER_MM } from "./contracts.js";

/** Indexed triangle mesh in mm: xyz triples and counter-clockwise (outward) index triples. */
export interface MeshData {
  readonly positions: Float64Array;
  readonly triangles: Uint32Array;
}

/** Signed enclosed volume, mm3; negative for an inside-out mesh. */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let six = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3;
    const b = t[i + 1]! * 3;
    const c = t[i + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    six += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

/** Triangles under this area are degenerate, mm2 (TENON sweep threshold). */
export const MIN_TRIANGLE_AREA_MM2 = 1e-14;

export interface MeshAudit {
  /** Undirected edges on raw indices not shared by exactly two faces, count. */
  readonly openEdgesRaw: number;
  /** Undirected edges keyed on grid coordinates not shared by exactly two faces, count. */
  readonly openEdges: number;
  /** Directed edges keyed on grid coordinates used more than once (inconsistent winding), count. */
  readonly windingErrors: number;
  /** Triangles with area under MIN_TRIANGLE_AREA_MM2 or a repeated vertex, count. */
  readonly degenerate: number;
  /** Merged vertices whose faces do not form one edge-connected fan, count. */
  readonly nonManifoldVertices: number;
  /** Enclosed volume, mm3 (computed); negative when inside out. */
  readonly signedVolumeMm3: number;
  /** Every count 0 and the volume above 0. */
  readonly ok: boolean;
}

export interface AuditOptions {
  /** Merge grid, points per mm. Default MESH_GRID_PER_MM (D-054); the 3MF validator mirror passes 1e8, trimesh's merge precision. */
  readonly mergeGridPerMm?: number;
}

/** Merge vertices that land on one grid point; returns merged index per vertex. */
function mergeOnGrid(positions: ArrayLike<number>, grid: number): { readonly remap: Uint32Array; readonly count: number } {
  const n = positions.length / 3;
  const remap = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const key = `${Math.round(positions[i * 3]! * grid)},${Math.round(positions[i * 3 + 1]! * grid)},${Math.round(positions[i * 3 + 2]! * grid)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    remap[i] = id;
  }
  return { remap, count: seen.size };
}

/** Edge pairing over index triples, after BOSS auditIndexed; nv bounds the index range. */
function pairEdges(tris: ArrayLike<number>, nv: number): { readonly open: number; readonly dir: number } {
  const undirected = new Map<number, number>();
  const directed = new Set<number>();
  let dir = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const t = [tris[i]!, tris[i + 1]!, tris[i + 2]!] as const;
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    for (let k = 0; k < 3; k += 1) {
      const a = t[k]!;
      const b = t[(k + 1) % 3]!;
      const key = a < b ? a * nv + b : b * nv + a;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
      const dk = a * nv + b;
      if (directed.has(dk)) dir += 1;
      directed.add(dk);
    }
  }
  let open = 0;
  for (const n of undirected.values()) if (n !== 2) open += 1;
  return { open, dir };
}

/** The seed validator's vertex fan check: union faces around each vertex through shared edges. */
function fanCheck(tris: ArrayLike<number>): number {
  const vf = new Map<number, number[]>();
  for (let f = 0; f < tris.length / 3; f += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = tris[f * 3 + k]!;
      let list = vf.get(v);
      if (list === undefined) vf.set(v, (list = []));
      if (list[list.length - 1] !== f) list.push(f);
    }
  }
  let bad = 0;
  for (const [v, flist] of vf) {
    const parent = flist.map((_, i) => i);
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]!]!;
        a = parent[a]!;
      }
      return a;
    };
    const edgeOf = new Map<number, number>();
    flist.forEach((f, li) => {
      for (let k = 0; k < 3; k += 1) {
        const o = tris[f * 3 + k]!;
        if (o === v) continue;
        const prev = edgeOf.get(o);
        if (prev === undefined) edgeOf.set(o, li);
        else parent[find(li)] = find(prev);
      }
    });
    const roots = new Set(flist.map((_, i) => find(i)));
    if (roots.size !== 1) bad += 1;
  }
  return bad;
}

function degenerateCount(mesh: MeshData): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let bad = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3;
    const b = t[i + 1]! * 3;
    const c = t[i + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) < MIN_TRIANGLE_AREA_MM2) bad += 1;
  }
  return bad;
}

/** Audit one closed triangle mesh in mm. */
export function audit(mesh: MeshData, opts: AuditOptions = {}): MeshAudit {
  const nv = mesh.positions.length / 3;
  const raw = pairEdges(mesh.triangles, nv);
  const { remap, count } = mergeOnGrid(mesh.positions, opts.mergeGridPerMm ?? MESH_GRID_PER_MM);
  const merged = mesh.triangles.map((i) => remap[i]!);
  const snapped = pairEdges(merged, count);
  const degenerate = degenerateCount(mesh);
  const nonManifoldVertices = fanCheck(merged);
  const signedVolumeMm3 = signedVolume(mesh);
  const ok =
    mesh.triangles.length > 0 &&
    raw.open === 0 &&
    snapped.open === 0 &&
    snapped.dir === 0 &&
    degenerate === 0 &&
    nonManifoldVertices === 0 &&
    signedVolumeMm3 > 0;
  return {
    openEdgesRaw: raw.open,
    openEdges: snapped.open,
    windingErrors: snapped.dir,
    degenerate,
    nonManifoldVertices,
    signedVolumeMm3,
    ok,
  };
}
