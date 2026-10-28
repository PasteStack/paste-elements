/*!
 * Copyright (c) 2017–present Tomshley LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     https://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Build tests/select-assets.conf first. Uses real Paste core and native controls.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const built = path.join(root, 'target/select-assets');
const manifest = JSON.parse(fs.readFileSync(path.join(built, 'manifest.json')));
function asset(suffix) {
  const entry = Object.values(manifest.assets).find(a => a.source.endsWith(suffix));
  assert.ok(entry, suffix);
  return fs.readFileSync(path.resolve(built, entry.output.replace(/^\//, '')), 'utf8');
}
const css = asset('/select.scss');
const source = fs.readFileSync(path.join(root, 'modules/select/select.js'), 'utf8');
const optimized = asset('/select.js');
const fixture = `<form id="shipping-form">
<label>Region <span class="paste-ui-select"><select id="region" name="region" required data-paste-select>
<option value="">Choose</option><option value="ct">Connecticut</option><option value="ny" label="New York">Internal name</option>
</select>\n<span data-paste-select-value aria-hidden="true"></span></span></label>
<input name="elements"><button type="reset">Reset</button>
</form>
<span class="paste-ui-select"><select id="external" form="shipping-form" name="outside" data-paste-select><option value="a">A</option><option value="b">B</option></select><span data-paste-select-value aria-hidden="true"></span></span>
<span class="paste-ui-select"><select id="multiple" multiple data-paste-select><option>A</option><option>B</option></select><span data-paste-select-value aria-hidden="true"></span></span>
<span class="paste-ui-select"><select id="list" size="3" data-paste-select><option>A</option></select><span data-paste-select-value aria-hidden="true"></span></span>
<span class="paste-ui-select"><select id="empty" data-paste-select></select><span data-paste-select-value aria-hidden="true">stale</span></span>
<select id="unpaired" data-paste-select><option>Plain</option></select>`;
const core = ['paste','guid','util','event'].map(name => `<script src="/core/${name}.js"></script>`).join('');
const instrument = `<script>window.bound=[];const originalBind=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(type){if(type==='change'||type==='reset')bound.push([this.id,type]);return originalBind.apply(this,arguments)};</script>`;
const server = http.createServer((req,res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', u.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
  if (u.pathname.startsWith('/core/')) return res.end(fs.readFileSync(path.join(process.env.PASTE_CORE_JS,u.pathname.slice(6))));
  if (u.pathname === '/form-dom.js') return res.end(fs.readFileSync(path.join(root,'modules/utilities/form-dom/form-dom.js')));
  if (u.pathname === '/select.js') return res.end(u.searchParams.has('min') ? optimized : source);
  res.end('<!doctype html><meta charset="utf-8"><title>Select contract</title><style>'+css+'</style>'+
    (u.searchParams.has('empty') ? '' : fixture)+instrument+core+
    '<script src="/form-dom.js"></script><script src="/select.js'+(u.searchParams.has('min')?'?min':'')+'"></script>');
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const results=[];
  try {
    for (const engine of ['chromium','firefox','webkit']) {
      const browser=await playwright[engine].launch({headless:true,proxy:{server:'http://127.0.0.1:9',bypass:'localhost,127.0.0.1'},firefoxUserPrefs:engine==='firefox'?{'extensions.pocket.enabled':false,'browser.newtabpage.enabled':false,'browser.newtabpage.activity-stream.feeds.system.topstories':false}:undefined,...(engine==='chromium'?{executablePath:process.env.ELEMENTS_CHROMIUM_EXECUTABLE}:{})});
      try {
        const baseline=await browser.newContext({javaScriptEnabled:false});
        const native=await baseline.newPage();await native.goto(url);
        assert.equal(await native.locator('#region').isVisible(),true);
        assert.equal(await native.locator('#region').evaluate(e=>getComputedStyle(e).opacity),'1');
        await native.selectOption('#region','ct');assert.equal(await native.inputValue('#region'),'ct');
        assert.equal(await native.locator('#region + span').isVisible(),false);
        await baseline.close();
        for (const min of [false,true]) {
          const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
          await page.goto(url+(min?'?min':''));
          const label=page.locator('#region + span');
          assert.equal(await label.textContent(),'Choose');
          assert.equal(await page.locator('#region').evaluate(e=>getComputedStyle(e).opacity),'0');
          await page.selectOption('#region','ny');assert.equal(await label.textContent(),'New York');
          assert.equal(await page.locator('#region').evaluate(e=>new FormData(e.form).get('region')),'ny');
          await page.locator('#region').focus();await page.locator('#region').press('ArrowUp');
          // Some native pickers commit arrow movement on Enter.
          await page.locator('#region').press('Enter');
          assert.equal(await label.textContent(),await page.locator('#region').evaluate(e=>e.options[e.selectedIndex].label));
          assert.equal(await label.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
          await page.selectOption('#region','ct');await page.selectOption('#external','b');
          await page.getByRole('button',{name:'Reset'}).click();
          await page.waitForFunction(()=>document.querySelector('#region + span').textContent==='Choose');
          assert.equal(await page.locator('#external + span').textContent(),'A');
          await page.selectOption('#region','ct');
          await page.evaluate(()=>document.getElementById('shipping-form').addEventListener('reset',e=>e.preventDefault(),{once:true}));
          await page.getByRole('button',{name:'Reset'}).click();
          assert.equal(await page.inputValue('#region'),'ct');assert.equal(await label.textContent(),'Connecticut');
          assert.equal(await page.locator('#empty + span').textContent(),'');
          for (const id of ['multiple','list','unpaired']) assert.equal(await page.locator('#'+id).getAttribute('data-paste-select-ready'),null);
          const bindings=await page.evaluate(()=>bound.length);
          await page.evaluate(()=>{paste.ui.select.init();paste.ui.select.init(document.getElementById('region'));});
          assert.equal(await page.evaluate(()=>bound.length),bindings);
          await page.evaluate(()=>{const el=document.getElementById('region');el.options[1].label='<b>Text & label</b>';el.value='ct';paste.ui.select.init(el);});
          assert.equal(await label.textContent(),'<b>Text & label</b>');assert.equal(await label.locator('b').count(),0);
          await page.evaluate(()=>document.querySelector('#region + span').hidden=true);
          assert.equal(await page.locator('#region').evaluate(e=>getComputedStyle(e).opacity),'1');
          await page.evaluate(()=>{document.querySelector('#region + span').hidden=false;document.getElementById('region').hidden=true;});
          assert.equal(await label.isVisible(),false);
          await page.evaluate(()=>{document.getElementById('region').hidden=false;});
          await page.emulateMedia({forcedColors:'active'});
          const forcedColors=await page.evaluate(()=>matchMedia('(forced-colors: active)').matches);
          if (forcedColors) {
            assert.equal(await page.locator('#region').evaluate(e=>getComputedStyle(e).opacity),'1');
            assert.equal(await label.isVisible(),false);
          }
          assert.deepEqual(errors,[]);
          await page.goto(url+'?empty'+(min?'&min':''));assert.deepEqual(await page.evaluate(()=>bound),[]);
          results.push({engine,version:browser.version(),minified:min,pass:true,nativeBaseline:true,keyboard:true,focusVisible:true,formData:true,reset:true,cancelledReset:true,externalFormControl:true,emptyAndListbox:true,textSafety:true,repeatInit:true,hiddenFallback:true,forcedColorsEmulated:forcedColors,emptyPageListeners:0});
          await page.close();
        }
      } finally {await browser.close();}
    }
    fs.writeFileSync(path.join(built,'browser-results.json'),JSON.stringify(results,null,2)+'\n');
    console.log('PASS select: source and minified output, native baseline and interaction in all three engines.');
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
