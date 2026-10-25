import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const BASE='https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/84/query';
const zipList=process.argv.slice(2).filter(x=>/^\d{5}$/.test(x));
if(!zipList.length)zipList.push('45202','32303','98004','00601');
await mkdir('signal-web/generated/boundaries',{recursive:true});
const results=[];
for(const zip of zipList){
 const params=new URLSearchParams({where:"GEOID='"+zip+"'",outFields:'GEOID,BASENAME',returnGeometry:'true',outSR:'4326',f:'geojson'});
 const url=BASE+'?'+params;
 let geo=null,lastErr;
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await fetch(url,{headers:{Accept:'application/geo+json, application/json'},signal:AbortSignal.timeout(25000)});
   const raw=await response.text();
   if(!response.ok)throw Error('HTTP '+response.status+' '+raw.slice(0,300));
   geo=JSON.parse(raw);
   if(geo.error)throw Error('ArcGIS '+JSON.stringify(geo.error));
   if(geo.type!=='FeatureCollection'||!Array.isArray(geo.features))throw Error('Not GeoJSON: '+raw.slice(0,120));
   if(geo.features.length<1)throw Error('No Census ZCTA polygon for '+zip);
   const features=geo.features.filter(x=>x.properties?.GEOID===zip);
   if(!features.length)throw Error('GEOID not returned/matched: '+JSON.stringify(geo.features[0].properties));
   if(!features.every(x=>['Polygon','MultiPolygon'].includes(x.geometry?.type)))throw Error('Non-polygon geometry');
   geo={type:'FeatureCollection',features};
   break;
  }catch(e){lastErr=String(e);await new Promise(r=>setTimeout(r,500+attempt*1000));}
 }
 if(!geo){console.error('BOUNDARY_FAIL',zip,lastErr);results.push({zip,passed:false,error:lastErr});continue;}
 const shape=geo.features[0].geometry;
 function count(a){if(typeof a[0]==='number')return 1;return a.reduce((n,v)=>n+count(v),0)}
 const vertices=count(shape.coordinates),bytes=Buffer.byteLength(JSON.stringify(geo));
 if(vertices<8||bytes<1000)throw Error('Boundary suspiciously small '+zip+': '+vertices+' vertices '+bytes+' bytes');
 await writeFile('signal-web/generated/boundaries/'+zip+'.geojson',JSON.stringify(geo));
 const item={zip,passed:true,features:geo.features.length,vertices,bytes,polygon:shape.type,source:'2020 U.S. Census ZCTA, TIGERweb layer 84',sourceUrl:url};
 results.push(item);console.log('BOUNDARY_PASS',JSON.stringify(item));
}
const report={passed:results.every(x=>x.passed),results,generatedAt:new Date().toISOString()};
await writeFile('signal-web/generated/boundaries/report.json',JSON.stringify(report,null,2));
if(!report.passed){console.error('BOUNDARY_REPORT',JSON.stringify(report));process.exitCode=1}
