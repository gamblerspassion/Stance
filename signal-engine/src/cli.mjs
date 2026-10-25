#!/usr/bin/env node
import {FileMarketStore} from './storage.mjs';
const x=new FileMarketStore();const [mode='zip',a='45202',b,c]=process.argv.slice(2);
let r;
if(mode==='zip')r=await x.zip(a);
else if(mode==='city')r=await x.city(a);
else if(mode==='route')r=await x.route(a);
else if(mode==='state')r=await x.state(a);
else if(mode==='provider')r=await x.provider(a);
else if(mode==='search')r=await x.lookupCity(a);
else if(mode==='compare')r=await x.compare(a,b,c);
else if(mode==='manifest')r=await x.manifest();
else throw new Error('mode must be zip | city | route | state | provider | search | compare | manifest');
console.log(JSON.stringify(r,null,2));