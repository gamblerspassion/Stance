import assert from 'node:assert/strict';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {FileMarketStore} from '../src/storage.mjs';
import {BrowserMarketStore} from '../src/client.mjs';
import {createMarketServer} from '../src/server.mjs';
import {qualifyAddressWithDealer} from '../src/market-engine.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=path.join(root,'data/signal-v1');
const store=new FileMarketStore();
const report={generatedAt:new Date().toISOString(),source:'SIGNAL v1 checked-in snapshot',checks:[],metrics:{},samples:{},limitations:[
  'FCC-reported ZCTA coverage does not prove eligibility at an installation address.',
  'This repository has no live dealer address-qualification integration, final prices or order submission.',
  'Passing this isolated backend check does not prove Internet 4 ALL website deployment, map UX, conversions or SEO performance.'
]};
let failures=0;
async function check(name,fn){
 const t=performance.now();
 try{const detail=await fn();report.checks.push({name,status:'PASS',ms:Math.round(performance.now()-t),detail:detail??null});console.log('PASS',name);}
 catch(err){failures++;report.checks.push({name,status:'FAIL',ms:Math.round(performance.now()-t),detail:String(err.stack||err).slice(0,1800)});console.error('FAIL',name,String(err));}
}
const json=async p=>JSON.parse(await readFile(path.join(data,p),'utf8'));
const stat={markets:0,fcc:0,siteZip:0,networkRows:0,directZipAreas:0,earthlinkInquiryZipAreas:0,routes:0,routeFamilies:{},zipReferences:0,badSalesClaims:0};
const markets=new Map(),routes=new Map(),zipKeys=[];
await check('Independently enumerate every national market and validate sales guardrails',async()=>{
 const files=(await readdir(path.join(data,'zip'))).filter(x=>x.endsWith('.json'));
 for(const f of files){
  const d=await json('zip/'+f);
  for(const [z,m] of Object.entries(d.markets)){
   assert.match(z,/^\d{5}$/);assert(!markets.has(z),'duplicate ZIP '+z);assert.equal(m.zip,z);
   markets.set(z,m);zipKeys.push(z);stat.markets++;
   stat.fcc+=Number(m.has_fcc_zcta===true);stat.siteZip+=Number(m.has_site_zip===true);
   stat.networkRows+=(m.networks||[]).length;
   stat.directZipAreas+=Number((m.direct||[]).length>0);
   stat.earthlinkInquiryZipAreas+=Number(m.earthlink?.coverage==='contiguous_us_address_inquiry');
   assert.equal(m.earthlink?.eligible_at_address,null,'EarthLink address claim '+z);
   if(m.has_fcc_zcta)assert('research' in m,'missing research '+z);
   for(const p of m.direct||[]){
    assert(!['spectrum','tmobile_fiber','metronet','verizon'].includes(p.id),'illegal direct '+p.id+' '+z);
    if(p.id==='frontier')assert.equal(p.t,'fiber','Frontier DSL '+z);
    if(p.id==='optimum')assert(['fiber','cable'].includes(p.t),'Optimum technology '+z);
   }
   for(const p of m.restricted||[]){
    if(p.id==='tmobile_fiber')assert.equal(p.channel,'door_to_door');
    if(p.id==='spectrum')assert.equal(p.channel,'event_only');
    if(p.id==='verizon'){assert.equal(p.channel,'wireless_first');assert.equal(m.state,'OH');}
   }
  }
 }
 assert.equal(stat.markets,41721);assert.equal(stat.fcc,32931);
 assert.equal(stat.networkRows,274945);
 return {marketFiles:files.length,markets:stat.markets,fccZctas:stat.fcc,networks:stat.networkRows};
});
await check('Independently enumerate all website routes and verify every ZIP association',async()=>{
 const files=(await readdir(path.join(data,'routes'))).filter(x=>x.endsWith('.json'));
 for(const f of files){
  const d=await json('routes/'+f);
  for(const [url,info] of Object.entries(d.routes)){
   assert(!routes.has(url),'duplicate route '+url);routes.set(url,info);stat.routes++;
   stat.routeFamilies[info.family]=(stat.routeFamilies[info.family]||0)+1;
   for(const z of info.zips){assert(markets.has(z),'route references missing ZIP '+z+' in '+url);stat.zipReferences++;}
  }
 }
 assert.equal(stat.routes,69803);assert.equal(stat.routeFamilies.zip,31043);
 assert.equal(stat.routeFamilies.city,19184);assert.equal(stat.routeFamilies.neighborhood,19251);
 return {routeShards:files.length,routeCount:stat.routes,families:stat.routeFamilies,totalZipAssociations:stat.zipReferences};
});
await check('Verify national state and provider indexes and EarthLink source-vintage metadata',async()=>{
 const [manifest,states,providers]=await Promise.all([store.manifest(),json('states.json'),json('providers.json')]);
 assert.equal(manifest.fcc_rows_read,424080);assert.equal(manifest.branded_rows,111819);
 assert(Object.keys(states).length>=50);assert(Object.keys(providers).length>=7);
 const e=await store.provider('earthlink');assert.equal(e.market_zips,40690);
 assert.equal(e.partner_fiber_proxy_zctas,10014);assert.equal(e.address_eligible,null);
 return {stateIndexes:Object.keys(states).length,providerIndexes:Object.keys(providers).length,earthlinkInquiryZips:e.market_zips};
});
await check('Realistic market sales cases (OH, FL, NY, WA, AK, PR)',async()=>{
 const c=await store.zip('45202');assert(c.found);assert(c.sales.direct.some(p=>p.provider==='altafiber'&&p.reportedCoveragePct>70));
 assert(c.sales.restricted.some(p=>p.provider==='spectrum'&&p.channel==='event_only'));
 assert(c.sales.restricted.some(p=>p.provider==='verizon'&&p.channel==='wireless_first'));
 const t=await store.zip('32303');assert(t.sales.restricted.some(p=>p.provider==='tmobile_fiber'&&p.channel==='door_to_door'));
 const ny=await store.zip('10550');assert.equal(ny.sales.direct.filter(p=>p.provider==='optimum').length,1);
 const kin=await store.zip('43055');assert(kin.sales.direct.some(p=>p.provider==='kinetic'));
 const wa=await store.zip('98004');assert(wa.sales.earthlink.reportedPartnerFiberNetworks.length>0);assert.equal(wa.sales.earthlink.eligibleAtAddress,null);
 const ak=await store.zip('99501');assert.equal(ak.sales.earthlink.route,'not_assumed');
 const pr=await store.zip('00601');assert(pr.found);assert.equal(pr.sales.earthlink.route,'unknown');
 assert.equal((await store.zip('99999')).found,false);
 report.samples={cincinnati:{zip:c.zip,topDirect:c.sales.direct.slice(0,4).map(p=>({provider:p.provider,coveragePct:p.reportedCoveragePct})),restricted:c.sales.restricted.map(p=>({provider:p.provider,channel:p.channel})),orderableWithoutAddress:c.allowOrderWithoutAddressPortalResult},tallahassee:{zip:t.zip,restricted:t.sales.restricted.map(p=>({provider:p.provider,channel:p.channel}))},earthlink:{zip:wa.zip,route:wa.sales.earthlink.route,eligibleAtAddress:wa.sales.earthlink.eligibleAtAddress}};
 return {testedZips:['45202','32303','10550','43055','98004','99501','00601','99999']};
});
await check('Mock-adapter authorization cannot bypass address qualification or provider channel',async()=>{
 const m=await store.rawZip('45202');
 await assert.rejects(()=>qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Example Rd'},null));
 await assert.rejects(()=>qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Example Rd'},async()=>({eligible:true})),/bound confirmation/);
 const fake=async({provider,request})=>({eligible:true,provider,addressZip:request.zip,providerConfirmationId:'mock-not-real-dealer'});
 const direct=await qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Example Rd'},fake);
 assert.equal(direct.route,'provider_portal');
 const restricted=await qualifyAddressWithDealer(m,'spectrum',{zip:'45202',address:'1 Example Rd'},fake);
 assert.equal(restricted.route,'event_only');
 return {adapter:'mock ONLY — no live dealer connection',directRoute:direct.route,restrictedRoute:restricted.route};
});
await check('Static browser asset adapter matches server-side ZIP results',async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async input=>{
  try{return new Response(await readFile(path.join(data,String(input).replace(/^\/data\/signal\/v1\//,''))),{status:200,headers:{'content-type':'application/json'}});}
  catch{return new Response('Not found',{status:404});}
 };
 try{
  const browser=new BrowserMarketStore();
  for(const z of ['45202','32303','98004','00601']){
   const a=await store.zip(z),b=await browser.zip(z);
   assert.deepEqual(b,a,'Node/browser disagreement '+z);
  }
  assert((await browser.searchCities('Cincinnati')).some(c=>c.slug==='cincinnati-oh'));
 }finally{globalThis.fetch=originalFetch;}
 return {identicalStaticAssetZips:4,citySearch:'Cincinnati'};
});
let apiURL='';
await check('Start real HTTP server and exercise every endpoint, errors, and expected data',async()=>{
 const svc=createMarketServer({store});const addr=await svc.start();apiURL='http://127.0.0.1:'+addr.port;
 const request=async p=>{const resp=await fetch(apiURL+p);const body=await resp.json();return {code:resp.status,body,headers:resp.headers}};
 try{
  const health=await request('/v1/health');assert.equal(health.code,200);assert.equal(health.body.markets,41721);assert.equal(health.headers.get('x-signal-market-version'),'1.0.0');
  const paths=['/v1/zip/45202','/v1/zip/32303','/v1/zip/10550','/v1/zip/98004','/v1/city/cincinnati-oh','/v1/state/OH','/v1/provider/frontier','/v1/provider/earthlink','/v1/cities/search?q=Cincinnati','/v1/route?path=%2Finternet-providers%2Fzip%2F45202%2F','/v1/compare/45202?a=altafiber&b=spectrum'];
  for(const p of paths){const r=await request(p);assert.equal(r.code,200,p+' '+r.code);assert(r.body!=null,p);}
  for(const p of ['/v1/zip/99999','/v1/provider/not-real','/v1/city/not-a-city'])assert.equal((await request(p)).code,404,p);
  for(const p of ['/v1/zip/45202abc','/v1/route','/v1/compare/45202?a=altafiber&b=unknown','/v1/compare/45202'])assert.equal((await request(p)).code,400,p);
  const notAllowed=await fetch(apiURL+'/v1/zip/45202',{method:'POST'});assert.equal(notAllowed.status,405);
  return {successPaths:paths.length,expected404:3,expected400:4,method405:true};
 }finally{await svc.close();}
});
await check('Burst test real ZIP API with deterministic nationwide sample and no 500s',async()=>{
 const svc=createMarketServer({store});const addr=await svc.start(),base='http://127.0.0.1:'+addr.port;
 const times=[],chosen=[];zipKeys.sort();
 for(let i=0;i<500;i++)chosen.push(zipKeys[(i*83)%zipKeys.length]);
 try{
  for(let i=0;i<chosen.length;i+=25){
   await Promise.all(chosen.slice(i,i+25).map(async z=>{
    const t=performance.now();const r=await fetch(base+'/v1/zip/'+z);const m=await r.json();
    times.push(performance.now()-t);assert.equal(r.status,200,z);assert.equal(m.zip,z);assert.equal(m.found,true);
    assert.equal(m.allowOrderWithoutAddressPortalResult,false);
   }));
  }
 }finally{await svc.close();}
 times.sort((a,b)=>a-b);
 const percentile=q=>Math.round(times[Math.min(times.length-1,Math.ceil(q*times.length)-1)]*100)/100;
 report.metrics.httpZipBurst={requests:times.length,concurrency:25,p50Ms:percentile(0.5),p95Ms:percentile(0.95),p99Ms:percentile(0.99),maxMs:percentile(1)};
 return report.metrics.httpZipBurst;
});
report.metrics.inventory=stat;report.failures=failures;report.passed=failures===0;
await mkdir(path.join(root,'proof-output'),{recursive:true});
await writeFile(path.join(root,'proof-output','proof-report.json'),JSON.stringify(report,null,2)+'\n');
const md=['# SIGNAL Backend Proof — '+(report.passed?'PASS':'FAIL'),'','Generated '+report.generatedAt,'','## Results',...report.checks.map(c=>'- **'+c.status+'** '+c.name+' ('+c.ms+' ms)'+(c.status==='FAIL'?' — '+c.detail.replace(/\n/g,' '):'')),'','## National snapshot inventory','\`\`\`json',JSON.stringify(stat,null,2),'\`\`\`','','## Measured HTTP ZIP burst','\`\`\`json',JSON.stringify(report.metrics.httpZipBurst||{},null,2),'\`\`\`','','## Example commercial routing','\`\`\`json',JSON.stringify(report.samples,null,2),'\`\`\`','','## What this does NOT prove',...report.limitations.map(s=>'- '+s),''];
await writeFile(path.join(root,'proof-output','proof-report.md'),md.join('\n'));
console.log('\nSIGNAL_PROOF_RESULT='+JSON.stringify({passed:report.passed,failures,checks:report.checks.length,metrics:report.metrics.httpZipBurst,inventory:{markets:stat.markets,routes:stat.routes}}));
if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,md.join('\n'),{flag:'a'});
if(failures)process.exitCode=1;
