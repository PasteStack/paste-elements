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
function fixture(options={}) {
 const callbacks=new Map(),listeners=[],pushes=[],moves=[];let serial=0,gets=0,intoView=0,command,api;
 const location=new URL('https://example.test/page');
 const target={id:'section',getBoundingClientRect:()=>({top:600-window.pageYOffset}),scrollIntoView(){intoView+=1;}};
 const anchor=Object.assign(new URL('#section',location),{nodeName:'A',hasAttribute:()=>false,getAttribute:()=>null,closest:()=>null});
 const window={WeakSet:options.noWeakSet?undefined:WeakSet,location,pageYOffset:100,pageXOffset:25,name:'',matchMedia:()=>({matches:!!options.reduced}),
 history:{pushState(state,title,hash){pushes.push({state,hash});location.hash=hash;}},scrollTo(v){moves.push(v);window.pageYOffset=v.top;},getComputedStyle:options.noStyle?undefined:options.native?()=>({getPropertyValue:k=>k==='--paste-smoothscroll-motion'?' native ':''}):()=>({getPropertyValue:()=>''})};
 const document={readyState:options.loading?'loading':'complete',querySelector:()=>null,getElementById:id=>id==='section'?target:null};
 const event={getEventTarget:e=>e.target,bind(type,el,fn){listeners.push({type,el,fn});}};
 event.Event=function(){this.subscribe=fn=>{command=fn;return {};};};
 event.Event.Subscription=function(type,el,fn){const b={type,el,fn};listeners.push(b);this.dispose=()=>{const i=listeners.indexOf(b);if(i>=0)listeners.splice(i,1);};};
 const frame={request(fn){callbacks.set(++serial,fn);return serial;},cancel(id){callbacks.delete(id);}};
 vm.runInNewContext(readModuleSource('paste/ui/smoothscroll.js'),{window,document,paste:{define(name,deps,factory){api=factory({},{get:()=>{gets+=1;return [anchor];},getScrollTop:()=>window.pageYOffset,querySelector:()=>null},event,frame);}}});
 return {api,window,target,anchor,pushes,moves,listeners,gets:()=>gets,intoView:()=>intoView,command:data=>command({},data),
 tick(time){const batch=[...callbacks.values()];callbacks.clear();batch.forEach(fn=>fn(time));},
 click(extra={}){const e={target:anchor,currentTarget:anchor,preventDefault(){this.defaultPrevented=true;},...extra};listeners.find(x=>x.type==='click').fn(e);return e;},
 wheel(){listeners.find(x=>x.type==='wheel').fn();},pending:()=>callbacks.size};
}
test('plain anchor pushes immediately and animates cubic motion without native navigation',()=>{
 const f=fixture();assert.equal(f.click().defaultPrevented,true);assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].state,null);
 assert.equal(f.moves.length,0);f.tick(0);f.tick(250);assert.equal(f.window.pageYOffset,350);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pending(),0);assert.equal(f.moves.at(-1).left,25);
});
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
test('legacy event without data moves to the current fragment',()=>{const f=fixture();f.window.location.hash='#section';f.command();f.tick(0);f.tick(500);assert.equal(f.window.pageYOffset,600);assert.equal(f.pushes[0].hash,'#section');});

test('legacy membership fallback keeps repeated init idempotent',()=>{const f=fixture({noWeakSet:true});f.api.init();f.api.init();assert.equal(f.listeners.filter(x=>x.type==='click').length,1);});
test('native motion steps aside: no link is discovered or bound, so clicks stay native',()=>{const f=fixture({native:true});assert.equal(f.gets(),0);assert.equal(f.listeners.filter(x=>x.type==='click').length,0);f.api.init();assert.equal(f.gets(),0);assert.equal(f.listeners.filter(x=>x.type==='click').length,0);assert.equal(f.pushes.length,0);assert.equal(f.moves.length,0);});
test('native motion routes the event and APIs through the platform',()=>{const f=fixture({native:true});f.command({newURL:'section'});assert.equal(f.window.location.hash,'#section');const g=fixture({native:true});g.command({newURL:'section',updateHash:false});assert.equal(g.intoView(),1);assert.equal(g.window.location.hash,'');const h=fixture({native:true});h.api.scrollTo('section');assert.equal(h.window.location.hash,'#section');const k=fixture({native:true});k.api.scrollTo(k.target);assert.equal(k.intoView(),1);});
test('native motion scrolls a target the address already names instead of setting the same hash',()=>{const f=fixture({native:true});f.window.location.hash='#section';f.api.scrollTo('section');assert.equal(f.intoView(),1);f.command({newURL:'section'});assert.equal(f.intoView(),2);assert.equal(f.window.location.hash,'#section');});
test('native motion ignores a missing target, as the default motion does',()=>{const f=fixture({native:true});f.api.scrollTo('missing');f.command({newURL:'missing'});assert.equal(f.window.location.hash,'');assert.equal(f.intoView(),0);});
test('native motion subscribes nothing while the document is still loading',()=>{const f=fixture({native:true,loading:true});assert.equal(f.listeners.filter(x=>x.type==='DOMContentLoaded').length,0);const g=fixture({loading:true});assert.equal(g.listeners.filter(x=>x.type==='DOMContentLoaded').length,1);});
test('a host without getComputedStyle keeps the default motion',()=>{const f=fixture({noStyle:true});assert.equal(f.listeners.filter(x=>x.type==='click').length,1);const e=f.click();assert.equal(e.defaultPrevented,true);});
