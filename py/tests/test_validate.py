"""M00-T09: validate_3mf.py modes, the rewritten CHK-3MF-06 and CHK-3MF-07,
export completeness and the exit codes of spec/errors.ts.

The gold Flash Studio save passes --roundtrip; known-bad fixtures made from
the gold fail with the named check; the writer's own exports pass --export.
The CASK and TENON originals are read from tools/corpus/3mf/known-bad/ once
M00-T10 has copied them, else from the evidence copies they come from; a
test whose input is absent on this host is skipped with that reason, never
passed.
"""
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py/hackbuild_3mf"))
import orca3mf  # noqa: E402
import validate_3mf as v  # noqa: E402

GOLD = REPO / "corpus/gold/hackbuild-coin-nfc.3mf"
KNOWN_BAD = REPO / "corpus/known-bad"
TETRA = REPO / "corpus/inputs/tetra-2part.json"
EPOCH = 1791072000


# Tracked known-bad corpus files (M00-T10); a checkout without them fails, never skips (D-153).
CASK = KNOWN_BAD / "cask-empty-plate.3mf"
TENON = KNOWN_BAD / "tenon-undefined.3mf"
TENON_STL = KNOWN_BAD / "tenon-stl.zip"


def test_known_bad_originals_are_tracked():
    for f in (CASK, TENON, TENON_STL):
        assert f.is_file(), f"{f} is tracked in tools/corpus/3mf/known-bad"


def run(*args):
    """The validator as the acceptance commands run it, through this interpreter."""
    p = subprocess.run([sys.executable, str(REPO / "py/hackbuild_3mf/validate_3mf.py"), *map(str, args)],
                       capture_output=True, text=True, cwd=REPO)
    return p.returncode, p.stdout, p.stderr


def run_json(*args):
    code, out, err = run(*args, "--json")
    return code, json.loads(out)


def failing(report):
    return sorted({r["id"] + ("[%s]" % r["extra"]["rule"] if "rule" in r.get("extra", {}) else "")
                   for r in report["results"] if r["verdict"] == "fail"})


def first_of(report, cid):
    return " ".join(str(r.get("extra", {}).get("first", "")) for r in report["results"]
                    if r["id"] == cid and r["verdict"] == "fail")


def rewrite(src, dst, fn):
    zi = zipfile.ZipFile(src)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
        for info in zi.infolist():
            zo.writestr(info, fn(info.filename, zi.read(info.filename)))
    return dst


def settings_edit(edit):
    def fn(name, data):
        if name != v.PROJECT_SETTINGS:
            return data
        ps = json.loads(data)
        edit(ps)
        return json.dumps(ps, indent=4).encode()
    return fn


def model_edit(pattern, repl):
    def fn(name, data):
        return re.sub(pattern, repl, data) if name == v.ROOT_MODEL else data
    return fn


@pytest.fixture(scope="module")
def tetra(tmp_path_factory):
    with open(TETRA, encoding="utf-8") as fh:
        w = orca3mf.from_input(json.load(fh), source_date_epoch=EPOCH)
    return Path(w.write(tmp_path_factory.mktemp("tetra") / "tetra-2part.3mf"))



# ------------------------------------------------------------------ gold and known-bad
def test_gold_passes_roundtrip():
    code, out, err = run("--roundtrip", GOLD)
    assert code == 0, out + err
    code, rep = run_json("--roundtrip", GOLD)
    assert code == 0 and failing(rep) == []
    assert rep["keySet"]["present"] == 127 and rep["keySet"]["templateLengths"] == {"3": 127}
    skipped = sorted(r["id"] for r in rep["results"] if r["verdict"] == "skip")
    # The gold save carries no Metadata/hackbuild_chase.json, so CHK-3MF-08 has no body roles to read (M05-T20).
    assert skipped == ["CHK-3MF-03", "CHK-3MF-08", "CHK-PRT-01"]
    assert all(set(r) >= {"id", "version", "verdict", "severity", "target", "measured", "legal", "constraint", "origin"}
               for r in rep["results"])


def test_gold_p_path_resolves_into_the_sub_model():
    rep = v.validate(GOLD, "roundtrip").as_json()
    paths = [r for r in rep["results"] if r["id"] == "CHK-3MF-06" and "rule" not in r.get("extra", {})]
    assert paths[0]["verdict"] == "pass" and paths[0]["extra"]["components"] == 3


def test_seed_rule_failed_the_gold():
    """verified-claims C2: the gold has no root meshes and length-4 printer keys; the old rules refused it."""
    z = zipfile.ZipFile(GOLD)
    model = z.read(v.ROOT_MODEL).decode()
    assert "<mesh" not in model and model.count('p:path="/3D/Objects/hackbuild-coin-nfc_2.model"') == 3
    ps = json.loads(z.read(v.PROJECT_SETTINGS))
    assert len(ps["nozzle_diameter"]) == 4 and "extruder_variant_list" in ps


def test_missing_part_fails_chk_3mf_06(tmp_path):
    f = rewrite(GOLD, tmp_path / "gold-missing-part.3mf", model_edit(rb'p:path="[^"]*"', b'p:path="/3D/Objects/missing.model"'))
    code, rep = run_json("--roundtrip", f)
    assert code == 1
    assert "CHK-3MF-06" in failing(rep) and "missing part" in first_of(rep, "CHK-3MF-06")


def test_self_reference_fails_chk_3mf_06(tmp_path):
    f = rewrite(GOLD, tmp_path / "gold-self.3mf", model_edit(rb'p:path="[^"]*"', b'p:path="/3D/3dmodel.model"'))
    code, rep = run_json("--roundtrip", f)
    assert code == 1 and "self-reference" in first_of(rep, "CHK-3MF-06")


@pytest.mark.parametrize("value", [[95, 10, 10], ["95", "10", "10"], ["nil", "nil", "nil"]])
def test_overhang_not_percent_fails_chk_3mf_07(tmp_path, value):
    f = rewrite(GOLD, tmp_path / "overhang.3mf", settings_edit(lambda ps: ps.__setitem__("overhang_fan_threshold", value)))
    code, rep = run_json("--roundtrip", f)
    assert code == 1
    assert failing(rep) == ["CHK-3MF-07"]
    assert first_of(rep, "CHK-3MF-07").startswith("overhang_fan_threshold slot 0")


def test_template_key_length_fails_chk_3mf_02(tmp_path):
    f = rewrite(GOLD, tmp_path / "short.3mf", settings_edit(lambda ps: ps.__setitem__("fan_max_speed", ["50", "70"])))
    code, rep = run_json("--roundtrip", f)
    assert code == 1 and failing(rep) == ["CHK-3MF-02"]
    r = next(r for r in rep["results"] if r["id"] == "CHK-3MF-02")
    assert r["measured"] == 2 and r["legal"] == {"kind": "interval", "lo": 3, "hi": 3, "unit": "elements", "nearest": 3}


def test_cask_original_fails_06_and_07():
    code, rep = run_json("--roundtrip", CASK)
    assert code == 1
    assert failing(rep) == ["CHK-3MF-06", "CHK-3MF-07"]
    assert "self-reference" in first_of(rep, "CHK-3MF-06")
    assert "Overhang_threshold_bridge" in first_of(rep, "CHK-3MF-07")


def test_tenon_fails_export_completeness():
    code, rep = run_json("--export", TENON, "--stl-zip", TENON_STL)
    assert code == 1
    c = next(r for r in rep["results"] if r["id"] == orca3mf.COMPLETENESS_ID)
    assert c["verdict"] == "fail"
    assert c["extra"]["alias"] == "export-completeness" and c["extra"]["parts"] == 11 and c["extra"]["stlMembers"] == 7
    assert "tenon-undefined" in c["extra"]["first"]


# ------------------------------------------------------------------ writer exports


def test_tetra_passes_export_and_legacy(tetra):
    for mode in ("--export", "--legacy"):
        code, rep = run_json(mode, tetra)
        assert code == 0, (mode, failing(rep))


def test_key_outside_template_fails_chk_3mf_03(tetra, tmp_path):
    f = rewrite(tetra, tmp_path / "extra.3mf", settings_edit(lambda ps: ps.update(layer_height="0.2", extruder_variant_list=["x"])))
    code, rep = run_json("--export", f)
    assert code == 1 and failing(rep) == ["CHK-3MF-03"]
    assert "extruder_variant_list" in first_of(rep, "CHK-3MF-03") and "layer_height" in first_of(rep, "CHK-3MF-03")
    code, rep = run_json("--legacy", f)
    assert code == 1 and failing(rep) == ["CHK-3MF-03"]


def test_seed_template_export_fails_on_kept_keys(tetra, tmp_path):
    f = rewrite(tetra, tmp_path / "seed97.3mf", settings_edit(lambda ps: [ps.pop(k) for k in ("filament_map", "filament_self_index")]))
    code, rep = run_json("--export", f)
    assert code == 1 and failing(rep) == ["CHK-3MF-02", "CHK-3MF-07"]
    assert "filament_map missing" in first_of(rep, "CHK-3MF-07")
    code, rep = run_json("--legacy", f)
    assert code == 0 and "filament_map" in rep["keySet"]["absent"]


def test_stl_zip_count_fails_completeness(tetra, tmp_path):
    stl = tmp_path / "short.zip"
    with zipfile.ZipFile(stl, "w") as z:
        z.writestr("tetra-left.stl", b"solid\n")
    code, rep = run_json("--export", tetra, "--stl-zip", stl)
    assert code == 1 and failing(rep) == ["CHK-ART-01"]
    assert "stl zip holds 1 members for 2 parts" in first_of(rep, "CHK-ART-01")


def test_overlap_reports_intersection_volume(tetra, tmp_path):
    code, rep = run_json("--export", "--overlap", tetra)
    over = [r for r in rep["results"] if r["id"] == "CHK-PRT-03"]
    assert code == 0 and over and over[0]["legal"]["hi"] == 1e-3


def second_item(dx):
    """The tetra's one build item twice, the copy moved dx mm in x: a plate placing one object as two items."""
    def fn(name, data):
        if name != v.ROOT_MODEL:
            return data
        item = re.search(rb'<item objectid="3"[^>]*transform="1 0 0 0 1 0 0 0 1 150 150 0"[^>]*/>', data)
        assert item, "the tetra build item moved"
        copy = item.group(0).replace(b"00000001-b1ec", b"00000002-b1ec").replace(b" 150 150 0", b" %s 150 0" % str(150 + dx).encode())
        return data.replace(item.group(0), item.group(0) + b"\n  " + copy)
    return fn


def build_row(rep):
    rows = [r for r in rep["results"] if r["id"] == "CHK-PRT-03" and r["target"].get("path") == v.ROOT_MODEL + "#build"]
    assert len(rows) == 1, rep["results"]
    return rows[0]


def test_stacked_build_items_fail_overlap(tetra, tmp_path):
    """M07-T08: plate copies are separate build items; two on one spot fail CHK-PRT-03[build] by the tetra volume."""
    code, rep = run_json("--export", "--overlap", rewrite(tetra, tmp_path / "stacked.3mf", second_item(0)))
    assert code == 1 and "CHK-PRT-03[build]" in failing(rep)
    row = build_row(rep)
    assert row["extra"]["items"] == 2 and row["extra"]["worstPair"] == "item 0,1"
    # Two items of two bodies each: 2 x 2 cross pairs compared; each body's box touches only its own copy.
    assert row["extra"]["pairs"] == 4 and row["extra"]["intersected"] == 2
    per_object = [r for r in rep["results"] if r["id"] == "CHK-PRT-03" and r is not row]
    assert per_object and all(r["verdict"] == "pass" for r in per_object)
    # The copy coincides with the original, so the worst pair is one whole body: tetra-2part.json gives
    # each body legs 10, 10 and 10.5 mm, volume 10 x 10 x 10.5 / 6 = 175 mm3 (closed form).
    assert row["measured"] == pytest.approx(175.0, rel=1e-4)


def test_build_items_shifted_into_each_other_fail_and_apart_pass(tetra, tmp_path):
    code, rep = run_json("--export", "--overlap", rewrite(tetra, tmp_path / "half.3mf", second_item(1)))
    assert code == 1 and "CHK-PRT-03[build]" in failing(rep) and build_row(rep)["measured"] > v.OVERLAP_MAX_MM3
    code, rep = run_json("--export", "--overlap", rewrite(tetra, tmp_path / "apart.3mf", second_item(80)))
    assert "CHK-PRT-03[build]" not in failing(rep)
    assert build_row(rep)["verdict"] == "pass" and build_row(rep)["measured"] == 0
    assert build_row(rep)["extra"]["pairs"] == 4 and build_row(rep)["extra"]["intersected"] == 0


def test_one_build_item_has_no_build_row(tetra):
    code, rep = run_json("--export", "--overlap", tetra)
    assert code == 0 and not [r for r in rep["results"] if r["target"].get("path") == v.ROOT_MODEL + "#build"]


def test_open_mesh_fails_topology(tetra, tmp_path):
    f = rewrite(tetra, tmp_path / "open.3mf", model_edit(rb"<triangle [^>]*/>", b"", ))
    code, rep = run_json("--export", f)
    assert code == 1 and "CHK-PRT-01[topology]" in failing(rep)


def test_open_part_fails_overlap_in_roundtrip(tetra, tmp_path):
    """manifold3d turns an open part into an empty solid that intersects nothing; it must fail, not pass."""
    def drop_one(name, data):
        return re.sub(rb"<triangle [^>]*/>", b"", data, count=1) if name == v.ROOT_MODEL else data
    f = rewrite(tetra, tmp_path / "open-part.3mf", drop_one)
    code, rep = run_json("--roundtrip", "--overlap", f)
    assert code == 1 and "CHK-PRT-03" in failing(rep)
    assert "is not manifold" in first_of(rep, "CHK-PRT-03")
    code, rep = run_json("--export", "--overlap", f)
    assert code == 1 and "CHK-PRT-03" in failing(rep)


# ------------------------------------------------------------------ zip limits (D-166)
def gold_plus(dst, extra):
    """The gold with extra entries appended; extra(zo) writes them."""
    zi = zipfile.ZipFile(GOLD)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
        for info in zi.infolist():
            zo.writestr(info, zi.read(info.filename))
        extra(zo)
    return dst


@pytest.mark.parametrize("name", ["../../evil.txt", "a/../../evil.txt", "/abs.txt", "\\abs.txt", "C:/win.txt", "c:evil.txt"])
def test_unsafe_entry_name_exits_2(tmp_path, name):
    f = gold_plus(tmp_path / "traversal.3mf", lambda zo: zo.writestr(name, b"x"))
    assert name in [i.filename for i in zipfile.ZipFile(f).infolist()]
    code, out, err = run("--roundtrip", f)
    assert code == 2, out + err
    assert "E_SCHEMA" in err and "D-166" in err and "drive letter" in err


def test_safe_dotted_names_pass_the_name_rule():
    for name in ("Metadata/..config", "a..b/c", "3D/Objects/x..model", "_rels/.rels"):
        assert not v.UNSAFE_NAME.search(name), name


def test_too_many_entries_exits_2(tmp_path):
    def many(zo):
        for i in range(v.ZIP_MAX_ENTRIES):
            zo.writestr("Metadata/pad/%05d.txt" % i, b"")
    f = gold_plus(tmp_path / "many.3mf", many)
    code, out, err = run("--roundtrip", f)
    assert code == 2 and "E_SCHEMA" in err and "at most 4096" in err


def test_entry_count_is_refused_before_zipfile_parses_the_directory(tmp_path, monkeypatch):
    """The central directory is walked first, so no ZipInfo is built for an oversize zip."""
    def many(zo):
        for i in range(v.ZIP_MAX_ENTRIES):
            zo.writestr("Metadata/pad/%05d.txt" % i, b"")
    f = gold_plus(tmp_path / "many.3mf", many)
    made = []
    real = v.zipfile.ZipFile
    monkeypatch.setattr(v.zipfile, "ZipFile", lambda *a, **k: made.append(a) or real(*a, **k))
    with pytest.raises(v.InputError, match="more than 4096 entries"):
        v.open_package(f)
    assert made == []
    assert v._preflight_central(GOLD) == len(zipfile.ZipFile(GOLD).infolist())


def test_preflight_reads_a_zip_with_prepended_bytes_as_zipfile_does(tmp_path):
    f = tmp_path / "prefixed.3mf"
    f.write_bytes(b"x" * 1000 + Path(GOLD).read_bytes())
    assert v._preflight_central(f) == len(zipfile.ZipFile(f).infolist())


def test_inflation_bomb_exits_2_while_inflating(tmp_path):
    """A 300 MiB member of zeros deflates to about 300 KB; the read stops at the cap."""
    def bomb(zo):
        with zo.open("Metadata/bomb.bin", "w", force_zip64=True) as fh:
            block = bytes(2 ** 20)
            for _ in range(300):
                fh.write(block)
    f = gold_plus(tmp_path / "bomb.3mf", bomb)
    assert f.stat().st_size < 2 * 2 ** 20
    code, out, err = run("--roundtrip", f)
    assert code == 2 and "E_SCHEMA" in err and "inflated size passes %d" % v.ZIP_MAX_INFLATED in err


def test_bad_crc_exits_2(tmp_path):
    f = gold_plus(tmp_path / "crc.3mf", lambda zo: zo.writestr(zipfile.ZipInfo("Metadata/note.txt"), b"hello world"))
    raw = bytearray(f.read_bytes())
    at = raw.rfind(b"hello world")
    raw[at] ^= 0xFF
    f.write_bytes(bytes(raw))
    code, out, err = run("--roundtrip", f)
    assert code == 2 and "corrupt at Metadata/note.txt" in err


def test_stl_zip_passes_the_same_rules(tetra, tmp_path):
    stl = tmp_path / "evil.zip"
    with zipfile.ZipFile(stl, "w") as z:
        z.writestr("../tetra-left.stl", b"solid\n")
        z.writestr("tetra-right.stl", b"solid\n")
    code, out, err = run("--export", tetra, "--stl-zip", stl)
    assert code == 2 and "E_SCHEMA" in err


# ------------------------------------------------------------------ exit codes and modules
def test_prusa_target_exits_2():
    code, out, err = run("--target", "prusa", GOLD)
    assert code == 2 and "target prusa not built in M00" in err


def test_unreadable_input_exits_2(tmp_path):
    bad = tmp_path / "not.3mf"
    bad.write_bytes(b"not a zip")
    assert run(bad)[0] == 2
    assert run(tmp_path / "absent.3mf")[0] == 2
    assert run("--roundtrip", "--stl-zip", bad, GOLD)[0] == 2


def test_missing_declared_module_exits_70(tmp_path):
    """A declared module that does not import is an internal error, never a skipped check (D-153)."""
    (tmp_path / "trimesh.py").write_text("raise ImportError('blocked for the test')\n")
    env = dict(os.environ, PYTHONPATH=str(tmp_path))
    p = subprocess.run([sys.executable, str(REPO / "py/hackbuild_3mf/validate_3mf.py"), "--json", str(GOLD)],
                       capture_output=True, text=True, cwd=REPO, env=env)
    assert p.returncode == 70
    assert json.loads(p.stdout)["error"]["kind"] == "internal"


def test_lib3mf_rule_reports_not_run_without_a_wheel(tetra, monkeypatch):
    monkeypatch.setattr(v, "lib3mf_available", lambda: False)
    rep = v.validate(tetra, "export").as_json()
    lib = [r for r in rep["results"] if r["id"] == "CHK-PRT-01" and r["verdict"] == "skip"]
    assert lib and "not run" in lib[0]["constraint"] and lib[0]["measured"] == "not run"


def test_versions_come_from_the_seed_registry():
    rows = {r["id"]: r for r in json.loads((REPO / "py/hackbuild_3mf/data/checks.seed.json").read_text())["checks"]}
    rep = v.validate(GOLD, "roundtrip").as_json()
    for r in rep["results"]:
        assert r["version"] == rows[r["id"]]["version"] and r["severity"] == rows[r["id"]]["severity"]


def test_stacked_items_corpus_fixture_fails_only_the_build_rule():
    """tools/corpus/3mf/known-bad/overlap-stacked-items.3mf: the gold coin's one build item copied onto
    itself. Before the build rule CHK-PRT-03 compared parts inside one object only and passed it."""
    fx = KNOWN_BAD / "overlap-stacked-items.3mf"
    assert fx.is_file(), "the stacked fixture is tracked; make_known_bad.py writes it"
    code, rep = run_json("--roundtrip", "--overlap", fx)
    assert code == 1 and failing(rep) == ["CHK-PRT-03[build]"]
    row = build_row(rep)
    assert row["extra"]["items"] == 2 and row["extra"]["pairs"] > 0 and row["measured"] > 1000
