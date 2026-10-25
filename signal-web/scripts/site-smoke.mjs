import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const base='http://127.0.0.1:4321';
const output=process.env.GITHUB_WORKSPACE+'/signal-evidence';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const failures=[],results=[];
async function scenario(name,task){const t=Date.now();try{const result=await task();results.push({name,status:'PASS',ms:Date.now()-t,detail:result});console.log('PASS',name,result||'');}catch(e){failures.push(name+': '+String(e));results.push({name,status:'FAIL',ms:Date.now()-t,error:String(e)});console.error('FAIL',name,e)}}
async function newPage(viewport){const context=await browser.newContext({viewport,deviceScaleFactor:1});const page=await context.newPage();return {page,context}}
const a=await newPage({width:1440,height:900}); const page=a.page;
await scenario('Astro preview route renders real Internet 4 ALL layout',async()=>{
 const response=await page.goto(base+'/signal-preview/',{waitUntil:'domcontentloaded',timeout:90000});
 if(response.status()!==200)throw Error('page status '+response.status());
 await page.locator('h1').getByText(/Find internet options/).waitFor({timeout:15000});
 await page.locator('#signal-map').waitFor();
 return {http:response.status(),title:await page.title()};
});
await scenario('Cincinnati 45202 ZIP market, real data, and routing to existing ZIP page',async()=>{
 await page.locator('#signal-query').fill('45202');await page.locator('#signal-search-form button[type=submit]').click();
 await page.locator('#signal-result h2').getByText('Internet providers in 45202').waitFor({timeout:30000});
 const content=await page.locator('#signal-result').innerText();
 if(!/Altafiber/i.test(content)||!/Spectrum/i.test(content)||!/Verizon/i.test(content))throw Error('Missing market provider(s)');
 const href=await page.locator('.signal-action').first().getAttribute('href');
 if(href!=='/internet-providers/zip/45202/')throw Error('ZIP route mismatch '+href);
 await page.screenshot({path:output+'/desktop-45202.png',fullPage:true});
 const r=await page.request.get(base+href,{timeout:90000});if(r.status()!==200)throw Error('existing ZIP page status '+r.status());
 return {providers:'altafiber/Spectrum/Verizon',existingZipStatus:r.status(),path:href};
});
await scenario('Cincinnati city lookup, associated ZIPs and existing city path',async()=>{
 await page.locator('#signal-query').fill('Cincinnati');
 await page.locator('#signal-search-form button[type=submit]').click();
 await page.locator('#signal-result h2').getByText(/Cincinnati/).waitFor({timeout:30000});
 const text=await page.locator('#signal-result').innerText();
 if(!text.includes('associated ZIPs')||!text.includes('Altafiber'))throw Error('City ZIP aggregation missing');
 const href=await page.getByText('View existing city page').getAttribute('href');
 const response=await page.request.get(base+href,{timeout:90000});if(response.status()!==200)throw Error('Existing city route '+response.status()+' '+href);
 return {path:href,status:response.status()};
});
await scenario('Unknown ZIP displays a usable not-found state',async()=>{
 await page.locator('#signal-query').fill('99999');await page.locator('#signal-search-form button[type=submit]').click();
 await page.locator('#signal-result').getByText(/not in the snapshot/i).waitFor({timeout:15000});
});
const b=await newPage({width:390,height:844});
await scenario('Mobile map-first render and T-Mobile Fiber Tallahassee routing',async()=>{
 const r=await b.page.goto(base+'/signal-preview/',{waitUntil:'domcontentloaded',timeout:90000});if(r.status()!==200)throw Error('mobile route '+r.status());
 const box=await b.page.locator('#signal-map').boundingBox();if(!box||box.width<300||box.height<200)throw Error('map not visible on mobile');
 await b.page.locator('[data-zip="32303"]').click();
 await b.page.locator('#signal-result h2').getByText(/32303/).waitFor({timeout:30000});
 const text=await b.page.locator('#signal-result').innerText();if(!text.includes('Tmobile Fiber')&&!text.includes('Tmobile Fiber'))throw Error('T-Mobile restricted entry missing');
 if(!text.includes('Door To Door'))throw Error('T-Mobile channel missing');
 await b.page.screenshot({path:output+'/mobile-32303.png',fullPage:true});
 return {mapWidth:box.width,mapHeight:box.height};
});
await scenario('Mobile page stays within screen width',async()=>{
 const w=await b.page.evaluate(()=>document.documentElement.scrollWidth);if(w>400)throw Error('horizontal overflow '+w);return {scrollWidth:w};
});
await scenario('Interactive map actually initializes, renders basemap tiles and ZIP outline',async()=>{
 await page.goto(base+'/signal-preview?zip=45202',{waitUntil:'domcontentloaded',timeout:90000});
 await page.locator('#signal-result h2').getByText('Internet providers in 45202').waitFor({timeout:20000});
 await page.locator('.leaflet-container').waitFor({timeout:15000});
 await page.waitForFunction(()=>document.querySelectorAll('.leaflet-tile-loaded').length>0,{timeout:25000});
 const tileCount=await page.locator('.leaflet-tile-loaded').count();
 await page.waitForFunction(()=>document.querySelector('#signal-map')?.dataset.boundaryZip==='45202'&&document.querySelector('#signal-map')?.dataset.boundaryStatus==='rendered',{timeout:25000});
 const outlineStatus='rendered';
 const count=await page.locator('#signal-map .leaflet-interactive').count();if(count<1)throw Error('GeoJSON polygon not rendered');
 const box=await page.locator('#signal-map').boundingBox();
 if(!box||box.width<700||tileCount===0)throw Error('Real map did not load');
 await page.locator('.leaflet-control-zoom-in').click();
 const next=await page.locator('#signal-map').evaluate(el=>el.querySelector('.leaflet-container')?.getAttribute('class'));
 await page.screenshot({path:output+'/desktop-map-zoom.png',fullPage:true});
 return {loadedTileImages:tileCount,zipOutline:outlineStatus,zoomControl:'clickable',mapClass:next};
});
await scenario('Address and market route handoffs work without broken destination pages',async()=>{
 const zip=await page.request.get(base+'/check-availability?zip=45202',{timeout:90000});
 if(zip.status()!==200)throw Error('address qualification page HTTP '+zip.status());
 const homepage=await page.request.get(base+'/',{timeout:90000});if(homepage.status()!==200)throw Error('homepage HTTP '+homepage.status());
 const coverage=await page.request.get(base+'/coverage-map/',{timeout:90000});if(coverage.status()!==200)throw Error('coverage map page HTTP '+coverage.status());
 return {homepage:homepage.status(),coveragePage:coverage.status(),addressPage:zip.status()};
});
await a.context.close();await b.context.close();await browser.close();
const fs=await import('node:fs/promises');await fs.writeFile(output+'/website-proof.json',JSON.stringify({passed:failures.length===0,results,failures},null,2));
console.log('SIGNAL_WEBSITE_PROOF',JSON.stringify({passed:failures.length===0,results,failures}));
if(failures.length)process.exitCode=1;
