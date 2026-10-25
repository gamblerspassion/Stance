/** Read-only national Market Engine HTTP API.
 * Run locally or behind private preview; no paid upstream dependencies.
 */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {FileMarketStore} from './storage.mjs';
const MAX=256_000;
export function createMarketServer({store=new FileMarketStore(),host='127.0.0.1',port=0}={}){
 const server=createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=900','access-control-allow-origin':'*','x-signal-market-version':'1.0.0','x-content-type-options':'nosniff'});res.end(JSON.stringify(data))};
  if(req.method!=='GET')return send(405,{error:'Read-only GET API'});
  try{
   const u=new URL(req.url,'http://localhost');const p=u.pathname.split('/').filter(Boolean);
   if(p[0]!=='v1')return send(404,{error:'No endpoint'});
   let result;
   if(p[1]==='health'&&p.length===2){const m=await store.manifest();return send(200,{ok:!!m,version:m?.version,markets:m?.zip_records,routes:m?.website_routes,fccRows:m?.fcc_rows_read})}
   else if(p[1]==='zip'&&p.length===3)result=await store.zip(p[2]);
   else if(p[1]==='city'&&p.length===3)result=await store.city(p[2]);
   else if(p[1]==='state'&&p.length===3)result=await store.state(p[2]);
   else if(p[1]==='provider'&&p.length===3)result=await store.provider(p[2]);
   else if(p[1]==='cities'&&p[2]==='search')result=await store.lookupCity(u.searchParams.get('q')||'');
   else if(p[1]==='route'&&p.length===2){const route=u.searchParams.get('path');if(!route)return send(400,{error:'path query required'});result=await store.route(route,{maxZipResults:500})}
   else if(p[1]==='compare'&&p.length===3){const a=u.searchParams.get('a'),b=u.searchParams.get('b');if(!a||!b)return send(400,{error:'a and b provider IDs required'});result=await store.compare(p[2],a,b)}
   else return send(404,{error:'No endpoint'});
   if(result==null||result.found===false)return send(404,{error:'Not in source data',data:result});
   const json=JSON.stringify(result);if(Buffer.byteLength(json)>MAX)return send(413,{error:'Response too large for inline API; query narrower geography'});
   res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=900','access-control-allow-origin':'*','x-signal-market-version':'1.0.0','x-content-type-options':'nosniff'});res.end(json);
  }catch(e){send(e instanceof TypeError?400:500,{error:e instanceof TypeError?e.message:'Unable to read market data'})}
 });
 return {server,start:()=>new Promise(resolve=>server.listen(port,host,()=>resolve(server.address()))),close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.PORT||8765);const svc=createMarketServer({host:process.env.HOST||'127.0.0.1',port});const address=await svc.start();console.log(`SIGNAL API running at http://${address.address}:${address.port}/v1/health`);
}