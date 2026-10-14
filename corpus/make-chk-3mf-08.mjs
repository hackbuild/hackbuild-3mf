#!/usr/bin/env node
// Writes the CHK-3MF-08 fixtures (M05-T20) to
// packages/checks/test/fixtures/CHK-3MF-08/. pass.3mf is export3mf of
// reference/keys/flex-pair at its default params with SOURCE_DATE_EPOCH
// 315532800: one object, flex-pair, holding the six conductor parts with
// the writer's overrides (interlocking_beam 0 on the object, solid infill on
// each conductor part) and the conductor record in
// Metadata/hackbuild_chase.json. Each fail file is that export with one
// edit a slicer save could make, rezipped with every entry dated at the same
// epoch:
//
//   fail-project-beam  the object's interlocking_beam line removed and the
//                      project set to interlocking_beam "1", so the object
//                      inherits beams from the project
//   fail-object-beam   the object's interlocking_beam set to "1"
//
//   npx tsc -b && node tools/corpus/3mf/make-chk-3mf-08.mjs
//
// It lives under tools/ because it builds through core; the checks package
// may not import core (tools/tiers.json). Generated, never hand-edited; the
// tests read the committed bytes.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = path.join(ROOT, "packages/checks/test/fixtures/CHK-3MF-08");
const EPOCH = 315532800;
const MODEL_SETTINGS = "Metadata/model_settings.config";
const PROJECT = "Metadata/project_settings.config";
const OBJECT_BEAM = /\n {4}<metadata key="interlocking_beam" value="0"\/>/;

for (const p of ["core/dist/resolve-hook.js", "core/dist/commands/build.js"]) {
  if (!existsSync(path.join(ROOT, p))) {
    console.error(`${p} is missing; run npx tsc -b first`);
    process.exit(2);
  }
}
register(pathToFileURL(path.join(ROOT, "core/dist/resolve-hook.js")).href);
const B = await import(pathToFileURL(path.join(ROOT, "core/dist/commands/build.js")).href);
const { default: JSZip } = await import(pathToFileURL(path.join(ROOT, "node_modules/jszip/lib/index.js")).href);

process.env.SOURCE_DATE_EPOCH = String(EPOCH);
const design = await B.loadDesign("reference/keys/flex-pair", ROOT);
const built = await B.buildPart(design, B.resolveParams(design.chase, undefined, undefined));
const pkg = await B.export3mf(built);

async function rezip(bytes, edit) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  const next = new JSZip();
  const date = new Date(EPOCH * 1000);
  for (const n of names) next.file(n, edit(n, await zip.files[n].async("string")), { date, createFolders: false });
  return next.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

function once(raw, re, to, what) {
  if (!re.test(raw)) throw new Error(`${what}: the export holds no ${re}`);
  return raw.replace(re, to);
}

const EDITS = {
  "fail-project-beam": (n, raw) => {
    if (n === MODEL_SETTINGS) return once(raw, OBJECT_BEAM, "", "fail-project-beam");
    if (n !== PROJECT) return raw;
    const ps = JSON.parse(raw);
    ps.interlocking_beam = "1";
    return JSON.stringify(Object.fromEntries(Object.entries(ps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 4);
  },
  "fail-object-beam": (n, raw) => (n === MODEL_SETTINGS
    ? once(raw, OBJECT_BEAM, '\n    <metadata key="interlocking_beam" value="1"/>', "fail-object-beam") : raw),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "pass.3mf"), pkg.bytes);
console.log(`pass.3mf ${pkg.bytes.length} bytes, artifactHash ${pkg.artifactHash}, build ${built.part.buildHash}`);
const same = Buffer.from(await rezip(pkg.bytes, (_n, raw) => raw));
for (const [name, edit] of Object.entries(EDITS)) {
  const bad = Buffer.from(await rezip(pkg.bytes, edit));
  if (Buffer.compare(bad, same) === 0) throw new Error(`${name}: the edit changed nothing`);
  writeFileSync(path.join(OUT, `${name}.3mf`), bad);
  console.log(`${name}.3mf ${bad.length} bytes`);
}
