#!/usr/bin/env python3
"""
run.py: the 3MF conformance corpus runner (M00-T10, TESTING.md 6.4).

    uv run --project py corpus/run.py [--validator path] [--set name] [--json out.json]

Every row of manifest.json runs through the Python validator
(py/hackbuild_3mf/validate_3mf.py, the reference, D-140) and the TypeScript mirror
(js/src/validate/, through mirror.mjs on the compiled package).
The runner exits 1 when a row lands outside its expectation, when the two
validators disagree on a row, or when the manifest itself is wrong: a copy
whose sha256 drifted, a sameAs row whose source differs from its target,
two sources that slugify to one destination, or a corpus file no row names.

Expectations (manifest row `expect`):
  pass    the validator passes the file
  fail    the validator fails it, and the failing check ids equal failsWith
  legacy  verdicts recorded: the failing check ids equal failsWith, never fixed in place
  parse   the validator reads the file (exit 0 or 1, never 2 or 70); verdict recorded
A row may add `asserts` (key-set, completeness, names, slice_info) and a
changed expectation carries a `reason` line.

--validator loads another copy of validate_3mf.py; the corpus test uses it
to show that a validator skipping CHK-3MF-06 makes this runner exit 1.
Reports under reports/ are regenerated on a full run with the reference
validator, never typed.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import zipfile
from collections import Counter, OrderedDict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MANIFEST = HERE / "manifest.json"
REPORTS = HERE / "reports"
REFERENCE_VALIDATOR = REPO / "py/hackbuild_3mf/validate_3mf.py"
MIRROR = HERE / "mirror.mjs"
SEED_TEMPLATE = HERE / "seed-97.json"
GOLD_ID = "gold"
SLICE_INFO = "Metadata/slice_info.config"
PLATE_JSON = "Metadata/plate_1.json"
# Sets whose copies keep the source file name under the slug rule (step 1); known-bad and gold are renamed on purpose.
SLUGGED_SETS = ("boss", "owner", "sprue", "legacy", "cotter", "roundtrip", "downloads")
# How a set's line reads when every row in it shares one expectation.
VERB = {"pass": "pass", "fail": "fail as named", "legacy": "legacy as recorded", "parse": "parse"}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def slug(name):
    """Lowercase; each run of characters outside [a-z0-9._-] becomes one '-'; '-' dropped at either end of the stem."""
    stem, ext = (name[:-4], name[-4:].lower()) if name.lower().endswith(".3mf") else (name, "")
    return re.sub(r"[^a-z0-9._-]+", "-", stem.lower()).strip("-") + ext


def parse_mode(mode):
    flags = mode.split()
    m = next((f[2:] for f in flags if f in ("--export", "--legacy", "--roundtrip")), "export")
    return m, "--overlap" in flags


def load_validator(path):
    spec = importlib.util.spec_from_file_location("validate_3mf_corpus", str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(Path(path).resolve().parent))
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------ manifest structure
def check_manifest(rows, problems):
    by_id = {}
    for r in rows:
        if r["id"] in by_id:
            problems.append("manifest: id %s appears twice" % r["id"])
        by_id[r["id"]] = r
    dest = {}
    for r in rows:
        if "sameAs" in r:
            t = by_id.get(r["sameAs"])
            if t is None or "sameAs" in t:
                problems.append("manifest: %s sameAs %s names no copied row" % (r["id"], r["sameAs"]))
                continue
            if r["sha256"] != t["sha256"]:
                problems.append("manifest: %s source sha256 %s differs from %s sha256 %s"
                                % (r["id"], r["sha256"][:12], t["id"], t["sha256"][:12]))
            if r["path"] != t["path"]:
                problems.append("manifest: %s path %s is not its target's copy %s" % (r["id"], r["path"], t["path"]))
        else:
            if r["path"] in dest:
                problems.append("manifest: %s and %s both land at %s" % (dest[r["path"]], r["id"], r["path"]))
            dest[r["path"]] = r["id"]
            p = HERE / r["path"]
            if not p.is_file():
                problems.append("manifest: %s has no copy at %s" % (r["id"], r["path"]))
            elif sha256(p) != r["sha256"]:
                problems.append("manifest: %s copy sha256 %s differs from the row %s" % (r["id"], sha256(p)[:12], r["sha256"][:12]))
            if r["set"] in SLUGGED_SETS and Path(r["path"]).name != slug(Path(r["source"]).name):
                problems.append("manifest: %s lands at %s, the slug of %s is %s"
                                % (r["id"], r["path"], Path(r["source"]).name, slug(Path(r["source"]).name)))
        src = Path(r["source"])
        if src.is_file() and "edit" not in r and sha256(src) != r["sha256"]:
            problems.append("manifest: %s source %s changed since it was copied" % (r["id"], src))
        if "edit" in r and src.is_file() and sha256(src) != r.get("sourceSha256"):
            problems.append("manifest: %s edit source %s changed since the fixture was made" % (r["id"], src))
    named = {HERE / p for p in dest} | {HERE / r["stlZip"] for r in rows if "stlZip" in r}
    for f in sorted(HERE.rglob("*")):
        if f.suffix in (".3mf", ".zip") and f not in named:
            problems.append("manifest: %s is in the corpus but no row names it" % f.relative_to(HERE))
    gold = by_id.get(GOLD_ID)
    if gold is not None:
        copies = [p for p in dest if (HERE / p).is_file() and sha256(HERE / p) == gold["sha256"]]
        if len(copies) != 1:
            problems.append("manifest: the gold sha256 appears %d times among copied files" % len(copies))
    return by_id


# ------------------------------------------------------------------ the two validators
def run_python(v, row, problems):
    mode, overlap = parse_mode(row["mode"])
    path = HERE / row["path"]
    stl = HERE / row["stlZip"] if "stlZip" in row else None
    out = {"error": None, "verdict": None, "fails": [], "results": [], "keySet": None, "names": None}
    try:
        rep = v.validate(path, mode, row.get("target", "bbs"), overlap, None, stl, quiet=True)
    except v.InputError as ex:
        out["error"] = "input: %s" % ex
        return out
    except Exception as ex:  # the validator broke; never a verdict
        out["error"] = "internal: %s: %s" % (type(ex).__name__, ex)
        return out
    j = rep.as_json()
    out.update(verdict=j["verdict"], results=j["results"], keySet=j["keySet"],
               fails=sorted({r["id"] for r in j["results"] if r["verdict"] == "fail"}))
    if row.get("asserts", {}).get("names"):
        z = zipfile.ZipFile(path)
        nrep = v.Report(path.name, mode, row.get("target", "bbs"))
        v.check_completeness(nrep, v._parse_xml(z, v.MODEL_SETTINGS), None, None)
        out["names"] = nrep.results[0]
    return out


def run_mirror(rows):
    """One node process over every row; returns id -> mirror report, or raises with the reason."""
    if not (REPO / "js/dist/index.js").is_file():
        raise RuntimeError("js/dist is missing; run npm run build --prefix js first")
    batch = []
    for r in rows:
        mode, _ = parse_mode(r["mode"])
        item = {"id": r["id"], "file": str(HERE / r["path"]), "mode": mode, "target": r.get("target", "bbs")}
        if "stlZip" in r:
            item["stlZip"] = str(HERE / r["stlZip"])
        if r.get("asserts", {}).get("names"):
            item["names"] = True
        batch.append(item)
    p = subprocess.run(["node", str(MIRROR)], input=json.dumps(batch), capture_output=True, text=True, cwd=REPO)
    if p.returncode != 0:
        raise RuntimeError("mirror.mjs exited %d: %s" % (p.returncode, p.stderr.strip()[-2000:]))
    return {x["id"]: x for x in json.loads(p.stdout)}


def verdict_map(results, rule_key):
    """Results keyed by id, rule and path, skips dropped; the mirror leaves the lib3mf read and CHK-PRT-03 to Python."""
    out = {}
    for r in results:
        rule = rule_key(r)
        if r["verdict"] == "skip" or r["id"] == "CHK-PRT-03" or rule == "lib3mf":
            continue
        path = r["target"].get("path", "") if "target" in r else r.get("path", "")
        k = "%s[%s]%s" % (r["id"], rule, path or "")
        out[k] = "fail" if out.get(k) == "fail" else r["verdict"]
    return out


def disagreement(py, ts):
    if ts is None:
        return "the mirror returned no report"
    if py["error"] or ts.get("error"):
        if bool(py["error"]) != bool(ts.get("error")):
            return "python %s, mirror %s" % (py["error"] or "read the file", ts.get("error") or "read the file")
        return None
    a = verdict_map(py["results"], lambda r: r.get("extra", {}).get("rule", ""))
    b = verdict_map(ts["results"], lambda r: r.get("rule", ""))
    diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    if diff:
        return "; ".join("%s python %s mirror %s" % (k, a.get(k, "absent"), b.get(k, "absent")) for k in diff[:4])
    pk = (py["keySet"] or {}).get("present")
    tk = (ts.get("keySet") or {}).get("present")
    if pk != tk:
        return "key-set present python %s mirror %s" % (pk, tk)
    if py["names"] is not None and (ts.get("names") or {}).get("verdict") != py["names"]["verdict"]:
        return "names python %s mirror %s" % (py["names"]["verdict"], (ts.get("names") or {}).get("verdict"))
    return None


# ------------------------------------------------------------------ expectations
def slice_info(path):
    z = zipfile.ZipFile(path)
    if SLICE_INFO not in z.namelist():
        return {}
    text = z.read(SLICE_INFO).decode("utf-8", "replace")
    return dict(re.findall(r'<header_item key="([^"]+)" value="([^"]*)"', text))


def check_asserts(row, py):
    bad = []
    a = row.get("asserts", {})
    ks = py["keySet"] or {}
    for k in ("present", "nonTemplateVectors", "nonTemplateVectorLengths", "templateLengths", "filaments"):
        if k in a.get("keySet", {}) and ks.get(k) != a["keySet"][k]:
            bad.append("keySet.%s %s, expected %s" % (k, json.dumps(ks.get(k)), json.dumps(a["keySet"][k])))
    if "absent" in a.get("keySet", {}) and len(ks.get("absent", [])) != a["keySet"]["absent"]:
        bad.append("keySet.absent %d, expected %d" % (len(ks.get("absent", [])), a["keySet"]["absent"]))
    if a.get("allTemplateAtN"):
        n = ks.get("filaments")
        if ks.get("templateLengths") != {str(n): ks.get("present")}:
            bad.append("template vectors %s at N %s" % (json.dumps(ks.get("templateLengths")), n))
    for k, want in a.get("sliceInfo", {}).items():
        got = slice_info(HERE / row["path"]).get(k)
        if got != want:
            bad.append("slice_info %s %s, expected %s" % (k, got, want))
    if "completeness" in a:
        c = next((r for r in py["results"] if r["id"] == "CHK-ART-01"), None)
        extra = (c or {}).get("extra", {})
        for k in ("parts", "stlMembers", "objects"):
            if k in a["completeness"] and extra.get(k) != a["completeness"][k]:
                bad.append("completeness %s %s, expected %s" % (k, extra.get(k), a["completeness"][k]))
        if "first" in a["completeness"] and a["completeness"]["first"] not in str(extra.get("first", "")):
            bad.append("completeness detail lacks %s" % a["completeness"]["first"])
    if a.get("names"):
        n = py["names"] or {}
        want = a["names"]
        if n.get("verdict") != want["verdict"] or n.get("extra", {}).get("objects") != want["objects"]:
            bad.append("names %s over %s objects, expected %s over %s"
                       % (n.get("verdict"), n.get("extra", {}).get("objects"), want["verdict"], want["objects"]))
    if a.get("componentsResolve"):
        c = [r for r in py["results"] if r["id"] == "CHK-3MF-06" and "rule" not in r.get("extra", {})]
        if not c or c[0]["verdict"] != "pass" or not c[0]["extra"].get("components"):
            bad.append("no component p:path resolved")
    return bad


def check_expect(row, py):
    exp = row["expect"]
    if py["error"]:
        return ["validator error, %s" % py["error"]]
    if exp == "parse":
        return []
    if exp == "pass":
        return [] if py["verdict"] == "pass" else ["fails %s, expected pass" % ", ".join(py["fails"])]
    want = sorted(set(row.get("failsWith", [])))
    if py["fails"] != want:
        return ["fails [%s], expected [%s]" % (", ".join(py["fails"]), ", ".join(want))]
    return []


# ------------------------------------------------------------------ reports
def project_settings(path):
    z = zipfile.ZipFile(path)
    if "Metadata/project_settings.config" not in z.namelist():
        return {}
    return json.loads(z.read("Metadata/project_settings.config"))


def part_map(path):
    """Sorted (object name, part name, extruder) triples from model_settings; a part takes its object's extruder when it has none."""
    import xml.etree.ElementTree as ET
    z = zipfile.ZipFile(path)
    ms = ET.fromstring(z.read("Metadata/model_settings.config"))
    out = []
    md = lambda el, k: next((m.get("value") for m in el.findall("metadata") if m.get("key") == k), None)
    for o in ms.findall("object"):
        for p in o.findall("part"):
            out.append([md(o, "name"), md(p, "name"), md(p, "extruder") or md(o, "extruder")])
    return sorted(out, key=lambda t: [str(x) for x in t])


def template_keys():
    sys.path.insert(0, str(REPO / "py/hackbuild_3mf"))
    import orca3mf
    return sorted(orca3mf.TEMPLATE["keys"])


def seed_keys():
    seed = json.loads(SEED_TEMPLATE.read_text(encoding="utf-8"))
    return sorted(set(seed["verbatim"]) | set(seed["computed"]))


def template_diff():
    gold, seed = set(template_keys()), set(seed_keys())
    return OrderedDict([
        ("about", "the seed filament template (corpus/seed-97.json) against the gold per-filament key set "
                  "(js/data/filament_template.json, harvested from gold/hackbuild-coin-nfc.3mf); generated by run.py"),
        ("goldKeys", len(gold)), ("seedKeys", len(seed)), ("shared", len(gold & seed)),
        ("missingFromSeed", sorted(gold - seed)), ("seedOnly", sorted(seed - gold)),
    ])


def owner_keysets(rows, results):
    out = []
    for r in rows:
        if r["set"] != "owner":
            continue
        ks = results[r["id"]]["keySet"] or {}
        ps = project_settings(HERE / r["path"])
        out.append(OrderedDict([
            ("id", r["id"]), ("source", r["source"]), ("application", application(HERE / r["path"])),
            ("printerPreset", ps.get("printer_settings_id")), ("filaments", ks.get("filaments")),
            ("templatePresent", ks.get("present")), ("templateAbsent", ks.get("absent", [])),
            ("nonTemplateAtN", sorted(k for k in ks.get("nonTemplate", [])
                                      if isinstance(ps.get(k), list) and len(ps[k]) == ks.get("filaments"))),
        ]))
    return {"about": "owner slicer saves: filament count, printer preset, template keys present and absent, keys outside "
                     "the template whose vector length equals the filament count; generated by run.py", "files": out}


def application(path):
    root = zipfile.ZipFile(path).read("3D/3dmodel.model").decode("utf-8", "replace")
    m = re.search(r'<metadata name="Application">([^<]*)</metadata>', root)
    return m.group(1) if m else None


def roundtrips(rows, results, seed_only):
    """Per project: the generator against each save on filament type, ids and part map, plus key sets and layer heights."""
    projects = OrderedDict()
    for r in rows:
        if r["set"] == "roundtrip":
            projects.setdefault(r["project"], []).append(r)
    out = []
    for name, rs in projects.items():
        gens = [r for r in rs if r["role"] == "generator"]
        saves = [r for r in rs if r["role"] == "save"]
        g = gens[0] if gens else None
        gps = project_settings(HERE / g["path"]) if g else {}
        rec = OrderedDict([("project", name), ("generator", g["id"] if g else None)])
        if g:
            rec["generatorFilaments"] = len(gps.get("filament_colour", [])) or None
        cmp = []
        for s in saves:
            sps = project_settings(HERE / s["path"])
            ks = results[s["id"]]["keySet"] or {}
            c = OrderedDict([("save", s["id"]), ("filaments", ks.get("filaments")),
                             ("templateAtN", ks.get("templateLengths", {}).get(str(ks.get("filaments")), 0)),
                             ("seedOnlyKeys", sorted(k for k in seed_only if k in sps))])
            if g:
                n = min(len(gps.get("filament_type", [])), len(sps.get("filament_type", [])))
                for k in ("filament_type", "filament_ids"):
                    c[k + "Equal"] = (gps.get(k, [])[:n] == sps.get(k, [])[:n]) if k in gps else None
                c["partMapEqual"] = part_map(HERE / g["path"]) == part_map(HERE / s["path"])
            c["layerHeight"] = sps.get("layer_height")
            z = zipfile.ZipFile(HERE / s["path"])
            if PLATE_JSON in z.namelist():
                c["plateLayerHeights"] = sorted({o.get("layer_height") for o in json.loads(z.read(PLATE_JSON)).get("bbox_objects", [])
                                                 if o.get("layer_height") is not None})
            cmp.append(c)
        rec["saves"] = cmp
        side = HERE / "owner/roundtrip" / name / (name + ".json")
        if side.is_file():
            rec["appLayerHeight"] = json.loads(side.read_text(encoding="utf-8")).get("print", {}).get("layer")
        out.append(rec)
    return {"about": "owner round trips: each generator export against the slicer saves of it; generated by run.py", "projects": out}


def check_pairs(manifest, report):
    bad = []
    want = manifest.get("pairs", {})
    for rec in report["projects"]:
        w = want.get(rec["project"], {})
        for c in rec["saves"]:
            if c["templateAtN"] != w.get("templateAtN", 127):
                bad.append("%s holds %s template keys at N" % (c["save"], c["templateAtN"]))
            if c["seedOnlyKeys"]:
                bad.append("%s holds seed-only keys %s" % (c["save"], ", ".join(c["seedOnlyKeys"])))
            for k in ("filament_typeEqual", "filament_idsEqual", "partMapEqual"):
                exp = w.get("equal", {}).get(c["save"], {}).get(k, True if rec["generator"] else None)
                if k in c and c[k] != exp:
                    bad.append("%s %s %s, expected %s" % (c["save"], k, c[k], exp))
    return bad


def check_set_asserts(manifest, rows, keysets):
    bad = []
    want = manifest.get("sets", {}).get("owner", {}).get("printerPresets")
    if want is not None:
        got = dict(Counter(f["printerPreset"] for f in keysets["files"]))
        if got != want:
            bad.append("owner printer presets %s, expected %s" % (json.dumps(got, sort_keys=True), json.dumps(want, sort_keys=True)))
    return bad


def write_report(name, data):
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / name).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# ------------------------------------------------------------------ driver
def main(argv):
    ap = argparse.ArgumentParser(prog="run.py", description="run the 3MF conformance corpus through both validators")
    ap.add_argument("--validator", default=str(REFERENCE_VALIDATOR), help="the validate_3mf.py to load")
    ap.add_argument("--set", dest="only", help="run one set")
    ap.add_argument("--json", dest="json_out", help="write every row's outcome to this file")
    a = ap.parse_args(argv)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows = manifest["rows"]
    problems = []
    check_manifest(rows, problems)
    run_rows = [r for r in rows if a.only is None or r["set"] == a.only]

    v = load_validator(a.validator)
    py = {r["id"]: run_python(v, r, problems) for r in run_rows}
    try:
        ts = run_mirror(run_rows)
    except RuntimeError as ex:
        problems.append("mirror: %s" % ex)
        ts = {}

    outcome = OrderedDict()
    for r in run_rows:
        p = py[r["id"]]
        miss = check_expect(r, p) + (check_asserts(r, p) if not p["error"] else [])
        dis = disagreement(p, ts.get(r["id"])) if ts else None
        outcome[r["id"]] = {"set": r["set"], "expect": r["expect"], "verdict": p["verdict"], "fails": p["fails"],
                            "error": p["error"], "outside": miss, "disagree": dis}

    sets = OrderedDict()
    for r in run_rows:
        sets.setdefault(r["set"], []).append(r)
    labels = manifest.get("sets", {})
    for s, rs in sets.items():
        ok = sum(1 for r in rs if not outcome[r["id"]]["outside"] and not outcome[r["id"]]["disagree"])
        exps = {r["expect"] for r in rs}
        verb = VERB[exps.pop()] if len(exps) == 1 else "as expected"
        print("%s %d of %d %s" % (labels.get(s, {}).get("label", s), ok, len(rs), verb))

    full = a.only is None and Path(a.validator).resolve() == REFERENCE_VALIDATOR
    if a.only is None:
        keysets = owner_keysets(rows, py)
        rt = roundtrips(rows, py, template_diff()["seedOnly"])
        problems += check_set_asserts(manifest, rows, keysets)
        problems += ["round trip: %s" % b for b in check_pairs(manifest, rt)]
        if full:
            write_report("owner-keysets.json", keysets)
            write_report("template-diff.json", template_diff())
            write_report("roundtrips.json", rt)

    for rid, o in outcome.items():
        for m in o["outside"]:
            problems.append("%s: %s" % (rid, m))
        if o["disagree"]:
            problems.append("%s: validators disagree, %s" % (rid, o["disagree"]))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(outcome, indent=1) + "\n", encoding="utf-8")
    for p in problems:
        print("outside: %s" % p)
    print("%d rows, %d outside expectation or in disagreement" % (len(run_rows), len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
