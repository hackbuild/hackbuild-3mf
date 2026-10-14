#!/usr/bin/env python3
"""
make_known_bad.py: the synthetic known-bad fixtures of the 3MF corpus (M00-T10 step 3).

    uv run --project py corpus/make_known_bad.py [--check]

Each fixture is the gold Flash Studio save with one edit. The script writes
the fixture under known-bad/ and records, in the fixture's manifest row, the
sha256 of the source it read, the edit, and the sha256 of what it wrote.
--check rebuilds in memory and exits 1 when a fixture or its row drifted.

The CASK empty plate and the TENON names fixture are owner files copied
unchanged, so they are not made here.
"""
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"
GOLD_ID = "gold"
ROOT_MODEL = "3D/3dmodel.model"
PROJECT_SETTINGS = "Metadata/project_settings.config"


def _sha(b):
    return hashlib.sha256(b).hexdigest()


def _missing_part(name, data):
    if name != ROOT_MODEL:
        return data
    return re.sub(rb'p:path="[^"]*"', b'p:path="/3D/Objects/missing.model"', data)


def _open_part(name, data):
    """The first triangle of the object sub-model removed, so the part is open (CHK-PRT-03 under --overlap)."""
    if not name.startswith("3D/Objects/"):
        return data
    return re.sub(rb"<triangle [^>]*/>", b"", data, count=1)


def _stacked_item(name, data):
    """The one build item copied onto itself: two copies of the coin at one spot (CHK-PRT-03 build rule
    under --overlap). A plate places each copy as its own build item (M07-T08), so the per-object rule
    alone passes this file."""
    if name != ROOT_MODEL:
        return data
    item = re.search(rb'<item objectid="4"[^>]*/>', data).group(0)
    copy = item.replace(b"00000004-b1ec", b"00000005-b1ec")
    return data.replace(item, item + b"\n  " + copy)


def _overhang(values):
    def edit(name, data):
        if name != PROJECT_SETTINGS:
            return data
        ps = json.loads(data)
        ps["overhang_fan_threshold"] = values
        return json.dumps(ps, indent=4).encode("utf-8")
    return edit


# id -> (edit applied to every entry, the edit as recorded in the manifest)
FIXTURES = {
    "known-bad/gold-missing-part": (_missing_part, "every component p:path in 3D/3dmodel.model set to /3D/Objects/missing.model"),
    "known-bad/overhang-numeric": (_overhang([95, 10, 10]), "overhang_fan_threshold set to JSON numbers [95, 10, 10]"),
    "known-bad/overhang-bare": (_overhang(["95", "10", "10"]), 'overhang_fan_threshold set to bare strings ["95", "10", "10"]'),
    "known-bad/overlap-open-part": (_open_part, "the first triangle of 3D/Objects/hackbuild-coin-nfc_2.model removed, so the part is open"),
    "known-bad/overlap-stacked-items": (_stacked_item, "the build item of object 4 copied with the same transform, so two coins stack"),
}


def rewrite(src_bytes, edit):
    """The source zip with each entry passed through edit; entry order, dates and compression kept."""
    zi = zipfile.ZipFile(io.BytesIO(src_bytes))
    out = io.BytesIO()
    changed = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for info in zi.infolist():
            data = zi.read(info.filename)
            new = edit(info.filename, data)
            changed += new != data
            zo.writestr(info, new)
    if changed != 1:
        raise SystemExit("make_known_bad: the edit changed %d entries, expected 1" % changed)
    return out.getvalue()


def main(argv):
    check = "--check" in argv
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows = {r["id"]: r for r in manifest["rows"]}
    gold = rows[GOLD_ID]
    src = (HERE / gold["path"]).read_bytes()
    if _sha(src) != gold["sha256"]:
        raise SystemExit("make_known_bad: %s sha256 differs from its manifest row" % gold["path"])
    drift = []
    for rid, (edit, text) in FIXTURES.items():
        row = rows[rid]
        data = rewrite(src, edit)
        want = {"sha256": _sha(data), "sourceSha256": gold["sha256"], "edit": text}
        dest = HERE / row["path"]
        if check:
            if not dest.is_file() or dest.read_bytes() != data or any(row.get(k) != v for k, v in want.items()):
                drift.append(rid)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        row.update(want)
        print("%s: %d bytes, sha256 %s, from %s (%s)" % (row["path"], len(data), want["sha256"][:12], gold["path"], text))
    if check:
        for rid in drift:
            print("make_known_bad: %s drifted from its source or its manifest row" % rid)
        return 1 if drift else 0
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
