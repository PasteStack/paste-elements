// Native boundary regressions. Uses the same compiled CSS and optional flat
// shipped JS tree as consistency-browser-checks.cjs; no platform API is mocked.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), engine = process.env.ELEMENTS_BROWSER || 'chromium';
const build = process.env.ELEMENTS_CONSISTENCY_BUILD || path.join(root, 'target/consistency-assets');
const manifest = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json')));
const css = name => fs.readFileSync(path.join(build, manifest.assets[name].output), 'utf8');
const scripts = ['paste','guid','util','oop','dom','event','has'].map(n => '/core/'+n+'.js');
const modules = ['utilities/animation-frame','utilities/mediaquery','utilities/scrollrange','scrollscrub','marquee'];
const html = `<!doctype html><meta charset="utf-8"><style>${css('css/modules/marquee/marquee.css')}
#scaled {transform:scale(.5,2);transform-origin:top left;width:700px}
.paste-ui-marquee {--paste-marquee-item-width:160px;--paste-marquee-item-height:48px}
#scroller {height:200px;overflow:auto}#space {height:1000px}</style>
<div id="scaled"><div id="marquee" class="paste-ui-marquee" data-paste-marquee>
<ul class="paste-ui-marquee-items">${Array.from({length:12},(_,i)=>`<li class="paste-ui-marquee-item">Item ${i}</li>`).join('')}</ul>
<button class="paste-ui-marquee-toggle" type="button" hidden disabled>Pause</button></div></div>
<div id="scroller"><div id="scope" data-paste-scrollscrub data-scrub-root="#scroller" data-scrub-mode="container" style="--paste-scrub-progress:.25!important"><div id="space"></div></div></div>
${[...scripts,...modules.map(n=>'/modules/'+n+'/'+n.split('/').pop()+'.js')].map(src=>`<script src="${src}"></script>`).join('')}`;
const server = http.createServer((req,res)=>{
  let file;
  if(req.url.startsWith('/core/')) file=path.join(process.env.PASTE_CORE_JS,req.url.slice(6));
  if(req.url.startsWith('/modules/')) {
    const base=path.basename(req.url),key='paste/ui/'+(req.url.includes('/utilities/')?'utilities/':'')+base;
    file=process.env.ELEMENTS_SOURCE_ROOT?path.join(process.env.ELEMENTS_SOURCE_ROOT,key):path.join(root,req.url);
  }
  res.setHeader('Content-Type',file?'text/javascript':'text/html; charset=utf-8');
  res.end(file?fs.readFileSync(file):html);
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await pw[engine].launch({proxy:{server:'http://127.0.0.1:9',bypass:'localhost,127.0.0.1'},firefoxUserPrefs:engine==='firefox'?{'extensions.pocket.enabled':false,'browser.newtabpage.enabled':false,'browser.newtabpage.activity-stream.feeds.system.topstories':false}:undefined,executablePath:process.env.ELEMENTS_BROWSER_EXECUTABLE,args:engine==='chromium'?['--no-sandbox']:[]});
  const page=await browser.newPage({viewport:{width:1000,height:800},reducedMotion:'no-preference'}),errors=[],evidence={browser:browser.version(),engine};
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.getElementById('marquee').dataset.pasteMarqueeState==='running');
    evidence.geometry=await page.evaluate(()=>{const list=document.querySelector('ul'),item=list.firstElementChild;return {published:parseFloat(list.style.getPropertyValue('--paste-marquee-row-height')),actual:item.offsetHeight,visual:item.getBoundingClientRect().height}});
    assert.ok(Math.abs(evidence.geometry.published-evidence.geometry.actual)<1);
    assert.ok(Math.abs(evidence.geometry.visual-2*evidence.geometry.actual)<1);
    // This absolute descendant changes interactivity without resizing a box.
    await page.evaluate(()=>{const b=document.createElement('button');b.id='inserted';b.textContent='Action';b.style.position='absolute';document.querySelector('li').append(b)});
    await page.waitForFunction(()=>document.getElementById('marquee').dataset.pasteMarqueeState==='static');
    await page.evaluate(()=>document.getElementById('inserted').remove());
    await page.waitForFunction(()=>document.getElementById('marquee').dataset.pasteMarqueeState==='running');
    await page.evaluate(()=>document.querySelector('li').tabIndex=0);
    await page.waitForFunction(()=>document.getElementById('marquee').dataset.pasteMarqueeState==='static');
    evidence.interactivity='insert/remove and tabindex observed without resize';
    await page.waitForFunction(()=>document.getElementById('scope').style.getPropertyValue('--paste-scrub-progress')==='0');
    evidence.claim=await page.evaluate(()=>document.getElementById('scope').style.cssText);
    assert.ok(!evidence.claim.includes('important'));
    await page.evaluate(()=>{document.getElementById('space').style.height='0px';dispatchEvent(new Event('resize'))});
    await page.waitForFunction(()=>document.getElementById('scope').style.getPropertyPriority('--paste-scrub-progress')==='important');
    evidence.restored=await page.evaluate(()=>document.getElementById('scope').style.getPropertyValue('--paste-scrub-progress'));
    assert.equal(Number(evidence.restored),.25);
    // A later writer owns its own declaration when the range becomes unusable.
    await page.evaluate(()=>{document.getElementById('space').style.height='1000px';dispatchEvent(new Event('resize'))});
    await page.waitForFunction(()=>document.getElementById('scope').style.getPropertyValue('--paste-scrub-progress')==='0');
    await page.evaluate(()=>{document.getElementById('scope').style.setProperty('--paste-scrub-progress','.8','important');document.getElementById('space').style.height='0px';dispatchEvent(new Event('resize'))});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    evidence.foreign=await page.evaluate(()=>document.getElementById('scope').style.cssText);
    assert.ok(evidence.foreign.includes('important'));assert.ok(evidence.foreign.includes('0.8')||evidence.foreign.includes('.8'));
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(root,'target','responsibility-'+engine+'-probes.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  } finally {await browser.close();server.close()}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
