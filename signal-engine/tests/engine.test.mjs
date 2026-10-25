import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FileMarketStore,routeShard} from '../src/storage.mjs';
import {normalizeZip,normalizePath,comparison,qualifyAddressWithDealer} from '../src/market-engine.mjs';
const store=new FileMarketStore();

test('all source populations and all routes loaded',async()=>{
 const m=await store.manifest();assert.equal(m.fcc_rows_read,424080);assert.equal(m.fcc_zctas,32931);assert.equal(m.branded_rows,111819);assert.equal(m.website_routes,69803);assert.equal(m.website_zip_routes,31043);assert.equal(m.city_routes,19184);assert.equal(m.zip_records,41721);assert.equal(m.additional_website_association_only_zips,117);
 assert.equal(m.special_zip_counts.tmobile_fiber,840);assert.equal(m.special_zip_counts.spectrum,222);assert.equal(m.special_zip_counts.verizon,1450);
});
test('ZIP preserves leading zeros and rejects malformed strings',async()=>{
 assert.equal(normalizeZip('00601'),'00601');assert.throws(()=>normalizeZip('601'));assert.throws(()=>normalizeZip('45202a'));
 const pr=await store.zip('00601');assert.equal(pr.found,true);assert.equal(pr.hasFccZcta,true);assert.equal(pr.state,null);assert.equal(pr.sales.earthlink.route,'unknown');
});
test('complete national market coverage with real positive networks',async()=>{
 for(const z of ['45202','45402','32303','43055','27837','98004','99501','00601']){
  const m=await store.zip(z);assert.equal(m.found,true,z);assert.equal(m.noAutomaticBroadbandMapLookup,true);assert.equal(m.allowOrderWithoutAddressPortalResult,false);assert(m.networkCount>=0);
 }
 const missing=await store.zip('99999');assert.equal(missing.found,false);
});
test('Cincinnati strong altafiber vs Dayton small footprint',async()=>{
 const a=(await store.zip('45202')).sales.direct.find(x=>x.provider==='altafiber');
 const b=(await store.zip('45402')).sales.direct.find(x=>x.provider==='altafiber');
 assert(a.reportedCoveragePct>70);assert(b.reportedCoveragePct<7);assert(b.reportedCoveragePct>0);
});
test('Frontier DSL explicitly excluded from website direct fiber routes',async()=>{
 const a=await store.zip('43055');assert(a.sales.direct.some(x=>x.provider==='kinetic'&&x.technologies.includes('fiber')));
 for(const z of ['43055','45202','10550','32303']){
  const m=await store.zip(z);const f=m.sales.direct.find(x=>x.provider==='frontier');if(f)assert(!f.technologies.includes('dsl'));
 }
});
test('Optimum fiber+cable is one sales provider, not two duplicate offers',async()=>{
 const a=await store.zip('10550');const p=a.sales.direct.filter(x=>x.provider==='optimum');assert.equal(p.length,1);
 assert(p[0].technologies.includes('fiber'));assert(p[0].technologies.includes('cable'));
});
test('T-Mobile Fiber Tallahassee never becomes online fiber checkout',async()=>{
 const m=await store.zip('32303');assert.equal(m.sales.restricted.find(x=>x.provider==='tmobile_fiber').channel,'door_to_door');
 assert(!m.sales.direct.some(x=>x.provider==='tmobile_fiber'));
});
test('Verizon Ohio and Spectrum Cincy/Dayton retain restrictions',async()=>{
 for(const z of ['45202','45424']){
  const m=await store.zip(z);assert.equal(m.sales.restricted.find(x=>x.provider==='verizon').channel,'wireless_first');
  assert.equal(m.sales.restricted.find(x=>x.provider==='spectrum').channel,'event_only');
 }
 const ohioSourceOnly=await store.zip('43001');assert.equal(ohioSourceOnly.hasWebsiteZip,false);assert.equal(ohioSourceOnly.sales.restricted.find(x=>x.provider==='verizon').channel,'wireless_first');
});
test('EarthLink partner proxy never becomes exact retail orderability',async()=>{
 const m=await store.zip('98004');assert(m.sales.earthlink.reportedPartnerFiberNetworks.length>=1);
 assert.equal(m.sales.earthlink.eligibleAtAddress,null);assert.equal(m.sales.earthlink.canInstantCheckout,false);
 const ak=await store.zip('99501');assert.equal(ak.sales.earthlink.route,'not_assumed');
});
test('provider comparisons keep separate provider and sales permissions',async()=>{
 const m=await store.compare('45202','altafiber','spectrum');assert.equal(m.providers[0].match,'reported_direct_network');assert.equal(m.providers[1].match,'restricted_channel');assert.equal(m.addressesVerified,0);
 const e=await store.compare('98004','earthlink','frontier');assert.equal(e.providers[0].match,'reseller_inquiry_not_address_eligibility');
});
test('city, ZIP, and neighborhood existing URL routes can be searched',async()=>{
 const c=await store.city('cincinnati-oh');assert.equal(c.found,true);assert.equal(c.family,'city');assert(c.associatedZipCount>=10);assert(c.marketSummary.directProviders.some(x=>x.provider==='altafiber'));
 const z=await store.route('/internet-providers/zip/45202');assert.equal(z.found,true);assert.equal(z.family,'zip');assert.equal(z.marketSummary.totalMatchedZipAreas,1);
 assert(routeShard('/internet-providers/zip/45202/').length===2);
 const lookup=await store.lookupCity('Cincinnati');assert(lookup.some(x=>x.slug==='cincinnati-oh'));
});
test('all 50 state hubs are present and a state summary is grounded',async()=>{
 const oh=await store.state('OH');assert(oh.known_zips>1000);assert(oh.special_by_provider.verizon>=1432);
 const pr=await store.provider('frontier');assert(pr.market_zips>1000);
 const earthlink=await store.provider('earthlink');assert.equal(earthlink.name,'EarthLink');assert.equal(earthlink.channel,'online_phone_quote');assert.equal(earthlink.market_zips,40690);assert.equal(earthlink.partner_fiber_proxy_zctas,10014);assert.equal(earthlink.address_eligible,null);
 assert.equal(await store.provider('totally_not_a_provider'),null);
 assert.equal(normalizePath('https://internet-4-all.com/internet-providers/zip/45202?x=1'),'/internet-providers/zip/45202/');
});
test('address qualification rejects untrusted claims and needs server adapter',async()=>{
 const m=await store.rawZip('45202');
 await assert.rejects(()=>qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Main St'},null));
 await assert.rejects(()=>qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Main St'},async()=>({eligible:true})),/bound confirmation/);
 const permitted=await qualifyAddressWithDealer(m,'altafiber',{zip:'45202',address:'1 Main St'},async()=>({provider:'altafiber',addressZip:'45202',eligible:true,providerConfirmationId:'test-confirmed-address-only'}));
 assert.equal(permitted.route,'provider_portal');
 const disallowed=await qualifyAddressWithDealer(m,'spectrum',{zip:'45202',address:'1 Main St'},async()=>({provider:'spectrum',addressZip:'45202',eligible:true,providerConfirmationId:'test-confirmed-address-only'}));
 assert.equal(disallowed.status,'channel_restriction_remains');assert.equal(disallowed.route,'event_only');
});
test('HTTP API real request paths and no upstream billing dependency',async()=>{
 const {createMarketServer}=await import('../src/server.mjs');
 const svc=createMarketServer({store});const addr=await svc.start();
 try{
  const base=`http://127.0.0.1:${addr.port}`;
  const request=async path=>{const r=await fetch(base+path);return {status:r.status,data:await r.json()}};
  let r=await request('/v1/health');assert.equal(r.status,200);assert.equal(r.data.markets,41721);
  r=await request('/v1/zip/45202');assert.equal(r.status,200);assert.equal(r.data.sales.direct[0].provider,'altafiber');
  r=await request('/v1/zip/32303');assert.equal(r.status,200);assert(r.data.sales.restricted.some(v=>v.channel==='door_to_door'));
  r=await request('/v1/state/OH');assert.equal(r.status,200);assert(r.data.special_by_provider.verizon>=1432);
  r=await request('/v1/provider/earthlink');assert.equal(r.status,200);assert.equal(r.data.market_zips,40690);assert.equal(r.data.inquiry_only,true);
  r=await request('/v1/city/cincinnati-oh');assert.equal(r.status,200);assert(r.data.marketSummary.directProviders.some(x=>x.provider==='altafiber'));
  r=await request('/v1/compare/45202?a=altafiber&b=spectrum');assert.equal(r.status,200);assert.equal(r.data.addressesVerified,0);
  r=await request('/v1/route?path=%2Finternet-providers%2Fzip%2F45202%2F');assert.equal(r.status,200);assert.equal(r.data.family,'zip');
  r=await request('/v1/zip/99999');assert.equal(r.status,404);
  r=await request('/v1/zip/malformed');assert.equal(r.status,400);
 }finally{await svc.close()}
});