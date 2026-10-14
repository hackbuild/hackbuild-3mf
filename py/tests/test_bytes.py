"""M00-T08 steps 1, 2 and 5: the Python writer reproduces its own bytes.

Two runs with one SOURCE_DATE_EPOCH give equal sha256 of the .3mf bytes, in
one process, across processes started at different times and across host
time zones. Each zip entry carries the epoch as a UTC mtime, create_system
3, mode 0644, DEFLATE at level 6, sorted names and no directory entries.
"""
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py/hackbuild_3mf"))
import orca3mf  # noqa: E402

EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH") or 1791072000)
TETRA = REPO / "corpus/inputs/tetra-2part.json"
VOLUME_LINE = re.compile(r"^volume check: parts (\d+\.\d{3}) vs solid (\d+\.\d{3}) mm3$", re.M)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def tetra_bytes(epoch=EPOCH):
    with open(TETRA, encoding="utf-8") as fh:
        return orca3mf.from_input(json.load(fh), source_date_epoch=epoch).zip_bytes()


def runner():
    uv = shutil.which("uv")
    return [uv, "run", "--project", str(REPO / "py"), "python"] if uv else [sys.executable]


def test_two_runs_equal_sha256():
    assert sha(tetra_bytes()) == sha(tetra_bytes())


def test_two_processes_and_two_time_zones_equal_sha256(tmp_path):
    code = ("import json,sys; sys.path.insert(0, %r); import orca3mf; "
            "w = orca3mf.from_input(json.load(open(%r)), source_date_epoch=%d); "
            "import hashlib; sys.stdout.write(hashlib.sha256(w.zip_bytes()).hexdigest())") % (str(REPO / "py/hackbuild_3mf"), str(TETRA), EPOCH)
    out = []
    for tz in ("UTC", "America/Phoenix"):
        env = dict(os.environ, TZ=tz)
        r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        out.append(r.stdout)
    assert out[0] == out[1] == sha(tetra_bytes())


def test_zip_layout():
    z = zipfile.ZipFile(io.BytesIO(tetra_bytes()))
    infos = z.infolist()
    names = [i.filename for i in infos]
    assert names == sorted(names)
    assert not any(n.endswith("/") for n in names)
    stamp = datetime.datetime.fromtimestamp(EPOCH, tz=datetime.timezone.utc).timetuple()[:6]
    for i in infos:
        assert i.date_time == tuple(stamp[:5]) + (stamp[5] // 2 * 2,)
        assert i.create_system == 3
        assert i.external_attr == 0o644 << 16
        assert i.compress_type == zipfile.ZIP_DEFLATED
    assert set(names) == {
        "3D/3dmodel.model", "Metadata/filament_sequence.json", "Metadata/hackbuild_chase.json",
        "Metadata/model_settings.config", "Metadata/project_settings.config", "Metadata/slice_info.config",
        "[Content_Types].xml", "_rels/.rels",
    }


def test_deflate_level_six():
    import zlib
    entries = orca3mf.from_input(json.load(open(TETRA, encoding="utf-8")), source_date_epoch=EPOCH).entries()
    z = zipfile.ZipFile(io.BytesIO(tetra_bytes()))
    raw = z.fp.getvalue()
    for info in z.infolist():
        start = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        stored = raw[start:start + info.compress_size]
        c = zlib.compressobj(6, zlib.DEFLATED, -15)
        assert stored == c.compress(entries[info.filename]) + c.flush(), info.filename


# The date literal below belongs to this epoch, so the test passes it itself
# instead of reading SOURCE_DATE_EPOCH: a shell that exports 315532800 (the
# builder pin) otherwise failed this test while every other test passed.
DATED_EPOCH = 1791072000  # s, 2026-10-04T00:00:00Z


def test_dates_come_from_the_epoch_and_clamp_at_1980():
    model = orca3mf.from_input(json.load(open(TETRA, encoding="utf-8")), source_date_epoch=DATED_EPOCH).entries()["3D/3dmodel.model"].decode()
    assert '<metadata name="CreationDate">2026-10-04</metadata>' in model
    assert '<metadata name="ModificationDate">2026-10-04</metadata>' in model
    early = zipfile.ZipFile(io.BytesIO(tetra_bytes(0)))
    assert early.infolist()[0].date_time == (1980, 1, 1, 0, 0, 0)
    assert orca3mf.iso_day(0) == "1980-01-01"


# The one-off failure of the test above came from the shell, not from load:
# a builder shell that exports the pin 315532800 handed it 1980-01-01 while a
# shell without the export passed it. This guard reruns it in fresh
# interpreters under each ambient value, so a dated literal that reads the
# environment again fails here every time, whichever shell runs the suite.
@pytest.mark.parametrize("ambient", [None, "315532800", "0", "4102444800"])
def test_dated_literals_ignore_the_ambient_epoch(ambient):
    env = {k: v for k, v in os.environ.items() if k != "SOURCE_DATE_EPOCH"}
    if ambient is not None:
        env["SOURCE_DATE_EPOCH"] = ambient
    node = "%s::test_dates_come_from_the_epoch_and_clamp_at_1980" % Path(__file__).resolve()
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", node],
                       cwd=REPO, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]


def test_artifact_hash_holds_across_epochs():
    a = orca3mf.from_input(json.load(open(TETRA, encoding="utf-8")), source_date_epoch=EPOCH).artifact_hash()
    b = orca3mf.from_input(json.load(open(TETRA, encoding="utf-8")), source_date_epoch=EPOCH + 86400 * 400).artifact_hash()
    assert a == b


def test_no_clock_in_the_writer():
    src = (REPO / "py/hackbuild_3mf/orca3mf.py").read_text(encoding="utf-8")
    assert not re.search(r"\b(?:date\.today|datetime\.now|datetime\.utcnow|time\.time|time\.localtime)\s*\(", src)

