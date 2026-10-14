"""The split stands alone: data copies equal the js package, entry points resolve."""
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PY = REPO / "py/hackbuild_3mf"
sys.path.insert(0, str(PY))


def test_data_equals_the_js_package():
    for name, js in (("filament_template.json", "js/data/filament_template.json"),
                     ("filament_presets.json", "js/data/filament_presets.json"),
                     ("default_preset.json", "js/data/default_preset.json"),
                     ("materials.json", "js/seed/materials.json")):
        assert (PY / "data" / name).read_bytes() == (REPO / js).read_bytes(), name


def test_check_rows_cover_every_id_the_validator_emits():
    import validate_3mf as v
    rep = v.validate(REPO / "corpus/gold/hackbuild-coin-nfc.3mf", "roundtrip").as_json()
    rows = {r["id"] for r in json.loads((PY / "data/checks.seed.json").read_text())["checks"]}
    assert {r["id"] for r in rep["results"]} <= rows | {"CHK-ART-01"}


def test_no_path_reaches_outside_the_split():
    for f in PY.glob("*.py"):
        src = f.read_text(encoding="utf-8")
        assert "packages/" not in src.replace("packages/3mf", ""), f.name
        assert "tools/py" not in src.replace("tools/py/pyproject", ""), f.name


def test_no_test_opens_a_fab_path():
    """A test copied from fab that still opens a fab path fails or passes on nothing here."""
    for f in (REPO / "py/tests").glob("*.py"):
        src = f.read_text(encoding="utf-8")
        for top in ("tools/", "packages/", "spec/", "core/"):
            assert 'REPO / "' + top not in src, f"{f.name} opens {top} of hackbuild-fab"
    for f in (REPO / "js/test").glob("*.ts"):
        assert '"../../../' not in f.read_text(encoding="utf-8"), f"{f.name} reaches above the repo root"


def test_preset_saves_resolve_inside_the_repo():
    """check:presets runs in CI, so every save it reads is a repo path that exists."""
    files = (REPO / "js/scripts/harvest-presets.mjs", REPO / "js/data/filament_presets.json",
             PY / "data/filament_presets.json")
    for f in files:
        assert "/Users/" not in f.read_text(encoding="utf-8"), f"{f.name} names a path on one machine"
    for src in json.loads((REPO / "js/data/filament_presets.json").read_text())["sources"]:
        assert not Path(src["file"]).is_absolute(), src["file"]
        assert (REPO / src["file"]).is_file(), src["file"]


def test_entry_point_prints_usage():
    p = subprocess.run([sys.executable, "-c", "import hackbuild_3mf.validate_3mf as m; m.cli()", "--help"],
                       capture_output=True, text=True, cwd=REPO / "py")
    assert p.returncode == 0 and "validate a 3MF" in p.stdout, p.stdout + p.stderr
