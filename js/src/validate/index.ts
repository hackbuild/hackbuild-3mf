// The TypeScript mirror of tools/py/validate_3mf.py (M00-T09 step 8, D-140).
// It runs CHK-3MF-01, -02, -03, -06, -07, -08, export completeness (CHK-ART-01)
// and the mesh audit (CHK-PRT-01 topology) on an entry map, in the three
// modes of the Python validator. The lib3mf read and the --overlap volume
// (CHK-PRT-03) need lib3mf and a manifold boolean per object pair; the
// mirror reports both as not run, and the Python validator stays the
// reference for them. check.run --artifact reads this (M00-T13).

import type { CheckResult, Verdict } from "../contracts.js";
import { audit } from "../mesh.js";
import { DEFAULT_TEMPLATE, exportError, type FilamentTemplate } from "../writer/template.js";
import { CHK_3MF_08, chk3mf08, type InterlockingDefaults } from "./chk-3mf-08.js";
import { checkCompleteness } from "./completeness.js";
import { readEntries, zipMemberNames } from "./reader.js";
import {
  BBS_ENTRIES, CORE_ENTRIES, MODEL_SETTINGS, PROJECT_SETTINGS, ROOT_MODEL,
  checkMaterials, checkModelSettings, checkPaths, entryText, readModels, type EntryMap, type ModelPart,
} from "./paths.js";
import {
  booleanResult, checkApplication, checkProjectSettings, resultSink, skipResult,
  type KeySetReport, type ResultSink, type ValidateMode, type ValidateTarget,
} from "./rules.js";

export { CHECK_META, KEPT_KEYS, APP_PREFIXES, slotKind, type KeySetReport, type SlotKind, type ValidateMode, type ValidateTarget, type ValidatorCheckId } from "./rules.js";
export { READER_LIMITS, readEntries, unsafeEntryName, zipMemberNames, type ReaderRule } from "./reader.js";
export { parseModel, partName, readModels, readRels, scanTags, type EntryMap, type ModelObject, type ModelPart, type XmlTag } from "./paths.js";

export interface ValidateOptions {
  /** Default export. */
  readonly mode?: ValidateMode;
  /** Default bbs; prusa is refused at the command layer (M00). */
  readonly target?: ValidateTarget;
  /** File name the results point at. */
  readonly artifact?: string;
  /** Member names of the export's STL zip (--stl-zip); completeness compares their count with the parts. */
  readonly stlMembers?: readonly string[];
  readonly template?: FilamentTemplate;
  /** Slicer interlocking defaults from profile (3mf.interlockingBeamWidth, 3mf.interlockingDepth); absent, a CHK-3MF-08 fail quotes no loss. */
  readonly interlocking?: InterlockingDefaults;
}

export interface ValidateReport {
  readonly artifact: string;
  readonly mode: ValidateMode;
  readonly target: ValidateTarget;
  /** fail when any result fails; skips never pass for a run. */
  readonly verdict: Extract<Verdict, "pass" | "fail">;
  readonly counts: { readonly ran: number; readonly skipped: number; readonly failed: number };
  readonly results: readonly CheckResult[];
  readonly notes: readonly string[];
  readonly keySet: KeySetReport | null;
}

/** trimesh merges vertices rounded to 8 decimals (tol.merge 1e-8); the Python reference audits after that merge. */
const TRIMESH_MERGE_GRID_PER_MM = 1e8;

const first = (bad: readonly string[]): Record<string, string> => (bad.length > 0 ? { first: bad.slice(0, 5).join("; ") } : {});

/** CHK-PRT-01 per mesh through the src/mesh.ts audit (BOSS auditIndexed, KNUCKLE audit, seed fan check). */
function checkTopology(sink: ResultSink, models: ReadonlyMap<string, ModelPart>): void {
  for (const [part, model] of models) {
    for (const [oid, o] of model.objects) {
      if (o.positions === undefined || o.triangles === undefined) continue;
      const where = `${part}#${oid}`;
      const bad: string[] = [];
      const nv = o.positions.length / 3;
      if (o.triangles.length === 0) bad.push("no triangles");
      else if (o.triangles.some((i) => !(i < nv))) bad.push("a triangle index is out of range");
      else {
        const a = audit({ positions: o.positions, triangles: o.triangles }, { mergeGridPerMm: TRIMESH_MERGE_GRID_PER_MM });
        if (a.degenerate > 0) bad.push(`${a.degenerate} degenerate triangles`);
        if (a.openEdgesRaw > 0) bad.push(`${a.openEdgesRaw} undirected edges not shared by exactly two faces (raw indices)`);
        if (a.windingErrors > 0) bad.push("inconsistent winding (a directed edge repeats)");
        if (!(a.signedVolumeMm3 > 0)) bad.push(`signed volume ${a.signedVolumeMm3.toFixed(4)} mm3 is not positive (inverted)`);
        if (a.openEdges > 0) bad.push("not watertight after vertex merge");
        if (a.nonManifoldVertices > 0) bad.push(`${a.nonManifoldVertices} non manifold vertices (two surfaces meet at a point)`);
      }
      sink.push(booleanResult(sink, "CHK-PRT-01", bad.length === 0, "every mesh is a closed manifold: two faces per undirected edge, one fan per vertex",
        where, { rule: "topology", triangles: o.triangles.length / 3, ...first(bad) }));
    }
  }
}

/** Every rule of the mode on one package held as an entry map. */
export function validateEntries(entries: EntryMap, opts: ValidateOptions = {}): ValidateReport {
  const mode = opts.mode ?? "export";
  const target = opts.target ?? "bbs";
  const artifact = opts.artifact ?? "model.3mf";
  const template = opts.template ?? DEFAULT_TEMPLATE;
  if (entryText(entries, ROOT_MODEL) === undefined) {
    throw exportError({ code: "E_SCHEMA", path: `/${ROOT_MODEL}`, expected: "a 3MF package with a root model", hint: `${artifact} has no ${ROOT_MODEL}` });
  }
  if (opts.stlMembers !== undefined && mode !== "export") {
    throw exportError({ code: "E_SCHEMA", path: "/stlMembers", expected: "mode export", hint: "the stl zip applies to --export only" });
  }
  const sink = resultSink(artifact);
  const need = target === "bbs" ? BBS_ENTRIES : CORE_ENTRIES;
  const missing = need.filter((e) => entries[e] === undefined);
  sink.push(booleanResult(sink, "CHK-3MF-06", missing.length === 0, `the package holds the entries the importer reads: ${need.join(", ")}`,
    undefined, { rule: "package", ...(missing.length > 0 ? { first: `missing ${missing.join(", ")}` } : {}) }));

  const models = readModels(entries, { triangleProps: target === "core" });
  const root = models.get(ROOT_MODEL)!;
  if (target === "bbs") checkApplication(sink, root.metadata["Application"] ?? "", ROOT_MODEL);
  else sink.push(skipResult(sink, "CHK-3MF-01", "not run for target core: no slicer dialect", ROOT_MODEL));

  checkPaths(sink, entries, models);

  let keySet: KeySetReport | null = null;
  if (target === "bbs") {
    let n: number | undefined;
    const text = entryText(entries, PROJECT_SETTINGS);
    if (text !== undefined) {
      let ps: unknown;
      try {
        ps = JSON.parse(text);
      } catch (e) {
        throw exportError({ code: "E_SCHEMA", path: `/${PROJECT_SETTINGS}`, hint: `${PROJECT_SETTINGS} is not JSON: ${String(e)}` });
      }
      if (typeof ps !== "object" || ps === null || Array.isArray(ps)) {
        throw exportError({ code: "E_SCHEMA", path: `/${PROJECT_SETTINGS}`, hint: `${PROJECT_SETTINGS} is not a JSON object` });
      }
      const r = checkProjectSettings(sink, ps as Record<string, unknown>, template, mode, PROJECT_SETTINGS);
      n = r.n;
      keySet = r.keySet;
    }
    checkModelSettings(sink, entries, models, n);
    const beam = chk3mf08(entries, opts.interlocking);
    if (beam.verdict === "skip") sink.push(skipResult(sink, CHK_3MF_08, beam.constraint, beam.path));
    else sink.push(booleanResult(sink, CHK_3MF_08, beam.verdict === "pass", beam.constraint, beam.path, beam.extra));
  } else {
    checkMaterials(sink, models);
    for (const id of ["CHK-3MF-02", "CHK-3MF-03", "CHK-3MF-07"] as const) {
      sink.push(skipResult(sink, id, "not run for target core: no slicer dialect keys", PROJECT_SETTINGS));
    }
    sink.push(skipResult(sink, CHK_3MF_08, "not run for target core: no per-object slicer settings", MODEL_SETTINGS));
  }

  if (mode === "roundtrip") sink.push(skipResult(sink, "CHK-PRT-01", "not run in --roundtrip: the slicer wrote the meshes", ROOT_MODEL));
  else {
    checkTopology(sink, models);
    sink.push(skipResult(sink, "CHK-PRT-01", "not run in the TypeScript mirror: the lib3mf read runs in tools/py/validate_3mf.py", ROOT_MODEL));
  }
  if (mode === "export") checkCompleteness(sink, entries, root, opts.stlMembers);

  const failed = sink.results.filter((r) => r.verdict === "fail").length;
  const skipped = sink.results.filter((r) => r.verdict === "skip").length;
  return {
    artifact, mode, target, verdict: failed > 0 ? "fail" : "pass",
    counts: { ran: sink.results.length - skipped, skipped, failed },
    results: sink.results, notes: sink.notes, keySet,
  };
}

/** validateEntries on .3mf bytes; stlZip, when given, is the export's STL zip. */
export async function validateZip(bytes: Uint8Array, opts: Omit<ValidateOptions, "stlMembers"> & { readonly stlZip?: Uint8Array } = {}): Promise<ValidateReport> {
  const entries = await readEntries(bytes);
  const { stlZip, ...rest } = opts;
  return validateEntries(entries, { ...rest, ...(stlZip !== undefined ? { stlMembers: await zipMemberNames(stlZip) } : {}) });
}

export { MODEL_SETTINGS, PROJECT_SETTINGS, ROOT_MODEL };
