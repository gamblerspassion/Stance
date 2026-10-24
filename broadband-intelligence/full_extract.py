#!/usr/bin/env python3
"""Complete, parallel, resumable-by-partition ArcGIS export with source-side counts.
No ArcGIS credentials required. Run in GitHub Actions; outputs remain downloadable
as GitHub artifacts. Does not mix provider network records with Stance eligibility.
"""
import argparse
import concurrent.futures as cf
import csv
import gzip
import json
import math
import os
import pathlib
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from arcgis_extract import SERVICE, FIELDS

def api(path, params, retries=9):
    url = f"{SERVICE}/{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url,headers={
                "User-Agent":"Internet4ALL-National-FCC-Research/1.0",
                "Accept":"application/json",
            })
            with urllib.request.urlopen(req, timeout=150) as r:
                result = json.load(r)
            if "error" in result:
                error=result["error"]
                raise RuntimeError(f"ArcGIS API error {error}")
            return result
        except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,
                json.JSONDecodeError,RuntimeError) as e:
            if attempt+1>=retries: raise
            wait=min(90, 2**attempt) + random.random()*2
            print(f"retry {attempt+1}/{retries}: {str(e)[:180]}; sleep {wait:.1f}s",flush=True)
            time.sleep(wait)

def source_stats(layer):
    details=api(str(layer),{"f":"json"})
    names={f["name"] for f in details.get("fields",[])}
    missing=[f for f in FIELDS[layer] if f not in names]
    if missing: raise RuntimeError(f"Missing required ArcGIS fields: {missing}")
    total=api(f"{layer}/query",{"where":"1=1","returnCountOnly":"true","f":"json"}).get("count")
    extreme=api(f"{layer}/query",{"where":"1=1","f":"json","returnGeometry":"false",
        "outStatistics":json.dumps([
            {"statisticType":"max","onStatisticField":"OBJECTID","outStatisticFieldName":"max_oid"},
            {"statisticType":"min","onStatisticField":"OBJECTID","outStatisticFieldName":"min_oid"}])})
    attrs=extreme["features"][0]["attributes"]
    stats={"layer":layer,"record_count":int(total),"min_oid":int(attrs["min_oid"]),
           "max_oid":int(attrs["max_oid"]),"service_item":details.get("serviceItemId"),
           "source_data_edit":details.get("editingInfo",{}).get("dataLastEditDate"),
           "schema_edit":details.get("editingInfo",{}).get("schemaLastEditDate")}
    print("SOURCE",json.dumps(stats),flush=True)
    return stats

def partition(layer, low, high, output, batch):
    # Crash-safe range outputs: a .partial gzip file is never mistaken for done.
    filename=output/f"layer{layer}_oid_{low:010d}_{high:010d}.csv.gz"
    receipt=output/f"layer{layer}_oid_{low:010d}_{high:010d}.json"
    if filename.exists() and receipt.exists():
        with receipt.open() as f: done=json.load(f)
        if done.get("low")==low and done.get("high")==high:
            return done
    tmp=filename.with_suffix(".partial")
    if tmp.exists():tmp.unlink()
    oid=low-1
    n=0
    previous=low-1
    with gzip.open(tmp,"wt",encoding="utf8",newline="",compresslevel=5) as f:
        writer=csv.DictWriter(f,fieldnames=FIELDS[layer],extrasaction="ignore")
        writer.writeheader()
        while True:
            obj=api(f"{layer}/query", {
              "f":"json","where":f"OBJECTID > {oid} AND OBJECTID <= {high}",
              "outFields":",".join(FIELDS[layer]),
              "returnGeometry":"false","orderByFields":"OBJECTID ASC",
              "resultRecordCount":str(batch),
            })
            feats=obj.get("features",[])
            if not feats: break
            for rec in feats:
                row=rec["attributes"]
                v=int(row["OBJECTID"])
                if v<=previous or v>high or v<low:
                    raise RuntimeError(f"Unexpected OBJECTID {v} in {low}..{high} after {previous}")
                writer.writerow(row)
                previous=v
                n+=1
            oid=previous
    os.replace(tmp,filename)
    result={"layer":layer,"low":low,"high":high,"rows":n,"last_oid":oid,
            "file":filename.name,"compressed_bytes":filename.stat().st_size}
    receipt.write_text(json.dumps(result),encoding="utf8")
    print("COMPLETED PART",json.dumps(result),flush=True)
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--layer",type=int,choices=[5,6],required=True)
    p.add_argument("--output",default="data/national")
    p.add_argument("--batch",type=int,default=16000)
    p.add_argument("--partition-size",type=int,default=1000000)
    p.add_argument("--workers",type=int,default=8)
    a=p.parse_args()
    if not 1<=a.batch<=32000: p.error("--batch must be 1..32000")
    if not 1<=a.workers<=20: p.error("--workers must be 1..20")
    if a.partition_size<10000:p.error("--partition-size must be >=10000")
    output=pathlib.Path(a.output)/f"layer{a.layer}"
    output.mkdir(parents=True,exist_ok=True)
    begin=source_stats(a.layer)
    segments=[]
    lo=begin["min_oid"]
    while lo<=begin["max_oid"]:
        hi=min(lo+a.partition_size-1,begin["max_oid"])
        segments.append((a.layer,lo,hi,output,a.batch))
        lo=hi+1
    results=[]
    with cf.ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures={pool.submit(partition,*args):args for args in segments}
        for fut in cf.as_completed(futures):
            results.append(fut.result())
    finish=source_stats(a.layer)
    if any(begin[k]!=finish[k] for k in
           ("record_count","min_oid","max_oid","source_data_edit","schema_edit")):
        raise RuntimeError("ArcGIS underlying dataset changed during extraction; output withheld")
    seen=sum(r["rows"] for r in results)
    if seen!=begin["record_count"]:
        raise RuntimeError(f"INCOMPLETE: downloaded {seen:,}, ArcGIS source has {begin['record_count']:,}")
    ordered=sorted(results,key=lambda r:r["low"])
    summary={"status":"COMPLETE","checked_utc":datetime.now(timezone.utc).isoformat(),
             "source":SERVICE,"layer":a.layer,"source_stats":begin,"partition_count":len(ordered),
             "downloaded_rows":seen,"fields":FIELDS[a.layer],"partitions":ordered}
    (output/f"layer{a.layer}_COMPLETE_manifest.json").write_text(json.dumps(summary,indent=2),encoding="utf8")
    print("NATIONAL EXTRACTION COMPLETE",json.dumps({
        "layer":a.layer,"verified":True,"rows":seen,"partition_count":len(ordered)}),flush=True)
if __name__=="__main__":
    main()
