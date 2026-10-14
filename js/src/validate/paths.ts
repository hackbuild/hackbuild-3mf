// Package parts of a 3MF read from an entry map, and CHK-3MF-06 per D-068
// (CHECKS.md 7.2): every component p:path resolves to a model part listed
// in 3D/_rels/3dmodel.model.rels, other than the root model, and the object
// id exists there; a component without p:path resolves in its own part.
// Mirror of tools/py/validate_3mf.py check_paths and check_model_settings.
// The reader is a tag scanner over the XML text, enough for the 3MF core,
// production and material elements; kernels run without a DOM.

import type { CheckResult } from "../contracts.js";
import { booleanResult, type ResultSink } from "./rules.js";

export const ROOT_MODEL = "3D/3dmodel.model";
export const ROOT_RELS = "3D/_rels/3dmodel.model.rels";
export const MODEL_SETTINGS = "Metadata/model_settings.config";
export const PROJECT_SETTINGS = "Metadata/project_settings.config";
export const BBS_ENTRIES = ["[Content_Types].xml", "_rels/.rels", ROOT_MODEL, MODEL_SETTINGS, PROJECT_SETTINGS] as const;
export const CORE_ENTRIES = ["[Content_Types].xml", "_rels/.rels", ROOT_MODEL] as const;

const NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

/** Zip members by path; text entries as strings, binary as bytes. */
export type EntryMap = Readonly<Record<string, string | Uint8Array>>;

export interface XmlTag {
  /** Local name, prefix dropped. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly close: boolean;
  readonly selfClosing: boolean;
  /** Offset just past the tag, for reading text content. */
  readonly end: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e]!);
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Every element tag in document order; comments, declarations and text are skipped. */
export function* scanTags(xml: string): Generator<XmlTag> {
  TAG.lastIndex = 0;
  for (let m = TAG.exec(xml); m !== null; m = TAG.exec(xml)) {
    // No prototype: an attribute named __proto__ is kept, never dropped.
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    const raw = m[3] ?? "";
    if (raw !== "") {
      ATTR.lastIndex = 0;
      for (let a = ATTR.exec(raw); a !== null; a = ATTR.exec(raw)) attrs[a[1]!] = unescapeXml(a[2] ?? a[3] ?? "");
    }
    const q = m[2]!;
    yield { name: q.slice(q.indexOf(":") + 1), attrs, close: m[1] === "/", selfClosing: m[4] === "/", end: TAG.lastIndex };
  }
}

export interface ComponentRef {
  readonly objectid: number;
  readonly path?: string;
  readonly transform?: string;
}

export interface ModelObject {
  readonly id: number;
  readonly name?: string;
  readonly pid?: string;
  readonly pindex?: string;
  /** Vertex coordinates, mm, x y z per vertex; absent on a component object. */
  readonly positions?: Float64Array;
  readonly triangles?: Uint32Array;
  /** Per triangle pid and p1 to p3 when present (target core). */
  readonly triangleProps?: readonly { readonly pid?: string; readonly idx: readonly string[] }[];
  readonly components: readonly ComponentRef[];
}

export interface ModelPart {
  readonly objects: ReadonlyMap<number, ModelObject>;
  readonly buildItems: readonly number[];
  readonly metadata: Readonly<Record<string, string>>;
  /** Material groups: id to element count. */
  readonly groups: ReadonlyMap<string, number>;
}

export function entryText(entries: EntryMap, name: string): string | undefined {
  const v = entries[name];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : new TextDecoder("utf-8").decode(v);
}

/** A package part name without the leading slash, with . and .. segments resolved. */
export function partName(target: string): string {
  const out: string[] = [];
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Objects, build items, metadata and material groups of one model part. */
export function parseModel(xml: string, opts: { readonly triangleProps?: boolean } = {}): ModelPart {
  const objects = new Map<number, ModelObject>();
  const buildItems: number[] = [];
  // No prototype: a metadata name of __proto__ is kept, and a lookup of constructor or toString finds nothing.
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  const groups = new Map<string, number>();
  let pathAttr = "p:path";
  let cur: { id: number; name?: string; pid?: string; pindex?: string; pos: number[]; tri: number[]; props: { pid?: string; idx: string[] }[]; comps: ComponentRef[]; mesh: boolean } | null = null;
  let group: string | null = null;
  for (const t of scanTags(xml)) {
    if (t.close) {
      if (t.name === "object" && cur !== null) {
        objects.set(cur.id, {
          id: cur.id, components: cur.comps,
          ...(cur.name !== undefined ? { name: cur.name } : {}),
          ...(cur.pid !== undefined ? { pid: cur.pid } : {}),
          ...(cur.pindex !== undefined ? { pindex: cur.pindex } : {}),
          ...(cur.mesh ? { positions: Float64Array.from(cur.pos), triangles: Uint32Array.from(cur.tri) } : {}),
          ...(cur.mesh && opts.triangleProps === true ? { triangleProps: cur.props } : {}),
        });
        cur = null;
      } else if (t.name === "basematerials" || t.name === "colorgroup") group = null;
      continue;
    }
    switch (t.name) {
      case "model": {
        for (const [k, v] of Object.entries(t.attrs)) if (k.startsWith("xmlns:") && v === NS_PROD) pathAttr = `${k.slice(6)}:path`;
        break;
      }
      case "metadata": {
        const name = t.attrs["name"];
        if (name !== undefined && cur === null && !t.selfClosing) {
          const stop = xml.indexOf("<", t.end);
          metadata[name] = unescapeXml(xml.slice(t.end, stop < 0 ? undefined : stop));
        }
        break;
      }
      case "object": {
        const a = t.attrs;
        cur = { id: Number(a["id"]), pos: [], tri: [], props: [], comps: [], mesh: false,
          ...(a["name"] !== undefined ? { name: a["name"] } : {}),
          ...(a["pid"] !== undefined ? { pid: a["pid"] } : {}),
          ...(a["pindex"] !== undefined ? { pindex: a["pindex"] } : {}) };
        if (t.selfClosing) {
          objects.set(cur.id, { id: cur.id, components: [] });
          cur = null;
        }
        break;
      }
      case "mesh":
        if (cur !== null) cur.mesh = true;
        break;
      case "vertex":
        cur?.pos.push(Number(t.attrs["x"]), Number(t.attrs["y"]), Number(t.attrs["z"]));
        break;
      case "triangle":
        if (cur !== null) {
          cur.tri.push(Number(t.attrs["v1"]), Number(t.attrs["v2"]), Number(t.attrs["v3"]));
          if (opts.triangleProps === true) {
            const idx = ["p1", "p2", "p3"].map((k) => t.attrs[k]).filter((x): x is string => x !== undefined);
            cur.props.push({ idx, ...(t.attrs["pid"] !== undefined ? { pid: t.attrs["pid"] } : {}) });
          }
        }
        break;
      case "component": {
        const p = t.attrs[pathAttr];
        const tr = t.attrs["transform"];
        cur?.comps.push({ objectid: Number(t.attrs["objectid"]), ...(p !== undefined ? { path: p } : {}), ...(tr !== undefined ? { transform: tr } : {}) });
        break;
      }
      case "item":
        buildItems.push(Number(t.attrs["objectid"]));
        break;
      case "basematerials":
      case "colorgroup":
        group = t.attrs["id"] ?? null;
        if (group !== null) groups.set(group, 0);
        if (t.selfClosing) group = null;
        break;
      case "base":
      case "color":
        if (group !== null) groups.set(group, (groups.get(group) ?? 0) + 1);
        break;
      default:
        break;
    }
  }
  return { objects, buildItems, metadata, groups };
}

/** Targets of 3D/_rels/3dmodel.model.rels as part names. */
export function readRels(entries: EntryMap): ReadonlySet<string> {
  const xml = entryText(entries, ROOT_RELS);
  const out = new Set<string>();
  if (xml === undefined) return out;
  for (const t of scanTags(xml)) if (!t.close && t.name === "Relationship" && t.attrs["Target"] !== undefined) out.add(partName(t.attrs["Target"]));
  return out;
}

/** The root model plus every part a root component names by p:path and the package holds. */
export function readModels(entries: EntryMap, opts: { readonly triangleProps?: boolean } = {}): Map<string, ModelPart> {
  const models = new Map<string, ModelPart>();
  const root = parseModel(entryText(entries, ROOT_MODEL) ?? "", opts);
  models.set(ROOT_MODEL, root);
  for (const obj of root.objects.values()) {
    for (const c of obj.components) {
      if (c.path === undefined) continue;
      const pn = partName(c.path);
      if (pn === ROOT_MODEL || models.has(pn)) continue;
      const xml = entryText(entries, pn);
      if (xml !== undefined) models.set(pn, parseModel(xml, opts));
    }
  }
  return models;
}

const first = (bad: readonly string[]): Record<string, string> => (bad.length > 0 ? { first: bad.slice(0, 5).join("; ") } : {});

/** CHK-3MF-06 on component references and build items. */
export function checkPaths(sink: ResultSink, entries: EntryMap, models: ReadonlyMap<string, ModelPart>): CheckResult {
  const rels = readRels(entries);
  const bad: string[] = [];
  let count = 0;
  for (const [part, model] of models) {
    for (const [oid, obj] of model.objects) {
      obj.components.forEach((c, ci) => {
        count += 1;
        const where = `${part}#${oid}/${ci}`;
        if (c.path !== undefined) {
          const pn = partName(c.path);
          if (pn === ROOT_MODEL) bad.push(`${where} self-reference: p:path ${c.path} is the root model`);
          else if (entries[pn] === undefined) bad.push(`${where} missing part: ${c.path} is not in the package`);
          else if (!rels.has(pn)) bad.push(`${where} missing part: ${c.path} is not listed in ${ROOT_RELS}`);
          else if (!(models.get(pn)?.objects.has(c.objectid) ?? false)) bad.push(`${where} missing object: id ${c.objectid} is not in ${c.path}`);
        } else if (!model.objects.has(c.objectid)) {
          bad.push(`${where} missing object: id ${c.objectid} is not in ${part}`);
        }
      });
    }
  }
  const root = models.get(ROOT_MODEL)!;
  for (const id of root.buildItems) if (!root.objects.has(id)) bad.push(`build item objectid ${id} is not in the root model`);
  if (root.buildItems.length === 0) bad.push("the root model has no build items");
  return sink.push(booleanResult(sink, "CHK-3MF-06", bad.length === 0,
    "every component p:path resolves to a model part other than the root model and the object id exists there; a component without p:path resolves in its own part (D-068)",
    undefined, { components: count, failures: bad.length, ...first(bad) }));
}

/** model_settings objects exist in the root, parts resolve to a mesh in any part, every part has an extruder in range. */
export function checkModelSettings(sink: ResultSink, entries: EntryMap, models: ReadonlyMap<string, ModelPart>, nFil: number | undefined): CheckResult | undefined {
  const xml = entryText(entries, MODEL_SETTINGS);
  if (xml === undefined) return undefined;
  const root = models.get(ROOT_MODEL)!;
  const meshIds = new Set<number>();
  for (const m of models.values()) for (const [id, o] of m.objects) if (o.positions !== undefined) meshIds.add(id);
  const bad: string[] = [];
  let objects = 0;
  let parts = 0;
  let instances = 0;
  let depth: "none" | "object" | "part" | "plate" = "none";
  let oid = 0;
  let pid = 0;
  let objExt: string | undefined;
  let partExt: string | undefined;
  const closePart = (): void => {
    const ext = partExt ?? objExt;
    if (ext === undefined) bad.push(`part ${pid} and object ${oid} have no extruder`);
    else if (nFil !== undefined && (!/^[0-9]+$/.test(ext) || Number(ext) < 1 || Number(ext) > nFil)) bad.push(`part ${pid} uses extruder ${ext} but ${nFil} filaments are declared`);
  };
  for (const t of scanTags(xml)) {
    if (t.close) {
      if (t.name === "part" && depth === "part") {
        closePart();
        depth = "object";
      } else if (t.name === "object") depth = "none";
      else if (t.name === "plate") depth = "none";
      continue;
    }
    if (t.name === "object" && depth === "none") {
      objects += 1;
      oid = Number(t.attrs["id"]);
      objExt = undefined;
      if (!root.objects.has(oid)) bad.push(`object ${oid} is not in the root model`);
      depth = t.selfClosing ? "none" : "object";
    } else if (t.name === "part" && depth === "object") {
      parts += 1;
      pid = Number(t.attrs["id"]);
      partExt = undefined;
      if (!meshIds.has(pid)) bad.push(`part ${pid} of object ${oid} resolves to no mesh in any model part`);
      depth = "part";
      if (t.selfClosing) {
        closePart();
        depth = "object";
      }
    } else if (t.name === "metadata" && t.attrs["key"] === "extruder") {
      // A part without its own extruder takes the object's, as the slicer saves it (TENON and HAFT saves).
      if (depth === "object") objExt = t.attrs["value"];
      else if (depth === "part") partExt = t.attrs["value"];
    } else if (t.name === "plate") depth = "plate";
    else if (t.name === "model_instance" && depth === "plate") instances += 1;
  }
  if (instances === 0) bad.push("plate has no model_instance blocks");
  return sink.push(booleanResult(sink, "CHK-3MF-06", bad.length === 0,
    "model_settings objects exist in the root model and every part resolves to a mesh with a declared extruder",
    MODEL_SETTINGS, { rule: "model-settings", objects, parts, failures: bad.length, ...first(bad) }));
}

/** Target core: every pid and pindex (object) and p1 to p3 (triangle) points into a declared group. */
export function checkMaterials(sink: ResultSink, models: ReadonlyMap<string, ModelPart>): CheckResult {
  const root = models.get(ROOT_MODEL)!;
  const sizes = root.groups;
  const bad: string[] = [];
  for (const [oid, o] of root.objects) {
    if (o.pid === undefined) continue;
    const size = sizes.get(o.pid);
    if (size === undefined) {
      bad.push(`object ${oid} pid ${o.pid} names no basematerials or colorgroup`);
      continue;
    }
    if (o.pindex !== undefined && !(Number(o.pindex) >= 0 && Number(o.pindex) < size)) bad.push(`object ${oid} pindex ${o.pindex} is outside group ${o.pid} of ${size}`);
    for (const tp of o.triangleProps ?? []) {
      const g = tp.pid ?? o.pid;
      const n = sizes.get(g);
      if (n === undefined) {
        bad.push(`object ${oid} triangle pid ${g} names no group`);
        break;
      }
      if (tp.idx.some((i) => !(Number(i) >= 0 && Number(i) < n))) {
        bad.push(`object ${oid} triangle index [${tp.idx.join(", ")}] outside group ${g} of ${n}`);
        break;
      }
    }
  }
  return sink.push(booleanResult(sink, "CHK-3MF-06", bad.length === 0, "target core: every material reference resolves to a declared group and index",
    ROOT_MODEL, { rule: "materials", groups: sizes.size, ...first(bad) }));
}
