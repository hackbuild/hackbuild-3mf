"""M00-T08 step 4 (D-159): the harvester classifies by template membership.

It refuses when the filament count equals the extruder count and whenever a
key outside the template has length N without a person's decision. The
gold (3 filaments on 4 extruders) reproduces the template; the two-slot
save and the four-slot save are refused. Owner saves under evidence/x are
used where present; a missing one skips its test and the skip is reported.
"""
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py/hackbuild_3mf"))
import harvest_filament_keys as hk  # noqa: E402

TOOL = REPO / "py/hackbuild_3mf/harvest_filament_keys.py"
GOLD = REPO / "corpus/gold/hackbuild-coin-nfc.3mf"
X = Path("/Users/obsidian/Projects/hackbuild/fab-knowledge/evidence/x/downloads/dl-gudgeon-tang-keyway")
TWO_SLOT = X / "gib/gib-finger-rigid-200x14.3mf"
FOUR_SLOT = X / "feeler/feeler-ladder (2).3mf"
TEMPLATE = hk.load_json(hk.TEMPLATE_PATH)


def run(*args):
    return subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True)


def need(path):
    if not path.exists():
        pytest.skip("owner save not present: %s" % path)
    return path


def settings(path):
    return hk.read_settings(path)[0]


def test_gold_reproduces_the_template(tmp_path):
    out = tmp_path / "t.json"
    r = run(GOLD, "--machine", "ffc5p", "-o", out)
    assert r.returncode == 0, r.stdout + r.stderr
    got = json.loads(out.read_text())
    assert got["filamentCount"] == 3
    assert got["keys"] == TEMPLATE["keys"]
    assert got["computed"] == TEMPLATE["computed"]


def test_classification_is_by_membership_only():
    ps = settings(GOLD)
    n = len(ps["filament_colour"])
    ps = dict(ps, made_up_vector=["a"] * n)
    res = hk.harvest(ps, TEMPLATE["keys"], 4)
    assert res["refused"] and res["candidates"] == ["made_up_vector"]
    assert "made_up_vector" not in res["perFilament"]
    accepted = hk.harvest(ps, TEMPLATE["keys"], 4, accept=["made_up_vector"])
    assert not accepted["refused"] and "made_up_vector" in accepted["perFilament"]
    rejected = hk.harvest(ps, TEMPLATE["keys"], 4, reject=["made_up_vector"])
    assert not rejected["refused"] and "made_up_vector" not in rejected["perFilament"]
    assert len(rejected["perFilament"]) == len(TEMPLATE["keys"])


def test_refuses_when_filament_count_equals_extruder_count():
    ps = settings(GOLD)
    res = hk.harvest(ps, TEMPLATE["keys"], len(ps["filament_colour"]))
    assert res["refused"]
    assert any("equals extruder count" in r for r in res["reasons"])


def test_refuses_a_one_filament_save(tmp_path):
    ps = settings(GOLD)
    one = {k: (v[:1] if isinstance(v, list) else v) for k, v in ps.items()}
    path = tmp_path / "one.3mf"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("Metadata/project_settings.config", json.dumps(one))
    r = run(path, "--machine", "ffc5p", "--json")
    assert r.returncode == 1
    res = json.loads(r.stdout)
    assert res["filamentCount"] == 1 and res["lengthN"] > len(TEMPLATE["keys"])
    assert res["refused"] and res["candidates"]


def test_two_slot_save_is_refused_until_a_person_decides():
    path = need(TWO_SLOT)
    r = run(path, "--machine", "ffc5p", "--json")
    assert r.returncode == 1
    res = json.loads(r.stdout)
    assert res["filamentCount"] == 2
    assert res["lengthN"] - len(TEMPLATE["keys"]) == len(res["candidates"])
    rejects = [a for k in res["candidates"] for a in ("--reject", k)]
    r2 = run(path, "--machine", "ffc5p", "--json", *rejects)
    assert r2.returncode == 0, r2.stdout + r2.stderr
    assert json.loads(r2.stdout)["perFilament"] == sorted(TEMPLATE["keys"])


def test_four_slot_save_on_four_extruders_is_refused():
    r = run(need(FOUR_SLOT), "--machine", "ffc5p", "--json")
    assert r.returncode == 1
    res = json.loads(r.stdout)
    assert res["filamentCount"] == res["extruderCount"] == 4
    assert any("equals extruder count" in x for x in res["reasons"])


def test_input_errors_exit_two(tmp_path):
    bad = tmp_path / "bad.3mf"
    bad.write_bytes(b"not a zip")
    assert run(bad).returncode == 2
    empty = tmp_path / "empty.3mf"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("3D/3dmodel.model", "")
    assert run(empty).returncode == 2
    assert run(GOLD, "--accept", "x", "--reject", "x").returncode == 2


@pytest.mark.parametrize("name", ["../../evil.txt", "/abs.txt", "C:/win.txt"])
def test_harvester_refuses_an_unsafe_entry_name(tmp_path, name):
    """harvest_filament_keys opens zips through validate_3mf.open_package (D-166, ARCHITECTURE 11.1)."""
    path = tmp_path / "traversal.3mf"
    src = zipfile.ZipFile(GOLD)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            z.writestr(info, src.read(info.filename))
        z.writestr(name, b"x")
    r = run(path, "--machine", "ffc5p")
    assert r.returncode == 2 and "E_SCHEMA" in r.stderr and "D-166" in r.stderr, r.stderr
