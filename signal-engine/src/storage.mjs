/** Runtime storage adapters. Supports local Node/Astro and static browser fetch.
 * Does not use BroadbandMap or any paid API. Uncached files are from static assets.
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeZip,normalizePath,summarizeMarket,aggregateMarkets,comparison} from './market-engine.mjs';
export function routeShard(pathname){return createHash('sha256').update(normalizePath(pathname)).digest('hex').slice(0,2)}
export class FileMarketStore{
 constructor(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/signal-v1')){this.root=root;this.pending=new Map()}
 async json(name){if(name.includes('..')||name.startsWith('/'))throw new Error('Invalid data path');
  if(!this.pending.has(name))this.pending.set(name,readFile(path.join(this.root,name),'utf8').then(JSON.parse).catch(e=>{this.pending.delete(name);if(e.code==='ENOENT')return null;throw e}));
  return this.pending.get(name)}
 async manifest(){return this.json('manifest.json')}
 async rules(){return this.json('rules.json')}
 async rawZip(zip){zip=normalizeZip(zip);const file=await this.json(`zip/${zip.slice(0,2)}.json`);return file?.markets?.[zip]??null}
 async zip(zip){zip=normalizeZip(zip);return summarizeMarket(await this.rawZip(zip),zip)}
 async route(pathname,{maxZipResults=500}={}){
  const p=normalizePath(pathname);const filename=`routes/${routeShard(p)}.json`;
  const info=(await this.json(filename))?.routes?.[p];
  if(!info)return {url:p,found:false};
  const total=info.zips.length;const zips=info.zips.slice(0,maxZipResults);const markets=await Promise.all(zips.map(z=>this.zip(z)));
  return {url:p,found:true,family:info.family,associatedZipCount:total,associatedZipResults:markets.length,hasMore:markets.length<total,
   zips,marketSummary:aggregateMarkets(markets,{route:p,family:info.family})};
 }
 async city(slug){const x=(await this.json('cities.json'))||{};const query=slug.toLowerCase().trim();const city=x[query];return city?this.route(city.route):{found:false,slug:query}}
 async state(code){code=String(code||'').toUpperCase();return (await this.json('states.json'))?.[code]||null}
 async provider(id){
  id=String(id||'').toLowerCase().trim();
  const published=(await this.json('providers.json'))?.[id];
  if(published)return published;
  // Original v1 snapshot omitted EarthLink from provider.json despite
  // retaining every EarthLink inquiry opportunity in ZIP/state indexes.
  // Derive the missing view from those source-backed indexes.
  if(id==='earthlink'){
   const [states,manifest]=await Promise.all([this.json('states.json'),this.manifest()]);
   if(!states||!manifest)return null;
   return {name:'EarthLink',channel:'online_phone_quote',
    market_zips:Object.values(states).reduce((n,s)=>n+(s.earthlink_inquiry||0),0),
    partner_fiber_proxy_zctas:manifest.earthlink_proxy_zctas||0,
    inquiry_only:true,address_eligible:null,
    nextStep:'earthlink_dealer_address_quote'};
  }
  return null;
 }
 async lookupCity(term,{limit=10}={}){const q=String(term||'').toLowerCase().trim();if(q.length<2)return [];
  const all=await this.json('cities.json');return Object.values(all||{}).filter(v=>v.name.toLowerCase().includes(q)||v.slug.includes(q)).slice(0,Math.min(100,limit))}
 async compare(zip,first,second){return comparison(first,second,await this.rawZip(zip))}
}