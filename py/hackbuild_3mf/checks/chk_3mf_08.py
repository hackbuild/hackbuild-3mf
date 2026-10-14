"""
chk_3mf_08.py: CHK-3MF-08 on a 3MF package, the Python mirror of
js/src/validate/chk-3mf-08.ts (CHECKS.md 9.11, M05-T20 step 4).

No object that holds a conductor body or shares a face with one has
interlocking_beam on, whether set per object or inherited from the project.
Interlocking beams interleave two filaments up to interlocking_depth cells
from their boundary and eat a conductor's cross section
(research/3dp-landscape.md section 3 and section 11 idea 8); no printed
failure is on record, so the loss a fail quotes is an inferred upper bound.

Which objects hold or touch a conductor comes from the conductor record the
writer puts in Metadata/hackbuild_chase.json (js/src/overrides.ts).
The slicer defaults the loss quote reads are the profile constants
3mf.interlockingBeamWidth and 3mf.interlockingDepth in
hackbuild_3mf/data/constants.json (copied from hackbuild-fab); nothing here keeps its own copy.
validate_3mf.py calls check() in every mode of the bbs target.
"""
import json
import re
from pathlib import Path

CHECK_ID = "CHK-3MF-08"
CHASE_ENTRY = "Metadata/hackbuild_chase.json"
MODEL_SETTINGS = "Metadata/model_settings.config"
PROJECT_SETTINGS = "Metadata/project_settings.config"
CONDUCTOR_RECORD = "conductors"
BEAM = "interlocking_beam"
BEAM_WIDTH = "interlocking_beam_width"
DEPTH = "interlocking_depth"
CONSTANTS = Path(__file__).resolve().parents[1] / "data" / "constants.json"
BEAM_CONSTANTS = {"beam_width_mm": "3mf.interlockingBeamWidth", "depth_cells": "3mf.interlockingDepth"}


def defaults():
    """The two slicer defaults from the profile constants, by key of BEAM_CONSTANTS."""
    rows = {c["id"]: c for c in json.loads(CONSTANTS.read_text(encoding="utf-8"))["constants"]}
    return {k: rows[cid]["value"] for k, cid in BEAM_CONSTANTS.items()}


def _num(v):
    """A number as JavaScript prints it: 2.0 as 2, 1.6 as 1.6."""
    f = float(v)
    return str(int(f)) if f.is_integer() else repr(round(f, 12))


def _truthy(v):
    """A slicer bool as either writer spells it: true, 1, "1" or "true"."""
    x = v[0] if isinstance(v, list) and v else v
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return x == 1
    return isinstance(x, str) and x.strip().lower() in ("1", "true")


def _number(v):
    x = v[0] if isinstance(v, list) and v else v
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        m = re.match(r"\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", x)
        return float(m.group(0)) if m else None
    return None


def object_metadata(ms_root):
    """Object-level metadata of model_settings by object name; part metadata is left out."""
    out = {}
    if ms_root is None:
        return out
    for obj in ms_root.findall("object"):
        meta = {m.get("key"): m.get("value", "") for m in obj.findall("metadata") if m.get("key") is not None}
        if "name" in meta:
            out[meta["name"]] = meta
    return out


def _is_record(v):
    return isinstance(v, list) and all(
        isinstance(o, dict) and isinstance(o.get("object"), str) and isinstance(o.get("conductors"), list)
        and isinstance(o.get("touches"), list) for o in v)


def outcome(chase_text, ms_root, project, dflt=None):
    """The CHK-3MF-08 verdict: {verdict, constraint, path, extra?}. chase_text is None when the entry is absent."""
    if chase_text is None:
        return {"verdict": "skip", "path": CHASE_ENTRY,
                "constraint": "not run: no %s, so no chase to read body roles from; body adjacency comes from Part IR" % CHASE_ENTRY}
    try:
        chase = json.loads(chase_text)
    except ValueError:
        return {"verdict": "skip", "path": CHASE_ENTRY, "constraint": "not run: %s is not json" % CHASE_ENTRY}
    raw = chase.get(CONDUCTOR_RECORD) if isinstance(chase, dict) else None
    if raw is None:
        return {"verdict": "skip", "path": CHASE_ENTRY,
                "constraint": "not run: %s carries no conductor record; check.run on the build reads body roles from Part IR" % CHASE_ENTRY}
    if not _is_record(raw):
        return {"verdict": "fail", "path": CHASE_ENTRY, "extra": {"objects": 0, "failing": 1},
                "constraint": "%s %s is not a list of objects with conductors and touches; export again" % (CHASE_ENTRY, CONDUCTOR_RECORD)}

    project = project if isinstance(project, dict) else {}
    objects = object_metadata(ms_root)
    width_of = {c["body"]: c["widthMm"] for o in raw for c in o["conductors"]
                if isinstance(c.get("widthMm"), (int, float)) and not isinstance(c.get("widthMm"), bool)}
    failing, losses, widths = [], [], []
    for o in raw:
        meta = objects.get(o["object"])
        if meta is None:
            failing.append("%s (not in %s)" % (o["object"], MODEL_SETTINGS))
            continue
        if BEAM in meta:
            src, on = "object", _truthy(meta[BEAM])
        elif BEAM in project:
            src, on = "project", _truthy(project[BEAM])
        else:
            src, on = "slicer default", False
        if not on:
            continue

        def pick(key, fallback):
            for v in (meta.get(key), project.get(key)):
                n = _number(v) if v is not None else None
                if n is not None:
                    return n
            return fallback

        width = pick(BEAM_WIDTH, None if dflt is None else dflt["beam_width_mm"])
        depth = pick(DEPTH, None if dflt is None else dflt["depth_cells"])
        if width is not None and depth is not None:
            losses.append(round(width * depth, 6))
        touching = []
        for t in o["touches"]:
            if t["body"] not in touching:
                touching.append(t["body"])
        named = []
        if o["conductors"]:
            named.append("holding " + ", ".join(c["body"] for c in o["conductors"]))
        if touching:
            named.append("touching " + ", ".join(touching))
        for b in [c["body"] for c in o["conductors"]] + [t["conductor"] for t in o["touches"]]:
            if b in width_of:
                widths.append(width_of[b])
        failing.append("%s (from the %s; %s)" % (o["object"], src, "; ".join(named)))
    extra = {"objects": len(raw), "failing": len(failing)}
    if not failing:
        return {"verdict": "pass", "path": MODEL_SETTINGS, "extra": extra,
                "constraint": "interlocking_beam off on every object that holds or touches a conductor: %s"
                              % ", ".join(o["object"] for o in raw)}
    loss = max(losses) if losses else None
    if loss is None:
        quote = "loss not quoted: no interlocking_depth or interlocking_beam_width default supplied"
    else:
        quote = ("beams cut up to %s mm per shared side (interlocking_depth x interlocking_beam_width, inferred upper bound: "
                 "the slicer cell size is unverified and taken as one beam width)" % _num(loss))
        if widths:
            quote += " against conductors %s to %s mm wide" % (_num(min(widths)), _num(max(widths)))
    # The fix is the writer's own row (orca3mf.OBJECT_OVERRIDES), so the check and the writer name one value.
    import orca3mf
    fix = " ".join(next(kv for kv in orca3mf.OBJECT_OVERRIDES if kv[0] == BEAM))
    extra["first"] = "; ".join(failing[:5])
    extra["fix"] = fix
    if loss is not None:
        extra["lossMm"] = loss
    if widths:
        extra["widthMinMm"] = min(widths)
        extra["widthMaxMm"] = max(widths)
    return {"verdict": "fail", "path": MODEL_SETTINGS, "extra": extra,
            "constraint": "interlocking_beam on for %d of %d objects that hold or touch a conductor: %s; %s; set %s on each object"
                          % (len(failing), len(raw), "; ".join(failing), quote, fix)}


def check(rep, z, names, ms_root):
    """Add the CHK-3MF-08 result for one bbs package to the validator report."""
    chase_text = z.read(CHASE_ENTRY).decode("utf-8") if CHASE_ENTRY in names else None
    project = None
    if PROJECT_SETTINGS in names:
        try:
            project = json.loads(z.read(PROJECT_SETTINGS).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            project = None
    out = outcome(chase_text, ms_root, project, defaults())
    if out["verdict"] == "skip":
        return rep.skip(CHECK_ID, out["constraint"], path=out["path"])
    return rep.boolean(CHECK_ID, out["verdict"] == "pass", out["constraint"], path=out["path"], extra=out.get("extra"))
