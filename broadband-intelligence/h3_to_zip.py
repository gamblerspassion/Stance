#!/usr/bin/env python3
"""Create nationwide 2020-ZCTA summaries from the verified ArcGIS H3 coverage extract.

Method: H3 cell CENTROID within simplified Census 2020 ZCTA polygon. This is a
geographic approximation, not an address lookup or exact ZIP-boundary estimate.
Never add per-H3 unique provider counts to suggest distinct ZIP providers.
"""
import argparse
import csv
import gzip
import json
import math
import pathlib
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from statistics import mean

import h3
import numpy as np
import geopandas as gpd
from shapely import STRtree, points

BOUNDARY_URL=("https://www2.census.gov/geo/tiger/GENZ2020/shp/"
              "cb_2020_us_zcta520_500k.zip")
SUM_FIELDS=[
 "TotalBSLs","ServedBSLs","UnderservedBSLs","UnservedBSLs",
 "ServedBSLsFiber","ServedBSLsCable","ServedBSLsLTFW",
 "ServedBSLsFiber_6monthPrevious","ServedBSLsFiber_12monthPrevious",
 "ServedBSLsCable_6monthPrevious","ServedBSLsCable_12monthPrevious",
 "ServedBSLs_6monthPrevious","ServedBSLs_12monthPrevious"
]
METRICS={f:i for i,f in enumerate(SUM_FIELDS)}
COUNTS=len(SUM_FIELDS)
FORMS=["UniqueProviders","UniqueProvidersFiber","UniqueProvidersCable"]

def get_boundary(path):
    if path.exists():return
    path.parent.mkdir(parents=True,exist_ok=True)
    req=urllib.request.Request(BOUNDARY_URL,headers={"User-Agent":"Internet4ALL/1.0"})
    with urllib.request.urlopen(req,timeout=180) as res, open(path,"wb") as fout:
        while True:
            buf=res.read(1024*1024)
            if not buf: break
            fout.write(buf)

def init_geography(path):
    g=gpd.read_file(path)
    if "ZCTA5CE20" not in g.columns:
        raise RuntimeError(f"ZCTA boundary file lacks expected ZCTA5CE20 column: {list(g.columns)}")
    if g.crs is None: raise RuntimeError("ZCTA file missing CRS")
    g=g.to_crs("EPSG:4326")
    g=g[g.geometry.notna() & ~g.geometry.is_empty].copy().reset_index(drop=True)
    return STRtree(list(g.geometry)), g["ZCTA5CE20"].astype(str).str.zfill(5).tolist(),len(g)

def val(text):
    if text is None or text=="":return 0.0
    return float(text)

def process(rows, tree, zips, totals, means, maxs, outfile, audit):
    lats=[];lons=[];valid=[]
    for i,r in enumerate(rows):
        try:
            la,lo=h3.cell_to_latlng(r["GEOID"])
            lats.append(la);lons.append(lo);valid.append(i)
        except Exception:
            audit["invalid_h3"]+=1
    coords=points(np.asarray(lons,dtype=float),np.asarray(lats,dtype=float))
    pair=tree.query(coords,predicate="within")
    # Many ZCTAs have non-overlapping polygons; select deterministically
    match={}
    for p,poly in zip(pair[0],pair[1]):
        src=valid[int(p)]
        zp=zips[int(poly)]
        if src in match:
            audit["ambiguous_h3"]+=1
            if zp<match[src]:match[src]=zp
        else:match[src]=zp
    for i,r in enumerate(rows):
        audit["source_cells"]+=1
        try:base=val(r.get("TotalBSLs"))
        except (ValueError,TypeError):base=0
        audit["source_bsls"]+=base
        zp=match.get(i)
        if zp is None:
            audit["unmapped_cells"]+=1
            audit["unmapped_bsls"]+=base
            continue
        accum=totals[zp]
        audit["mapped_cells"]+=1
        audit["mapped_bsls"]+=base
        accum["h3_cells"]+=1
        measures=accum["sum"]
        for k in SUM_FIELDS:
            try:measures[METRICS[k]]+=val(r.get(k))
            except (ValueError,TypeError):pass
        # Provider counts are cell-wise (not necessarily unique across cells).
        for name in FORMS:
            value=r.get(name)
            if value is not None and value!="":
                n=int(float(value))
                maxs[zp][name]=max(n,maxs[zp].get(name,0))
                means[zp][name][0]+=n*base
                means[zp][name][1]+=base
        outfile.writerow([r["GEOID"],zp,r["TotalBSLs"]])

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input",required=True,help="directory containing verified layer5 *.csv.gz and COMPLETE manifest")
    p.add_argument("--output",default="data/zip_analytics")
    p.add_argument("--boundary",default="data/census_cb_2020_us_zcta520_500k.zip")
    p.add_argument("--batch",type=int,default=25000)
    a=p.parse_args()
    source=pathlib.Path(a.input)
    out=pathlib.Path(a.output)
    out.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((source/"layer5_COMPLETE_manifest.json").read_text())
    if manifest.get("status")!="COMPLETE":raise RuntimeError("Layer 5 source is not verified complete")
    files=[source/x["file"] for x in manifest["partitions"]]
    for f in files:
        if not f.exists():raise RuntimeError("Missing verified source partition: "+str(f))
    boundary=pathlib.Path(a.boundary)
    get_boundary(boundary)
    tree,zips,zctacount=init_geography(boundary)
    totals=defaultdict(lambda:{"h3_cells":0,"sum":[0.0]*COUNTS})
    means=defaultdict(lambda:defaultdict(lambda:[0.,0.]))
    maxs=defaultdict(dict)
    audit=defaultdict(float)
    crosswalk=out/"h3_to_zcta_centroid_approx.csv.gz"
    with gzip.open(crosswalk,"wt",encoding="utf8",newline="",compresslevel=5) as wh:
        writer=csv.writer(wh)
        writer.writerow(["h3_cell","zcta_2020","h3_total_bsls"])
        for filename in files:
            with gzip.open(filename,"rt",encoding="utf8",newline="") as sourcefile:
                reader=csv.DictReader(sourcefile)
                batch=[]
                for row in reader:
                    batch.append(row)
                    if len(batch)>=a.batch:
                        process(batch,tree,zips,totals,means,maxs,writer,audit)
                        batch=[]
                if batch: process(batch,tree,zips,totals,means,maxs,writer,audit)
            print(f"DONE {filename.name}: {int(audit['source_cells']):,} processed",flush=True)
    expected=manifest["source_stats"]["record_count"]
    if int(audit["source_cells"])!=expected:
        raise RuntimeError(f"Extract is incomplete: processed {audit['source_cells']}, expected {expected}")
    csvfile=out/"all_zcta_broadband_coverage_and_change.csv"
    fields=["zcta_2020","h3_cell_count"]+SUM_FIELDS+[
        "fiber_pct_of_current_bsls","cable_pct_of_current_bsls",
        "served_pct_of_current_bsls","fiber_6mo_change_bsls","fiber_12mo_change_bsls",
        "cable_6mo_change_bsls","cable_12mo_change_bsls",
    ]+[f"maximum_h3_{s}" for s in FORMS]+[f"bsl_weighted_average_h3_{s}" for s in FORMS]
    with open(csvfile,"w",newline="",encoding="utf8") as handle:
        w=csv.DictWriter(handle,fieldnames=fields);w.writeheader()
        for zp,data in sorted(totals.items()):
            s=dict(zip(SUM_FIELDS,data["sum"]))
            total=s["TotalBSLs"]
            r={"zcta_2020":zp,"h3_cell_count":data["h3_cells"]}
            r.update({key:int(round(value)) for key,value in s.items()})
            for col,key in [("fiber_pct_of_current_bsls","ServedBSLsFiber"),
                            ("cable_pct_of_current_bsls","ServedBSLsCable"),
                            ("served_pct_of_current_bsls","ServedBSLs")]:
                r[col]=round(100*s[key]/total,3) if total else ""
            r["fiber_6mo_change_bsls"]=int(s["ServedBSLsFiber"]-s["ServedBSLsFiber_6monthPrevious"])
            r["fiber_12mo_change_bsls"]=int(s["ServedBSLsFiber"]-s["ServedBSLsFiber_12monthPrevious"])
            r["cable_6mo_change_bsls"]=int(s["ServedBSLsCable"]-s["ServedBSLsCable_6monthPrevious"])
            r["cable_12mo_change_bsls"]=int(s["ServedBSLsCable"]-s["ServedBSLsCable_12monthPrevious"])
            for name in FORMS:
                r[f"maximum_h3_{name}"]=maxs[zp].get(name,"")
                v,b=means[zp][name]
                r[f"bsl_weighted_average_h3_{name}"]=round(v/b,3) if b else ""
            w.writerow(r)
    info={"source":manifest["source"],"source_stats":manifest["source_stats"],
        "created_utc":datetime.now(timezone.utc).isoformat(),
        "matched_zctas":len(totals),"census_boundary":BOUNDARY_URL,
        "census_boundary_zctas":zctacount,
        "join":"H3 cell centroid within generalized 2020 Census ZCTA polygon",
        "data_counts":dict(audit),
        "method_limitations":[
            "ZCTA is not USPS ZIP; 2020 Census generalized polygons approximate geographic borders.",
            "H3 cell centroid lookup is approximate and some cells fall outside ZCTA polygons.",
            "H3 rows are not address-level eligibility; counts do not prove reseller serviceability.",
            "Historical columns refer to ArcGIS source's same-cell previous-period comparisons, not necessarily exact ZIP area at historical time.",
            "Reported previous-period totals do not guarantee denominator stability; raw changes are not installation counts.",
            "Provider-count summaries are per-H3 maximum/BSL-weighted averages, NOT distinct provider names in the ZIP."
        ]}
    (out/"zcta_coverage_audit_manifest.json").write_text(json.dumps(info,indent=2))
    print("FINISHED",json.dumps({"zctas":len(totals),**dict(audit)}),flush=True)

if __name__=="__main__":main()
