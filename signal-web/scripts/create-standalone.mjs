import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root='web-preview/public/data/signal/v1';
const entries={};for(const f of (await readdir(path.join(root,'zip'))).filter(x=>x.endsWith('.json'))){const obj=JSON.parse(await readFile(path.join(root,'zip',f),'utf8'));Object.assign(entries,obj.markets)}
if(Object.keys(entries).length!==41721)throw Error('National market record count mismatch');
const boundaries={};for(const f of(await readdir('signal-web/generated/boundaries')).filter(x=>x.endsWith('.geojson')))boundaries[f.slice(0,5)]=JSON.parse(await readFile('signal-web/generated/boundaries/'+f,'utf8'));
for(const z of ['45202','32303','98004','00601'])if(!boundaries[z]?.features?.some(x=>x.properties?.GEOID===z))throw Error('Missing verified polygon '+z);
const original=await readFile('signal-web/standalone/preview-template.html','utf8');
const payload=JSON.stringify({markets:entries,boundaries}).replace(/</g,'\\u003c');
if(!original.includes('__SIGNAL_DATA__'))throw Error('Missing HTML injection anchor');
await mkdir('signal-evidence',{recursive:true});const output='signal-evidence/SIGNAL-interactive-preview.html';const html=original.replace('__SIGNAL_DATA__',payload);
await writeFile(output,html);
console.log('SIGNAL_HTML_CREATED',JSON.stringify({bytes:Buffer.byteLength(html),marketRecords:Object.keys(entries).length,boundaries:Object.keys(boundaries)}));
