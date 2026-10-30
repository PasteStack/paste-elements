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

const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readModuleSource}=require('./fakes.cjs');
const HREF='https://example.test/page#section';
function fixture(options={}) {
 const callbacks=new Map(),listeners=[],pushes=[],moves=[],order=[],selectors=[];let serial=0,gets=0,intoView=0,command,api;
 const location=new URL('https://example.test/page');location.replace=hash=>{order.push('replace '+hash);if(options.refuseReplace)throw new Error('refused');};
 const id=options.id||'section';
 const target={id,getBoundingClientRect:()=>({top:600-window.pageYOffset}),scrollIntoView(){intoView+=1;}};
 const anchor=Object.assign(new URL('#'+id,location),{nodeName:'A',hasAttribute:()=>false,getAttribute:()=>null,closest:sel=>sel.split(',').some(one=>(one=one.trim())==='.paste-ui-section-nav-disclosure'?options.disclosure:one==='.paste-ui-section-nav-toggle'?options.toggle:one==='.paste-ui-section-nav-panel:target'?options.panelOpen:false)?{}:null});
 const window={WeakSet:options.noWeakSet?undefined:WeakSet,location,pageYOffset:100,pageXOffset:25,name:'',matchMedia:()=>({matches:!!options.reduced}),
 history:{pushState(state,title,hash){pushes.push({state,hash});order.push('push '+hash);location.hash=hash;}},scrollTo(v){moves.push(v);order.push('scroll '+v.top);window.pageYOffset=v.top;},getComputedStyle:options.noStyle?undefined:el=>el&&el.probe?{scrollMarginTop:options.navVar}:el===target?{scrollMarginTop:(options.margin||0)+'px'}:{scrollPaddingTop:options.padding===undefined?'0px':typeof options.padding==='string'?options.padding:options.padding+'px',getPropertyValue:k=>options.native&&k==='--paste-smoothscroll-motion'?' native ':k==='--paste-ui-section-nav-clearance'&&options.navVar?' calc(3.5rem + 51px) ':''}};
 const document={activeElement:null,readyState:options.loading?'loading':'complete',querySelector:()=>null,getElementById:k=>k===id?target:null,documentElement:{clientHeight:800},createElement:()=>({probe:true,style:{}}),body:{children:[],appendChild(n){this.children.push(n);},removeChild(n){this.children.splice(this.children.indexOf(n),1);}}};
 const event={getEventTarget:e=>e.target,bind(type,el,fn){listeners.push({type,el,fn});}};
 event.Event=function(){this.subscribe=fn=>{command=fn;return {};};};
 event.Event.Subscription=function(type,el,fn){const b={type,el,fn};listeners.push(b);this.dispose=()=>{const i=listeners.indexOf(b);if(i>=0)listeners.splice(i,1);};};
 const frame={request(fn){callbacks.set(++serial,fn);return serial;},cancel(id){callbacks.delete(id);}};
 vm.runInNewContext(readModuleSource('paste/ui/smoothscroll.js'),{window,document,paste:{define(name,deps,factory){api=factory({},{get:sel=>{gets+=1;selectors.push(sel);return [anchor];},getScrollTop:()=>window.pageYOffset,querySelector:()=>options.nav?{getBoundingClientRect:()=>({height:options.nav})}:null},event,frame);}}});
 return {api,window,document,target,anchor,pushes,moves,order,selectors,listeners,gets:()=>gets,intoView:()=>intoView,command:data=>command({},data),
 tick(time){const batch=[...callbacks.values()];callbacks.clear();batch.forEach(fn=>fn(time));},
 click(extra={}){const e={target:anchor,currentTarget:anchor,preventDefault(){this.defaultPrevented=true;},...extra};listeners.find(x=>x.type==='click').fn(e);return e;},
 wheel(){listeners.find(x=>x.type==='wheel').fn();},pop(){listeners.find(x=>x.type==='popstate').fn();},pending:()=>callbacks.size};
}
test('a declared link animates cubic motion without native navigation and pushes at completion',()=>{const f=fixture();assert.equal(f.click().defaultPrevented,true);assert.equal(f.pushes.length,0);assert.equal(f.moves.length,0);f.tick(0);f.tick(250);assert.equal(f.window.pageYOffset,350);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pending(),0);assert.equal(f.moves.at(-1).left,25);assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].hash,'#section');});
test('only declared containers are discovered, so any other link, an undeclared section nav\'s included, stays native',()=>{const f=fixture();assert.deepEqual(f.selectors,['[data-paste-smoothscroll]']);});

test('element API honors duration without changing history',()=>{const f=fixture();f.api.scrollTo(f.target,1000);f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,350);f.tick(1000);assert.equal(f.window.pageYOffset,600);assert.equal(f.pushes.length,0);});
test('legacy event applies offset and pushes only at completion',()=>{const f=fixture();f.command({newURL:'section',verticalOffset:80});assert.equal(f.pushes.length,0);f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,520);assert.equal(f.pushes.length,1);});
test('legacy boolean parsing preserves suppressed history',()=>{for(const updateHash of [false,'false','FALSE','',0,null,undefined]){const f=fixture();f.command({newURL:'section',updateHash});f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pushes.length,0);}});
test('legacy true strings retain case-insensitive opt-in',()=>{const f=fixture();f.command({newURL:'section',updateHash:'TRUE'});f.tick(0);f.tick(500);assert.equal(f.pushes.length,1);});
test('id API retains zero offset and completion history',()=>{const f=fixture();f.api.scrollTo('section',0);f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pushes[0].hash,'#section');});
test('wheel cancels movement and pending history',()=>{const f=fixture();f.command({newURL:'section'});f.tick(0);f.tick(100);const y=f.window.pageYOffset;f.wheel();f.tick(500);assert.equal(f.window.pageYOffset,y);assert.equal(f.pushes.length,0);assert.equal(f.pending(),0);});
test('replacement movement cancels prior completion history',()=>{const f=fixture();f.command({newURL:'section'});f.tick(0);f.api.scrollTo(f.target,100);f.tick(10);f.tick(110);assert.equal(f.pushes.length,0);});
test('reduced motion lands immediately with intended history',()=>{const f=fixture({reduced:true});f.click();assert.equal(f.window.pageYOffset,600);assert.equal(f.pending(),0);assert.equal(f.pushes.length,1);});
test('repeat initialization does not duplicate click bindings',()=>{const f=fixture();f.api.init();f.api.init();assert.equal(f.listeners.filter(x=>x.type==='click').length,1);});
test('modified, foreign and missing-target links remain native',()=>{for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}]){const f=fixture();f.click(extra);assert.equal(f.pushes.length,0);}for(const href of ['https://other.test/#section','/other#section','?other#section','#missing']){const f=fixture();f.anchor.href=new URL(href,f.window.location).href;assert.equal(f.click().defaultPrevented,undefined);}});

// The legacy command without data resolves the current fragment.
test('legacy event without data moves to the current fragment and settles it without a second entry',()=>{const f=fixture();f.window.location.hash='#section';f.command();f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pushes.length,0);assert.equal(f.order.at(-1),'replace '+HREF);});

test('legacy membership fallback keeps repeated init idempotent',()=>{const f=fixture({noWeakSet:true});f.api.init();f.api.init();assert.equal(f.listeners.filter(x=>x.type==='click').length,1);});
test('native motion steps aside: no link is discovered or bound, so clicks stay native',()=>{const f=fixture({native:true});assert.equal(f.gets(),0);assert.equal(f.listeners.filter(x=>x.type==='click').length,0);f.api.init();assert.equal(f.gets(),0);assert.equal(f.listeners.filter(x=>x.type==='click').length,0);assert.equal(f.pushes.length,0);assert.equal(f.moves.length,0);});
test('native motion routes the event and APIs through the platform',()=>{const f=fixture({native:true});f.command({newURL:'section'});assert.equal(f.window.location.hash,'#section');const g=fixture({native:true});g.command({newURL:'section',updateHash:false});assert.equal(g.intoView(),1);assert.equal(g.window.location.hash,'');const h=fixture({native:true});h.api.scrollTo('section');assert.equal(h.window.location.hash,'#section');const k=fixture({native:true});k.api.scrollTo(k.target);assert.equal(k.intoView(),1);});
test('native motion scrolls a target the address already names instead of setting the same hash',()=>{const f=fixture({native:true});f.window.location.hash='#section';f.api.scrollTo('section');assert.equal(f.intoView(),1);f.command({newURL:'section'});assert.equal(f.intoView(),2);assert.equal(f.window.location.hash,'#section');});
test('native motion ignores a missing target, as the default motion does',()=>{const f=fixture({native:true});f.api.scrollTo('missing');f.command({newURL:'missing'});assert.equal(f.window.location.hash,'');assert.equal(f.intoView(),0);});
test('native motion subscribes nothing while the document is still loading',()=>{const f=fixture({native:true,loading:true});assert.equal(f.listeners.filter(x=>x.type==='DOMContentLoaded').length,0);const g=fixture({loading:true});assert.equal(g.listeners.filter(x=>x.type==='DOMContentLoaded').length,1);});
test('a host without getComputedStyle keeps the default motion',()=>{const f=fixture({noStyle:true});assert.equal(f.listeners.filter(x=>x.type==='click').length,1);const e=f.click();assert.equal(e.defaultPrevented,true);});

// Without an explicit offset the motion keeps the clearance native fragment
// navigation keeps, so a page's CSS clearance holds in both motions.
function land(f,act){act(f);f.tick(0);f.tick(500);return f.window.pageYOffset;}
test('declared links keep the target scroll-margin-top plus the root scroll-padding-top',()=>{assert.equal(land(fixture({margin:40,padding:20}),f=>f.click()),540);});
test('declared links fall back to the measured section nav only when the page declares no clearance',()=>{assert.equal(land(fixture({nav:50}),f=>f.click()),550);assert.equal(land(fixture({nav:50,margin:40}),f=>f.click()),560);assert.equal(land(fixture({nav:50,noStyle:true}),f=>f.click()),550);});
test('the event, id and element APIs keep the page clearance when no offset is given',()=>{assert.equal(land(fixture({margin:40}),f=>f.command({newURL:'section'})),560);assert.equal(land(fixture({margin:40,nav:50}),f=>f.api.scrollTo('section')),560);assert.equal(land(fixture({margin:40}),f=>f.api.scrollTo(f.target)),560);});
test('explicit offsets win over the page clearance',()=>{assert.equal(land(fixture({margin:40}),f=>f.command({newURL:'section',verticalOffset:80})),520);});
test('a missing target or a non-element moves nothing',()=>{const f=fixture({margin:40,nav:50});f.api.scrollTo('missing');f.api.scrollTo({});f.command({newURL:'missing'});assert.equal(f.pending(),0);assert.equal(f.moves.length,0);});

// Once the fragment is written, a same-address replace runs the platform's
// own fragment steps (focus starting point, :target); the landing is then
// re-asserted over the replace's own scroll to the fragment.
test('completion history settles after its push, and reduced motion lands and settles at once',()=>{const f=fixture();f.command({newURL:'section'});f.tick(0);f.tick(500);assert.deepEqual(f.order.slice(-3),['push #section','scroll 600','replace '+HREF]);const g=fixture({reduced:true,margin:40});g.click();assert.deepEqual(g.order,['scroll 560','scroll 100','push #section','scroll 560','replace '+HREF]);});
test('the platform\'s own scroll to the fragment lands an implicit settle; an explicit offset is held over it',()=>{const f=fixture();f.command({newURL:'section',verticalOffset:80});f.tick(0);f.tick(500);assert.deepEqual(f.order.slice(-2),['replace '+HREF,'scroll 520']);assert.equal(f.moves.at(-1).left,25);const g=fixture();g.api.scrollTo('section',0);g.tick(0);g.tick(500);assert.deepEqual(g.order.slice(-2),['replace '+HREF,'scroll 600']);});
test('movement without a written fragment settles nothing',()=>{for(const act of [f=>f.command({newURL:'section',updateHash:false}),f=>f.api.scrollTo(f.target)]){const f=fixture();act(f);f.tick(0);f.tick(500);assert.equal(f.order.some(x=>x.startsWith('replace')),false);}});
test('wheel input settles nothing: the pending completion history is never written',()=>{const g=fixture();g.command({newURL:'section'});g.tick(0);g.tick(100);g.wheel();g.tick(500);assert.equal(g.order.some(x=>x.startsWith('replace')),false);assert.equal(g.pushes.length,0);});
test('a fragment the address does not name settles nothing',()=>{const g=fixture();g.command({newURL:'section'});g.tick(0);g.tick(100);g.window.location.hash='#elsewhere';g.window.history.pushState=(s,t,h)=>g.order.push('push '+h);g.tick(500);assert.equal(g.order.some(x=>x.startsWith('replace')),false);});
test('a platform navigation during the motion supersedes it',()=>{const f=fixture();f.command({newURL:'section'});f.tick(0);f.tick(100);const y=f.window.pageYOffset;f.pop();f.tick(500);assert.equal(f.window.pageYOffset,y);assert.equal(f.pending(),0);assert.equal(f.pushes.length,0);assert.equal(f.order.some(x=>x.startsWith('replace')),false);assert.equal(f.listeners.some(x=>x.type==='popstate'),false);});
test('an id the address percent-encodes still settles',()=>{const f=fixture({id:'caf\u00e9'});f.api.scrollTo('caf\u00e9',0);f.tick(0);f.tick(500);assert.deepEqual(f.order.slice(-2),['replace https://example.test/page#caf%C3%A9','scroll 600']);});
test('a percentage root scroll-padding-top is of the viewport',()=>{assert.equal(land(fixture({padding:'10%'}),f=>f.click()),520);});
test('a refused replace keeps the landing',()=>{const f=fixture({refuseReplace:true,margin:40});f.click();f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,560);assert.equal(f.order.at(-1),'replace '+HREF);});

// A disclosure section nav's links are the module's while the URL does not
// target its panel (the wide list); its toggles, and a section chosen from
// the open panel, stay native so the browser closes the panel.
test('a disclosure section link is the module\'s while the URL does not target its panel',()=>{const f=fixture({disclosure:true});assert.equal(f.click().defaultPrevented,true);f.tick(0);f.tick(500);assert.equal(f.pushes.length,1);});
test('disclosure toggles and a section chosen from the open panel stay native',()=>{for(const extra of [{toggle:true},{panelOpen:true}]){const f=fixture({disclosure:true,...extra});assert.equal(f.click().defaultPrevented,undefined);f.tick(0);f.tick(500);assert.equal(f.pushes.length,0);assert.equal(f.moves.length,0);}});
test('a navigation that moves the document during the motion stops it where it is, completion work, listeners and start included',()=>{const f=fixture();f.command({newURL:'section'});f.tick(0);f.tick(100);const y=f.window.pageYOffset;f.window.location.pathname='/article';f.tick(200);f.tick(500);assert.equal(f.window.pageYOffset,y);assert.equal(f.pending(),0);assert.equal(f.pushes.length,0);assert.equal(f.order.some(x=>x.startsWith('replace')),false);assert.equal(f.listeners.some(x=>x.type==='popstate'||x.type==='wheel'),false);f.window.pageYOffset=900;f.api.scrollTo('section');f.tick(600);f.tick(1200);const i=f.order.indexOf('push #section');assert.equal(f.order[i-1],'scroll 900');});
test('focus the visitor moves during the motion stays theirs: the history is written, the settle stands down',()=>{for(const act of [f=>f.command({newURL:'section'}),f=>f.api.scrollTo('section')]){const f=fixture();act(f);f.tick(0);f.tick(100);f.document.activeElement={id:'field'};f.tick(500);assert.equal(f.pushes.length,1);assert.equal(f.order.some(x=>x.startsWith('replace')),false);}});
test('completion movement aims at the page\'s section-nav clearance when it sets one, else the measured nav',()=>{const v=fixture({nav:50,navVar:'107px'});assert.equal(land(v,f=>f.click()),493);assert.equal(v.document.body.children.length,0);assert.equal(land(fixture({nav:50}),f=>f.click()),550);});
test('an undefined verticalOffset is no offset: the page clearance aims and the platform lands it',()=>{const f=fixture({margin:40});f.command({newURL:'section',verticalOffset:undefined});f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,560);assert.equal(f.order.at(-1),'replace '+HREF);});
test('movement that writes no fragment keeps no section-nav fallback',()=>{assert.equal(land(fixture({nav:50}),f=>f.api.scrollTo(f.target)),600);assert.equal(land(fixture({nav:50}),f=>f.command({newURL:'section',updateHash:false})),600);});
test('the event and id APIs that write the fragment aim at the section nav when the page declares no clearance',()=>{assert.equal(land(fixture({nav:50}),f=>f.command({newURL:'section'})),550);assert.equal(land(fixture({nav:50}),f=>f.api.scrollTo('section')),550);});
test('the completion push leaves the entry at the position the click left, so Back returns there',()=>{const f=fixture({margin:40});f.click();f.tick(0);f.tick(500);const i=f.order.indexOf('push #section');assert.deepEqual(f.order.slice(i-1,i+2),['scroll 100','push #section','scroll 560']);assert.equal(f.window.pageYOffset,560);});
test('a movement that replaces one with pending history pushes from where the first started',()=>{const f=fixture({margin:40});f.click();f.tick(0);f.tick(100);f.click();f.tick(200);f.tick(800);const i=f.order.indexOf('push #section');assert.equal(f.order[i-1],'scroll 100');assert.equal(f.pushes.length,1);});
test('wheel input forgets a pending movement\'s start: the next movement pushes from where the wheel left it',()=>{const f=fixture();f.click();f.tick(0);f.tick(100);f.wheel();const y=f.window.pageYOffset;f.click();f.tick(200);f.tick(800);const i=f.order.indexOf('push #section');assert.equal(f.order[i-1],'scroll '+y);});
test('a declared link to the fragment the address already names adds no entry: the settle replaces it, as native does',()=>{const f=fixture();f.window.location.hash='#section';f.click();f.tick(0);f.tick(500);assert.equal(f.pushes.length,0);assert.equal(f.order.at(-1),'replace '+HREF);assert.equal(f.window.pageYOffset,600);});
test('a movement that writes no history leaves no start behind: a declared link replacing it pushes from where it was clicked',()=>{const f=fixture();f.api.scrollTo(f.target);f.tick(0);f.tick(100);const y=f.window.pageYOffset;f.click();f.tick(200);f.tick(800);const i=f.order.indexOf('push #section');assert.equal(f.order[i-1],'scroll '+y);});
