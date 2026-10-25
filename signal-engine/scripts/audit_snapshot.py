#!/usr/bin/env python3
"""Global snapshot verification: every market, route, program, disallowed technology."""
import pathlib,collections,hashlib,json,os,sys
root=pathlib.Path(__file__).resolve().parents[1]/'data/signal-v1'
markets={}
for f in (root/'zip').glob('*.json'):
 for k,v in json.loads(f.read_text())['markets'].items():
  assert k not in markets,(k,f);markets[k]=v
routed={}
for f in (root/'routes').glob('*.json'):
 for k,v in json.loads(f.read_text())['routes'].items():
  assert k not in routed,k;assert hashlib.sha256(k.encode()).hexdigest()[:2]==f.stem,(k,f)
  routed[k]=v
issues=[]; c=collections.Counter();providers=collections.Counter()
for k,v in markets.items():
 c['zip_market_total']+=1;c['fcc']+=bool(v['has_fcc_zcta']);c['site_zip']+=bool(v['has_site_zip']);c['neutral_network_records']+=len(v['networks']);c['direct_qualified_geo']+=bool(v['direct']);c['restricted_geo']+=bool(v['restricted']);c['earthlink_inquiry_geo']+=v['earthlink']['coverage']=='contiguous_us_address_inquiry'
 for p in v['direct']:
  providers[p['id']]+=1
  if p['id']=='frontier' and p['t']!='fiber':issues.append(f'{k} Frontier incorrect tech {p["t"]}')
  if p['id']=='optimum' and p['t'] not in ('fiber','cable'):issues.append(f'{k} Optimum tech {p["t"]}')
  if p['id'] in ('metronet','spectrum','verizon','tmobile_fiber'):issues.append(f'{k} restricted provider incorrectly direct')
 for p in v['restricted']:
  if p['id']=='verizon' and v['state']!='OH':issues.append(f'{k} Verizon not OH')
  if p['id']=='spectrum' and p['channel']!='event_only':issues.append(f'{k} Spectrum not events')
  if p['id']=='tmobile_fiber' and p['channel']!='door_to_door':issues.append(f'{k} T-Fiber not D2D')
  if p['id']=='verizon' and p['channel']!='wireless_first':issues.append(f'{k} Verizon not wireless-first')
 if v['earthlink']['eligible_at_address'] is not None:issues.append(f'{k} EarthLink false address qualification')
 if v['has_fcc_zcta'] and 'research' not in v:issues.append(f'{k} missing H3 research geo summary')
 if v['has_fcc_zcta'] and not v['networks']:issues.append(f'{k} no positive coverage reporters')
for path,info in routed.items():
 c['route_total']+=1;c['route_'+info['family']]+=1
 if info['family']=='zip':
  z=path.split('/')[3];
  if z not in markets or not markets[z]['has_site_zip']:issues.append(f'{path} missing ZIP market')
 for z in info['zips']:
  if z not in markets:issues.append(f'{path} missing associated ZIP {z}')
 c['total_zip_associations']+=len(info['zips'])
assert c['route_total']==69803,c['route_total']
assert c['zip_market_total']==41721,c['zip_market_total']
assert c['fcc']==32931,c['fcc']
assert c['route_zip']==31043,c['route_zip']
assert c['route_city']==19184,c['route_city']
assert c['route_neighborhood']==19251,c['route_neighborhood']
assert c['neutral_network_records']==274945,c['neutral_network_records']
assert providers['frontier']==3159;assert providers['kinetic']==1616;assert providers['brightspeed']==1526;assert providers['altafiber']==184
out={'audit_passed':not issues,'counts':dict(c),'provider_network_rows':dict(providers),'error_count':len(issues),'sample_errors':issues[:30]}
path=pathlib.Path(__file__).resolve().parents[1]/'audit-result.json';path.write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
if issues:raise SystemExit(1)