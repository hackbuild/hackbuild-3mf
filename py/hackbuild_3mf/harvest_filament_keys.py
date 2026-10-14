#!/usr/bin/env python3
"""
harvest_filament_keys.py: read the per-filament vectors of a 3MF the slicer
itself saved, classified by template membership (D-159, M00-T08 step 4).

    uv run --project py harvest-filament-keys save.3mf
        [--machine ffc5p] [--accept KEY]... [--reject KEY]... [-o out.json] [--json]

A vector is per-filament only when it is one of the keys of
hackbuild_3mf/data/filament_template.json or a person accepts it with
--accept. Length alone never classifies a key: a printer-scoped vector has
one element per extruder, so on a 4-extruder machine a length-4 vector
could be either. The harvester therefore refuses:

  * whenever the filament count N equals the machine's extruder count E
    (4 on ffc5p); harvest from a save with a different filament count;
  * whenever a key outside the template has length N and no person has
    accepted or rejected it. The owner saves show why: 1-filament saves
    carry 137 length-1 lists and the 2-filament save 133 length-2 lists
    against the 127 template keys.

With -o and no refusal it writes the template in the format of
hackbuild_3mf/data/filament_template.json (keys sorted, values as strings),
keeping the current computed list and perExtruderExclude.

Exit codes follow spec/errors.ts: 0 classified, 1 refused, 2 usage or input.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from validate_3mf import InputError as PackageError, open_package

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = HERE / "data"
TEMPLATE_PATH = DATA / "filament_template.json"
MACHINES_PATH = DATA / "machines.json"


class InputError(Exception):
    pass


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def machine_extruders(machine_id):
    """Toolhead count of a machine in hackbuild_3mf/data/machines.json."""
    for m in load_json(MACHINES_PATH)["machines"]:
        if m["id"] == machine_id:
            return len(m["toolheads"])
    raise InputError("machine %s is not in hackbuild_3mf/data/machines.json" % machine_id)


def read_settings(path):
    try:
        # open_package refuses unsafe names, more than 4096 entries and more than 256 MB inflated (D-166).
        with open_package(path) as z:
            raw = z.read("Metadata/project_settings.config")
    except PackageError as err:
        raise InputError("cannot read %s as a 3MF: %s" % (path, err))
    except KeyError:
        raise InputError("%s has no Metadata/project_settings.config; harvest a slicer save" % path)
    ps = json.loads(raw.decode("utf-8"))
    if not isinstance(ps.get("filament_colour"), list):
        raise InputError("%s has no filament_colour vector; harvest a slicer save" % path)
    return ps, hashlib.sha256(Path(path).read_bytes()).hexdigest()


def harvest(ps, template_keys, extruders, accept=(), reject=()):
    """Classify the vectors of one project_settings dict. Pure: no file access."""
    n = len(ps["filament_colour"])
    template_keys = set(template_keys)
    accept, reject = set(accept), set(reject)
    length_n = sorted(k for k, v in ps.items() if isinstance(v, list) and len(v) == n)
    outside = [k for k in length_n if k not in template_keys]
    candidates = [k for k in outside if k not in accept and k not in reject]
    per_filament = sorted([k for k in length_n if k in template_keys] + [k for k in outside if k in accept])
    wrong_length = sorted(k for k in template_keys if isinstance(ps.get(k), list) and len(ps[k]) != n)
    missing = sorted(k for k in template_keys if k not in ps)
    unknown = sorted((accept | reject) - set(outside))
    reasons = []
    if n == extruders:
        reasons.append("filament count %d equals extruder count %d: a length-%d vector could be per-extruder; "
                       "harvest a save with a different filament count" % (n, extruders, n))
    if candidates:
        reasons.append("%d keys outside the template have length %d; accept or reject each: %s"
                       % (len(candidates), n, ", ".join(candidates)))
    if wrong_length:
        reasons.append("%d template keys are not %d long: %s" % (len(wrong_length), n, ", ".join(wrong_length)))
    return {
        "filamentCount": n, "extruderCount": extruders, "lengthN": len(length_n), "perFilament": per_filament,
        "candidates": candidates, "accepted": sorted(accept & set(outside)), "rejected": sorted(reject & set(outside)),
        "missingTemplate": missing, "unknownDecisions": unknown, "refused": bool(reasons), "reasons": reasons,
    }


def template_out(ps, result, current, source):
    keys = {k: [v if isinstance(v, str) else json.dumps(v) for v in ps[k]] for k in result["perFilament"]}
    return {
        "source": source,
        "filamentCount": result["filamentCount"],
        "keys": keys,
        "computed": list(current.get("computed", [])),
        "perExtruderExclude": list(current.get("perExtruderExclude", [])),
    }


def main(argv):
    ap = argparse.ArgumentParser(description="classify the per-filament vectors of a slicer save by template membership")
    ap.add_argument("path")
    ap.add_argument("--machine", default=None, help="machine id in hackbuild_3mf/data/machines.json; absent, len(nozzle_diameter) of the save")
    ap.add_argument("--accept", action="append", default=[], metavar="KEY", help="a person classifies KEY as per-filament")
    ap.add_argument("--reject", action="append", default=[], metavar="KEY", help="a person classifies KEY as not per-filament")
    ap.add_argument("-o", "--out", default=None, help="write the harvested template here")
    ap.add_argument("--json", action="store_true", help="print the classification as JSON")
    a = ap.parse_args(argv)
    try:
        both = sorted(set(a.accept) & set(a.reject))
        if both:
            raise InputError("keys both accepted and rejected: %s" % ", ".join(both))
        ps, sha = read_settings(a.path)
        if a.machine is not None:
            extruders = machine_extruders(a.machine)
        elif isinstance(ps.get("nozzle_diameter"), list):
            extruders = len(ps["nozzle_diameter"])
        else:
            raise InputError("the save has no nozzle_diameter vector; pass --machine")
        current = load_json(TEMPLATE_PATH)
    except InputError as err:
        print("harvest: %s" % err, file=sys.stderr)
        return 2
    result = harvest(ps, current["keys"], extruders, a.accept, a.reject)
    if result["unknownDecisions"]:
        print("harvest: decisions name keys that are not length-%d vectors outside the template: %s"
              % (result["filamentCount"], ", ".join(result["unknownDecisions"])), file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(result, indent=2))
    else:
        print("filaments %d, extruders %d, length-%d vectors %d, per-filament %d, template keys absent %d"
              % (result["filamentCount"], result["extruderCount"], result["filamentCount"], result["lengthN"],
                 len(result["perFilament"]), len(result["missingTemplate"])))
        for r in result["reasons"]:
            print("refused: %s" % r)
    if result["refused"]:
        return 1
    if a.out:
        source = {"file": a.path, "sha256": sha, "version": ps.get("version", ""),
                  "printer": ps.get("printer_settings_id", "")}
        with open(a.out, "w", encoding="utf-8") as fh:
            json.dump(template_out(ps, result, current, source), fh, indent=2, ensure_ascii=False, sort_keys=False)
            fh.write("\n")
        print("wrote %s with %d per-filament keys" % (a.out, len(result["perFilament"])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))


def cli():
    """Console entry point."""
    sys.exit(main(sys.argv[1:]))
