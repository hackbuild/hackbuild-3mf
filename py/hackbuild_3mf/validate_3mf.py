#!/usr/bin/env python3
"""
validate_3mf.py: the audit every 3MF passes before it ships (M00-T09, D-140).

    uv run --project py validate-3mf [--export | --legacy | --roundtrip]
        [--overlap] [--solid solid.stl] [--stl-zip parts.zip] [--target bbs|core] [--json] [--quiet] file.3mf

Modes say who wrote the file:

  --export     (default) a hackbuild writer. Every one of the 127 template
               keys is present and N long (CHK-3MF-02); outside the template
               only the writer's scalar keys appear (CHK-3MF-03); CHK-3MF-06,
               CHK-3MF-07, export completeness (CHK-ART-01), topology per mesh
               and the lib3mf read (CHK-PRT-01), model_settings references.
               CHK-3MF-08 (interlocking beams against a conductor,
               checks/chk_3mf_08.py beside this file) runs in every mode of the bbs
               target and reads the conductor record in
               Metadata/hackbuild_chase.json; without one it reports not run.
  --legacy     a pre-template writer (BOSS, SPRUE, legacy benches). CHK-3MF-02
               on the template keys present; missing template keys and keys
               outside the template go to the key-set note;
               extruder_variant_list fails. Same 06, 07, topology, lib3mf.
  --roundtrip  a slicer save. Components follow p:path into 3D/Objects/*.model,
               model_settings part ids resolve against sub-model objects,
               vectors the slicer wrote pass whatever their length, CHK-3MF-06
               and CHK-3MF-07 apply. The slicer wrote the meshes, so topology
               and lib3mf report not run.
  --overlap    pairwise part intersection volume per object under 1e-3 mm3
               and, with two or more build items, between the items as
               placed (CHK-PRT-03, manifold3d); a part manifold3d refuses as not
               manifold fails the check; --solid adds parts sum to the solid
               within 0.1 percent.
  --target     bbs (default) is the Orca and Bambu dialect; core runs lib3mf in
               strict mode and the Materials rules and skips the dialect keys;
               prusa exits 2.

A key is per-filament when it is one of the template keys, never because its
length equals N: on the 4-extruder ffc5p a length-4 vector outside the
template could be per-filament or per-extruder, and the validator does not
guess (M00-T09 step 1).

Exit codes follow spec/errors.ts: 0 pass, 1 fail, 2 usage or input, 70
internal. A declared module missing on a platform its marker includes is an
internal error, never a skipped check (D-153).

Check versions and severities come from hackbuild_3mf/data/checks.seed.json (rows copied from hackbuild-fab);
the template, the scalar keys and the forbidden keys come from orca3mf.py,
which reads hackbuild_3mf/data/filament_template.json. Nothing here keeps its
own copy of what it audits.
"""
import io
import json
import platform
import posixpath
import re
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = HERE / "data"
sys.path.insert(0, str(HERE))

from checks import chk_3mf_08  # noqa: E402  CHK-3MF-08, beams against a conductor (M05-T20)

EXIT_PASS, EXIT_FAIL, EXIT_INPUT, EXIT_INTERNAL = 0, 1, 2, 70

NS_CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
NS_MAT = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": NS_CORE, "p": NS_PROD, "mat": NS_MAT, "r": NS_RELS}
P_PATH = "{%s}path" % NS_PROD

ROOT_MODEL = "3D/3dmodel.model"
ROOT_RELS = "3D/_rels/3dmodel.model.rels"
MODEL_SETTINGS = "Metadata/model_settings.config"
PROJECT_SETTINGS = "Metadata/project_settings.config"
BBS_ENTRIES = ("[Content_Types].xml", "_rels/.rels", ROOT_MODEL, MODEL_SETTINGS, PROJECT_SETTINGS)
CORE_ENTRIES = ("[Content_Types].xml", "_rels/.rels", ROOT_MODEL)
CHECK_SEED = DATA / "checks.seed.json"

# The writer must keep these three, which the seed template dropped (C-07, CHECKS.md 7.3 rule 5).
KEPT_KEYS = ("filament_map", "filament_self_index", "filament_extruder_variant")
OVERHANG_KEY = "overhang_fan_threshold"
OVERHANG_RE = re.compile(r"[0-9]+%")
PERCENT_RE = re.compile(r"-?[0-9]+(\.[0-9]+)?%")
NUMBER_RE = re.compile(r"-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?")
# Overlap ceiling, mm3 (CHK-PRT-03 legal interval 0 to 0.001), and the parts-sum tolerance, fraction.
OVERLAP_MAX_MM3 = 1e-3
SUM_TOLERANCE = 1e-3
# Triangles under this doubled area are degenerate, mm2 (seed validate_3mf.py).
DEGENERATE_AREA2 = 1e-12


class InputError(Exception):
    """The file or the arguments cannot be read; exit 2."""


class InternalError(Exception):
    """A declared module is missing or the validator broke; exit 70."""


# ------------------------------------------------------------------ check metadata
def _check_rows():
    rows = json.loads(CHECK_SEED.read_text(encoding="utf-8"))["checks"]
    return {r["id"]: r for r in rows}


def _completeness_meta():
    import orca3mf
    return orca3mf.COMPLETENESS_ID, orca3mf.COMPLETENESS_ALIAS


class Report:
    """CheckResult list in the D-064 shape, plus notes and the key-set report."""

    def __init__(self, artifact, mode, target):
        self.artifact = artifact
        self.mode = mode
        self.target = target
        self.rows = _check_rows()
        self.results = []
        self.notes = []
        self.key_set = None
        self.build_items = []
        self.say = lambda *_: None

    def _meta(self, cid):
        if cid in self.rows:
            r = self.rows[cid]
            return r["version"], r["severity"]
        cmp_id, _ = _completeness_meta()
        if cid == cmp_id:
            # CHK-ART-01 enters the registry at M04 (CHECKS.md 9); the writer stamps 0.1.0.
            return "0.1.0", "block"
        raise InternalError("check %s has no seed row in %s" % (cid, CHECK_SEED))

    def add(self, cid, verdict, constraint, legal, measured, path=None, extra=None):
        version, severity = self._meta(cid)
        target = {"level": "artifact", "artifact": self.artifact}
        if path:
            target["path"] = path
        r = {"id": cid, "version": version, "verdict": verdict, "severity": severity, "target": target,
             "measured": measured, "legal": legal, "constraint": constraint, "origin": "hbf://check/%s" % cid}
        if extra:
            r["extra"] = extra
        self.results.append(r)
        return r

    def boolean(self, cid, ok, constraint, path=None, extra=None):
        return self.add(cid, "pass" if ok else "fail", constraint, {"kind": "boolean", "must": True}, bool(ok), path, extra)

    def skip(self, cid, reason, path=None):
        return self.add(cid, "skip", reason, {"kind": "none"}, "not run", path)

    def failed(self):
        return [r for r in self.results if r["verdict"] == "fail"]

    def as_json(self):
        ran = [r for r in self.results if r["verdict"] != "skip"]
        return {"artifact": self.artifact, "mode": self.mode, "target": self.target,
                "verdict": "fail" if self.failed() else "pass",
                "counts": {"ran": len(ran), "skipped": len(self.results) - len(ran), "failed": len(self.failed())},
                "results": self.results, "notes": self.notes, "keySet": self.key_set}


def _problems(items, limit=5):
    return "; ".join(items[:limit])


# ------------------------------------------------------------------ package reading
# Zip limits for untrusted input (D-166, ARCHITECTURE 11.1): plan budgets (inferred).
ZIP_MAX_ENTRIES = 4096
ZIP_MAX_INFLATED = 256 * 2 ** 20
ZIP_CHUNK = 2 ** 20
# A `..` segment, a leading slash or backslash, or a drive letter.
UNSAFE_NAME = re.compile(r"(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:")


_SIG_CENTRAL = b"PK\x01\x02"
_SIG_END = b"PK\x05\x06"
_SIG_ZIP64_LOCATOR = b"PK\x06\x07"
_SIG_ZIP64_END = b"PK\x06\x06"
# The end record is 22 bytes and its comment at most 65535, so it starts in the last 65557 bytes.
_END_SEARCH = 22 + 0xFFFF


def _preflight_central(path, limit=ZIP_MAX_ENTRIES):
    """Count central directory records by walking them before zipfile parses any.

    zipfile.ZipFile builds a ZipInfo for every central record before a count
    can be checked, so a zip with millions of records costs that memory first.
    This walk reads only bytes, from the offset the end record (or the Zip64
    end record) names plus the prepended-data shift zipfile applies, and
    stops as soon as the count passes `limit`; the counts the end records
    claim are ignored. packages/3mf/src/validate/reader.ts preflightCentral
    is the same walk for the JS reader.
    """
    def not_zip(why):
        return InputError("%s is not a readable zip: %s" % (path, why))
    with open(path, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        tail_len = min(size, _END_SEARCH)
        fh.seek(size - tail_len)
        tail = fh.read(tail_len)
        i = tail.rfind(_SIG_END, 0, max(0, len(tail) - 18))
        if i < 0 or i + 22 > len(tail):
            raise not_zip("no end of central directory record in the last %d bytes" % _END_SEARCH)
        eocd = size - tail_len + i
        disk, cd_disk, n_here, n_total, cd_size, cd_offset = struct.unpack("<HHHHII", tail[i + 4:i + 20])
        end_of_central = eocd
        if 0xFFFF in (disk, cd_disk, n_here, n_total) or 0xFFFFFFFF in (cd_size, cd_offset):
            if eocd < 20:
                raise not_zip("no Zip64 end of central directory locator")
            fh.seek(eocd - 20)
            loc = fh.read(20)
            if loc[:4] != _SIG_ZIP64_LOCATOR:
                raise not_zip("no Zip64 end of central directory locator")
            rec = struct.unpack("<Q", loc[8:16])[0]
            if rec + 56 > size:
                raise not_zip("the Zip64 locator names a record past the end of the file")
            fh.seek(rec)
            z64 = fh.read(56)
            if z64[:4] != _SIG_ZIP64_END:
                raise not_zip("no Zip64 end of central directory record")
            cd_size, cd_offset = struct.unpack("<QQ", z64[40:56])
            end_of_central = rec
        concat = end_of_central - (cd_offset + cd_size)
        if concat < 0 or cd_size > size:
            raise not_zip("the central directory runs past its end record")
        fh.seek(cd_offset + concat)
        central = fh.read(cd_size)
    at = 0
    count = 0
    while central[at:at + 4] == _SIG_CENTRAL:
        if at + 46 > len(central):
            raise not_zip("central record %d runs past the end of the directory" % count)
        name_len, extra_len, comment_len = struct.unpack("<HHH", central[at + 28:at + 34])
        count += 1
        if count > limit:
            raise InputError("E_SCHEMA %s: more than %d entries; the zip rule allows at most %d (D-166)"
                             % (path, limit, limit))
        at += 46 + name_len + extra_len + comment_len
    return count


def open_package(path):
    """Open a 3MF or any zip under the D-166 rules and return the ZipFile.

    Refuses more than ZIP_MAX_ENTRIES entries and any entry name with a `..`
    segment, a leading `/` or `\\`, or a drive letter. Every member is then
    inflated in ZIP_CHUNK reads with a running total across members; the read
    stops once the total passes ZIP_MAX_INFLATED, whatever the headers
    declare. Reading to the end of each member also checks its CRC, which
    zipfile.testzip did here before. Each refusal is an InputError (exit 2)
    whose text names E_SCHEMA, the rule and the limit.
    """
    try:
        _preflight_central(path)
    except OSError as ex:
        raise InputError("%s is not a readable zip: %s" % (path, ex))
    try:
        z = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as ex:
        raise InputError("%s is not a readable zip: %s" % (path, ex))
    try:
        infos = z.infolist()
        if len(infos) > ZIP_MAX_ENTRIES:
            raise InputError("E_SCHEMA %s: %d entries; the zip rule allows at most %d (D-166)"
                             % (path, len(infos), ZIP_MAX_ENTRIES))
        for info in infos:
            if UNSAFE_NAME.search(info.filename):
                raise InputError("E_SCHEMA %s: entry name %r has a .. segment, a leading slash or a drive letter; "
                                 "the zip rule refuses it (D-166)" % (path, info.filename))
        total = 0
        for info in infos:
            if info.is_dir():
                continue
            try:
                with z.open(info) as fh:
                    while True:
                        chunk = fh.read(ZIP_CHUNK)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > ZIP_MAX_INFLATED:
                            raise InputError("E_SCHEMA %s: inflated size passes %d bytes at %s; the zip rule allows "
                                             "at most %d (D-166)" % (path, ZIP_MAX_INFLATED, info.filename, ZIP_MAX_INFLATED))
            except (zipfile.BadZipFile, zlib.error, EOFError, RuntimeError, NotImplementedError, OSError) as ex:
                raise InputError("%s is corrupt at %s: %s" % (path, info.filename, ex))
    except BaseException:
        z.close()
        raise
    return z


def _parse_xml(z, name):
    try:
        return ET.fromstring(z.read(name))
    except ET.ParseError as ex:
        raise InputError("%s is not well-formed XML: %s" % (name, ex))


def _part_name(target):
    """A package part name without the leading slash, normalised."""
    return posixpath.normpath(target.lstrip("/"))


def parse_model(root):
    """Objects of one model part: id -> {mesh: (vertices, faces) | None, components: [...], name, pid, pindex}."""
    import numpy as np
    out = {}
    for obj in root.findall("m:resources/m:object", NS):
        oid = int(obj.get("id"))
        mesh = obj.find("m:mesh", NS)
        rec = {"name": obj.get("name"), "pid": obj.get("pid"), "pindex": obj.get("pindex"), "mesh": None, "components": [],
               "triangles": []}
        if mesh is not None:
            vs = np.array([[float(v.get("x")), float(v.get("y")), float(v.get("z"))]
                           for v in mesh.findall("m:vertices/m:vertex", NS)], dtype=np.float64).reshape(-1, 3)
            tris = mesh.findall("m:triangles/m:triangle", NS)
            fs = np.array([[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in tris], dtype=np.int64).reshape(-1, 3)
            rec["mesh"] = (vs, fs)
            rec["triangles"] = tris
        for c in obj.findall("m:components/m:component", NS):
            rec["components"].append({"objectid": int(c.get("objectid")), "path": c.get(P_PATH), "transform": c.get("transform")})
        out[oid] = rec
    return out


def read_rels(z, names):
    """Targets of 3D/_rels/3dmodel.model.rels, normalised part names."""
    if ROOT_RELS not in names:
        return set()
    root = _parse_xml(z, ROOT_RELS)
    return {_part_name(r.get("Target", "")) for r in root.findall("r:Relationship", NS)}


def transform_matrix(t):
    import numpy as np
    m = np.eye(4)
    if not t:
        return m
    v = [float(x) for x in t.split()]
    m[:3, :3] = np.array(v[:9]).reshape(3, 3).T
    m[:3, 3] = v[9:12]
    return m


# ------------------------------------------------------------------ CHK-3MF-06
def check_paths(rep, z, names, models, rels):
    """CHK-3MF-06 per D-068: every component reference resolves; p:path never names the root model."""
    bad = []
    count = 0
    for part, objs in models.items():
        for oid, rec in objs.items():
            for ci, comp in enumerate(rec["components"]):
                count += 1
                where = "%s#%d/%d" % (part, oid, ci)
                p = comp["path"]
                if p:
                    pn = _part_name(p)
                    if pn == ROOT_MODEL:
                        bad.append("%s self-reference: p:path %s is the root model" % (where, p))
                    elif pn not in names:
                        bad.append("%s missing part: %s is not in the package" % (where, p))
                    elif pn not in rels:
                        bad.append("%s missing part: %s is not listed in %s" % (where, p, ROOT_RELS))
                    elif comp["objectid"] not in models.get(pn, {}):
                        bad.append("%s missing object: id %d is not in %s" % (where, comp["objectid"], p))
                elif comp["objectid"] not in objs:
                    bad.append("%s missing object: id %d is not in %s" % (where, comp["objectid"], part))
    root = models[ROOT_MODEL]
    for it in rep.build_items:
        if int(it.get("objectid")) not in root:
            bad.append("build item objectid %s is not in the root model" % it.get("objectid"))
    if not rep.build_items:
        bad.append("the root model has no build items")
    rep.boolean("CHK-3MF-06", not bad,
                "every component p:path resolves to a model part other than the root model and the object id exists "
                "there; a component without p:path resolves in its own part (D-068)",
                extra={"components": count, "failures": len(bad), **({"first": _problems(bad)} if bad else {})})


def check_model_settings(rep, z, names, models, n_fil):
    """model_settings objects exist in the root, parts resolve to a mesh in any model part, extruders exist."""
    if MODEL_SETTINGS not in names:
        return None
    ms = _parse_xml(z, MODEL_SETTINGS)
    root = models[ROOT_MODEL]
    mesh_ids = {oid for objs in models.values() for oid, rec in objs.items() if rec["mesh"] is not None}
    bad = []
    for obj in ms.findall("object"):
        oid = int(obj.get("id"))
        if oid not in root:
            bad.append("object %d is not in the root model" % oid)
        # A part without its own extruder takes the object's, as the slicer saves it (TENON and HAFT saves).
        obj_ext = [m.get("value") for m in obj.findall("metadata") if m.get("key") == "extruder"]
        for part in obj.findall("part"):
            pid = int(part.get("id"))
            if pid not in mesh_ids:
                bad.append("part %d of object %d resolves to no mesh in any model part" % (pid, oid))
            ext = [m.get("value") for m in part.findall("metadata") if m.get("key") == "extruder"] or obj_ext
            if not ext:
                bad.append("part %d and object %d have no extruder" % (pid, oid))
            elif n_fil is not None and (not ext[0].isdigit() or not 1 <= int(ext[0]) <= n_fil):
                bad.append("part %d uses extruder %s but %d filaments are declared" % (pid, ext[0], n_fil))
    if not ms.findall("plate/model_instance"):
        bad.append("plate has no model_instance blocks")
    rep.boolean("CHK-3MF-06", not bad,
                "model_settings objects exist in the root model and every part resolves to a mesh with a declared extruder",
                path=MODEL_SETTINGS,
                extra={"rule": "model-settings", "objects": len(ms.findall("object")), "parts": len(ms.findall("object/part")),
                       "failures": len(bad), **({"first": _problems(bad)} if bad else {})})
    return ms


# ------------------------------------------------------------------ topology and lib3mf
def nonmanifold_vertices(m):
    """Count vertices whose incident faces do not form a single edge connected fan (vertex pinches)."""
    import numpy as np
    from collections import defaultdict
    faces = np.asarray(m.faces)
    vf = defaultdict(list)
    for fi, f in enumerate(faces):
        for v in f:
            vf[int(v)].append(fi)
    bad = 0
    for v, flist in vf.items():
        parent = list(range(len(flist)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        edge_of = {}
        for li, fi in enumerate(flist):
            for o in faces[fi]:
                o = int(o)
                if o == v:
                    continue
                e = (v, o) if v < o else (o, v)
                if e in edge_of:
                    parent[find(li)] = find(edge_of[e])
                else:
                    edge_of[e] = li
        if len({find(i) for i in range(len(flist))}) != 1:
            bad += 1
    return bad


def check_topology(rep, models):
    """CHK-PRT-01 per mesh, the seed rules: raw edge pairing, winding, volume, trimesh merge, vertex fans."""
    import numpy as np
    import trimesh
    merged = {}
    for part, objs in models.items():
        for oid, rec in objs.items():
            if rec["mesh"] is None:
                continue
            vs, fs = rec["mesh"]
            where = "%s#%d" % (part, oid)
            bad = []
            if len(fs) == 0:
                bad.append("no triangles")
            elif fs.min() < 0 or fs.max() >= len(vs):
                bad.append("a triangle index is out of range")
            else:
                a_, b_, c_ = vs[fs[:, 0]], vs[fs[:, 1]], vs[fs[:, 2]]
                degen = int((np.linalg.norm(np.cross(b_ - a_, c_ - a_), axis=1) < DEGENERATE_AREA2).sum())
                if degen:
                    bad.append("%d degenerate triangles" % degen)
                e = np.concatenate([fs[:, [0, 1]], fs[:, [1, 2]], fs[:, [2, 0]]])
                _, cnt = np.unique(np.sort(e, axis=1), axis=0, return_counts=True)
                odd = int((cnt != 2).sum())
                if odd:
                    bad.append("%d undirected edges not shared by exactly two faces (raw indices)" % odd)
                _, dcnt = np.unique(e, axis=0, return_counts=True)
                if int((dcnt != 1).sum()):
                    bad.append("inconsistent winding (a directed edge repeats)")
                vol = float(np.einsum("ij,ij->i", a_, np.cross(b_, c_)).sum() / 6.0)
                if vol <= 0:
                    bad.append("signed volume %.4f mm3 is not positive (inverted)" % vol)
                m = trimesh.Trimesh(vs, fs, process=True)  # merges coincident vertices like the slicer will
                merged[(part, oid)] = m
                if not m.is_watertight:
                    bad.append("not watertight after vertex merge")
                if not m.is_winding_consistent:
                    bad.append("winding inconsistent after vertex merge")
                nmv = nonmanifold_vertices(m)
                if nmv:
                    bad.append("%d non manifold vertices (two surfaces meet at a point)" % nmv)
                rep.say("mesh %s: %d tris, vol %.3f mm3 (computed), non manifold vertices %d" % (where, len(fs), m.volume, nmv))
            rep.boolean("CHK-PRT-01", not bad, "every mesh is a closed manifold: two faces per undirected edge, one fan per vertex",
                        path=where, extra={"rule": "topology", "triangles": int(len(fs)),
                                           **({"first": _problems(bad)} if bad else {})})
    return merged


def lib3mf_available():
    """lib3mf 2.5.0 ships no linux aarch64 wheel; py/pyproject.toml drops it there by marker."""
    return not (sys.platform.startswith("linux") and platform.machine() == "aarch64")


def check_lib3mf(rep, path, strict):
    if not lib3mf_available():
        rep.skip("CHK-PRT-01", "not run: lib3mf 2.5.0 has no linux aarch64 wheel (pyproject marker)", path=ROOT_MODEL)
        return
    try:
        import lib3mf
    except ImportError as ex:
        raise InternalError("lib3mf is declared for this platform in py/pyproject.toml but did not import: %s" % ex)
    bad = []
    n = 0
    try:
        wrapper = lib3mf.get_wrapper()
        model = wrapper.CreateModel()
        reader = model.QueryReader("3mf")
        reader.SetStrictModeActive(bool(strict))
        reader.ReadFromFile(str(path))
        warns = [reader.GetWarning(i) for i in range(reader.GetWarningCount())]
        unknown = [w for w in warns if "Unknown Model Metadata" in str(w[1])]
        # printable="1" and auto_drop="1" on build items are Bambu attributes outside the core namespace.
        attr = [w for w in warns if "Invalid Attribute in namespace" in str(w[1])]
        other = [w for w in warns if w not in unknown and w not in attr]
        it = model.GetMeshObjects()
        while it.MoveNext():
            mo = it.GetCurrentMeshObject()
            n += 1
            if not mo.IsManifoldAndOriented():
                bad.append("mesh %s is not manifold and oriented" % mo.GetName())
        rep.say("lib3mf: %d meshes read, %d 'Unknown Model Metadata' notices (Bambu tags, expected), "
                "%d build item attribute notices, %d other warnings" % (n, len(unknown), len(attr), len(other)))
        for w in other[:10]:
            rep.notes.append("lib3mf warning: %s" % (w,))
    except Exception as ex:  # lib3mf raises its own ELib3MFException on any read failure
        bad.append("lib3mf could not read the file: %s" % ex)
    rep.boolean("CHK-PRT-01", not bad, "lib3mf reads the package and reports every mesh manifold and oriented%s"
                % (" (strict mode)" if strict else ""), path=ROOT_MODEL,
                extra={"rule": "lib3mf", "meshes": n, **({"first": _problems(bad)} if bad else {})})


# ------------------------------------------------------------------ core target materials
def check_materials(rep, root_el, models):
    """Target core: every pid and pindex (object) and p1 to p3 (triangle) points into a declared group."""
    sizes = {}
    for res in root_el.findall("m:resources/*", NS):
        tag = res.tag.split("}")[-1]
        if tag == "basematerials":
            sizes[res.get("id")] = len(res.findall("m:base", NS))
        elif tag == "colorgroup":
            sizes[res.get("id")] = len(res.findall("mat:color", NS))
    bad = []
    for oid, rec in models[ROOT_MODEL].items():
        pid = rec["pid"]
        if pid is None:
            continue
        if pid not in sizes:
            bad.append("object %d pid %s names no basematerials or colorgroup" % (oid, pid))
            continue
        if rec["pindex"] is not None and not 0 <= int(rec["pindex"]) < sizes[pid]:
            bad.append("object %d pindex %s is outside group %s of %d" % (oid, rec["pindex"], pid, sizes[pid]))
        for t in rec["triangles"]:
            tp = t.get("pid", pid)
            if tp not in sizes:
                bad.append("object %d triangle pid %s names no group" % (oid, tp))
                break
            idx = [t.get(k) for k in ("p1", "p2", "p3") if t.get(k) is not None]
            if any(not 0 <= int(i) < sizes[tp] for i in idx):
                bad.append("object %d triangle index %s outside group %s of %d" % (oid, idx, tp, sizes[tp]))
                break
    rep.boolean("CHK-3MF-06", not bad, "target core: every material reference resolves to a declared group and index",
                path=ROOT_MODEL, extra={"rule": "materials", "groups": len(sizes), **({"first": _problems(bad)} if bad else {})})


# ------------------------------------------------------------------ project settings rules
def slot_kind(values):
    """The per-slot type of a template key, read from its template values: percent, number, string or any."""
    non_nil = [v for v in values if v != "nil"]
    nullable = len(non_nil) < len(values)
    if not non_nil:
        return "any", True
    if all(PERCENT_RE.fullmatch(v) for v in non_nil):
        return "percent", nullable
    # Integer and float strings share one class: the gold writes filament_flow_ratio "1" where other presets write "0.98".
    if all(NUMBER_RE.fullmatch(v) for v in non_nil):
        return "number", nullable
    return "string", nullable


def element_problem(key, kind, nullable, x):
    if not isinstance(x, str):
        return "is a JSON %s, not a string" % type(x).__name__
    if key == OVERHANG_KEY:
        return None if OVERHANG_RE.fullmatch(x) else "does not match ^[0-9]+%$"
    if x == "nil":
        return None if nullable else "is nil where the template has no nil"
    if kind == "percent" and not PERCENT_RE.fullmatch(x):
        return "is not a percent string"
    if kind == "number" and not NUMBER_RE.fullmatch(x):
        return "is not a numeric string"
    return None


def check_project_settings(rep, z, names):
    import orca3mf
    template = orca3mf.TEMPLATE["keys"]
    tk = set(template)
    if PROJECT_SETTINGS not in names:
        return None
    try:
        ps = json.loads(z.read(PROJECT_SETTINGS).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as ex:
        raise InputError("%s is not JSON: %s" % (PROJECT_SETTINGS, ex))
    if not isinstance(ps, dict):
        raise InputError("%s is not a JSON object" % PROJECT_SETTINGS)
    colours = ps.get("filament_colour")
    n = len(colours) if isinstance(colours, list) else None
    present = sorted(k for k in tk if k in ps)
    absent = sorted(tk - set(ps))
    non_template = sorted(k for k in ps if k not in tk)
    non_template_vectors = [k for k in non_template if isinstance(ps[k], list)]
    lengths = {}
    for k in present:
        v = ps[k]
        L = len(v) if isinstance(v, list) else -1
        lengths[L] = lengths.get(L, 0) + 1
    rep.key_set = {"templateKeys": len(tk), "present": len(present), "absent": absent,
                   "nonTemplate": non_template, "nonTemplateVectors": len(non_template_vectors),
                   "nonTemplateVectorLengths": sorted({len(ps[k]) for k in non_template_vectors}),
                   "templateLengths": {str(k): v for k, v in sorted(lengths.items())}, "filaments": n}
    rep.notes.append("key-set: %d of %d template keys present, %d absent; %d keys outside the template, %d of them vectors"
                     % (len(present), len(tk), len(absent), len(non_template), len(non_template_vectors)))
    mode = rep.mode

    # CHK-3MF-02: template keys exactly N long; under --export every template key is present.
    bad02 = []
    worst = n if n is not None else 0
    if n is None:
        bad02.append("filament_colour is missing or not a list, so the filament count is unknown")
    else:
        for k in present:
            v = ps[k]
            if not isinstance(v, list):
                bad02.append("%s is a scalar, not a vector" % k)
                worst = 1
            elif len(v) != n:
                bad02.append("%s has %d elements" % (k, len(v)))
                worst = len(v)
        for k in ("filament_diameter", "filament_settings_id"):
            if k not in ps:
                bad02.append("%s missing (the loader reads its size)" % k)
                worst = 0
        if mode == "export" and absent:
            bad02.append("%d template keys missing, first %s" % (len(absent), ", ".join(absent[:5])))
            worst = 0
    N = n if n is not None else 0
    rep.add("CHK-3MF-02", "fail" if bad02 else "pass",
            "every template key is a vector of one element per filament, N = len(filament_colour)%s"
            % (", and all %d template keys are present" % len(tk) if mode == "export" else " (template keys present)"),
            {"kind": "interval", "lo": N, "hi": N, "unit": "elements", "nearest": N}, worst, path=PROJECT_SETTINGS,
            extra={"filaments": N, "checked": len(present), **({"first": _problems(bad02)} if bad02 else {})})

    # CHK-3MF-03: key scope by template membership.
    forbidden = [k for k in orca3mf.FORBIDDEN_KEYS if k in ps]
    if mode == "export":
        extra_keys = [k for k in non_template if k not in orca3mf.SCALAR_KEYS]
        bad03 = ["%s is outside the template and the writer's scalar keys" % k for k in extra_keys]
        rep.boolean("CHK-3MF-03", not bad03,
                    "outside the %d template keys only the writer's scalar keys appear: %s"
                    % (len(tk), ", ".join(orca3mf.SCALAR_KEYS)), path=PROJECT_SETTINGS,
                    extra={"outside": len(extra_keys), **({"first": _problems(bad03)} if bad03 else {})})
    elif mode == "legacy":
        rep.boolean("CHK-3MF-03", "extruder_variant_list" not in ps,
                    "no extruder_variant_list, the loader asserts on it; keys outside the template go to the key-set note",
                    path=PROJECT_SETTINGS, extra={"outside": len(non_template)})
    else:
        rep.skip("CHK-3MF-03", "not run in --roundtrip: the slicer wrote every key, including printer-scoped vectors",
                 path=PROJECT_SETTINGS)
    if mode == "export" and forbidden:
        rep.notes.append("forbidden keys present: %s" % ", ".join(forbidden))

    # CHK-3MF-07: per-slot types on template keys; overhang_fan_threshold percent strings.
    bad07 = []
    for k in present:
        v = ps[k]
        if not isinstance(v, list):
            continue  # a scalar template key is a CHK-3MF-02 fail
        kind, nullable = slot_kind(template[k])
        for i, x in enumerate(v):
            p = element_problem(k, kind, nullable, x)
            if p is not None:
                bad07.append("%s slot %d element %s %s" % (k, i, json.dumps(x), p))
                break
    if mode == "export":
        for k in KEPT_KEYS:
            if k not in ps:
                bad07.append("%s missing; the writer keeps it (C-07)" % k)
    rep.boolean("CHK-3MF-07", not bad07,
                "per-filament vectors carry the template's per-slot type; overhang_fan_threshold elements match ^[0-9]+%$ (D-069)",
                path=PROJECT_SETTINGS, extra={"checked": len(present), "failures": len(bad07),
                                              **({"first": _problems(bad07)} if bad07 else {})})

    if mode in ("export", "legacy"):
        for k in ("printer_settings_id", "print_settings_id"):
            if k not in ps:
                rep.notes.append("%s not written: the slicer will invent an external preset named after the file" % k)
        if "curr_bed_type" not in ps:
            rep.notes.append("curr_bed_type not written: the slicer opens on its default plate (cold plate in Flash "
                             "Studio); set the machine preset bed type")
    rep.say("project_settings: %d keys, filament count %s, printer %s / %s, plate %s"
            % (len(ps), n, ps.get("printer_settings_id"), ps.get("print_settings_id"), ps.get("curr_bed_type")))
    return n


# ------------------------------------------------------------------ export completeness
def check_completeness(rep, ms, models, stl_zip):
    """CHK-ART-01 (export-completeness until M04): names resolve and are unique; the STL zip has one member per part."""
    import orca3mf
    cid, alias = _completeness_meta()
    if ms is not None:
        objects = [(next((m.get("value") for m in o.findall("metadata") if m.get("key") == "name"), None),
                    [next((m.get("value") for m in p.findall("metadata") if m.get("key") == "name"), None)
                     for p in o.findall("part")]) for o in ms.findall("object")]
    else:
        root = models[ROOT_MODEL]
        objects = [(rec["name"], [root.get(c["objectid"], {}).get("name") for c in rec["components"]])
                   for rec in root.values() if rec["components"]]
    bad = []
    seen = {}
    parts = 0
    for i, (name, part_names) in enumerate(objects):
        p = orca3mf._name_problem(name)
        if p is not None:
            bad.append("object %d name %s %s" % (i, json.dumps(name), p))
        seen[str(name)] = seen.get(str(name), 0) + 1
        for j, pn in enumerate(part_names):
            parts += 1
            q = orca3mf._name_problem(pn)
            if q is not None:
                bad.append("object %d part %d name %s %s" % (i, j, json.dumps(pn), q))
    for name, k in seen.items():
        if k > 1:
            bad.append("object name %s used %d times" % (json.dumps(name), k))
    extra = {"alias": alias, "objects": len(objects), "parts": parts}
    if stl_zip is not None:
        with open_package(stl_zip) as sz:
            members = [m for m in sz.namelist() if not m.endswith("/")]
        extra["stlMembers"] = len(members)
        if len(members) != parts:
            bad.append("stl zip holds %d members for %d parts" % (len(members), parts))
        if len(set(members)) != len(members):
            bad.append("stl zip holds %d unique names for %d members" % (len(set(members)), len(members)))
    if bad:
        extra["first"] = _problems(bad)
    rep.boolean(cid, not bad, "every object and part name resolves, object names are unique, the stl zip holds one member "
                "per part (plan-deltas R50)", path=MODEL_SETTINGS if ms is not None else ROOT_MODEL, extra=extra)


# ------------------------------------------------------------------ overlap
def _manifold(m3d, models, merged, key, M):
    """(solid, why) for object key under transform M: solid is (manifold3d solid or None, trimesh volume,
    lowest corner, highest corner); why says why manifold3d refused it. (None, None): the key names no mesh."""
    import numpy as np
    m = merged.get(key)
    if m is None:
        src = models.get(key[0], {}).get(key[1])
        if src is None or src["mesh"] is None:
            return None, None
        import trimesh
        m = trimesh.Trimesh(*src["mesh"], process=True)
        merged[key] = m
    v = (np.c_[np.asarray(m.vertices), np.ones(len(m.vertices))] @ M.T)[:, :3]
    man = m3d.Manifold(m3d.Mesh(np.asarray(v, dtype=np.float32), np.asarray(m.faces, dtype=np.uint32)))
    # manifold3d turns a mesh it cannot accept into an empty Manifold of volume 0, which
    # intersects nothing: such a part would pass, so the caller fails the check instead.
    if man.status() != m3d.Error.NoError:
        return (None, float(m.volume), v.min(axis=0), v.max(axis=0)), \
            "part %d is not manifold (%s); overlap not computed" % (key[1], str(man.status()).split(".")[-1])
    return (man, float(m.volume), v.min(axis=0), v.max(axis=0)), None


def _object_solids(m3d, models, merged, oid, M):
    """Every mesh an object of the root model places, under transform M: ([(objectid, solid)], [why refused])."""
    rec = models[ROOT_MODEL].get(oid)
    if rec is None:
        return [], []
    if rec["mesh"] is not None:
        got, why = _manifold(m3d, models, merged, (ROOT_MODEL, oid), M)
        return ([(oid, got)] if got else []), ([why] if why else [])
    # Components follow p:path into sub-models; a component that names no mesh adds nothing.
    out, broken = [], []
    for comp in rec["components"]:
        key = (_part_name(comp["path"]) if comp["path"] else ROOT_MODEL, comp["objectid"])
        got, why = _manifold(m3d, models, merged, key, M @ transform_matrix(comp["transform"]))
        if why:
            broken.append(why)
        if got:
            out.append((comp["objectid"], got))
    return out, broken


def _worst_pair(groups):
    """Largest intersection volume between solids of different groups: (mm3, (group i, group j), counts).

    counts is {"pairs": solid pairs of different groups compared, "intersected": those whose bounding
    boxes touch and so went through the manifold3d boolean}. Pairs whose bounding boxes are apart are
    not intersected: their volume is 0."""
    worst, pair, pairs, cut = 0.0, None, 0, 0
    flat = [(g, s) for g, solids in enumerate(groups) for s in solids]
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            (gi, (_, a)), (gj, (_, b)) = flat[i], flat[j]
            if gi == gj:
                continue
            pairs += 1
            if a[0] is None or b[0] is None or (a[2] > b[3]).any() or (b[2] > a[3]).any():
                continue
            cut += 1
            inter = (a[0] ^ b[0]).volume()
            if inter > worst:
                worst, pair = inter, (gi, gj)
    return worst, pair, {"pairs": pairs, "intersected": cut}


def check_overlap(rep, models, merged, solid):
    """CHK-PRT-03: pairwise intersection volume under 1e-3 mm3 between the parts of one object and,
    when the build has two or more items, between the items as placed; with --solid parts sum to it.

    A plate places one object as several build items, so the per-object rule
    alone cannot see two copies on top of each other (M07-T08). A part
    manifold3d cannot accept (status other than NoError) fails the check:
    its overlap with the other parts cannot be computed.
    """
    try:
        import manifold3d as m3d
    except ImportError as ex:
        raise InternalError("manifold3d is declared in py/pyproject.toml but did not import: %s" % ex)
    import numpy as np
    solid_vol = None
    if solid is not None:
        import trimesh
        try:
            solid_vol = float(trimesh.load(solid, force="mesh").volume)
        except Exception as ex:
            raise InputError("--solid %s cannot be read: %s" % (solid, ex))
    legal = lambda worst: {"kind": "interval", "lo": 0, "hi": OVERLAP_MAX_MM3, "unit": "mm3", "nearest": min(worst, OVERLAP_MAX_MM3)}
    for oid, rec in models[ROOT_MODEL].items():
        if not rec["components"]:
            continue
        solids, broken = _object_solids(m3d, models, merged, oid, np.eye(4))
        vols = [s[1][1] for s in solids]
        worst, pair, counts = _worst_pair([[s] for s in solids])
        ok = worst <= OVERLAP_MAX_MM3
        extra = {"parts": len(vols), **counts}
        if pair:
            extra["worstPair"] = "%d,%d" % (solids[pair[0]][0], solids[pair[1]][0])
        if broken:
            ok = False
            extra["first"] = broken[0]
            extra["notManifold"] = len(broken)
        constraint = "parts of one object never overlap: pairwise intersection at most %g mm3 (manifold3d)" % OVERLAP_MAX_MM3
        if solid_vol is not None:
            total = sum(vols)
            extra["partsMm3"] = round(total, 3)
            extra["solidMm3"] = round(solid_vol, 3)
            if abs(total - solid_vol) > SUM_TOLERANCE * max(1.0, solid_vol):
                ok = False
                extra["first" if "first" not in extra else "sum"] = "parts sum to %.3f mm3 but the solid is %.3f" % (total, solid_vol)
            rep.say("object %d: parts %.3f vs solid %.3f mm3 (computed)" % (oid, total, solid_vol))
            constraint += "; parts sum to the solid within 0.1 percent"
        rep.add("CHK-PRT-03", "pass" if ok else "fail", constraint, legal(worst),
                round(worst, 6), path="%s#%d" % (ROOT_MODEL, oid), extra=extra)
    items = rep.build_items
    if len(items) < 2:
        return
    groups, broken = [], []
    for it in items:
        got, bad = _object_solids(m3d, models, merged, int(it.get("objectid")), transform_matrix(it.get("transform")))
        groups.append(got)
        broken += bad
    worst, pair, counts = _worst_pair(groups)
    ok = worst <= OVERLAP_MAX_MM3 and not broken
    extra = {"rule": "build", "items": len(items), **counts}
    if pair:
        extra["worstPair"] = "item %d,%d" % pair
    if broken:
        extra["notManifold"] = len(broken)
    if not ok:
        extra["first"] = broken[0] if broken else "build items %d and %d intersect by %.6f mm3" % (pair[0], pair[1], worst)
    rep.say("build: %d items, %d pairs compared, %d intersected, worst intersection %.6f mm3 (computed)"
            % (len(items), counts["pairs"], counts["intersected"], worst))
    rep.add("CHK-PRT-03", "pass" if ok else "fail",
            "build items never overlap as placed: pairwise intersection at most %g mm3 (manifold3d)" % OVERLAP_MAX_MM3,
            legal(worst), round(worst, 6), path="%s#build" % ROOT_MODEL, extra=extra)


# ------------------------------------------------------------------ driver
def validate(path, mode="export", target="bbs", overlap=False, solid=None, stl_zip=None, quiet=True):
    """Run every rule of the mode on one file; returns the Report."""
    path = Path(path)
    rep = Report(path.name, mode, target)
    if not quiet:
        rep.say = print
    z = open_package(path)
    names = {n for n in z.namelist() if not n.endswith("/")}
    if ROOT_MODEL not in names:
        raise InputError("%s has no %s" % (path, ROOT_MODEL))
    rep.say("entries: %s" % ", ".join(sorted(names)))

    # Package entries the importer needs.
    need = BBS_ENTRIES if target == "bbs" else CORE_ENTRIES
    missing = [e for e in need if e not in names]
    rep.boolean("CHK-3MF-06", not missing, "the package holds the entries the importer reads: %s" % ", ".join(need),
                extra={"rule": "package", **({"first": "missing " + ", ".join(missing)} if missing else {})})

    root_el = _parse_xml(z, ROOT_MODEL)
    rels = read_rels(z, names)
    models = {ROOT_MODEL: parse_model(root_el)}
    rep.build_items = root_el.findall("m:build/m:item", NS)
    for objs in list(models[ROOT_MODEL].values()):
        for comp in objs["components"]:
            pn = _part_name(comp["path"]) if comp["path"] else None
            if pn and pn != ROOT_MODEL and pn in names and pn not in models:
                models[pn] = parse_model(_parse_xml(z, pn))

    # CHK-3MF-01: the Application tag (bbs only).
    if target == "bbs":
        import orca3mf
        app = next((md.text or "" for md in root_el.findall("m:metadata", NS) if md.get("name") == "Application"), "")
        ok = any(app.startswith(p) for p in orca3mf.APP_PREFIXES)
        rep.add("CHK-3MF-01", "pass" if ok else "fail",
                "the importer reads colours only from an Application tag starting BambuStudio- or OrcaSlicer-",
                {"kind": "set", "values": list(orca3mf.APP_PREFIXES), "nearest": orca3mf.APP_PREFIXES[0]}, app, path=ROOT_MODEL)
        rep.say("application: %s" % app)
    else:
        rep.skip("CHK-3MF-01", "not run for target core: no slicer dialect", path=ROOT_MODEL)

    check_paths(rep, z, names, models, rels)

    n_fil = None
    ms = None
    if target == "bbs":
        n_fil = check_project_settings(rep, z, names)
        ms = check_model_settings(rep, z, names, models, n_fil)
        chk_3mf_08.check(rep, z, names, ms)
    else:
        check_materials(rep, root_el, models)
        for cid in ("CHK-3MF-02", "CHK-3MF-03", "CHK-3MF-07"):
            rep.skip(cid, "not run for target core: no slicer dialect keys", path=PROJECT_SETTINGS)
        rep.skip("CHK-3MF-08", "not run for target core: no per-object slicer settings", path=MODEL_SETTINGS)

    merged = {}
    if mode in ("export", "legacy"):
        merged = check_topology(rep, models)
        check_lib3mf(rep, path, strict=(target == "core"))
    else:
        rep.skip("CHK-PRT-01", "not run in --roundtrip: the slicer wrote the meshes", path=ROOT_MODEL)

    if mode == "export":
        check_completeness(rep, ms, models, stl_zip)

    if overlap or solid is not None:
        check_overlap(rep, models, merged, solid)
    return rep


def print_text(rep):
    for r in rep.results:
        extra = r.get("extra", {})
        label = r["id"] + ("[%s]" % extra["rule"] if "rule" in extra else "")
        where = r["target"].get("path", "")
        detail = extra.get("first", r["constraint"] if r["verdict"] == "skip" else "")
        print("%-4s %-22s %s%s" % (r["verdict"], label, where, (" : " + detail) if detail else ""))
    for n in rep.notes:
        print("note: %s" % n)
    f = rep.failed()
    ran = len([r for r in rep.results if r["verdict"] != "skip"])
    skipped = len(rep.results) - ran
    print("%s: %d checks ran, %d skipped, %d failed (%s, target %s)" % (rep.artifact, ran, skipped, len(f), rep.mode, rep.target))


def parse_args(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="validate_3mf.py", description="validate a 3MF export, legacy file or slicer save")
    ap.add_argument("path")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--export", dest="mode", action="store_const", const="export", help="a hackbuild writer export (default)")
    g.add_argument("--legacy", dest="mode", action="store_const", const="legacy", help="a pre-template writer export")
    g.add_argument("--roundtrip", dest="mode", action="store_const", const="roundtrip", help="a slicer save")
    ap.add_argument("--overlap", action="store_true", help="pairwise part overlap per object and between build items (manifold3d)")
    ap.add_argument("--solid", help="STL of the complete solid; parts must sum to its volume within 0.1 percent")
    ap.add_argument("--stl-zip", dest="stl_zip", help="the per-part STL zip of the export; member count must equal part count")
    ap.add_argument("--target", default="bbs", help="bbs (default), core or prusa")
    ap.add_argument("--json", action="store_true", help="print the CheckResult list as JSON")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    a.mode = a.mode or "export"
    if a.target == "prusa":
        raise InputError("target prusa not built in M00")
    if a.target not in ("bbs", "core"):
        raise InputError("target %s unknown; use bbs or core" % a.target)
    if a.stl_zip is not None and a.mode != "export":
        raise InputError("--stl-zip applies to --export only")
    if not Path(a.path).is_file():
        raise InputError("no file at %s" % a.path)
    return a


def main(argv):
    as_json = "--json" in argv
    try:
        a = parse_args(argv)
        for mod in ("numpy", "trimesh"):
            try:
                __import__(mod)
            except ImportError as ex:
                raise InternalError("%s is declared in py/pyproject.toml but did not import: %s" % (mod, ex))
        rep = validate(a.path, a.mode, a.target, a.overlap, a.solid, a.stl_zip, quiet=a.quiet or a.json)
    except InputError as ex:
        _error(as_json, "input", str(ex))
        return EXIT_INPUT
    except InternalError as ex:
        _error(as_json, "internal", str(ex))
        return EXIT_INTERNAL
    except Exception as ex:  # anything unforeseen is the validator's fault, never the file's verdict
        _error(as_json, "internal", "%s: %s" % (type(ex).__name__, ex))
        return EXIT_INTERNAL
    if a.json:
        print(json.dumps(rep.as_json(), indent=1))
    else:
        print_text(rep)
    return EXIT_FAIL if rep.failed() else EXIT_PASS


def _error(as_json, kind, msg):
    if as_json:
        print(json.dumps({"error": {"kind": kind, "hint": msg}}))
    else:
        print("validate_3mf: %s" % msg, file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))


def cli():
    """Console entry point."""
    sys.exit(main(sys.argv[1:]))
