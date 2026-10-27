// Build with paste-assetgraph build --config tests/consistency-assets.conf.
// Run with PASTE_CORE_JS and Playwright installed; optional ELEMENTS_BROWSER,
// ELEMENTS_BROWSER_EXECUTABLE, PLAYWRIGHT_MODULE and ELEMENTS_CONSISTENCY_BUILD.
// Evidence records operation counts, not a runtime speedup claim.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.ELEMENTS_BROWSER || 'chromium';
const root = path.resolve(__dirname, '..');
const build = process.env.ELEMENTS_CONSISTENCY_BUILD || path.join(root, 'target/consistency-assets');
const manifest = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json')));
const output = path.join(root, 'target', 'consistency-' + engine + '-probes.json');
function css(name) { return fs.readFileSync(path.join(build, manifest.assets[name].output), 'utf8'); }
// Exercise the real compiled fallback on modern engines, outside @supports.
const marqueeCSS = css('css/modules/marquee/marquee.css');
const fallbackAt = marqueeCSS.search(/@supports\s+not\s+selector\(\s*:dir\(rtl\)\s*\)/);
assert.ok(fallbackAt >= 0);
const fallbackStart = marqueeCSS.indexOf('{', fallbackAt) + 1;
let fallbackEnd = fallbackStart, depth = 1;
while (depth && fallbackEnd < marqueeCSS.length) {
  const c = marqueeCSS[fallbackEnd++];
  if (c === '{') depth++; else if (c === '}') depth--;
}
const directionCSS = marqueeCSS.slice(fallbackStart, fallbackEnd - 1);
const common = ['paste', 'util', 'oop', 'guid', 'dom', 'event', 'has', 'io'].map(n => '/core/' + n + '.js');
const frame = '/modules/utilities/animation-frame/animation-frame.js';
const panels = key => `<div id="${key}-a" data-multistate-key="${key}" data-multistate-value="a">A</div><div id="${key}-b" data-multistate-key="${key}" data-multistate-value="b">B</div>`;
const dimension = key => `<input id="${key}-radio-a" type="radio" name="${key}" value="a" data-multistate-key="${key}" checked><input id="${key}-radio-b" type="radio" name="${key}" value="b" data-multistate-key="${key}">` + panels(key);
const pages = {
  validation: {markup:'<iframe name="result"></iframe><form id="ordinary" action="/capture" target="result"><input required><button id="validate">Validate</button><button id="bypass" formnovalidate>Draft</button></form>',scripts:['/modules/utilities/form-dom/form-dom.js','/modules/utilities/io-html-fragment/io-html-fragment.js','/modules/form/form_validity/form_validity.js','/modules/form/form_html/form_html.js'],setup:'window.invalidCount=0;ordinary.addEventListener("invalid",()=>invalidCount++,true);'},
  reentry: {markup:'<div data-paste-io-reply-fragment-target><form id="first" data-paste-form method="post" action="/capture?first"><button>One</button></form><form id="second" data-paste-form method="post" action="/capture?second"><button>Two</button></form></div>',scripts:['/modules/utilities/form-dom/form-dom.js','/modules/utilities/io-html-fragment/io-html-fragment.js','/modules/form/form_validity/form_validity.js','/modules/form/form_html/form_html.js'],setup:'first.addEventListener("formdata",()=>second.requestSubmit());'},
  filenames: {markup:'<iframe name="result"></iframe><form id="native" action="/capture" target="result"><button>Native</button></form><div data-paste-io-reply-fragment-target><form id="enhanced" data-paste-form action="/capture"><button>Enhanced</button></form></div>',scripts:['/modules/utilities/form-dom/form-dom.js','/modules/utilities/io-html-fragment/io-html-fragment.js','/modules/form/form_validity/form_validity.js','/modules/form/form_html/form_html.js'],setup:'for(const id of ["native","enhanced"]) document.getElementById(id).addEventListener("formdata",e=>e.formData.append("file",new File(["x"],"a\\nb.txt")));'},
  binding: {markup:'<form data-ui-autosave="title" data-autosave-action="/autosave"><input id="draft" name="title"></form><div data-paste-io-reply-fragment-bind="bad attr=message"></div><div id="valid" data-paste-io-reply-fragment-bind="title=message"></div>',scripts:['/modules/utilities/form-dom/form-dom.js','/modules/utilities/io-html-fragment/io-html-fragment.js','/modules/form/form_autosave/form_autosave.js']},
  stickyInsert: {markup:'<nav data-paste-sticky-nav>Nav</nav>',scripts:[frame,'/modules/stickynav/stickynav.js']},
  multi: {markup: dimension('one') + dimension('two'), scripts: ['/modules/multistate/multistate.js']},
  select: {markup: '<select id="choice" data-multistate-key="one"><option value="a">A</option><option value="b">B</option></select>' + panels('one'), scripts: ['/modules/multistate/multistate.js']},
  form: {markup: '<div data-paste-io-reply-fragment-target><form id="form" data-paste-form action="/submit"><button>Send</button></form></div>', setup: 'window.URLSearchParams = undefined;', scripts: ['/modules/utilities/form-dom/form-dom.js','/modules/utilities/io-html-fragment/io-html-fragment.js','/modules/form/form_validity/form_validity.js','/modules/form/form_html/form_html.js']},
  sticky: {markup: '<div data-paste-sticky-target style="height:400px">Header</div><nav data-paste-sticky-nav data-sticky-min-width="2000">Navigation</nav><main style="height:3000px">Content</main>', scripts: [frame, '/modules/stickynav/stickynav.js']},
  nativeField: {markup: '<style>textarea{width:200px;min-height:80px;max-height:400px;box-sizing:border-box;field-sizing:content}</style><textarea id="field"></textarea>', scripts: []},
  sequence: {
    markup: '<section data-paste-scrollscrub data-scrub-mode="container"><div id="scene" data-paste-imagesequence="#frames" style="width:200px;height:200px;background-image:url(/a.svg)"></div></section><main style="height:4000px"></main><script type="application/json" id="frames">{"frames":[{"src":"/a.svg","width":200,"height":200},{"src":"/b.svg","width":200,"height":200}]}</script>',
    setup: `window.intervention=[];const scene=document.getElementById('scene');new MutationObserver(()=>{const value=scene.style.backgroundImage;if(value.includes('/b.svg')&&!intervention.length){intervention.push(value);scene.style.backgroundImage='url(/foreign.svg)';intervention.push(scene.style.backgroundImage)}}).observe(scene,{attributes:true,attributeFilter:['style']});`,
    scripts: [frame,'/modules/utilities/mediaquery/mediaquery.js','/modules/utilities/scrollrange/scrollrange.js','/modules/utilities/imageresolution/imageresolution.js','/modules/imagesequence/imagesequence.js']
  },
  direction: {markup: '<div dir="rtl"><div dir="ltr"><div class="paste-ui-marquee" id="rtl-host" dir="rtl">RTL</div></div></div><style>' + directionCSS + '</style>',scripts: []},
  focus: {markup: '<link rel="stylesheet" href="/css/main.css"><div class="paste-ui-form-field"><label for="input">Name</label><input id="input" value="Text"></div><label for="native-input">Native control</label><input id="native-input" value="Text">',scripts: []},
  hidden: {
    markup: ['/css/main.css','/css/structure/grid/grid.css','/css/structure/layout/layout.css','/css/modules/heroscroll/heroscroll.css','/css/modules/marquee/marquee.css','/css/modules/sectionnav/sectionnav.css'].map(src=>`<link rel="stylesheet" href="${src}">`).join('')+'<button hidden id="native-hidden">Native hidden button</button><section hidden id="semantic-hidden">Hidden semantic section</section><button hidden class="paste-ui-button" id="button-hidden">Hidden skip control</button><div class="paste-ui-form-field"><input hidden id="input-hidden" value="Hidden input"></div><div hidden class="paste-row" id="grid-hidden">Hidden row</div><div hidden class="paste-page" id="page-hidden">Hidden page</div><section hidden class="paste-ui-hero" id="hero-hidden">Hidden hero</section><section hidden class="paste-ui-marquee" id="marquee-hidden">Hidden marquee</section><nav hidden class="paste-ui-section-nav" id="nav-hidden">Hidden navigation</nav>',scripts: []
  }
};
const instrumentation = `
window.audit={listeners:[],rect:0,style:0,checked:[],frames:0};
const add=EventTarget.prototype.addEventListener, rect=Element.prototype.getBoundingClientRect, style=window.getComputedStyle, raf=window.requestAnimationFrame;
EventTarget.prototype.addEventListener=function(type){audit.listeners.push({type,id:this.id||'',tag:this.tagName||'window'});return add.apply(this,arguments)};
Element.prototype.getBoundingClientRect=function(){audit.rect++;return rect.apply(this,arguments)};
window.getComputedStyle=function(){audit.style++;return style.apply(this,arguments)};
window.requestAnimationFrame=function(){audit.frames++;return raf.apply(this,arguments)};
const checked=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked');
Object.defineProperty(HTMLInputElement.prototype,'checked',{...checked,set(value){audit.checked.push({id:this.id,value});return checked.set.call(this,value)}});
window.resetAudit=()=>{audit.rect=0;audit.style=0;audit.checked=[];audit.frames=0};`;
const captured = [];
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if(url.pathname === '/autosave') {
    req.resume(); res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({meta:{code:200},data:{variables:{message:'Kept'}}}));return;
  }
  if(url.pathname === '/capture') {
    let body='';req.on('data',b=>body+=b);req.on('end',()=>{
      captured.push({method:req.method,query:url.search,body,xhr:req.headers['x-requested-with']||''});
      res.setHeader('Content-Type','text/html');res.end('<p>Complete</p>');
    });return;
  }
  if(url.pathname.startsWith('/css/')){res.setHeader('Content-Type','text/css');res.end(css(url.pathname.slice(1)));return;}
  if(/^\/(?:a|b|foreign)\.svg$/.test(url.pathname)){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="green"/></svg>');return;}
  let file;
  if (url.pathname.startsWith('/core/')) file = path.join(process.env.PASTE_CORE_JS, url.pathname.slice(6));
  if (url.pathname.startsWith('/modules/')) {
    const basename = path.basename(url.pathname);
    const modulePath = 'paste/ui/' + (url.pathname.startsWith('/modules/utilities/') ? 'utilities/' : '') + basename;
    file = process.env.ELEMENTS_SOURCE_ROOT ? path.join(process.env.ELEMENTS_SOURCE_ROOT, modulePath) : path.join(root, url.pathname);
  }
  if (file) {res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));return;}
  const entry = pages[url.pathname.slice(1)];
  if (!entry) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html');
  res.end('<!doctype html><meta charset="utf-8"><title>Consistency review</title>'+entry.markup+'<script>'+instrumentation+(entry.setup||'')+'</script>'+[...common,...entry.scripts].map(s=>`<script src="${s}"></script>`).join(''));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await playwright[engine].launch({proxy:{server:'http://127.0.0.1:9',bypass:'localhost,127.0.0.1'},firefoxUserPrefs:engine==='firefox'?{'extensions.pocket.enabled':false,'browser.newtabpage.enabled':false,'browser.newtabpage.activity-stream.feeds.system.topstories':false}:undefined,executablePath:process.env.ELEMENTS_BROWSER_EXECUTABLE,args:engine === 'chromium' ? ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : []});
  const results=[];
  const page=await browser.newPage({viewport:{width:1000,height:700},hasTouch:false});
  try {
    for (const name of Object.keys(pages)) {
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      captured.length=0;
      await page.goto(`http://127.0.0.1:${server.address().port}/${name}`);
      await page.waitForTimeout(150);
      const initial=await page.evaluate(()=>JSON.parse(JSON.stringify(audit)));
      let evidence;
      if(name==='validation'){
        const before=await page.evaluate(()=>invalidCount);
        await page.locator('#validate').click();
        assert.equal(captured.length,0);
        assert.ok(await page.evaluate(n=>invalidCount>n,before));
        assert.equal(await page.evaluate(()=>document.activeElement===ordinary.querySelector('input')),true);
        assert.equal(await page.evaluate(()=>ordinary.noValidate),false);
        await page.locator('#bypass').click();await page.waitForTimeout(100);assert.equal(captured.length,1);
        await page.evaluate(()=>ordinary.noValidate=true);
        await page.locator('#validate').click();await page.waitForTimeout(100);assert.equal(captured.length,2);
        await page.evaluate(()=>ordinary.setAttribute('data-not-allowed','true'));
        await page.locator('#validate').click();await page.waitForTimeout(100);assert.equal(captured.length,2);
        evidence={nativeValidation:true,bypasses:2,veto:true};
      }else if(name==='reentry'){
        await page.locator('#first button').click();await page.waitForTimeout(200);
        assert.equal(captured.length,1);assert.equal(captured[0].query,'?first');assert.equal(captured[0].xhr,'XMLHttpRequest');
        evidence=captured.slice();
      }else if(name==='filenames'){
        evidence=[];
        for(const method of ['get','post']){
          if(method==='post') {await page.reload();await page.waitForTimeout(100);await page.evaluate(()=>{document.getElementById('native').method='post';document.getElementById('enhanced').method='post'});}
          captured.length=0;
          await page.locator('#native button').click();await page.waitForTimeout(100);
          await page.locator('#enhanced button').click();await page.waitForTimeout(100);
          assert.equal(captured.length,2);const field=method==='get'?'query':'body';
          assert.equal(captured[0][field],captured[1][field]);assert.ok(captured[1][field].includes('file=a%0D%0Ab.txt'));
          evidence.push({method,native:captured[0],enhanced:captured[1]});
        }
      }else if(name==='binding'){
        await page.locator('#draft').fill('Changed');
        await page.waitForFunction(()=>document.getElementById('valid').getAttribute('title')==='Kept');
        assert.equal(await page.locator('#valid').getAttribute('title'),'Kept');evidence={validSibling:'Kept'};
      }else if(name==='stickyInsert'){
        evidence=await page.evaluate(async()=>{let scans=0,visited=0;const q=Element.prototype.querySelectorAll;Element.prototype.querySelectorAll=function(selector){const result=q.call(this,selector);if(selector==='*'){scans++;visited+=result.length}return result};const box=document.createElement('section');box.innerHTML='<p>Unrelated</p>'.repeat(1000);document.body.appendChild(box);await new Promise(r=>setTimeout(r,30));Element.prototype.querySelectorAll=q;return {scans,visited}});
        assert.deepEqual(evidence,{scans:0,visited:0});
      }else if(name==='multi'){
        await page.evaluate(()=>{
          window.mutations=[];
          new MutationObserver(records=>records.forEach(r=>mutations.push({id:r.target.id,attribute:r.attributeName}))).observe(document.body,{attributes:true,subtree:true});
          resetAudit();
        });
        await page.locator('#one-radio-b').check();
        evidence=await page.evaluate(()=>({checked:audit.checked,mutations,selection:[...document.querySelectorAll('[data-multistate-state]')].map(e=>e.id)}));
        assert.deepEqual(evidence.selection,['one-b','two-a']);
      }else if(name==='select'){
        await page.selectOption('#choice','b');
        evidence=await page.evaluate(()=>({ownsChecked:Object.hasOwn(document.getElementById('choice'),'checked'),checked:document.getElementById('choice').checked,selection:[...document.querySelectorAll('[data-multistate-state]')].map(e=>e.id),hash:location.hash}));
      }else if(name==='sticky'){
        await page.evaluate(()=>{resetAudit();dispatchEvent(new Event('resize'))});
        await page.waitForTimeout(100);
        evidence=await page.evaluate(()=>({rect:audit.rect,style:audit.style,frames:audit.frames,stuck:document.querySelector('nav').classList.contains('paste-ui-sticky-active')}));
      }else if(name==='form'){
        // Validation now has its own lifetime. Missing HTML transport support
        // must leave a valid submit uncanceled while retaining that one listener.
        evidence={submitListeners:initial.listeners.filter(l=>l.type==='submit'),
          defaultAllowed:await page.evaluate(()=>document.getElementById('form').dispatchEvent(new SubmitEvent('submit',{cancelable:true,bubbles:true})))};
      }else if(name==='sequence'){
        await page.evaluate(()=>scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForFunction(()=>intervention.length===2);
        await page.waitForTimeout(150);
        evidence=await page.evaluate(()=>({intervention,finalInline:document.getElementById('scene').style.backgroundImage,finalComputed:getComputedStyle(document.getElementById('scene')).backgroundImage}));
      }else if(name==='direction'){
        evidence=await page.evaluate(()=>{const style=getComputedStyle(document.getElementById('rtl-host'));return {direction:style.direction,sign:style.getPropertyValue('--paste-marquee-inline-sign')}});
      }else if(name==='focus'){
        await page.emulateMedia({forcedColors:'active'});
        const read=()=>{const el=document.getElementById('input'),s=getComputedStyle(el);return {focused:document.activeElement===el,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,borderColor:s.borderColor,borderWidth:s.borderWidth,boxShadow:s.boxShadow,forced:matchMedia('(forced-colors:active)').matches}};
        const before=await page.evaluate(read);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(250);
        const after=await page.evaluate(read);
        await page.keyboard.press('Tab');
        const native=await page.evaluate(()=>{const el=document.getElementById('native-input'),s=getComputedStyle(el);return {focused:document.activeElement===el,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,borderColor:s.borderColor,boxShadow:s.boxShadow}});
        evidence={before,after,native};
      }else if(name==='hidden'){
        evidence=await page.evaluate(()=>[...document.querySelectorAll('[hidden]')].map(el=>({id:el.id,hidden:el.hidden,display:getComputedStyle(el).display,rendered:el.getClientRects().length>0})));
      }else{
        evidence=await page.evaluate(()=>{const f=document.getElementById('field');const initial=f.offsetHeight;f.value=Array(15).fill('Text').join('\n');const grown=f.offsetHeight;f.style.height='300px';f.value='short';return {supports:CSS.supports('field-sizing','content'),initial,grown,afterExplicitHeight:f.offsetHeight}});
      }
      assert.deepEqual(errors, [], name + ' page errors');
      if (name === 'multi') {
        assert.equal(initial.checked.length, 0);
        assert.equal(evidence.checked.length, 0, 'native radio selection needed no checked writes');
        assert.equal(evidence.mutations.length, 4);
        assert.ok(evidence.mutations.every(r => r.id.startsWith('one-')));
      } else if (name === 'select') {
        assert.equal(evidence.ownsChecked, false);
        assert.equal(evidence.hash, '');
        assert.deepEqual(evidence.selection, []);
      } else if (name === 'form') {
        assert.deepEqual(evidence.submitListeners,[{type:'submit',id:'form',tag:'FORM'}]);
        assert.equal(evidence.defaultAllowed,true);
      }
      else if (name === 'sticky') {
        assert.equal(evidence.rect, 0); assert.equal(evidence.style, 0);
      } else if (name === 'sequence') assert.ok(evidence.finalInline.includes('/foreign.svg'));
      else if (name === 'direction') assert.equal(evidence.sign.trim(), '-1');
      else if (name === 'focus' && evidence.after.forced) {
        assert.equal(evidence.after.outlineStyle, 'solid');
        assert.equal(evidence.after.outlineWidth, '2px');
      } else if (name === 'hidden') {
        assert.ok(evidence.every(e => !e.rendered), 'native hidden was overridden');
        const untilFound = await page.evaluate(() => {
          const row = document.getElementById('grid-hidden');
          row.setAttribute('hidden', 'until-found');
          const style = getComputedStyle(row);
          return {display: style.display, visibility: style.contentVisibility};
        });
        assert.equal(untilFound.display, 'flex', 'until-found lost authored layout');
        const authored = await page.evaluate(() => {
          const row = document.getElementById('grid-hidden');
          row.removeAttribute('hidden');
          row.classList.add('authored-layout');
          const sheet = document.createElement('style');
          sheet.textContent = '.authored-layout { display: grid; }';
          document.head.appendChild(sheet);
          return getComputedStyle(row).display;
        });
        assert.equal(authored, 'grid', 'hidden guard increased component specificity');
      }
      results.push({name,initial,evidence,errors});
      fs.writeFileSync(output,JSON.stringify({browser:browser.version(),results},null,2));
      page.removeAllListeners('pageerror');
    }
    fs.writeFileSync(output,JSON.stringify({browser:browser.version(),results},null,2));
    console.log(JSON.stringify(results.map(({name,evidence,errors})=>({name,evidence,errors})),null,2));
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
