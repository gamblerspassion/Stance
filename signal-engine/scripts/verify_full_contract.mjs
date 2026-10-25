import assert from 'node:assert/strict';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileMarketStore} from '../src/storage.mjs';
import {createMarketServer} from '../src/server.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.join(ROOT,'data/signal-v1');
const store=new FileMarketStore();
const read=async p=>JSON.parse(await readFile(path.join(DATA,p),'utf8'));
const out={date:new Date().toISOString(),gitSha:process.env.GITHUB_SHA||null,checks:[],counts:{},samples:[],failures:[],warnings:[]};
const c=out.counts;
const err=(kind,key,detail)=>{if(out.failures.length<50)out.failures.push({kind,key,detail:String(detail)});c.errors=(c.errors||0)+1;};
const block=async(label,fn)=>{let t=performance.now();try{await fn();out.checks.push({name:label,status:'PASS',durationMs:Math.round(performance.now()-t)});console.log('PASS',label);}catch(e){err('block',label,e.stack||e);out.checks.push({name:label,status:'FAIL',durationMs:Math.round(performance.now()-t)});console.log('FAIL',label,String(e));}};
let zipKeys=[],routePairs=[],cityKeys=[],stateKeys=[],providerKeys=[];
await block('Load complete raw ZIP, route, city, state and provider inventories',async()=>{
 const mFiles=(await readdir(path.join(DATA,'zip'))).filter(x=>x.endsWith('.json')).sort();
 for(const f of mFiles){const d=await read('zip/'+f);for(const k of Object.keys(d.markets)){zipKeys.push(k);assert.equal(k.slice(0,2),f.slice(0,2));}}
 const rFiles=(await readdir(path.join(DATA,'routes'))).filter(x=>x.endsWith('.json')).sort();
 for(const f of rFiles){const d=await read('routes/'+f);for(const [k,v] of Object.entries(d.routes)){routePairs.push([k,v]);}}
 const cities=await read('cities.json'),states=await read('states.json'),providers=await read('providers.json');
 cityKeys=Object.keys(cities);stateKeys=Object.keys(states);providerKeys=Object.keys(providers);
 c.zipRecords=zipKeys.length;c.routes=routePairs.length;c.cityIndexEntries=cityKeys.length;c.states=stateKeys.length;c.providerIndexEntries=providerKeys.length;
 assert.equal(c.zipRecords,41721);assert.equal(c.routes,69803);
 assert(stateKeys.length>=50);assert(providerKeys.length>=5);
 console.log('INDEX_COUNTS',JSON.stringify(c));
});
await block('ALL 41,721 ZIP lookups: public record shape, sales evidence, technology and routing',async()=>{
 let passed=0,direct=0,restricted=0,el=0,nonFcc=0,invalid=0;let maxDirect=0;
 for(let i=0;i<zipKeys.length;i+=100){
 const items=await Promise.all(zipKeys.slice(i,i+100).map(async k=>[k,await store.zip(k)]));
 for(const [k,m] of items){
  if(!m.found||m.zip!==k){err('zip','notfound:'+k,JSON.stringify(m).slice(0,200));continue;}
  passed++;if(!m.hasFccZcta)nonFcc++;if(m.sales.direct.length)direct++;if(m.sales.restricted.length)restricted++;if(m.sales.earthlink.route==='contiguous_us_address_inquiry')el++;
  maxDirect=Math.max(maxDirect,m.sales.direct.length);
  if(m.allowOrderWithoutAddressPortalResult!==false||m.allowPriceClaimWithoutValidatedOffer!==false||!m.noAutomaticBroadbandMapLookup)err('commercial',k,'incorrect public permission');
  if(m.sales.earthlink.eligibleAtAddress!==null||m.sales.earthlink.canInstantCheckout!==false)err('earthlink',k,'unsupported qualification');
  const used=new Set();let previous=Infinity;
  for(const x of m.sales.direct){
   if(used.has(x.provider))err('duplicateDirect',k,x.provider);used.add(x.provider);
   if(x.reportedCoveredLocations>previous)err('sort',k,x.provider);previous=x.reportedCoveredLocations;
   if(x.reportedCoveragePct<0||x.reportedCoveragePct>100)err('percentage',k,x.provider+' '+x.reportedCoveragePct);
   if(x.provider==='frontier'&&x.technologies.some(t=>t!=='fiber'))err('dsl',k,'Frontier DSL');
   if(x.canFinalizeOrder!==false)err('checkout',k,x.provider);
  }
  for(const x of m.sales.restricted){
   if(x.provider==='tmobile_fiber'&&x.channel!=='door_to_door')err('channel',k,'tmobile');
   if(x.provider==='spectrum'&&x.channel!=='event_only')err('channel',k,'spectrum');
   if(x.provider==='verizon'&&(x.channel!=='wireless_first'||m.state!=='OH'))err('channel',k,'verizon');
  }
 }
 }
 c.zipLookupsPassed=passed;c.directZipAreas=direct;c.restrictedZipAreas=restricted;c.earthlinkInquiryZips=el;c.nonFccZipRecords=nonFcc;c.maximumDirectProviderCount=maxDirect;
 assert.equal(passed,41721);
});
await block('ALL 69,803 existing URL routes resolve with accurate associations and bounded result size',async()=>{
 let passed=0,partial=0,tooLarge=0,max=0,maxPath='',maxMs=0;
 for(let i=0;i<routePairs.length;i+=50){
  const parts=routePairs.slice(i,i+50);
  const records=await Promise.all(parts.map(async([p,info])=>{try{const t=performance.now();const r=await store.route(p);return {p,info,r,ms:performance.now()-t};}catch(e){return {p,error:String(e)}};}));
  for(const {p,info,r,ms,error} of records){
   if(error){err('route-exception',p,error);continue;}
   if(!r.found){err('route-not-found',p,'');continue;}
   if(r.family!==info.family||r.associatedZipCount!==info.zips.length||r.associatedZipResults!==Math.min(500,info.zips.length))err('route-metadata',p,JSON.stringify({count:r.associatedZipCount,expected:info.zips.length}));
   if(r.marketSummary.totalMatchedZipAreas!==r.associatedZipResults)err('route-aggregate',p,r.marketSummary.totalMatchedZipAreas+' vs '+r.associatedZipResults);
   if(r.hasMore!== (info.zips.length>500))err('route-pagination',p,'hasMore mismatch');
   const responseSize=Buffer.byteLength(JSON.stringify(r));
   if(responseSize>256000){tooLarge++;if(out.samples.length<10)out.samples.push({type:'too-large-route',path:p,size:responseSize});}
   if(info.zips.length>500)partial++;
   if(responseSize>max){max=responseSize;maxPath=p;}
   maxMs=Math.max(maxMs,ms);passed++;
  }
 }
 c.routesResolved=passed;c.routeResponsesOver256k=tooLarge;c.routesWithPartialSummaries=partial;c.largestRouteBytes=max;c.largestRoutePath=maxPath;c.slowestRouteLookupMs=Math.round(maxMs);
 assert.equal(passed,69803);
});
await block('ALL city slugs and statewide/provider index reads',async()=>{
 let resolved=0;let broken=[];
 for(let i=0;i<cityKeys.length;i+=50){
  const z=await Promise.all(cityKeys.slice(i,i+50).map(async slug=>[slug,await store.city(slug)]));
  for(const [slug,r] of z){if(!r.found){broken.push(slug);err('city',slug,'not found');}else resolved++;}
 }
 c.citySlugsResolved=resolved;c.brokenCitySlugs=broken.length;
 for(const s of stateKeys){const r=await store.state(s);if(!r)err('state',s,'no result');}
 for(const p of [...providerKeys,'earthlink']){const r=await store.provider(p);if(!r)err('provider',p,'no result');}
 const citiesSearch=await store.lookupCity('Cincinnati');assert(citiesSearch.some(x=>x.slug==='cincinnati-oh'));
});
await block('Real HTTP server: every endpoint, 1,200 geographically distributed ZIPs and 1,000 existing routes',async()=>{
 const svc=createMarketServer({store});const a=await svc.start();const base='http://127.0.0.1:'+a.port;let ok=0,invalid=0;const times=[];
 try{
  const req=async p=>{const t=performance.now();const response=await fetch(base+p);let body;try{body=await response.json();}catch(e){body={parseError:String(e)};}times.push(performance.now()-t);return {status:response.status,body};};
  const required=['/v1/health','/v1/city/cincinnati-oh','/v1/state/OH','/v1/provider/earthlink','/v1/provider/frontier','/v1/cities/search?q=Cincinnati','/v1/compare/45202?a=altafiber&b=spectrum','/v1/route?path=%2Finternet-providers%2Fzip%2F45202%2F'];
  for(const p of required){const v=await req(p);if(v.status!==200)err('http-required',p,JSON.stringify(v).slice(0,350));else ok++;}
  for(let i=0;i<1200;i+=24){await Promise.all(Array.from({length:Math.min(24,1200-i)},(_,j)=>zipKeys[((i+j)*37)%zipKeys.length]).map(async z=>{const v=await req('/v1/zip/'+z);if(v.status!==200||!v.body.found||v.body.zip!==z)err('http-zip',z,JSON.stringify(v).slice(0,180));else ok++;}));}
  for(let i=0;i<1000;i+=20){await Promise.all(Array.from({length:Math.min(20,1000-i)},(_,j)=>routePairs[((i+j)*59)%routePairs.length][0]).map(async p=>{const v=await req('/v1/route?path='+encodeURIComponent(p));if(v.status!==200||!v.body.found)err('http-route',p,'HTTP '+v.status);else ok++;}));}
  const bad=[['/v1/zip/99999',404],['/v1/zip/abcd',400],['/v1/zip/123',400],['/v1/route',400],['/v1/compare/45202',400],['/v1/provider/not_a_provider',404]];
  for(const [p,code] of bad){const v=await req(p);if(v.status!==code)err('http-invalid',p,'expected '+code+' got '+v.status);else invalid++;}
  const wrongMethod=await fetch(base+'/v1/zip/45202',{method:'POST'});if(wrongMethod.status!==405)err('method','POST','expected 405 got '+wrongMethod.status);
  times.sort((a,b)=>a-b);c.httpSuccesses=ok;c.httpExpectedErrors=invalid;c.httpP95Ms=Number(times[Math.ceil(times.length*0.95)-1].toFixed(2));c.httpP99Ms=Number(times[Math.ceil(times.length*0.99)-1].toFixed(2));
 }finally{await svc.close();}
});
out.passed=(c.errors||0)===0;await mkdir(path.join(ROOT,'proof-output'),{recursive:true});
await writeFile(path.join(ROOT,'proof-output','exhaustive-contract.json'),JSON.stringify(out,null,2)+'\n');
const lines=['# SIGNAL Exhaustive Contract Audit','','Result: **'+(out.passed?'PASS':'FAIL')+'**','','## Coverage',...Object.entries(c).map(([k,v])=>'- '+k+': '+v),'','## Test stages',...out.checks.map(v=>'- '+v.status+': '+v.name+' ('+v.durationMs+' ms)'),'','## First problems',...out.failures.slice(0,30).map(x=>'- '+JSON.stringify(x)),''];
await writeFile(path.join(ROOT,'proof-output','exhaustive-contract.md'),lines.join('\n'));
if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n'),{flag:'a'});
console.log('EXHAUSTIVE_CONTRACT_RESULT',JSON.stringify({passed:out.passed,checks:out.checks,counts:out.counts,firstProblems:out.failures.slice(0,12)}));
if(!out.passed)process.exitCode=1;
