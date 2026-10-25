#!/usr/bin/env python3
"""Reproducible offline builder for the SIGNAL market data API.

Reads existing, provenance-rich FCC and Stance source extracts. Never fabricates
address-level coverage, provider speeds, purchase rights, or EarthLink eligibility.
"""
from __future__ import annotations
import argparse,csv,io,zipfile,json,sqlite3,os,hashlib,collections,re,datetime,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE=pathlib.Path(os.environ.get('SIGNAL_SOURCE_DIR','/mnt/data'))
FCC_ARCHIVE='Internet4ALL_COMPLETE_NATIONAL_FCC_ALL_PROVIDERS_DATA_2026-10-24.zip'
BRAND_ARCHIVE='Stance_FCC_Master_ALL_PROVIDERS_EarthLink_Partners_2026-10-23.zip'
TURF_FILE='STANCE_COMPLETE_TURF_DATA_20261025/01_COMPLETE_NATIONAL_ZIP_PROVIDER_TERRITORY_MASTER.csv'
LINK_DB='STANCE_URL_PARTNER_EARTHLINK_JOIN_INTERNAL.sqlite'
EARTHLINK_FILE='00_INTEGRATED_STANCE_EARTHLINK_MASTER_ALL_ZCTAS.csv'
DIRECT={'frontier','kinetic','brightspeed','optimum','altafiber'}
TECH={'10':'DSL','11':'DSL','12':'DSL','40':'cable','41':'cable','42':'cable','43':'cable','50':'fiber','60':'satellite','61':'satellite','70':'fixed_wireless','71':'fixed_wireless','72':'fixed_wireless'}
POLICIES={
 'frontier':dict(name='Frontier',channel='online_phone',active=True,allowed=['fiber'],gate='address_and_provider_portal'),
 'kinetic':dict(name='Kinetic',channel='online_phone',active=True,allowed=['fiber'],gate='address_and_provider_portal'),
 'brightspeed':dict(name='Brightspeed',channel='online_phone',active=True,allowed=['fiber'],gate='address_and_provider_portal'),
 'optimum':dict(name='Optimum',channel='online_phone',active=True,allowed=['fiber','cable'],gate='address_and_provider_portal'),
 'altafiber':dict(name='altafiber',channel='online_phone',active=True,allowed=['fiber'],gate='address_and_provider_portal'),
 'tmobile_fiber':dict(name='T-Mobile Fiber / Metronet',channel='door_to_door',active=True,allowed=['fiber'],gate='assigned_turf_and_portal'),
 'spectrum':dict(name='Spectrum',channel='event_only',active=True,allowed=['cable','fiber'],gate='approved_event_and_portal'),
 'verizon':dict(name='Verizon (wireless first)',channel='wireless_first',active=True,allowed=['fixed_wireless'],gate='wireless_order_then_5g_eligibility'),
 'earthlink':dict(name='EarthLink',channel='online_phone_quote',active=True,allowed=['reseller'],gate='earthlink_dealer_address_quote'),
}
CONTIG=set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split())

def read_csv(path):
 with path.open(encoding='utf-8-sig',newline='') as f:
  yield from csv.DictReader(f)

def read_zipped_csv(zfile,suffix):
 with zipfile.ZipFile(zfile) as z:
  found=[n for n in z.namelist() if n.endswith(suffix)]
  if len(found)!=1:raise RuntimeError(f'expect one file matching {suffix}, got {found}')
  with z.open(found[0]) as b:
   yield from csv.DictReader(io.TextIOWrapper(b,encoding='utf-8-sig',newline=''))

def number(a,zero=0):
 try:return float(a) if a not in ('',None) else zero
 except(ValueError,TypeError):return zero

def intnum(a):return int(number(a))

def yes(a):return str(a or '').strip().lower() in ('1','true','yes','y')

def zipkey(v):
 v=str(v or '').strip()
 return v if re.fullmatch(r'\d{5}',v) else None

def compact_float(a):return round(float(a),3)

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--source',type=pathlib.Path,default=SOURCE)
 parser.add_argument('--output',type=pathlib.Path,default=ROOT/'data'/'signal-v1')
 args=parser.parse_args();src=args.source;out=args.output;out.mkdir(parents=True,exist_ok=True)
 for p in ['zip','routes']:(out/p).mkdir(exist_ok=True)
 db=sqlite3.connect(src/LINK_DB)
 db.row_factory=sqlite3.Row
 def empty(zipcode):return {'zip':zipcode,'state':None,'city':None,'has_fcc_zcta':False,'has_site_zip':False,'total_locations':None,'networks':[],'direct':[],'restricted':[],'earthlink':{'coverage':'unknown','carrier_proxy':[],'eligible_at_address':None,'quote_required':True},'history':[],'geography_basis':'unresolved','source':[]}
 markets={}
 def get(k):return markets.setdefault(k,empty(k))
 # 1. Ground every legacy website route and geographic association.
 routes={};site_zips=set();counts=collections.Counter();city_index=[]
 for row in db.execute('SELECT url,page_family,associated_zips FROM url_join'):
  path=re.sub(r'^https?://[^/]+','',row['url']).split('?')[0]
  path='/'+path.strip('/')+'/' if path.strip('/') else '/'
  zs=list(dict.fromkeys(x for x in (row['associated_zips'] or '').split(';') if zipkey(x)))
  fam=row['page_family'] or 'other'
  routes[path]={'family':fam,'zips':zs}
  counts[f'route_{fam}']+=1
  if fam=='zip' and re.search(r'/zip/(\d{5})/$',path):
   k=path.rsplit('/',2)[1];site_zips.add(k);get(k)['has_site_zip']=True
  if fam=='city':
   label=path.split('/')[-2];city_index.append({'slug':label,'route':path,'zips':zs,'name':label.rsplit('-',1)[0].replace('-',' ').title(),'state':label.rsplit('-',1)[-1].upper() if '-' in label else None})
 # 2. Import ALL national FCC rows; do not discard entire unsupported markets.
 n_fcc=0;positive=0;fcc_zip=set(); reporter_set=set();tech_counts=collections.Counter()
 for r in read_zipped_csv(src/FCC_ARCHIVE,'Internet4ALL_NATIONAL_ALL_PROVIDERS_424080_FCC_ZIP_NETWORKS_Dec2025.csv'):
  n_fcc+=1;k=zipkey(r['zcta']);
  if not k:continue
  m=get(k);m['has_fcc_zcta']=True;m['geography_basis']='fcc_zcta'
  fcc_zip.add(k); reporter_set.add((r['provider_as_filed'],r['frn']))
  total=intnum(r.get('zip_total_bsls'));m['total_locations']=max(m['total_locations'] or 0,total)
  tech=str(r['technology_code']);tech_counts[tech]+=1
  covered=intnum(r['provider_served_bsls']);pct=number(r['estimated_coverage_pct']);
  if covered<=0 or pct<=0:continue
  positive+=1
  m['networks'].append({'n':r['provider_as_filed'],'frn':r['frn'],'t':TECH.get(tech,f'fcc_{tech}'),'tc':tech,'b':covered,'pct':compact_float(pct)})
 # 3. Provider branded report matches (including copper excluded from direct sale).
 brand_counts=collections.Counter();review_only=0
 for r in read_zipped_csv(src/BRAND_ARCHIVE,'/02_PROVIDER_ZIP_MASTER_COMPLETE.csv'):
  k=zipkey(r['zcta']);p=r['provider_key'];
  if not k:continue
  brand_counts[p]+=1;m=get(k)
  rawtech=r['technology'].lower(); tech=('fiber' if rawtech=='fiber' else 'cable' if rawtech=='cable' else 'dsl' if rawtech=='dsl/copper' else 'fixed_wireless' if 'wireless' in rawtech else 'unknown')
  covered=intnum(r['estimated_100_20_bsls_conservative_max']); any_covered=intnum(r['estimated_any_bsls_conservative_max']);pct=number(r['coverage_100_20_pct']);
  if p in DIRECT and tech in POLICIES[p]['allowed'] and any_covered>0:
   # Partial footprints remain exposed, but are not address-verified.
   m['direct'].append({'id':p,'t':tech,'b':any_covered,'b100_20':covered,'pct':compact_float(number(r['coverage_any_pct'])),'reporters':r['fcc_reporters'],'fcc_frns':r['fcc_frns'],'source':'fcc_dec2025_brand_map','channel':'online_phone','address_qualified':False})
  elif p in DIRECT and (any_covered>0):
   m['history'].append({'id':p,'t':tech,'status':'non_primary_technology','b':any_covered})
  # Special-channel signal is gated by the explicit territory overlay, added below.
  elif p in ('metronet','spectrum','verizon') and any_covered>0:
   m.setdefault('_reporting_special',{}).setdefault(p,[]).append({'t':tech,'b':any_covered,'pct':compact_float(number(r['coverage_any_pct']))})
  elif p in ('tmobile_fiber_review','verizon_fiber_review','affiliate_review'):review_only+=1
 # 3b. Enrich every ZCTA with dated national research metrics and temporal trends.
 research_count=0
 for r in read_csv(src/'Internet4ALL_ALL_32931_ENRICHED_ZIP_MARKETS_FCC_HISTORY_COMMERCIAL_2026-10-24.csv'):
  k=zipkey(r.get('zcta'))
  if not k:continue
  m=get(k);research_count+=1
  m['research']={
   'source':'fcc_dec2025_h3_aggregates','total_bsl':intnum(r.get('geo_TotalBSLs')),
   'served_bsl':intnum(r.get('geo_ServedBSLs')),'underserved_bsl':intnum(r.get('geo_UnderservedBSLs')),
   'unserved_bsl':intnum(r.get('geo_UnservedBSLs')),
   'fiber_bsl':intnum(r.get('geo_ServedBSLsFiber')),'cable_bsl':intnum(r.get('geo_ServedBSLsCable')),
   'fiber_pct':compact_float(number(r.get('geo_fiber_pct_of_current_bsls'))),
   'cable_pct':compact_float(number(r.get('geo_cable_pct_of_current_bsls'))),
   'fiber_6mo_bsl_change':intnum(r.get('geo_fiber_6mo_change_bsls')),
   'fiber_12mo_bsl_change':intnum(r.get('geo_fiber_12mo_change_bsls')),
   'cable_6mo_bsl_change':intnum(r.get('geo_cable_6mo_change_bsls')),
   'cable_12mo_bsl_change':intnum(r.get('geo_cable_12mo_change_bsls')),
   'max_observed_h3_fiber_provider_count':intnum(r.get('geo_maximum_h3_UniqueProvidersFiber')),
   'max_observed_h3_cable_provider_count':intnum(r.get('geo_maximum_h3_UniqueProvidersCable')),
  }
 # 4. Authoritative Stance territory overlay and ZIP-only legacy ZIPs.
 overlay_count=collections.Counter()
 for r in read_csv(src/TURF_FILE):
  k=zipkey(r.get('zip'));state=(r.get('state') or '').strip();
  if not k:continue
  m=get(k);overlay_count['records']+=1
  if len(state)==2 and state.isalpha():m['state']=state
  city=(r.get('city') or '').strip();
  if city:m['city']=city
  m['has_site_zip']=m['has_site_zip'] or yes(r.get('site_zip_page_exists')) or 'internet-providers/zip/' in r.get('existing_site_zip_url','')
  old=(r.get('all_5_direct_historical_list_presence') or '').strip()
  if old:m['history_territories']=old.split(';')
  m['_turf']={
   'tmobile_fiber':yes(r.get('tmobile_fiber_oct23_inquiry')),
   'spectrum':yes(r.get('spectrum_cincinnati_dayton_event')),
   'verizon':yes(r.get('verizon_ohio_geographic_inquiry')),
   'spectrum_metro':r.get('spectrum_metro',''),
  }
  for p in ('tmobile_fiber','spectrum','verizon'):
   if m['_turf'][p]:overlay_count[p]+=1
 # 5. EarthLink reseller/partner network opportunity is not EarthLink address eligibility.
 el_count=collections.Counter()
 for r in read_csv(src/EARTHLINK_FILE):
  k=zipkey(r['zcta']);
  if not k:continue
  m=get(k); names=[x.strip() for x in re.split('[;|]',r.get('earthlink_named_partner_fiber_networks','')) if x.strip()]
  m['earthlink']['carrier_proxy']=names
  if names:el_count['fiber_proxy']+=1
  m['earthlink']['proxy_pct']=number(r.get('earthlink_partner_fiber_lower_pct'),None)
 # 5b. Repair genuinely unresolved website neighborhood ZIP references, explicitly
 # as postal lookup aliases; never substitute FCC data or fake local service.
 added_url_only_zips=set()
 for route_path,info in routes.items():
  segments=route_path.strip('/').split('/')
  state_hint=segments[1].upper() if len(segments)>2 and len(segments[1])==2 and segments[1].upper() in CONTIG else None
  for linked in info['zips']:
   if linked in markets:continue
   m=get(linked);m['geography_basis']='associated_postal_zip_without_source_profile'
   m['source']=['website_neighborhood_association'];added_url_only_zips.add(linked)
   if state_hint:m['state']=state_hint
 # 6. Reconcile channel-specific network signals and route into appropriate territory.
 for k,m in markets.items():
  turf=m.pop('_turf',{})
  special=m.pop('_reporting_special',{})
  for channel,source_key in [('tmobile_fiber','metronet'),('spectrum','spectrum'),('verizon','verizon')]:
   if not turf.get(channel):continue
   # Source territory is an inquiry zone; stronger FCC signal is attached separately.
   signal=special.get(source_key,[])
   valid=[x for x in signal if x['t'] in POLICIES[channel]['allowed']]
   best=max(valid,key=lambda x:x['b'],default=None)
   m['restricted'].append({'id':channel,'channel':POLICIES[channel]['channel'],'territory':True,'reported_network':bool(best),'t':best['t'] if best else None,'b':best['b'] if best else None,'pct':best['pct'] if best else None,'address_qualified':False,**({'metro':turf.get('spectrum_metro')} if channel=='spectrum' else {})})
  state=m.get('state')
  # Do not claim EarthLink address availability anywhere based on proxy/marketing reach.
  if state in CONTIG and (m['has_fcc_zcta'] or m['has_site_zip']):m['earthlink']['coverage']='contiguous_us_address_inquiry'
  elif state in ('AK','HI','PR','VI','GU','MP','AS'):m['earthlink']['coverage']='not_assumed'
  else:m['earthlink']['coverage']='unknown'
  m['direct'].sort(key=lambda a:(-a['b'],a['id'],a['t']))
  m['networks'].sort(key=lambda a:(-a['b'],a['n'],a['tc']))
  m['restricted'].sort(key=lambda a:a['id'])
  # Signals are report-level, not address-level or permission to finalize an order.
  m['source']=['fcc_h3_zcta_dec2025'] if m['has_fcc_zcta'] else []
  if m.get('history_territories'):m['source'].append('historical_partner_territory')
  if m['restricted']:m['source'].append('oct2026_program_territory')
  if not m['has_fcc_zcta'] and m['has_site_zip']:m['geography_basis']='postal_site_without_fcc_zcta'
  if m['has_site_zip'] and not m['has_fcc_zcta']:m['total_locations']=None
  if m['direct'] or m['restricted'] or m['earthlink']['carrier_proxy']:m['has_commercial_signal']=True
  else:m['has_commercial_signal']=False
  if not m['city'] and m['has_site_zip']:
   # City page lookup can recover locality display without mislabeling city boundaries.
   pass
 # 7. Generate state and provider derived indexes. No summing overlapping BSLs.
 states=collections.defaultdict(lambda:dict(known_zips=0,fcc_zctas=0,website_zip_routes=0,direct_by_provider=collections.Counter(),special_by_provider=collections.Counter(),earthlink_inquiry=0))
 providers=collections.defaultdict(lambda:dict(zcta_with_network=set(),zip_route_count=0))
 for m in markets.values():
  st=m.get('state')
  if st and len(st)==2:
   s=states[st];s['known_zips']+=1;s['fcc_zctas']+=bool(m['has_fcc_zcta']);s['website_zip_routes']+=bool(m['has_site_zip']);s['earthlink_inquiry']+=m['earthlink']['coverage']=='contiguous_us_address_inquiry'
   for p in {x['id'] for x in m['direct']}:s['direct_by_provider'][p]+=1
   for p in {x['id'] for x in m['restricted']}:s['special_by_provider'][p]+=1
  for p in {x['id'] for x in m['direct']+m['restricted']}:providers[p]['zcta_with_network'].add(m['zip'])
 # 8. Save static, sharded JSON for browser and server: no paid request or runtime DB needed.
 manifest={'version':'1.0.0','generated_date':'2026-10-25','fcc_vintage':'2025-12',
 'source_files':[FCC_ARCHIVE,BRAND_ARCHIVE,TURF_FILE,EARTHLINK_FILE,LINK_DB],
 'zip_records':len(markets),'additional_website_association_only_zips':len(added_url_only_zips),'fcc_rows_read':n_fcc,'positive_fcc_rows':positive,'fcc_zctas':len(fcc_zip),
 'fcc_reporters':len(reporter_set),'branded_rows':sum(brand_counts.values()),'research_zctas':research_count,'website_routes':len(routes),
 'website_zip_routes':len(site_zips),'city_routes':len(city_index),
 'provider_brand_counts':dict(brand_counts),'special_zip_counts':dict(overlay_count),
 'earthlink_proxy_zctas':el_count['fiber_proxy'],
 'restrictions':'No exact address eligibility, no verified speed max, no verified real-time retail pricing, no background metered requests',
 'runtime_paths':{'zip':'zip/{prefix}.json','route':'routes/{sha256_2}.json','city':'cities.json','state':'states.json','policy':'rules.json'}}
 def write(name,obj):
  p=out/name;p.parent.mkdir(parents=True,exist_ok=True)
  with p.open('w',encoding='utf8') as f:json.dump(obj,f,ensure_ascii=False,separators=(',',':'),sort_keys=True)
  return p.stat().st_size
 shards=collections.defaultdict(dict)
 for k,m in markets.items():shards[k[:2]][k]=m
 sizes=[]
 for a,b in shards.items():sizes.append(write('zip/'+a+'.json',{'_version':manifest['version'],'markets':b}))
 route_shards=collections.defaultdict(dict)
 for path,record in routes.items():route_shards[hashlib.sha256(path.encode()).hexdigest()[:2]][path]=record
 route_sizes=[]
 for a,b in route_shards.items():route_sizes.append(write('routes/'+a+'.json',{'routes':b}))
 sjson={k:{**v,'direct_by_provider':dict(v['direct_by_provider']),'special_by_provider':dict(v['special_by_provider'])} for k,v in states.items()}
 write('states.json',sjson)
 write('cities.json',{x['slug']:x for x in city_index})
 write('rules.json',{'policies':POLICIES,'fcc_technology_codes':TECH,'channels_valid_for_instant_online_checkout':[], 'address_required_for_every_order':True})
 provider_index={k:{'name':POLICIES[k]['name'] if k in POLICIES else k,'market_zips':len(v['zcta_with_network']),'channel':POLICIES.get(k,{}).get('channel')} for k,v in providers.items()}
 provider_index['earthlink']={'name':'EarthLink','channel':'online_phone_quote','market_zips':sum(st['earthlink_inquiry'] for st in states.values()),'partner_fiber_proxy_zctas':el_count['fiber_proxy'],'inquiry_only':True,'address_eligible':None,'nextStep':'earthlink_dealer_address_quote'}
 write('providers.json',provider_index)
 manifest['zip_shards']=len(shards);manifest['route_shards']=len(route_shards);manifest['zip_bytes']=sum(sizes);manifest['route_bytes']=sum(route_sizes)
 write('manifest.json',manifest)
 print(json.dumps(manifest,indent=2))
 if n_fcc!=424080 or len(fcc_zip)!=32931 or len(routes)!=69803 or len(markets)<41604:raise RuntimeError('SOURCE INTEGRITY: expected national sample sizes not met')
 assert markets['45202']['direct'] and any(x['id']=='altafiber' for x in markets['45202']['direct'])
 assert any(x['id']=='verizon' for x in markets['45202']['restricted'])
 assert markets['45202']['earthlink']['eligible_at_address'] is None
 assert len(city_index)==19184
 return manifest

if __name__=='__main__':main()