#!/usr/bin/env python3
"""Resumable FCC/Esri H3 extraction. No live website calls or paid APIs.
Usage:
  python broadband-intelligence/arcgis_extract.py inspect
  python broadband-intelligence/arcgis_extract.py extract --layer 5 --db data/arcgis.sqlite --max-pages 2
  python broadband-intelligence/arcgis_extract.py extract --layer 6 --db data/arcgis.sqlite --max-pages 2
  python broadband-intelligence/arcgis_extract.py export --layer 5 --db data/arcgis.sqlite --output data/h3_coverage.csv
"""
import argparse
import csv
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE = os.environ.get(
    "ARCGIS_FCC_SERVICE",
    "https://services8.arcgis.com/peDZJliSvYims39Q/ArcGIS/rest/services/"
    "FCC_Broadband_Data_Collection_December_2024_View/FeatureServer",
).rstrip("/")
# The legacy-named /2024_View currently exposes the December 2025 source.
# Always inspect the metadata and verify release before running a nationwide job.
FIELDS = {
    5: [
        "OBJECTID", "GEOID", "TotalBSLs", "ServedBSLs", "UnderservedBSLs",
        "UnservedBSLs", "UniqueProviders", "UniqueProvidersFiber",
        "UniqueProvidersCable", "ServedBSLsFiber", "ServedBSLsCable",
        "ServedBSLsLTFW", "ServedBSLsFiber_6monthPrevious",
        "ServedBSLsFiber_12monthPrevious", "ServedBSLsCable_6monthPrevious",
        "ServedBSLsCable_12monthPrevious", "ServedBSLs_6monthPrevious",
        "ServedBSLs_12monthPrevious"
    ],
    6: [
        "OBJECTID", "GEOID", "ProviderName", "FRN", "Technology", "TotalBSLs",
        "ServedBSLs", "UnderservedBSLs", "UnservedBSLs"
    ],
}

def arcgis_json(url, params=None, tries=5):
    query = urllib.parse.urlencode(params or {})
    link = url + (("?" + query) if query else "")
    for attempt in range(tries):
        try:
            req = urllib.request.Request(link, headers={"User-Agent": "Internet4ALL-Research/1.0"})
            with urllib.request.urlopen(req, timeout=90) as res:
                data = json.load(res)
            if "error" in data:
                raise RuntimeError(f"ArcGIS API error: {data['error']}")
            return data
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == tries - 1:
                raise RuntimeError(f"Failed after {tries} attempts: {link}") from exc
            time.sleep(min(2 ** attempt, 16))
    raise RuntimeError("Unreachable")

def metadata(layer):
    obj = arcgis_json(f"{SERVICE}/{layer}", {"f": "json"})
    available = {f["name"] for f in obj.get("fields", [])}
    missing = set(FIELDS[layer]) - available
    if missing:
        raise RuntimeError(f"ArcGIS schema changed, required fields missing: {sorted(missing)}")
    return obj

def make_db(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS records (
      layer INTEGER NOT NULL, oid INTEGER NOT NULL, attrs TEXT NOT NULL,
      PRIMARY KEY(layer, oid))""")
    db.execute("""CREATE TABLE IF NOT EXISTS source_meta (
      layer INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, detail TEXT NOT NULL)""")
    db.commit()
    return db

def fingerprint(meta, release):
    # An explicit release label is essential: a re-pointed ArcGIS view must not
    # silently resume an extraction based on a different reporting snapshot.
    return json.dumps({
        "release_user_confirmed": release,
        "service_item": meta.get("serviceItemId"),
        "schema_edit": meta.get("editingInfo", {}).get("schemaLastEditDate"),
        "data_edit": meta.get("editingInfo", {}).get("dataLastEditDate"),
        "field_names": sorted(f["name"] for f in meta.get("fields", []))
    }, sort_keys=True)

def check_source(db, layer, meta, release):
    stamp = fingerprint(meta, release)
    existing = db.execute("SELECT fingerprint FROM source_meta WHERE layer=?", (layer,)).fetchone()
    if existing and existing[0] != stamp:
        raise RuntimeError("ArcGIS source changed: use a NEW SQLite database for the new release")
    if not existing:
        db.execute("INSERT INTO source_meta VALUES (?,?,?)", (
            layer, stamp, json.dumps({"url": SERVICE, "layer": layer, "release": release})
        ))
        db.commit()

def extract(layer, dbpath, release, batch, max_pages):
    info = metadata(layer)
    db = make_db(dbpath)
    check_source(db, layer, info, release)
    last = db.execute("SELECT COALESCE(MAX(oid),0) FROM records WHERE layer=?", (layer,)).fetchone()[0]
    added = 0
    page = 0
    while max_pages is None or page < max_pages:
        result = arcgis_json(f"{SERVICE}/{layer}/query", {
            "f": "json", "where": f"OBJECTID > {last}",
            "outFields": ",".join(FIELDS[layer]),
            "orderByFields": "OBJECTID ASC", "resultRecordCount": batch,
            "returnGeometry": "false", "sqlFormat": "standard"
        })
        features = result.get("features", [])
        if not features:
            break
        ids = []
        rows = []
        for entry in features:
            attrs = entry["attributes"]
            oid = int(attrs["OBJECTID"])
            if oid <= last:
                raise RuntimeError("Non-monotonic or repeated ArcGIS OBJECTID; stopped to prevent data loss")
            ids.append(oid)
            rows.append((layer, oid, json.dumps(attrs, separators=(",", ":"))))
        if ids != sorted(set(ids)):
            raise RuntimeError("Duplicate or out-of-order IDs received")
        with db:
            db.executemany("INSERT OR IGNORE INTO records(layer,oid,attrs) VALUES(?,?,?)", rows)
        last = ids[-1]
        added += len(rows)
        page += 1
        print(f"layer={layer} pages={page} fetched={added} last_oid={last}", flush=True)
        if len(features) < batch and not result.get("exceededTransferLimit", False):
            break
    count = db.execute("SELECT COUNT(*) FROM records WHERE layer=?", (layer,)).fetchone()[0]
    print(json.dumps({"layer": layer, "total_saved": count, "this_run": added, "next_oid": last}))
    db.close()

def export_rows(layer, dbpath, output):
    db = sqlite3.connect(dbpath)
    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS[layer], extrasaction="ignore")
        writer.writeheader()
        for (attrs,) in db.execute("SELECT attrs FROM records WHERE layer=? ORDER BY oid", (layer,)):
            writer.writerow(json.loads(attrs))
            n += 1
    print(json.dumps({"export": str(out), "layer": layer, "rows": n}))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="cmd", required=True)
    inspect = subs.add_parser("inspect")
    inspect.add_argument("--layer", type=int, choices=[5, 6])
    run = subs.add_parser("extract")
    run.add_argument("--layer", type=int, choices=[5, 6], required=True)
    run.add_argument("--db", default="data/arcgis.sqlite")
    run.add_argument("--release", default="2025-12-31")
    run.add_argument("--batch", type=int, default=1000)
    run.add_argument("--max-pages", type=int, default=None)
    exp = subs.add_parser("export")
    exp.add_argument("--layer", type=int, choices=[5, 6], required=True)
    exp.add_argument("--db", default="data/arcgis.sqlite")
    exp.add_argument("--output", required=True)
    a = parser.parse_args()
    if a.cmd == "inspect":
        for lay in ([a.layer] if a.layer else [5, 6]):
            m = metadata(lay)
            print(json.dumps({"layer": lay, "name": m.get("name"),
                              "serviceItemId": m.get("serviceItemId"),
                              "last_edit": m.get("editingInfo"),
                              "required_fields": FIELDS[lay]}, indent=2))
    elif a.cmd == "extract":
        if not 1 <= a.batch <= 2000:
            parser.error("--batch must be 1..2000")
        extract(a.layer, a.db, a.release, a.batch, a.max_pages)
    elif a.cmd == "export":
        export_rows(a.layer, a.db, a.output)

if __name__ == "__main__":
    main()
