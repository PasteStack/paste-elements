// Run: PASTE_ASSETGRAPH_BIN=/path/to/paste-assetgraph node tests/style-contract-checks.cjs
// Add --browser with PLAYWRIGHT_MODULE / ELEMENTS_BROWSER_EXECUTABLE for native CSS checks.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),work=fs.mkdtempSync(path.join(os.tmpdir(),'paste-styles-'));
const minify=process.argv.includes('--minify');
const binary=process.env.PASTE_ASSETGRAPH_BIN||'paste-assetgraph';
// Compiler-only mode exercises the same SCSS contracts with Dart Sass when
// the private assetgraph executable is unavailable. It is not a graph-build check.
const sass=process.env.PASTE_SASS_MODULE ? require(process.env.PASTE_SASS_MODULE) : null;
const imports=names=>names.map(n=>'@import '+JSON.stringify(path.join(root,n))+';').join('\n');
const definitions=['base/mixins',...['grid','layout','spacing','typography'].map(n=>'structure/'+n+'/mixin'),...['form','button','address','autogrow','heroscroll','imagesequence','marquee','sectionnav','js_tooltip','imageupload','select','carousel'].map(n=>'modules/'+n+'/mixin'),'modules/form/form_apply/mixin'];
function compile(samples,expectError){
 if(sass){
  let compiled;
  try { compiled=Object.fromEntries(Object.entries(samples).map(([name,source])=>[name,sass.compileString(source,{loadPaths:[root],style:minify?'compressed':'expanded',logger:sass.Logger.silent}).css])); }
  catch(error){if(!expectError)throw error;assert.match(String(error),expectError);return;}
  assert.equal(expectError,undefined,'invalid input unexpectedly compiled');return compiled;
 }
 const dir=fs.mkdtempSync(path.join(work,'case-')),src=path.join(dir,'src'),out=path.join(dir,'out');fs.mkdirSync(src);
 for(const [n,s] of Object.entries(samples))fs.writeFileSync(path.join(src,n+'.scss'),s);
 const conf=path.join(dir,'build.conf');fs.writeFileSync(conf,'source.scss = '+JSON.stringify(src)+'\ninclude-paths = ['+JSON.stringify(root)+']\noutput.base = '+JSON.stringify(out)+'\nmanifest = '+JSON.stringify(path.join(out,'manifest.json'))+'\nminify = '+minify+'\nsource-maps = false\n');
 const run=spawnSync(binary,['build','--config',conf,'--cwd',dir],{encoding:'utf8'});if(run.error)throw run.error;
 if(expectError){assert.notEqual(run.status,0);assert.match(run.stdout+run.stderr,expectError);return;}
 assert.equal(run.status,0,run.stdout+run.stderr);const m=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
 return Object.fromEntries(Object.keys(samples).map(n=>[n,fs.readFileSync(path.join(out,m.assets['css/'+n+'.css'].output.replace(/^\//,'')),'utf8')]));
}
(async()=>{let browser;try{
 const silent=compile(Object.fromEntries([...definitions,'base/rem','base/transition','base/media-queries','base/no3d','base/badie'].map((name,i)=>['definition'+i,imports([name])])));
 for(const value of Object.values(silent))assert.equal(value.trim(),'','standalone definition import emitted CSS');
 const css=compile({
  componentRoots:imports(['modules/autogrow/mixin','modules/heroscroll/mixin','modules/imagesequence/mixin','modules/marquee/mixin','modules/sectionnav/mixin'])+'\n.consumer { .grow, .grow-two { @include paste-ui-autogrow($min-height:91px); } .hero { @include paste-ui-heroscroll($height:321px); } .sequence { @include paste-ui-imagesequence(); } .ticker { @include paste-ui-marquee($gap:7px); } .nav { @include paste-ui-sectionnav($background:rgb(1,2,3)); } }',
  definitions:imports(definitions),base:imports(['base/base']),
  grid:imports(['structure/grid/grid']),layout:imports(['structure/layout/layout']),
  spacing:imports(['structure/spacing/spacing']),typography:imports(['structure/typography/typography']),
  form:imports(['modules/form/form']),button:imports(['modules/button/button']),address:imports(['modules/address/address']),
  restored:imports(['modules/js_tooltip/mixin','modules/imageupload/mixin'])+'\n.consumer-tip { @include paste-ui-js-tooltip($background:rgb(1,2,3)); } .consumer-upload-message { @include paste-ui-imageupload-message($loading-text:"Saving photo"); }',
  selectCustom:imports(['modules/select/mixin'])+'\n.shop-choice { @include paste-ui-select($background:rgb(1,2,3)); }',
  selectDefault:imports(['modules/select/select']),
  restoredDefaults:imports(['modules/js_tooltip/js_tooltip','modules/imageupload/imageupload']),
  componentScope:imports(['modules/form/mixin','modules/button/mixin','modules/address/mixin'])+'\n.shop { .action { @include paste-ui-button(); } .address { @include paste-ui-address(); } .field { @include paste-ui-form-field(); } .help { @include paste-ui-form-description(); } .error { @include paste-ui-form-error(); } }',
  prefixed:'$paste-prefix:"shop";'+imports(['modules/form/form','modules/button/button','modules/address/address']),
  scoped:imports(['structure/typography/mixin'])+'\n.article { @include paste-typography($root:"&"); }',
  rem:imports(['base/rem'])+'\n.probe { width:rem(32px); height:strip-units(24px)*1px; @include px-rem(margin,0,2,auto,12px); }',
  unitOverride:'$unit-default-px:10px;'+imports(['base/rem'])+'\n.probe {width:fix8_unit_to_px(2);}',
  helpers:'$base-font-size:20px;$experimental-support-for-webkit:true;$legacy-support-for-ie8:true;$breakpoint-mobile:420px;'+imports(['base/rem','base/transition','base/media-queries','base/badie','base/no3d'])+'\n.probe {font-size:rem(40px);@include transition(opacity 1s);@include transition-property(transform);}@include media(mobile){.m{width:1px}}@include badie{.old{height:1px}}@include no3d{.flat{opacity:1}}',
  custom:'$paste-grid-columns:16;$paste-grid-gutter:2rem;$paste-header-height-lg:105px;$paste-spacers:(tiny:3px);'+imports(['structure/grid/grid','structure/layout/layout','structure/spacing/spacing','modules/form/mixin'])+'\n.custom-form-field { @include paste-ui-form-field($focus-color:orange); }'
 });
 assert.match(css.selectCustom,/\.shop-choice/);assert.doesNotMatch(css.selectCustom,/\.paste-ui-select/);assert.match(css.selectDefault,/\.paste-ui-select/);
 assert.doesNotMatch(css.componentScope,/\.paste-ui-/);
 assert.match(css.prefixed,/\.shop-button/);assert.match(css.prefixed,/\.shop-formfield/);assert.match(css.prefixed,/\.shop-address/);assert.doesNotMatch(css.prefixed,/\.paste-ui-/);
 assert.equal(css.definitions.trim(),'','definition imports emitted CSS');
 assert.doesNotMatch(css.restored,/\.ui-js-tooltip|^\s*body\s*\{/m);
 assert.match(css.restored,/\.consumer-tip/);assert.match(css.restored,/Saving photo/);
 assert.match(css.restoredDefaults,/\.ui-js-tooltip/);assert.match(css.restoredDefaults,/data-image-upload-message/);
 assert.doesNotMatch(css.base,/paste-ui-(form|button|address)/);assert.match(css.base,/border-collapse:\s*collapse/);
 assert.doesNotMatch(css.grid,/\[class\*=/);assert.match(css.grid,/\.paste-col-auto/);assert.match(css.grid,/\.paste-col-lg-12/);
 assert.match(css.unitOverride,/width:\s*20px/);
 assert.match(css.rem,/width:\s*2rem/);assert.match(css.rem,/height:\s*24px/);assert.match(css.rem,/margin:\s*0 2rem auto 12px/);
 assert.match(css.helpers,/-webkit-transition:/);assert.match(css.helpers,/-webkit-transition-property:\s*-webkit-transform/);assert.match(css.helpers,/(?:max-width:\s*|width\s*<=\s*)420px/);assert.match(css.helpers,/\.ie8/);
 assert.match(css.custom,/\.paste-col-16/);assert.match(css.custom,/\.paste-m-tiny/);assert.match(css.custom,/height:\s*105px/);assert.match(css.custom,/\.custom-form-field/);assert.doesNotMatch(css.custom,/\.paste-ui-form-field/);
 for(const bad of ['0','-1','1.5','2px','"twelve"'])compile({invalid:'$paste-grid-columns:'+bad+';'+imports(['structure/grid/grid'])},/positive whole number/);
 compile({invalid:'$paste-container-max-widths:(missing:500px);'+imports(['structure/grid/grid'])},/missing from/);
 const demo=fs.readFileSync(path.join(root,'examples/heroscroll.html'),'utf8');assert.match(demo,/href="#paste-heroscroll-demo-content"/);assert.match(demo,/id="paste-heroscroll-demo-content"/);assert.doesNotMatch(demo,/id="content"|class="content"/);
 console.log('PASS Sass definitions, explicit output, helper defaults/overrides, grid validation and demo identity');
 if(process.argv.includes('--browser')){
  const pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await pw.chromium.launch({executablePath:process.env.ELEMENTS_BROWSER_EXECUTABLE,proxy:{server:'http://127.0.0.1:9',bypass:'localhost,127.0.0.1'}});
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  await page.setContent('<style>'+css.restored+'</style><div id="ownedTip" class="consumer-tip">Help</div><span id="ownedUpload" class="consumer-upload-message" data-image-upload-loading></span><div id="otherTip" class="ui-js-tooltip">Other</div>');
  const restored=await page.evaluate(()=>({body:getComputedStyle(document.body).position,own:getComputedStyle(document.getElementById('ownedTip')).position,other:getComputedStyle(document.getElementById('otherTip')).position,message:getComputedStyle(document.getElementById('ownedUpload'),'::after').content}));
  assert.equal(restored.body,'static');assert.equal(restored.own,'fixed');assert.equal(restored.other,'static');assert.match(restored.message,/Saving photo/);
  await page.setContent('<style>'+css.componentScope+'</style><div class="shop"><button class="action" id="ownButton">Submit</button><button class="action" hidden id="ownHidden">Hidden</button><address class="address" id="ownAddress">Address</address><div class="field has-error"><label>Name</label><input id="ownInput"><input type="checkbox" id="ownCheck"></div><div class="help" id="ownHelp">Help</div><div class="error" id="ownError">Error</div></div><button class="action" id="outsideButton">Outside</button>');
  const own=await page.evaluate(()=>Object.fromEntries(['ownButton','ownHidden','ownAddress','ownInput','ownCheck','ownHelp','ownError','outsideButton'].map(id=>{const s=getComputedStyle(document.getElementById(id));return [id,{padding:s.paddingTop,display:s.display,fontStyle:s.fontStyle,fontSize:s.fontSize,color:s.color,border:s.borderTopColor}]})));
  assert.equal(own.ownButton.padding,'8px');assert.notEqual(own.outsideButton.padding,own.ownButton.padding);
  assert.equal(own.ownHidden.display,'none');assert.equal(own.ownAddress.fontStyle,'normal');
  assert.equal(own.ownInput.border,'rgb(220, 53, 69)');assert.equal(own.ownCheck.padding,'0px');
  assert.equal(own.ownHelp.fontSize,'14px');assert.equal(own.ownError.color,'rgb(220, 53, 69)');
  await page.emulateMedia({forcedColors:'active'});await page.locator('#ownInput').focus();
  assert.notEqual(await page.locator('#ownInput').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.emulateMedia({forcedColors:'none'});
  await page.setContent('<style>'+css.componentRoots+'</style><div class="consumer"><textarea id="grow" class="grow"></textarea><textarea id="grow2" class="grow-two"></textarea><section id="hero" class="hero"></section><div id="sequence" class="sequence"></div><section id="ticker" class="ticker"><ul class="paste-ui-marquee-items"><li class="paste-ui-marquee-item">Item</li></ul></section><nav id="nav" class="nav"><ul class="paste-ui-section-nav-items"><li class="paste-ui-section-nav-item"><a id="navLink" class="paste-ui-section-nav-link" href="#destination">Link</a></li></ul><div id="ownPanel" class="paste-ui-section-nav-panel"></div></nav></div><a id="outsideLink" class="paste-ui-section-nav-link">Outside</a><div id="foreignPanel" class="paste-ui-section-nav-panel"></div><div id="destination"></div>');
  const roots=await page.evaluate(()=>Object.fromEntries(['grow','grow2','hero','sequence','ticker','nav','navLink','outsideLink'].map(id=>{const s=getComputedStyle(document.getElementById(id));return [id,{minHeight:s.minHeight,height:s.height,background:s.backgroundColor,size:s.backgroundSize,gap:s.getPropertyValue('--paste-marquee-gap'),padding:s.paddingTop}]})));
  assert.equal(roots.grow.minHeight,'91px');assert.equal(roots.grow2.minHeight,'91px');assert.equal(roots.hero.height,'321px');assert.equal(roots.sequence.size,'cover');assert.equal(roots.ticker.gap.trim(),'7px');assert.equal(roots.nav.background,'rgb(1, 2, 3)');assert.equal(roots.navLink.padding,'10px');assert.equal(roots.outsideLink.padding,'0px');
  await page.setViewportSize({width:500,height:700});
  await page.evaluate(()=>location.hash='foreignPanel');assert.notEqual(await page.evaluate(()=>getComputedStyle(document.documentElement).overflow),'hidden');
  await page.evaluate(()=>location.hash='ownPanel');assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).overflow),'hidden');
  await page.evaluate(()=>location.hash='destination');assert.equal(await page.locator('#destination').evaluate(e=>getComputedStyle(e).scrollMarginTop),'51px');
  await page.setViewportSize({width:1200,height:800});
  await page.setContent('<style>'+css.base+'</style><div class="paste-ui-form-field"><input id=f></div><button id=b class=paste-ui-button>Button</button>');
  const plain=await page.locator('#f').evaluate(e=>({width:getComputedStyle(e).width,padding:getComputedStyle(e).paddingTop}));assert.notEqual(plain.width,'1200px');
  await page.setContent('<style>'+css.grid+'</style><div id=foreign class="site-paste-col-6-preview"></div><div id=column class=paste-col-6></div><div id=responsive class=paste-col-lg-6></div><div id=auto class=paste-col-auto></div><div id=row hidden class=paste-row></div>');
  const box=await page.evaluate(()=>Object.fromEntries(['foreign','column','responsive','auto','row'].map(id=>{const s=getComputedStyle(document.getElementById(id));return [id,{padding:s.paddingLeft,width:s.maxWidth,display:s.display}]})));
  assert.equal(box.foreign.padding,'0px');assert.equal(box.column.padding,'12px');assert.equal(box.column.width,'50%');assert.equal(box.responsive.width,'50%');assert.equal(box.auto.padding,'12px');assert.equal(box.row.display,'none');
  await page.setContent('<style>'+css.scoped+'</style><h1 id=outside>Outside</h1><div class=article><h1 id=inside>Inside</h1><a href=#>Link</a></div>');
  const type=await page.evaluate(()=>({outside:getComputedStyle(document.getElementById('outside')).fontSize,inside:getComputedStyle(document.getElementById('inside')).fontSize}));assert.equal(type.inside,'40px');assert.notEqual(type.outside,type.inside);
  await page.setContent('<style>'+css.form+css.button+css.address+css.layout+'</style><div class=paste-ui-formfield><input id=input><input type=checkbox id=checkbox><input hidden id=hidden><label hidden id=label>Label</label></div><button hidden class=paste-ui-button id=button>Button</button><div hidden class=paste-page id=page></div><address class=paste-ui-address id=address>Address</address>');
  for(const id of ['hidden','label','button','page'])assert.equal(await page.locator('#'+id).evaluate(e=>getComputedStyle(e).display),'none');
  assert.equal(await page.locator('#checkbox').evaluate(e=>getComputedStyle(e).paddingTop),'0px');
  await page.emulateMedia({forcedColors:'active'});await page.locator('#input').focus();assert.notEqual(await page.locator('#input').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  assert.equal(await page.locator('#address').evaluate(e=>getComputedStyle(e).fontStyle),'normal');
  console.log('PASS consumer-owned component selectors, native selector isolation, responsive/auto grid, scoped typography, hidden controls and forced-color focus in '+browser.version());await page.close();
 }
}finally{if(browser)await browser.close();fs.rmSync(work,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
