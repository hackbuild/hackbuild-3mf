#!/usr/bin/env python3
"""
orca3mf.py: the Python 3MF writer, entry for entry the same as the
TypeScript writer in js/src/writer (D-052, D-159, M00-T08).

Target bbs is the Orca and Bambu dialect Flash Studio reads: Application
starts "BambuStudio-", every per-filament key of the 127-key template is
written N times (N = len(filament_colour)), each slot taking the values of
the preset row its filament_settings_id names. Outside the template only
the scalar keys that name the printer, the plate and the file go in.

Bytes are reproducible: dates come from SOURCE_DATE_EPOCH (UTC), entries
are sorted, no directory entries, one mtime, DEFLATE level 6. With no
epoch given the writer uses 1980-01-01, the zip floor; it never reads the
clock.

Data resolves from the repo root, never from this folder:
  hackbuild_3mf/data/filament_template.json   the 127 gold keys, per slot
  hackbuild_3mf/data/filament_presets.json    preset rows from slicer saves
  hackbuild_3mf/data/materials.json           computed keys per filament type
  hackbuild_3mf/data/default_preset.json      the preset a build with no printer writes
  hackbuild_3mf/data/machines.json        printer, process, plate names

Library:

    from orca3mf import Orca3MF, PrintObject, Part
    w = Orca3MF([{"color": "#1A1A1A", "type": "PETG"}, {"color": "#FE0386", "type": "PETG"}])
    w.add(PrintObject("coin", [Part("body", verts, faces, 1), Part("inlay", v2, f2, 2)]), [(128, 128)])
    w.write("coin.3mf")

verts (n,3) mm, part local, bed at z = 0; faces (m,3) counter-clockwise
from outside; slot is 1 based. The writer repairs nothing; run
validate_3mf.py on the output.

CLI, quick pack of STLs:

    uv run --project py orca3mf out.3mf body.stl:1 inlay.stl:2 --name coin
"""
import datetime
import hashlib
import json
import os
import re
import struct
import sys
import zipfile
from decimal import ROUND_HALF_UP, Context, Decimal, localcontext
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = HERE / "data"
TEMPLATE_PATH = DATA / "filament_template.json"
PRESETS_PATH = DATA / "filament_presets.json"
# The profile slicer table replaces this once the TypeScript writer reads it;
# both writers read the same table so their entries agree.
MATERIALS_PATH = DATA / "materials.json"
MACHINES_PATH = DATA / "machines.json"
DEFAULT_PRESET_PATH = DATA / "default_preset.json"

DEFAULT_APP = "BambuStudio-01.10.01.50"
APP_PREFIXES = ("BambuStudio-", "OrcaSlicer-")
TPU_FALLBACK_PRESET = "Generic PETG @FF C5P"

# The earliest date a zip entry holds, 1980-01-01T00:00:00Z, s.
DOS_EPOCH = 315532800
DEFLATE_LEVEL = 6

# Fixed p:UUID suffixes and the build UUID (seed orca3mf.js SUF, BUILD_UUID);
# lib3mf warns 32944 without them.
SUF_OBJECT = "-61cb-4c03-9d28-80fed5dfa1dc"
SUF_SUB = "-81cb-4c03-9d28-80fed5dfa1dc"
SUF_COMP = "-b206-40ff-9872-83e8017abed1"
SUF_ITEM = "-b1ec-4553-aec9-835e5b724bb4"
BUILD_UUID = "2c7c17d8-22b5-4d84-8835-1976022ea369"
# identify_id the slicer gives the first instance on plate 1.
FIRST_IDENTIFY_ID = 401

# The loader asserts on these, or they override the process preset.
FORBIDDEN_KEYS = ("extruder_variant_list", "layer_height")
SCALAR_KEYS = ("curr_bed_type", "from", "name", "print_settings_id", "printer_model", "printer_settings_id",
               "printer_technology", "printer_variant", "version")

COMPLETENESS_ID = "CHK-ART-01"
COMPLETENESS_ALIAS = "export-completeness"
_UNRESOLVED = re.compile(r"(^|[^A-Za-z])(undefined|null|NaN)([^A-Za-z]|$)")

MODEL = "3D/3dmodel.model"
FILAMENT_SEQUENCE = '{"plate_1":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}}'
CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                 ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
                 ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
                 ' <Default Extension="png" ContentType="image/png"/>\n</Types>\n')
RELS = ('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n')


def _load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


TEMPLATE = _load(TEMPLATE_PATH)
# The machine and preset a build with no printer writes; the TypeScript
# writer reads the same file (DEFAULT_PRESET in packages/3mf).
_DEFAULT = _load(DEFAULT_PRESET_PATH)
DEFAULT_MACHINE = _DEFAULT["machine"]
DEFAULT_PRESET = _DEFAULT["id"]
PRESETS = _load(PRESETS_PATH)["rows"]
MATERIALS = {k: v for k, v in _load(MATERIALS_PATH).items() if not k.startswith("_")}


class ExportError(Exception):
    """A refusal with the command error shape of spec/errors.ts: code, path, hint."""

    def __init__(self, hbf):
        super().__init__(hbf.get("hint", ""))
        self.hbf = hbf


class CompletenessError(ExportError):
    """Export completeness failed; .result holds the CheckResult and no byte was written."""

    def __init__(self, result):
        super().__init__({"code": "E_SCHEMA", "path": "/objects", "got": result["extra"].get("first", ""),
                          "expected": "resolved, unique object and part names",
                          "hint": "name every object and part once before export", "record": COMPLETENESS_ID})
        self.result = result


# ------------------------------------------------------------------ text forms
_CTX = Context(prec=80)


def fmt(v):
    """A coordinate, mm: JS toFixed(10) with trailing zeros and point stripped, -0 written 0 (D-054)."""
    v = float(v)
    if v != v or v in (float("inf"), float("-inf")):
        got = "NaN" if v != v else ("Infinity" if v > 0 else "-Infinity")  # JS String(v), as writer/fmt.ts reports it
        raise ExportError({"code": "E_SCHEMA", "path": "/objects/mesh/positions", "got": got,
                           "expected": "a finite coordinate, mm", "hint": "a vertex is not finite; rebuild the mesh"})
    with localcontext(_CTX):
        # toFixed picks the larger magnitude on an exact tie: ROUND_HALF_UP on the exact binary value.
        s = format(Decimal(v).quantize(Decimal("1e-10"), rounding=ROUND_HALF_UP), "f")
    s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def js_str(v):
    """ECMAScript Number::toString for a finite float."""
    v = float(v)
    if v == 0:
        return "0"
    if v == int(v) and abs(v) < 1e21:
        return str(int(v))
    # repr gives the shortest round-trip digits, as ECMAScript does; only the layout differs.
    d = Decimal(repr(v))
    # ECMAScript prints decimals from 1e-6 up to 1e21 and exponent form outside (Number::toString).
    if 1e-6 <= abs(v) < 1e21:
        return format(d, "f")
    digits = "".join(map(str, d.as_tuple().digits)).rstrip("0") or "0"
    e = d.adjusted()
    head = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    return "%s%se%s%d" % ("-" if v < 0 else "", head, "+" if e > 0 else "-", abs(e))


def num(v):
    """A slicer number: String(+v.toPrecision(6)), six significant digits."""
    v = float(v)
    if v == 0:
        return "0"
    with localcontext(_CTX):
        d = Decimal(v)
        q = d.quantize(Decimal(1).scaleb(d.adjusted() - 5), rounding=ROUND_HALF_UP)
    return js_str(float(q))


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def clamp_epoch(epoch):
    return max(int(epoch), DOS_EPOCH)


def iso_day(epoch):
    """The UTC day of an epoch as YYYY-MM-DD; reads no clock."""
    return datetime.datetime.fromtimestamp(clamp_epoch(epoch), tz=datetime.timezone.utc).date().isoformat()


def env_epoch():
    """SOURCE_DATE_EPOCH from the environment, s; absent, the zip floor."""
    raw = os.environ.get("SOURCE_DATE_EPOCH")
    if raw is None or raw == "":
        return DOS_EPOCH
    if not re.fullmatch(r"[0-9]+", raw):
        raise ExportError({"code": "E_SCHEMA", "path": "/sourceDateEpoch", "got": raw,
                           "expected": "whole seconds since 1970-01-01 UTC", "hint": "set SOURCE_DATE_EPOCH to an integer"})
    return int(raw)


def canonical_json(v):
    """RFC 8785 canonical JSON for the strings and objects the writer records."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


_DATE_META = re.compile(r'(<metadata name="(?:CreationDate|ModificationDate)">)[^<]*')


def artifact_hash(entries):
    """sha256 over (name, 0x00, hex sha256 of the bytes, 0x0A) in sorted name order, model dates blanked (D-052)."""
    lines = []
    for name in sorted(entries):
        v = entries[name]
        if name == MODEL:
            v = _DATE_META.sub(r"\1", v.decode("utf-8")).encode("utf-8")
        lines.append("%s\0%s\n" % (name, hashlib.sha256(v).hexdigest()))
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


def zip_entries(entries, epoch):
    """The .3mf bytes: sorted names, one UTC mtime, no directory entries, DEFLATE level 6."""
    import io
    buf = io.BytesIO()
    stamp = datetime.datetime.fromtimestamp(clamp_epoch(epoch), tz=datetime.timezone.utc).timetuple()[:6]
    with zipfile.ZipFile(buf, "w") as z:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.create_system = 3
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, entries[name], compresslevel=DEFLATE_LEVEL)
    return buf.getvalue()


# ------------------------------------------------------------------ suggestions
def edit_distance(a, b):
    """Levenshtein distance: insert, delete and substitute each cost 1."""
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)))
        prev = cur
    return prev[len(b)]


def did_you_mean(got, ids):
    """Up to three ids nearest to got by edit distance (spec/errors.ts), ties in table order, got left out.

    The same ranking as didYouMean in js/src/writer/suggest.ts; a got that is not a string ranks against "".
    """
    g = got if isinstance(got, str) else ""
    ranked = sorted(((edit_distance(i, g), n, i) for n, i in enumerate(ids) if i != g))
    return [i for _, _, i in ranked[:3]]


# ------------------------------------------------------------------ machine presets
def machine_preset(machine=None, preset=None):
    """The MachinePreset row of hackbuild_3mf/data/machines.json; absent, DEFAULT_MACHINE and DEFAULT_PRESET."""
    machine = DEFAULT_MACHINE if machine is None else machine
    preset = DEFAULT_PRESET if preset is None else preset
    machines = _load(MACHINES_PATH)["machines"]
    for m in machines:
        if m["id"] != machine:
            continue
        for p in m.get("presets", []):
            if p["id"] == preset:
                return p
        raise ExportError({"code": "E_REF", "path": "/preset", "got": preset,
                           "didYouMean": did_you_mean(preset, [p["id"] for p in m.get("presets", [])]),
                           "hint": "name a preset of machine %s in hackbuild_3mf/data/machines.json" % machine})
    raise ExportError({"code": "E_REF", "path": "/machine", "got": machine,
                       "didYouMean": did_you_mean(machine, [m["id"] for m in machines]),
                       "hint": "name a machine in hackbuild_3mf/data/machines.json"})


def printer_of(slicer):
    """Writer printer fields from MachinePreset.slicer, as configOf in js maps them."""
    out = {"printer_settings_id": slicer["printer"], "print_settings_id": slicer["process"], "app": slicer["app"]}
    if slicer.get("bedType") is not None:
        out["curr_bed_type"] = slicer["bedType"]
    return out


def printer_parts(settings_id):
    m = re.fullmatch(r"(.+) (\d+(?:\.\d+)?) nozzle", settings_id)
    return None if m is None else (m.group(1), m.group(2))


def app_version(app):
    return re.sub(r"^[^-]*-", "", app, count=1)


# ------------------------------------------------------------------ geometry
class Part:
    """One colour part of a print object. verts (n,3) mm, faces (m,3) int, slot 1 based."""

    def __init__(self, name, verts, faces, slot=1, body=None, role=None, width_mm=None):
        """body, role, width_mm: the Part IR body id and role and the declared conductor width, mm (M05-T20 overrides)."""
        import numpy as np
        self.name = name
        self.verts = np.asarray(verts, dtype=float).reshape(-1, 3)
        self.faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        self.slot = slot
        self.body = body
        self.role = role
        self.width_mm = width_mm

    def signed_volume(self):
        import numpy as np
        v = self.verts
        a, b, c = v[self.faces[:, 0]], v[self.faces[:, 1]], v[self.faces[:, 2]]
        return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)

    def stl_bytes(self):
        """Binary STL of this part alone, same coordinates as the 3MF."""
        import numpy as np
        v = self.verts
        f = self.faces
        a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n, axis=1)
        ln[ln == 0] = 1
        n = n / ln[:, None]
        rec = np.zeros(len(f), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")]))
        rec["n"] = n
        rec["v"][:, 0] = a
        rec["v"][:, 1] = b
        rec["v"][:, 2] = c
        header = self.name.encode("utf-8")[:80].ljust(80, b"\0")
        return header + struct.pack("<I", len(f)) + rec.tobytes()


# ------------------------------------------------------------------ overrides
# Per-object and per-part slicer overrides from body roles, the mirror of
# packages/3mf/src/overrides.ts (M05-T20, D-159): a conductor part gets solid
# infill (CHK-NET-05) and every object holding a conductor part or sharing a
# face with one gets interlocking_beam 0 (CHK-3MF-08). The TPU row of the
# table is recorded there and written by neither writer in M05.
CONDUCTOR_ROLES = ("conductor", "flex-conductor")
OBJECT_OVERRIDES = (("interlocking_beam", "0"),)
PART_OVERRIDES = (("sparse_infill_density", "100%"),)


def conductor_objects(objects, adjacency=()):
    """[(object name, conductors, touches)] as overrides.ts conductorObjects, record dicts in write order."""
    role_of = {p.body: p.role for obj, _ in objects for p in obj.parts if p.body is not None}
    out = []
    for obj, _ in objects:
        conductors = []
        for p in obj.parts:
            if p.body is not None and p.role in CONDUCTOR_ROLES:
                c = {"part": p.name, "body": p.body, "role": p.role}
                if p.width_mm is not None:
                    c["widthMm"] = p.width_mm
                conductors.append(c)
        touches = []
        for p in obj.parts:
            if p.body is None or p.role in CONDUCTOR_ROLES:
                continue
            for r in adjacency:
                other = r["b"] if r["a"] == p.body else r["a"] if r["b"] == p.body else None
                if other is not None and role_of.get(other) in CONDUCTOR_ROLES:
                    touches.append({"part": p.name, "body": p.body, "conductor": other, "areaMm2": r["areaMm2"]})
        if conductors or touches:
            out.append({"object": obj.name, "conductors": conductors, "touches": touches})
    return out


class PrintObject:
    """A printed object: several colour parts that together form one solid."""

    def __init__(self, name, parts):
        self.name = name
        self.parts = list(parts)


def _name_problem(v):
    if not isinstance(v, str):
        return "is %s" % ("null" if v is None else type(v).__name__)
    if v.strip() == "":
        return "is empty"
    if _UNRESOLVED.search(v):
        return "holds an unresolved token"
    return None


def export_completeness(artifact, objects):
    """CHK-ART-01 (plan-deltas R50) over (PrintObject, positions) pairs: pass, or a blocking fail."""
    problems = []
    seen = {}
    for i, (o, _) in enumerate(objects):
        p = _name_problem(o.name)
        if p is not None:
            problems.append("object %d name %s %s" % (i, json.dumps(str(o.name)), p))
        seen[str(o.name)] = seen.get(str(o.name), 0) + 1
        for j, part in enumerate(o.parts):
            q = _name_problem(part.name)
            if q is not None:
                problems.append("object %d part %d name %s %s" % (i, j, json.dumps(str(part.name)), q))
    for name, n in seen.items():
        if n > 1:
            problems.append("object name %s used %d times" % (json.dumps(name), n))
    members = ["%s-%s.stl" % (o.name, p.name) for o, _ in objects for p in o.parts]
    unique = len(set(members))
    if unique != len(members):
        problems.append("stl fallback holds %d unique names for %d parts" % (unique, len(members)))
    ok = not problems
    extra = {"alias": COMPLETENESS_ALIAS, "objects": len(objects), "stlMembers": len(members),
             "stlUniqueNames": unique, "problems": len(problems)}
    if not ok:
        extra["first"] = "; ".join(problems[:5])
    return {
        "id": COMPLETENESS_ID, "version": "0.1.0", "verdict": "pass" if ok else "fail", "severity": "block",
        "target": {"level": "artifact", "artifact": artifact},
        "constraint": "every object and part name resolves, object names are unique, the stl fallback has one "
                      "uniquely named member per part (plan-deltas R50)",
        "origin": "hbf://check/%s" % COMPLETENESS_ID, "legal": {"kind": "boolean", "must": True}, "measured": ok,
        "extra": extra,
    }


# ------------------------------------------------------------------ the writer
# Names lint-authors refuses in Designer and Copyright (D-001): tools/ai-names.json, the one list
# tools/lint-authors.mjs, lint-commits.mjs and lint-voice.mjs read too.
_AI = json.loads((Path(__file__).resolve().parent / "data" / "ai-names.json").read_text(encoding="utf-8"))
AI_NAME = re.compile(r"(?<![^\W_])(?:%s)(?![^\W_])" % "|".join(_AI["tools"] + _AI["identityOnly"]), re.I)


def attribution(designer, license, epoch):
    """License, Designer and Copyright for one export (LICENSING.md 1.4), as packages/3mf/src/metadata.ts attribution."""
    def single(field, v):
        v = v or ""
        if "\r" in v or "\n" in v:
            raise ExportError({"code": "E_SCHEMA", "path": "/" + field, "got": v, "expected": "one line",
                               "hint": "give %s on one line" % field})
        return v.strip()
    d, lic = single("designer", designer), single("license", license)
    if AI_NAME.search(d):
        raise ExportError({"code": "E_SCHEMA", "path": "/designer", "got": d, "expected": "a person's name",
                           "hint": "name the person who designed it; no tool, model or ai credit goes in exported metadata",
                           "record": "D-001"})
    year = datetime.datetime.fromtimestamp(int(epoch), tz=datetime.timezone.utc).year
    return {"designer": d, "copyright": "Copyright (c) %d %s" % (year, d) if d else "", "license": lic}


class Orca3MF:
    def __init__(self, filaments, printer=None, preset_pattern=None, write_filaments=True, layer_height=None,
                 title=None, chase="", build_hash="", nozzle_mm=None, source_date_epoch=None, preset=None,
                 license=None, designer=None):
        """
        filaments: list of {color '#RRGGBB', type 'PETG', name?, preset?, material?}; slot i is filaments[i-1].
        printer: printer_settings_id, print_settings_id, printer_model, printer_variant, curr_bed_type, app.
          Absent, the names of the machine preset (default ffc5p_20260819), plate included.
        preset_pattern: filament_settings_id per slot, "{TYPE}" replaced by the slot type.
        write_filaments: False writes only the slot identity and keeps the machine's tuned presets.
        layer_height: preset layer height, mm; the print card shows it, project_settings never carries it.
        source_date_epoch: s; absent, SOURCE_DATE_EPOCH, else 1980-01-01.
        license: ChaseMeta.license, the bbs License; absent, empty.
        designer: the person name of the workspace author; Designer and Copyright. Absent, both empty.
        """
        mp = preset if preset is not None else machine_preset()
        self.filaments = [dict(f) for f in filaments]
        self.printer = dict(printer) if printer is not None else printer_of(mp["slicer"])
        self.preset_pattern = preset_pattern if preset_pattern is not None else mp["slicer"]["filament"]
        self.write_filaments = write_filaments
        self.layer_height = layer_height
        self.title = title
        self.chase = chase
        self.build_hash = build_hash
        self.nozzle_mm = nozzle_mm if nozzle_mm is not None else (mp["nozzle"] if printer is None else None)
        self.source_date_epoch = env_epoch() if source_date_epoch is None else source_date_epoch
        self.attr = attribution(designer, license, self.source_date_epoch)
        self.warnings = []
        self._objects = []
        # Part IR body adjacency over Part.body ids, [{a, b, areaMm2}] (M05-T20).
        self.adjacency = []

    def add(self, obj, positions=((0.0, 0.0, 0.0),)):
        """Add a print object with one build item per (x, y[, z]) bed position, mm."""
        pos = []
        for p in positions:
            p = list(p) + [0.0] * (3 - len(p))
            pos.append(tuple(float(v) for v in p[:3]))
        self._objects.append((obj, pos or [(0.0, 0.0, 0.0)]))
        return self

    # ---------------------------------------------------------------- checks
    def _validate(self, app):
        def bad(**hbf):
            raise ExportError(hbf)
        if not any(app.startswith(p) for p in APP_PREFIXES):
            bad(code="E_SCHEMA", path="/printer/app", got=app, expected="BambuStudio- or OrcaSlicer- prefix",
                hint="set the preset app tag; any other tag loads geometry only and drops the colours", record="CHK-3MF-01")
        e = self.source_date_epoch
        if not isinstance(e, int) or isinstance(e, bool) or e < 0:
            bad(code="E_SCHEMA", path="/sourceDateEpoch", got=e, expected="whole seconds since 1970-01-01 UTC",
                hint="pass SOURCE_DATE_EPOCH as an integer")
        n = len(self.filaments)
        if n < 1:
            bad(code="E_SCHEMA", path="/filaments", got=0, expected="at least one filament", hint="load a filament")
        for i, f in enumerate(self.filaments):
            if not isinstance(f.get("color"), str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", f["color"]):
                bad(code="E_SCHEMA", path="/filaments/%d/color" % i, got=f.get("color"), expected="#RRGGBB",
                    hint="give the slot colour as six hex digits")
            if f.get("type") not in MATERIALS:
                known = list(MATERIALS)
                bad(code="E_REF", path="/filaments/%d/type" % i, got=f.get("type"), didYouMean=did_you_mean(f.get("type"), known),
                    hint="name a slicer type the material table holds: %s" % ", ".join(known))
        if not self._objects:
            bad(code="E_SCHEMA", path="/objects", got=0, expected="at least one object", hint="export at least one object")
        for i, (o, _) in enumerate(self._objects):
            if not o.parts:
                bad(code="E_SCHEMA", path="/objects/%d/parts" % i, got=0, expected="at least one part",
                    hint="give the object a part")
            for j, p in enumerate(o.parts):
                at = "/objects/%d/parts/%d" % (i, j)
                if not isinstance(p.slot, int) or isinstance(p.slot, bool) or not 1 <= p.slot <= n:
                    bad(code="E_SCHEMA", path=at + "/slot", got=p.slot, expected="slot 1 to %d" % n,
                        hint="assign the part to a loaded filament slot")
                if len(p.faces) == 0:
                    bad(code="E_SCHEMA", path=at + "/indices", got=0, expected="whole triangles, at least one",
                        hint="part %s has no triangles; build it before export" % p.name)
                nv = len(p.verts)
                if int(p.faces.min()) < 0 or int(p.faces.max()) >= nv:
                    bad(code="E_SCHEMA", path=at + "/indices", got=int(p.faces.max()), expected="index below %d" % nv,
                        hint="part %s has an index out of range" % p.name)

    # ---------------------------------------------------------------- pieces
    def _plan(self):
        """Resource ids: mesh objects first, then the components object, per print object."""
        plan = []
        nid = 1
        for obj, pos in self._objects:
            mesh_ids = list(range(nid, nid + len(obj.parts)))
            nid += len(obj.parts)
            plan.append({"obj": obj, "pos": pos, "mesh_ids": mesh_ids, "obj_id": nid})
            nid += 1
        return plan

    @staticmethod
    def _uuid(n, suffix):
        return "%08x%s" % (n & 0xFFFFFFFF, suffix)

    def model_xml(self, app, title, plan):
        day = iso_day(self.source_date_epoch)
        out = ['<?xml version="1.0" encoding="UTF-8"?>\n',
               '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
               'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
               'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n']
        # License, Designer and Copyright per LICENSING.md 1.4 (attribution); DesignerUserId, Origin and DesignerCover stay empty.
        a = self.attr
        for k, v in [("Application", app), ("BambuStudio:3mfVersion", "1"), ("Copyright", a["copyright"]), ("CreationDate", day),
                     ("Description", ""), ("Designer", a["designer"]), ("DesignerCover", ""), ("DesignerUserId", ""),
                     ("License", a["license"]),
                     ("ModificationDate", day), ("Origin", ""), ("Title", title)]:
            out.append(' <metadata name="%s">%s</metadata>\n' % (k, esc(v)))
        out.append(" <resources>\n")
        for p in plan:
            for prt, mid in zip(p["obj"].parts, p["mesh_ids"]):
                out.append('  <object id="%d" p:UUID="%s" type="model">\n' % (mid, self._uuid(mid, SUF_SUB)))
                out.append("   <mesh>\n    <vertices>\n")
                out.append("".join('     <vertex x="%s" y="%s" z="%s"/>\n' % (fmt(x), fmt(y), fmt(z))
                                   for x, y, z in prt.verts.tolist()))
                out.append("    </vertices>\n    <triangles>\n")
                out.append("".join('     <triangle v1="%d" v2="%d" v3="%d"/>\n' % (a, b, c) for a, b, c in prt.faces.tolist()))
                out.append("    </triangles>\n   </mesh>\n  </object>\n")
            # Root components carry no p:path: the meshes live in this part (dialect record, empty-plate bug).
            out.append('  <object id="%d" p:UUID="%s" type="model">\n   <components>\n' % (p["obj_id"], self._uuid(p["obj_id"], SUF_OBJECT)))
            for mid in p["mesh_ids"]:
                out.append('    <component objectid="%d" p:UUID="%s" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n'
                           % (mid, self._uuid(mid, SUF_COMP)))
            out.append("   </components>\n  </object>\n")
        out.append(' </resources>\n <build p:UUID="%s">\n' % BUILD_UUID)
        n = 1
        for p in plan:
            for x, y, z in p["pos"]:
                out.append('  <item objectid="%d" p:UUID="%s" transform="1 0 0 0 1 0 0 0 1 %s %s %s" printable="1" auto_drop="1"/>\n'
                           % (p["obj_id"], self._uuid(n, SUF_ITEM), fmt(x), fmt(y), fmt(z)))
                n += 1
        out.append(" </build>\n</model>\n")
        return "".join(out)

    def model_settings_xml(self, plan):
        out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n']
        beam_free = {c["object"] for c in conductor_objects(self._objects, self.adjacency)}
        for p in plan:
            obj = p["obj"]
            out.append('  <object id="%d">\n    <metadata key="name" value="%s"/>\n'
                       '    <metadata key="extruder" value="%d"/>\n' % (p["obj_id"], esc(obj.name), obj.parts[0].slot))
            if obj.name in beam_free:
                out.extend('    <metadata key="%s" value="%s"/>\n' % (esc(k), esc(v)) for k, v in OBJECT_OVERRIDES)
            for i, (prt, mid) in enumerate(zip(obj.parts, p["mesh_ids"])):
                part_ov = "".join('      <metadata key="%s" value="%s"/>\n' % (esc(k), esc(v)) for k, v in PART_OVERRIDES) \
                    if prt.role in CONDUCTOR_ROLES else ""
                out.append('    <part id="%d" subtype="normal_part">\n'
                           '      <metadata key="name" value="%s"/>\n'
                           '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
                           '      <metadata key="source_file" value="%s.3mf"/>\n'
                           '      <metadata key="source_object_id" value="0"/>\n'
                           '      <metadata key="source_volume_id" value="%d"/>\n'
                           '      <metadata key="source_offset_x" value="0"/>\n'
                           '      <metadata key="source_offset_y" value="0"/>\n'
                           '      <metadata key="source_offset_z" value="0"/>\n'
                           '      <metadata key="extruder" value="%d"/>\n'
                           '%s'
                           '      <mesh_stat face_count="%d" edges_fixed="0" degenerate_facets="0" facets_removed="0" '
                           'facets_reversed="0" backwards_edges="0"/>\n'
                           '    </part>\n' % (mid, esc(prt.name), esc(obj.name), i, prt.slot, part_ov, len(prt.faces)))
            out.append("  </object>\n")
        out.append('  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n'
                   '    <metadata key="locked" value="false"/>\n    <metadata key="filament_map_mode" value="Auto For Flush"/>\n'
                   '    <metadata key="filament_maps" value="%s"/>\n' % " ".join(["1"] * len(self.filaments)))
        ident = FIRST_IDENTIFY_ID
        for p in plan:
            for i, _ in enumerate(p["pos"]):
                out.append('    <model_instance>\n      <metadata key="object_id" value="%d"/>\n'
                           '      <metadata key="instance_id" value="%d"/>\n'
                           '      <metadata key="identify_id" value="%d"/>\n    </model_instance>\n' % (p["obj_id"], i, ident))
                ident += 1
        out.append("  </plate>\n  <assemble>\n")
        for p in plan:
            for i, (x, y, z) in enumerate(p["pos"]):
                out.append('   <assemble_item object_id="%d" instance_id="%d" transform="1 0 0 0 1 0 0 0 1 %s %s %s" offset="0 0 0" />\n'
                           % (p["obj_id"], i, fmt(x), fmt(y), fmt(z)))
        out.append("  </assemble>\n</config>\n")
        return "".join(out)

    def slice_info_xml(self, app, plan):
        if self.nozzle_mm is not None:
            nozzle = num(self.nozzle_mm)
        else:
            nozzle = self.printer.get("printer_variant") or "0.4"
        out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
               '    <header_item key="X-BBL-Client-Version" value="%s"/>\n  </header>\n  <plate>\n' % esc(app_version(app))]
        for k, v in [("index", "1"), ("printer_model_id", ""), ("nozzle_diameters", nozzle), ("timelapse_type", "0"),
                     ("prediction", "0"), ("weight", "0"), ("outside", "false"), ("support_used", "false"),
                     ("label_object_enabled", "false")]:
            out.append('    <metadata key="%s" value="%s"/>\n' % (k, esc(v)))
        ident = FIRST_IDENTIFY_ID
        for p in plan:
            for _ in p["pos"]:
                out.append('    <object identify_id="%d" name="%s" skipped="false" />\n' % (ident, esc(p["obj"].name)))
                ident += 1
        for i, f in enumerate(self.filaments):
            out.append('    <filament id="%d" tray_info_idx="%s" type="%s" color="%s" used_m="0" used_g="0" />\n'
                       % (i + 1, esc(MATERIALS[f["type"]]["tray"]), esc(f["type"]), esc(f["color"].upper())))
        out.append("  </plate>\n</config>\n")
        return "".join(out)

    def _resolve_preset(self, settings_id, ftype, at):
        row = PRESETS.get(settings_id)
        if row is not None:
            return row
        fallback = PRESETS.get(TPU_FALLBACK_PRESET)
        if ftype == "TPU" and fallback is not None:
            self.warnings.append({
                "code": "PRESET_INFERRED",
                "text": "TPU preset row inferred: %s takes the %s column until a slicer save holds it" % (settings_id, TPU_FALLBACK_PRESET),
                "param": at,
            })
            return dict(fallback, tier="inferred")
        raise ExportError({"code": "E_REF", "path": at, "got": settings_id, "didYouMean": did_you_mean(settings_id, list(PRESETS)),
                           "hint": "no harvested preset row for %s; save a project with it in the slicer and rerun "
                                   "js/scripts/harvest-presets.mjs" % settings_id, "record": "3mf-dialect"})

    def project_settings(self, app):
        """The dict written to Metadata/project_settings.config, keys sorted."""
        ps = {"from": "project", "name": "project_settings", "version": app_version(app)}
        pr = self.printer
        sid = pr.get("printer_settings_id")
        if sid:
            parts = printer_parts(sid)
            ps["printer_settings_id"] = sid
            ps["printer_technology"] = "FFF"
            model = pr.get("printer_model", parts[0] if parts else None)
            variant = pr.get("printer_variant", parts[1] if parts else None)
            if model:
                ps["printer_model"] = model
            if variant:
                ps["printer_variant"] = variant
        if pr.get("print_settings_id"):
            ps["print_settings_id"] = pr["print_settings_id"]
        if pr.get("curr_bed_type"):
            ps["curr_bed_type"] = pr["curr_bed_type"]

        F = self.filaments
        ids = [f.get("preset") or self.preset_pattern.replace("{TYPE}", f["type"], 1) for f in F]
        self.warnings = []
        if not self.write_filaments:
            ps["filament_colour"] = [f["color"].upper() for f in F]
            ps["filament_settings_id"] = ids
            ps["filament_type"] = [f["type"] for f in F]
        else:
            computed = set(TEMPLATE["computed"])
            per_slot = []
            for i, f in enumerate(F):
                row = self._resolve_preset(ids[i], f["type"], "/filaments/%d/type" % i)
                per_slot.append((row, self._computed(f, MATERIALS[f["type"]], ids[i]),
                                 {"filament_multi_colour": f["color"].upper(), "filament_self_index": str(i + 1),
                                  "filament_map": "1"}))
            for key in TEMPLATE["keys"]:
                vals = []
                for i, (row, comp, ident) in enumerate(per_slot):
                    if key in computed:
                        v = comp.get(key)
                        if v is None:
                            raise ExportError({"code": "E_SCHEMA", "path": "/template/computed", "got": key,
                                               "expected": "a key the writer computes", "record": "3mf-dialect",
                                               "hint": "drop the key from computed or teach the writer to compute it"})
                    else:
                        v = ident.get(key, row["values"].get(key))
                        if v is None:
                            raise ExportError({"code": "E_SCHEMA", "path": "/filaments/%d" % i, "got": key,
                                               "expected": "a value in the preset row", "record": "3mf-dialect",
                                               "hint": "preset %s lacks %s; re-harvest the preset rows" % (ids[i], key)})
                    vals.append(v)
                ps[key] = vals
        assert_settings(ps, len(F))
        return {k: ps[k] for k in sorted(ps)}

    @staticmethod
    def _computed(f, m, settings_id):
        bed, bed_first = num(m["bed"]), num(m["bed_first"])
        return {
            "filament_colour": f["color"].upper(), "filament_type": f["type"], "filament_vendor": "Generic",
            "filament_ids": m["tray"], "filament_settings_id": settings_id, "filament_density": num(m["density"]),
            "filament_cost": num(m["cost"]), "filament_flow_ratio": num(m["flow"]),
            "filament_max_volumetric_speed": num(m["maxvol"]),
            "nozzle_temperature": num(m["nozzle"]), "nozzle_temperature_initial_layer": num(m["nozzle_first"]),
            "nozzle_temperature_range_low": num(m["range_low"]), "nozzle_temperature_range_high": num(m["range_high"]),
            "hot_plate_temp": bed, "hot_plate_temp_initial_layer": bed_first, "cool_plate_temp": bed,
            "cool_plate_temp_initial_layer": bed_first, "eng_plate_temp": bed, "eng_plate_temp_initial_layer": bed_first,
            "textured_plate_temp": bed, "textured_plate_temp_initial_layer": bed_first,
            "textured_cool_plate_temp": bed, "textured_cool_plate_temp_initial_layer": bed_first,
            "supertack_plate_temp": bed, "supertack_plate_temp_initial_layer": bed_first,
            "temperature_vitrification": num(m["vitrification"]), "fan_max_speed": num(m["fan_max"]),
            "fan_min_speed": num(m["fan_min"]), "overhang_fan_speed": num(m["overhang_fan"]),
        }

    # ---------------------------------------------------------------- output
    def _title(self):
        if self.title is not None:
            return self.title
        return self._objects[0][0].name if self._objects else "model"

    def completeness(self):
        return export_completeness("%s.3mf" % self._title(), self._objects)

    def entries(self):
        """{zip path: bytes} in sorted order. Raises CompletenessError before any other work."""
        result = self.completeness()
        if result["verdict"] == "fail":
            raise CompletenessError(result)
        app = self.printer.get("app") or DEFAULT_APP
        self._validate(app)
        plan = self._plan()
        title = self._title()
        e = {
            "3D/3dmodel.model": self.model_xml(app, title, plan),
            "Metadata/filament_sequence.json": FILAMENT_SEQUENCE,
            "Metadata/hackbuild_chase.json": canonical_json(self._chase_record()),
            "Metadata/model_settings.config": self.model_settings_xml(plan),
            "Metadata/project_settings.config": json.dumps(self.project_settings(app), indent=4, ensure_ascii=False),
            "Metadata/slice_info.config": self.slice_info_xml(app, plan),
            "[Content_Types].xml": CONTENT_TYPES,
            "_rels/.rels": RELS,
        }
        return {k: e[k].encode("utf-8") for k in sorted(e)}

    def _chase_record(self):
        """Chase id and build hash, with the conductor record when an object holds or touches a conductor (CHK-3MF-08)."""
        rec = {"chase": self.chase or "", "buildHash": self.build_hash or ""}
        conductors = conductor_objects(self._objects, self.adjacency)
        if conductors:
            rec["conductors"] = conductors
        return rec

    def artifact_hash(self):
        return artifact_hash(self.entries())

    def zip_bytes(self):
        return zip_entries(self.entries(), self.source_date_epoch)

    def write(self, path):
        data = self.zip_bytes()
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def print_card(self):
        """The print card (js printCard): what to load, on which slot, and the fallback."""
        pr = self.printer
        lh = self.layer_height
        lines = ["print card", "=" * 40,
                 "printer  : %s" % pr.get("printer_settings_id", "(unchanged)"),
                 "process  : %s" % pr.get("print_settings_id", "(unchanged)"),
                 "plate    : %s" % pr.get("curr_bed_type", "(unchanged)"),
                 "layer    : %s" % ("(preset)" if lh is None else "%.2f mm, preset" % lh), ""]
        vol = {}
        for obj, pos in self._objects:
            for prt in obj.parts:
                vol[prt.slot] = vol.get(prt.slot, 0.0) + abs(prt.signed_volume()) * len(pos)
        for i, f in enumerate(self.filaments, 1):
            g = vol.get(i, 0.0) / 1000.0 * MATERIALS.get(f["type"], {}).get("density", 0)
            lines.append("slot %d   : %s %s   %s   %.1f g computed from volume and vendor density"
                         % (i, f["color"].upper(), f["type"], f.get("name") or "", g))
        lines.append("")
        for obj, pos in self._objects:
            lines.append("object %s x%d: %s" % (obj.name, len(pos), ", ".join("%s(slot %d)" % (p.name, p.slot) for p in obj.parts)))
        beam_free = {c["object"] for c in conductor_objects(self._objects, self.adjacency)}
        overrides = []
        for obj, _ in self._objects:
            if obj.name in beam_free:
                overrides.append("object %s: %s" % (obj.name, ", ".join("%s %s" % kv for kv in OBJECT_OVERRIDES)))
            for prt in obj.parts:
                if prt.role in CONDUCTOR_ROLES:
                    overrides.append("part %s of %s: %s" % (prt.name, obj.name, ", ".join("%s %s" % kv for kv in PART_OVERRIDES)))
        if overrides:
            lines += ["", "per-object settings written to the file; confirm each in the slicer object list before slicing:"] + overrides
        lines += ["", "fallback if the filament list imports as one: open all per part STLs at once, answer yes to",
                  "'load as a single object with multiple parts', then set the filament per part."]
        return "\n".join(lines) + "\n"


def assert_settings(ps, n):
    """Refuse a vector of the wrong length and any key the loader asserts on."""
    for k in FORBIDDEN_KEYS:
        if k in ps:
            raise ExportError({"code": "E_SCHEMA", "path": "/" + k, "got": k, "expected": "no printer- or process-scoped key",
                               "hint": "remove %s from the settings; the loader asserts on it or it overrides the process preset" % k,
                               "record": "3mf-dialect"})
    for k, v in ps.items():
        if isinstance(v, list) and len(v) != n:
            raise ExportError({"code": "E_SCHEMA", "path": "/" + k, "got": len(v), "expected": "%d values, one per filament" % n,
                               "hint": "per-filament key %s has the wrong length" % k, "record": "CHK-3MF-02"})


def from_input(inp, source_date_epoch=None):
    """A writer for one corpus input (corpus/inputs/*.json), the ThreeMfInput shape of js."""
    mp = machine_preset(inp["machine"], inp["preset"])
    w = Orca3MF([{"color": f["colour"], "type": f["type"], "material": f.get("material")} for f in inp["filaments"]],
                preset=mp, title=inp["title"], chase=inp["chase"], build_hash=inp["buildHash"],
                nozzle_mm=mp["nozzle"], source_date_epoch=source_date_epoch,
                license=inp.get("license"), designer=inp.get("designer"))
    for o in inp["objects"]:
        parts = [Part(b["name"], b["positions"], b["triangles"], b["slot"], b.get("body"), b.get("role"), b.get("widthMm"))
                 for b in o["bodies"]]
        w.add(PrintObject(o["name"], parts), [o["position"]])
    w.adjacency = list(inp.get("adjacency", []))
    return w


# ------------------------------------------------------------------ CLI
def _read_stl(path):
    import numpy as np
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:5] == b"solid" and b"facet" in data[:400]:
        tris = []
        cur = []
        for line in data.decode("utf-8", "ignore").splitlines():
            t = line.strip().split()
            if t[:1] == ["vertex"]:
                cur.append([float(t[1]), float(t[2]), float(t[3])])
                if len(cur) == 3:
                    tris.append(cur)
                    cur = []
        v = np.array(tris, dtype=float).reshape(-1, 3)
    else:
        n = struct.unpack("<I", data[80:84])[0]
        rec = np.frombuffer(data[84:84 + n * 50], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
        v = rec["v"].reshape(-1, 3).astype(float)
    uniq, inv = np.unique(v, axis=0, return_inverse=True)
    return uniq, inv.reshape(-1, 3)


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description="pack per colour STLs into an Orca dialect multicolour 3MF")
    ap.add_argument("out")
    ap.add_argument("parts", nargs="+", help="path.stl:slot, slot is 1 based")
    ap.add_argument("--name", default="object")
    ap.add_argument("--filaments", default="#1A1A1A:PETG,#FFFFFF:PETG,#FE0386:PETG", help="comma list of color:TYPE, slot order")
    ap.add_argument("--pos", default="128,128", help="x,y bed position, mm; separate instances with ;")
    ap.add_argument("--pattern", default=None)
    ap.add_argument("--no-filaments", action="store_true", help="write only the slot identity")
    a = ap.parse_args(argv)
    fils = [{"color": c, "type": t} for c, t in (tok.split(":") for tok in a.filaments.split(","))]
    parts = []
    for tok in a.parts:
        p, s = tok.rsplit(":", 1)
        v, f = _read_stl(p)
        parts.append(Part(os.path.splitext(os.path.basename(p))[0], v, f, int(s)))
    w = Orca3MF(fils, preset_pattern=a.pattern, write_filaments=not a.no_filaments)
    w.add(PrintObject(a.name, parts), [tuple(float(x) for x in q.split(",")) for q in a.pos.split(";")])
    try:
        w.write(a.out)
    except ExportError as err:
        print(json.dumps(err.hbf), file=sys.stderr)
        return 2
    print("wrote", a.out)
    print(w.print_card(), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))


def cli():
    """Console entry point."""
    sys.exit(main(sys.argv[1:]))
