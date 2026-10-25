/** SIGNAL Market Engine: pure decisions, evidence-first; no network writes or metered APIs.
 * Dataset vintage 2025-12 for FCC, territory overlay 2026-10.
 * A ZIP is a coarse geography; an address is never declared serviceable by this engine.
 */
export const DATA_VERSION='1.0.0';
const VALID=/^\d{5}$/;
const PRODUCTS=new Map([['frontier','Fiber'],['kinetic','Fiber'],['brightspeed','Fiber'],['optimum','Fiber/Cable'],['altafiber','Fiber'],['tmobile_fiber','Fiber D2D'],['spectrum','Cable/Fiber Event'],['verizon','Wireless bundle'],['earthlink','Reseller Quote']]);
export function normalizeZip(zip){const v=String(zip??'').trim();if(!VALID.test(v))throw new TypeError('ZIP must be exactly five decimal digits');return v}
export function normalizePath(path){
 const value=String(path||'').trim();
 if(!value)throw new TypeError('Missing path');
 const url=/^https?:\/\//i.test(value)?new URL(value).pathname:value.split(/[?#]/)[0];
 let part='/'+url.replace(/^\/+|\/+$/g,'');
 return part==='/'?'/':part+'/';
}
export function dedupeNetworks(networks,tech=null){
 const a=(networks||[]).filter(x=>!tech||x.t===tech);
 return a.slice().sort((x,y)=>(y.b||0)-(x.b||0)||String(x.n).localeCompare(String(y.n)));
}
/** Read-only, immutable point-in-time market classification. */
export function summarizeMarket(m, zip=m?.zip){
 if(!m)return {zip,found:false,availability:'unknown',websiteRoute:null,coverageData:null,networkCount:0,sales:{direct:[],restricted:[],earthlink:null},recommendedNextStep:'informational_lookup'};
 const grouped=new Map();
 for(const x of m.direct||[]){let g=grouped.get(x.id)||{provider:x.id,product:PRODUCTS.get(x.id),technologies:[],technologyOptions:[],reportedCoveragePct:0,reportedCoveredLocations:0,reportedAtLeast100_20Locations:0,channel:'online_phone',canInviteToCheckAddress:true,canFinalizeOrder:false,nextStep:'provider_address_qualification'};
  if(!g.technologies.includes(x.t))g.technologies.push(x.t);
  g.technologyOptions.push({technology:x.t,reportedCoveragePct:x.pct,reportedCoveredLocations:x.b,reportedAtLeast100_20Locations:x.b100_20,reportingEntity:x.reporters});
  // MAX, never sum multiple overlapping fiber/cable reporter footprints.
  g.reportedCoveragePct=Math.max(g.reportedCoveragePct,x.pct||0);
  g.reportedCoveredLocations=Math.max(g.reportedCoveredLocations,x.b||0);
  g.reportedAtLeast100_20Locations=Math.max(g.reportedAtLeast100_20Locations,x.b100_20||0);
  grouped.set(x.id,g);
 }
 const direct=[...grouped.values()].sort((a,b)=>b.reportedCoveredLocations-a.reportedCoveredLocations||a.provider.localeCompare(b.provider));
 const restricted=(m.restricted||[]).map(x=>({provider:x.id,product:PRODUCTS.get(x.id),technology:x.t,channel:x.channel,territoryInquiry:true,reportedNetwork:x.reported_network,reportedCoveragePct:x.pct,metro:x.metro||null,canInstantInternetCheckout:false,nextStep:x.channel==='door_to_door'?'assigned_turf_field_sale':x.channel==='event_only'?'approved_event_only':'sell_wireless_first_then_check_5g'}));
 const e=m.earthlink||{};
 const earthlink={channel:'online_phone_quote',route:e.coverage||'unknown',reportedPartnerFiberNetworks:e.carrier_proxy||[],partnerNetworkProxyPct:e.proxy_pct??null,eligibleAtAddress:null,canClaimAddressAvailable:false,canInstantCheckout:false,nextStep:e.coverage==='not_assumed'?'no_generalized_territory_claim':'earthlink_dealer_address_quote'};
 const chosen=direct.length?'provider_address_qualification':restricted.length?'restricted_program_flow':e.coverage==='contiguous_us_address_inquiry'?'earthlink_dealer_address_quote':'informational_lookup';
 return {zip,found:true,state:m.state??null,city:m.city??null,hasWebsiteZip:m.has_site_zip===true,websiteRoute:m.has_site_zip?`/internet-providers/zip/${zip}/`:null,
  geographicBasis:m.geography_basis,reportedLocations:m.total_locations??null,hasFccZcta:m.has_fcc_zcta===true,networkCount:(m.networks||[]).length,
  networks:dedupeNetworks(m.networks),research:m.research??null,sales:{direct,restricted,earthlink},history:{territories:m.history_territories||[],nonPrimaryTechnology:m.history||[]},
  availability:'reported_network_not_address_eligibility',asOf:{fcc:'2025-12',territory:'2026-10'},recommendedNextStep:chosen,
  noAutomaticBroadbandMapLookup:true,allowPriceClaimWithoutValidatedOffer:false,allowOrderWithoutAddressPortalResult:false};
}
function channelRank(x){return x.channel==='online_phone'?0:x.channel==='online_phone_quote'?1:x.channel==='door_to_door'?2:x.channel==='event_only'?3:4}
export function aggregateMarkets(markets,meta={}){
 const provider=new Map();const channels=new Map();let known=0,anyFcc=0,el=0,allZips=0;
 for(const m of markets.filter(Boolean)){
  known++;if(m.hasFccZcta)anyFcc++;if(m.sales.earthlink?.route==='contiguous_us_address_inquiry')el++;allZips++;
  for(const row of m.sales.direct){let r=provider.get(row.provider)||{provider:row.provider,channel:'online_phone',matchedZipAreas:0,maxReportedCoveragePct:0,technologies:new Set(),sampleZips:[]};r.matchedZipAreas++;r.maxReportedCoveragePct=Math.max(r.maxReportedCoveragePct,row.reportedCoveragePct||0);for(const t of row.technologies)r.technologies.add(t);if(r.sampleZips.length<12)r.sampleZips.push(m.zip);provider.set(row.provider,r)}
  for(const row of m.sales.restricted){let r=channels.get(row.provider)||{provider:row.provider,channel:row.channel,matchedZipAreas:0,reportedNetworkZips:0,sampleZips:[]};r.matchedZipAreas++;r.reportedNetworkZips+=row.reportedNetwork?1:0;if(r.sampleZips.length<12)r.sampleZips.push(m.zip);channels.set(row.provider,r)}
 }
 const p=[...provider.values()].map(x=>({...x,technologies:[...x.technologies]})).sort((a,b)=>a.provider.localeCompare(b.provider));
 const c=[...channels.values()].sort((a,b)=>a.provider.localeCompare(b.provider));
 return {context:meta,totalMatchedZipAreas:known,fccZctaZipAreas:anyFcc,earthlinkContiguousInquiryZipAreas:el,
  directProviders:p,restrictedPrograms:c,coverageMethod:'associated ZIPs / ZCTAs; percentages must NOT be summed or attributed to entire cities or state boundaries',
  purchaseAllowedWithoutAddressCheck:false};
}
export function comparison(a,b,market){
 const m=summarizeMarket(market,market?.zip);const ids=[a,b];if(!ids.every(id=>PRODUCTS.has(id)))throw new TypeError('Unknown provider selection');
 const status=id=>{const d=m.sales.direct?.find(x=>x.provider===id);if(d)return {...d,match:'reported_direct_network'};
  const r=m.sales.restricted?.find(x=>x.provider===id);if(r)return {...r,match:'restricted_channel'};
  if(id==='earthlink')return {...m.sales.earthlink,match:'reseller_inquiry_not_address_eligibility'};
  const independent=(m.networks||[]).filter(n=>n.n.toLowerCase().includes(id.toLowerCase()));return {provider:id,match:'no_specific_stance_route',reportedNetworkRecords:independent.length,canFinalizeOrder:false};};
 return {zip:m.zip,providers:ids.map(status),addressesVerified:0,buyingDecision:'requires_address_qualification'};
}
/** Server-only address authorization handshake. The verifier must be a trusted,
 * injected provider/dealer adapter and MUST NOT rely on untrusted browser booleans.
 * No partner credentials are embedded in or available to the public dataset.
 */
export async function qualifyAddressWithDealer(market,provider,request,verifyDealer){
 if(typeof verifyDealer!=='function')throw new Error('Trusted server-side dealer verifier required');
 if(!request||!request.address||!request.zip)throw new Error('Full installation address required');
 const result=await verifyDealer({provider,request});
 if(!result||result.provider!==provider||result.addressZip!==request.zip||result.providerConfirmationId==null)
  throw new Error('Dealer verification did not return a bound confirmation');
 if(result.eligible!==true)return {provider,status:'address_not_eligible',route:null};
 const p=(market?.direct||[]).find(x=>x.id===provider);
 const special=(market?.restricted||[]).find(x=>x.id===provider);
 if(provider==='earthlink')return {provider,status:'address_eligible_for_quote',route:'earthlink_dealer_quote',confirmation:result.providerConfirmationId};
 if(p)return {provider,status:'address_eligible_for_portal_order',route:'provider_portal',confirmation:result.providerConfirmationId};
 if(special)return {provider,status:'channel_restriction_remains',route:special.channel,confirmation:result.providerConfirmationId};
 return {provider,status:'outside_known_program_territory',route:null};
}