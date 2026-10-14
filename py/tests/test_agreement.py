"""The Python and TypeScript writers agree entry by entry (D-052).

Every input under corpus/inputs/ is built by both writers; each entry's
sha256 and the artifactHash must be equal. Byte identity of the two zips is
outside the requirement. The TypeScript side runs from js/dist; run
`npm run build --prefix js` first.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py/hackbuild_3mf"))
import orca3mf  # noqa: E402

INPUTS = sorted((REPO / "corpus/inputs").glob("*.json"))
EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH") or 1791072000)
DIST = REPO / "js/dist/index.js"
MACHINES = REPO / "py/hackbuild_3mf/data/machines.json"

JS = r"""
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [dist, machinesPath, input, epoch] = process.argv.slice(2);
const { build, configOf, DEFAULT_TEMPLATE, DEFAULT_MATERIALS } = await import(pathToFileURL(dist).href);
const inp = JSON.parse(readFileSync(input, "utf8"));
const machines = JSON.parse(readFileSync(machinesPath, "utf8")).machines;
const preset = machines.find((m) => m.id === inp.machine).presets.find((p) => p.id === inp.preset);
const out = build(configOf({
  title: inp.title, chase: inp.chase, buildHash: inp.buildHash, sourceDateEpoch: Number(epoch),
  ...(inp.license === undefined ? {} : { license: inp.license }),
  ...(inp.designer === undefined ? {} : { designer: inp.designer }),
  slicer: preset.slicer, nozzleMm: preset.nozzle, template: DEFAULT_TEMPLATE, materials: DEFAULT_MATERIALS,
  filaments: inp.filaments,
  ...(inp.adjacency === undefined ? {} : { adjacency: inp.adjacency }),
  objects: inp.objects.map((o) => ({ name: o.name, position: o.position,
    bodies: o.bodies.map((b) => ({ name: b.name, slot: b.slot, mesh: { positions: b.positions, triangles: b.triangles },
      ...(b.body === undefined ? {} : { body: b.body }), ...(b.role === undefined ? {} : { role: b.role }),
      ...(b.widthMm === undefined ? {} : { widthMm: b.widthMm }) })) })),
}));
if (!out.ok) { console.error(JSON.stringify(out.completeness)); process.exit(1); }
const entries = {};
for (const [k, v] of Object.entries(out.entries)) entries[k] = createHash("sha256").update(Buffer.from(v, "utf8")).digest("hex");
process.stdout.write(JSON.stringify({ entries, artifactHash: out.artifactHash, warnings: out.warnings }));
"""


@pytest.fixture(scope="module")
def ts_driver(tmp_path_factory):
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is not on PATH; the agreement test needs the TypeScript writer")
    if not DIST.is_file():
        pytest.fail("js/dist is missing; run npm run build --prefix js first")
    out = tmp_path_factory.mktemp("agreement") / "driver.mjs"
    out.write_text(JS, encoding="utf-8")
    return node, out


def ts_build(driver, path):
    node, script = driver
    r = subprocess.run([node, str(script), str(DIST), str(MACHINES), str(path), str(EPOCH)],
                       cwd=REPO, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def py_build(path):
    with open(path, encoding="utf-8") as fh:
        inp = json.load(fh)
    w = orca3mf.from_input(inp, source_date_epoch=EPOCH)
    entries = w.entries()
    return {"entries": {k: hashlib.sha256(v).hexdigest() for k, v in entries.items()},
            "artifactHash": orca3mf.artifact_hash(entries), "warnings": w.warnings}


def test_inputs_present():
    assert {"tetra-2part.json", "collar-coin.json"} <= {p.name for p in INPUTS}


@pytest.mark.parametrize("path", INPUTS, ids=[p.stem for p in INPUTS])
def test_entries_and_artifact_hash_agree(ts_driver, path):
    js = ts_build(ts_driver, path)
    py = py_build(path)
    assert sorted(py["entries"]) == sorted(js["entries"])
    differ = [k for k in py["entries"] if py["entries"][k] != js["entries"][k]]
    assert differ == [], "entries differ between the writers: %s" % differ
    assert py["artifactHash"] == js["artifactHash"]
    assert [w["code"] for w in py["warnings"]] == [w["code"] for w in js["warnings"]]


def test_bed_type_from_machine_preset():
    with open(INPUTS[0], encoding="utf-8") as fh:
        inp = json.load(fh)
    ps = json.loads(orca3mf.from_input(inp, source_date_epoch=EPOCH).entries()["Metadata/project_settings.config"])
    preset = orca3mf.machine_preset(inp["machine"], inp["preset"])
    assert ps["curr_bed_type"] == preset["slicer"]["bedType"] == "Textured PEI Plate"


# A build with no printer writes data/default_preset.json on both sides, and
# both writers rank didYouMean by edit distance the same way.
DEFAULTS_JS = r"""
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [dist, mode, arg, epoch] = process.argv.slice(2);
const { build, didYouMean } = await import(pathToFileURL(dist).href);
if (mode === "rank") {
  process.stdout.write(JSON.stringify(JSON.parse(arg).map(([got, ids]) => didYouMean(got, ids))));
} else {
  const inp = JSON.parse(readFileSync(arg, "utf8"));
  const out = build({
    title: inp.title, chase: inp.chase, buildHash: inp.buildHash, sourceDateEpoch: Number(epoch),
    filaments: inp.filaments.map((f) => ({ color: f.colour, type: f.type, material: f.material })),
    objects: inp.objects.map((o) => ({ name: o.name, positions: [o.position],
      parts: o.bodies.map((b) => ({ name: b.name, slot: b.slot, positions: b.positions, indices: b.triangles })) })),
  });
  const entries = {};
  for (const [k, v] of Object.entries(out.entries)) entries[k] = createHash("sha256").update(Buffer.from(v, "utf8")).digest("hex");
  process.stdout.write(JSON.stringify({ entries, artifactHash: out.artifactHash }));
}
"""


@pytest.fixture(scope="module")
def ts_defaults(ts_driver, tmp_path_factory):
    node, _ = ts_driver
    out = tmp_path_factory.mktemp("defaults") / "defaults.mjs"
    out.write_text(DEFAULTS_JS, encoding="utf-8")

    def run(mode, arg):
        r = subprocess.run([node, str(out), str(DIST), mode, str(arg), str(EPOCH)], cwd=REPO, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)
    return run


@pytest.mark.parametrize("path", INPUTS, ids=[p.stem for p in INPUTS])
def test_no_printer_builds_agree(ts_defaults, path):
    with open(path, encoding="utf-8") as fh:
        inp = json.load(fh)
    w = orca3mf.Orca3MF([{"color": f["colour"], "type": f["type"], "material": f.get("material")} for f in inp["filaments"]],
                        title=inp["title"], chase=inp["chase"], build_hash=inp["buildHash"], source_date_epoch=EPOCH)
    for o in inp["objects"]:
        w.add(orca3mf.PrintObject(o["name"], [orca3mf.Part(b["name"], b["positions"], b["triangles"], b["slot"]) for b in o["bodies"]]),
              [o["position"]])
    entries = w.entries()
    js = ts_defaults("build", path)
    assert {k: hashlib.sha256(v).hexdigest() for k, v in entries.items()} == js["entries"]
    assert orca3mf.artifact_hash(entries) == js["artifactHash"]


def test_did_you_mean_ranks_as_the_typescript_writer(ts_defaults):
    cases = [["PTEG", ["ABS", "ASA", "PLA", "PETG", "TPU"]], [None, ["PLA", "ABS", "TPU"]],
             ["Generic PTEG @FF C5P", list(orca3mf.PRESETS)]]
    assert [orca3mf.did_you_mean(g, ids) for g, ids in cases] == ts_defaults("rank", json.dumps(cases))
