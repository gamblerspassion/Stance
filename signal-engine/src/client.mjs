/** Browser adapter; all reads are public versioned static JSON assets. */
import {normalizeZip,summarizeMarket} from './market-engine.mjs';
export class BrowserMarketStore{
 constructor(base='/data/signal/v1'){this.base=base.replace(/\/$/,'');this.pending=new Map()}
 async json(name){if(!/^[-a-zA-Z0-9/.]+$/.test(name)||name.includes('..'))throw new Error('Invalid path');if(!this.pending.has(name))this.pending.set(name,fetch(`${this.base}/${name}`,{credentials:'omit'}).then(async r=>r.ok?r.json():null).catch(()=>{this.pending.delete(name);return null}));return this.pending.get(name)}
 async zip(zip){zip=normalizeZip(zip);const data=await this.json(`zip/${zip.slice(0,2)}.json`);return summarizeMarket(data?.markets?.[zip]??null,zip)}
 async searchCities(q,max=12){const cities=await this.json('cities.json')||{};const term=String(q).trim().toLowerCase();if(term.length<2)return [];
  return Object.values(cities).filter(x=>x.name.toLowerCase().includes(term)||x.slug.includes(term)).slice(0,Math.min(max,100))}
}