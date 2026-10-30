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

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const terser = require(process.env.TERSER_MODULE || 'terser');
const root = path.resolve(__dirname, '..');
const results = [];
const cache = new Map();
async function source(file, optimized) {
    const key = file + optimized;
    if (!cache.has(key)) {
        const code = fs.readFileSync(file, 'utf8');
        cache.set(key, optimized ? (await terser.minify(code, {ecma:5})).code : code);
    }
    return cache.get(key);
}
const form = '<form class="paste-ui-formhtml" action="/submit" method="post"><input name="note" value="kept"><button name="intent" value="save">Send</button></form>';
const targets = '<section data-paste-io-reply-fragment-target="story">Old story</section>';
async function fixture(browser, optimized, markup, modules, respond, enhanced = true, navigate, headers = {}) {
    const page = await browser.newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(String(e)));
    let bundle = '';
    if (enhanced) {
        for (const name of ['paste','util','oop','guid','dom','event','io']) {
            bundle += await source(path.join(process.env.PASTE_CORE_JS,name+'.js'),optimized);
        }
        for (const name of ['utilities/form-dom','utilities/io-html-fragment',...modules]) {
            bundle += await source(path.join(root,'modules',name,name.split('/').pop()+'.js'),optimized);
        }
    }
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.isNavigationRequest() && navigate && url.pathname !== '/') {
            await navigate(route,url);
        } else if (request.isNavigationRequest()) {
            await route.fulfill({headers,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Page '+url.pathname+'</title><main data-native-page>'+markup+'</main><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'});
        } else {
            requests.push(request);
            await respond(route, url);
        }
    });
    await page.goto('http://paste.test/');
    return {page,errors,requests};
}
function envelope(markup, code=200, title) {
    return JSON.stringify({meta:{code},data:{fragments:{story:{markup}},variables:{label:'fresh'},...(title ? {title} : {})}});
}
(async () => {
    for (const engine of (process.env.ELEMENTS_ENGINES || 'chromium,firefox,webkit').split(',')) {
        const browser = await pw[engine].launch({headless:true,executablePath:engine==='chromium'?process.env.ELEMENTS_CHROMIUM_EXECUTABLE:undefined,proxy:{server:'http://127.0.0.1:9'}});
        try {
            for (const optimized of [false,true]) {
                async function check(scenario, run) {
                    await run(); results.push({engine,version:browser.version(),optimized,scenario});
                }
                await check('native article href works with enhancement absent',async()=>{
                    const {page,requests}=await fixture(browser,optimized,'<a href="/article/one" data-paste-io-reply-fragment="story">Read</a>'+targets,[],null,false);
                    await page.click('a'); await page.waitForURL('**/article/one');
                    assert.equal(await page.title(),'Page /article/one');assert.equal(requests.length,0);await page.close();
                });
                for (const json of [false,true]) {
                    await check((json?'JSON':'HTML')+' form validation reply preserves HTTP status and rebinds replacement form',async()=>{
                        const {page,errors,requests}=await fixture(browser,optimized,'<section data-paste-io-reply-fragment-target="story"'+(json?' data-paste-io-reply-fragment-format="json"':'')+'>'+form+'</section>',
                            ['form/form_validity','form/form_html'],async r=>{
                                assert.equal(r.request().postData(),'note=kept&intent=save');
                                if(json) assert.equal(r.request().headers().accept,'application/json');
                                const markup='<p role="alert" id="answer">Check this</p>'+form;
                                await r.fulfill({status:422,contentType:json?'application/json':'text/html',body:json?envelope(markup,422):markup});
                            });
                        await page.click('button');await page.waitForSelector('#answer');
                        assert.equal(await page.evaluate(()=>document.activeElement.id),'answer');
                        await page.click('button');await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                        assert.equal(requests.length,2);assert.deepEqual(errors,[]);await page.close();
                    });
                }
                await check('JSON strings cannot replace or erase a fragment target',async()=>{
                    const bodies={'/string':'<b>Unexpected</b>','/empty':'','/data':{data:''},'/fragments':{data:{fragments:''}},'/entry':{data:{fragments:{story:''}}}};
                    const {page,errors}=await fixture(browser,optimized,targets,[],async(r,u)=>r.fulfill({contentType:'application/json',body:JSON.stringify(bodies[u.pathname])}));
                    const result=await page.evaluate(async()=>{
                        const target=document.querySelector('section'),results=[];
                        let commits=0;
                        for(const url of ['/string','/empty','/data','/fragments','/entry'])results.push(await new Promise(resolve=>paste.ui.utilities['io-html-fragment'].load(target,{
                            url,beforePlace(){commits++;},onDone(){resolve('done');},onFailed(reason){resolve(reason);}
                        })));
                        return {results,commits,html:target.innerHTML,busy:target.hasAttribute('aria-busy')};
                    });
                    assert.deepEqual(result,{results:Array(5).fill('response'),commits:0,html:'Old story',busy:false});assert.deepEqual(errors,[]);await page.close();
                });
                await check('an absent target name cannot match the literal name null',async()=>{
                    const {page,errors}=await fixture(browser,optimized,'<section>Old story</section>',[],async r=>r.fulfill({contentType:'application/json',body:'{"data":{"fragments":{"null":{"markup":"Named target"}}}}'}));
                    const result=await page.evaluate(async()=>{
                        const target=document.querySelector('section'),results=[];let commits=0;
                        for(const named of [false,true]){
                            if(named)target.setAttribute('data-paste-io-reply-fragment-target','null');
                            const outcome=await new Promise(resolve=>paste.ui.utilities['io-html-fragment'].load(target,{url:'/reply',beforePlace(){commits++;},onDone(){resolve('done');},onFailed(reason){resolve(reason);}}));
                            results.push([outcome,target.innerHTML,commits]);
                        }
                        return results;
                    });
                    assert.deepEqual(result,[['response','Old story',0],['done','Named target',1]]);assert.deepEqual(errors,[]);await page.close();
                });
                await check('an empty JSON string preserves a submitted form and follows its failure policy',async()=>{
                    const {page,errors,requests}=await fixture(browser,optimized,'<section data-paste-io-reply-fragment-target="story">'+form+'</section>',
                        ['form/form_validity','form/form_html'],async r=>r.fulfill({contentType:'application/json',body:'""'}));
                    await page.click('button');await page.waitForSelector('.paste-ui-formhtml-failure');
                    assert.equal(await page.locator('[name=note]').inputValue(),'kept');assert.equal(requests.length,1);assert.deepEqual(errors,[]);await page.close();
                });
                await check('a JSON string article reply falls back without committing enhanced history',async()=>{
                    const {page,errors}=await fixture(browser,optimized,'<a href="/article" data-paste-io-reply-fragment="story">Read</a>'+targets,['fragment_navigation'],
                        async r=>r.fulfill({contentType:'application/json',body:'"<p>Unexpected</p>"'}));
                    await page.evaluate(()=>{sessionStorage.setItem('pushCount','0');const native=history.pushState;history.pushState=function(){sessionStorage.setItem('pushCount',String(Number(sessionStorage.getItem('pushCount'))+1));return native.apply(this,arguments);};});
                    await Promise.all([page.waitForEvent('domcontentloaded'),page.click('a')]);
                    assert.equal(await page.title(),'Page /article');assert.equal(await page.evaluate(()=>sessionStorage.getItem('pushCount')),'0');assert.deepEqual(errors,[]);await page.close();
                });
                await check('opted-in article navigation commits URL/title and native Back/Forward reload full pages',async()=>{
                    const {page,errors,requests}=await fixture(browser,optimized,'<a href="/article/one#section" data-paste-io-reply-fragment="story">Read</a>'+targets,
                        ['fragment_navigation'],async r=>r.fulfill({contentType:'application/json',body:envelope('<h1 id="section">Article</h1><a href="#section">Local</a>',200,'Article title')}));
                    await page.evaluate(()=>window.documentWasRetained=true);
                    await page.click('a');await page.waitForSelector('#section');
                    assert.equal(page.url(),'http://paste.test/article/one#section');assert.equal(await page.title(),'Article title');
                    assert.equal(await page.evaluate(()=>window.documentWasRetained),true);
                    assert.equal(await page.evaluate(()=>document.activeElement.id),'section');
                    await page.click('section a');assert.equal(requests.length,1);
                    await page.goBack();await page.waitForURL('http://paste.test/');await page.waitForFunction(()=>document.title==='Page /');
                    assert.equal(await page.evaluate(()=>window.documentWasRetained),undefined);
                    await page.goForward();await page.waitForURL('**/article/one#section');
                    await page.waitForFunction(()=>document.title==='Page /article/one');assert.deepEqual(errors,[]);await page.close();
                });
                await check('modified, download, other-context, cross-origin and local-hash clicks stay native',async()=>{
                    const links='<a href="/article/one" data-paste-io-reply-fragment="story">Read</a>';
                    const {page,requests,errors}=await fixture(browser,optimized,links+targets,['fragment_navigation'],async()=>assert.fail('must not request'));
                    const result=await page.evaluate(()=>{
                        const a=document.querySelector('a'),checks=[];
                        document.addEventListener('click',e=>{checks.push(!e.defaultPrevented);e.preventDefault();});
                        for(const init of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}]) a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...init}));
                        for(const [attr,value] of [['download',''],['target','_blank'],['href','https://other.test/article'],['href','#local'],['referrerpolicy','no-referrer'],['rel','noreferrer'],['ping','/ping']]){
                            a.setAttribute(attr,value);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));a.removeAttribute(attr);
                            a.href='/article/one';
                        }
                        return checks;
                    });
                    assert.equal(result.length,12);assert.ok(result.every(Boolean));assert.equal(requests.length,0);assert.deepEqual(errors,[]);await page.close();
                });
                await check('relative iframe and background resources resolve against the destination URL',async()=>{
                    const markup='<a href="/news/article/" data-paste-io-reply-fragment="story">Read</a>'+targets;
                    const {page,errors}=await fixture(browser,optimized,markup,['fragment_navigation'],async(r,u)=>{
                        if(u.pathname==='/news/article/')await r.fulfill({contentType:'text/html',body:'<iframe src="embedded.html"></iframe><div style="width:100px;height:100px;background-image:url(background.svg)">Article</div>'});
                        else await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
                    },true,async r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Embedded</title>'}));
                    const background=page.waitForRequest(r=>r.url().endsWith('/background.svg'));
                    const embedded=page.waitForRequest(r=>r.url().endsWith('/embedded.html'));
                    await page.click('a');
                    assert.equal((await background).url(),'http://paste.test/news/article/background.svg');
                    assert.equal((await embedded).url(),'http://paste.test/news/article/embedded.html');
                    assert.equal(page.url(),'http://paste.test/news/article/');assert.deepEqual(errors,[]);await page.close();
                });
                if(engine==='chromium')await check('refused placement falls back to the full page without an extra history entry',async()=>{
                    const {page,errors}=await fixture(browser,optimized,'<a href="/article" data-paste-io-reply-fragment="story">Read</a>'+targets,['fragment_navigation'],
                        async r=>r.fulfill({contentType:'text/html',body:'<p>Article</p>'}),true,undefined,{'Content-Security-Policy':"require-trusted-types-for 'script'"});
                    const length=await page.evaluate(()=>history.length);
                    await Promise.all([page.waitForEvent('domcontentloaded'),page.click('a')]);
                    assert.equal(await page.title(),'Page /article');
                    assert.equal(await page.evaluate(()=>history.length),length+1);assert.deepEqual(errors,[]);await page.close();
                });
                await check('redirected links use native navigation so Location fragments are preserved',async()=>{
                    let bundle='';
                    for(const name of ['paste','util','oop','guid','dom','event','io']) bundle+=await source(path.join(process.env.PASTE_CORE_JS,name+'.js'),optimized);
                    for(const name of ['utilities/io-html-fragment','fragment_navigation']) bundle+=await source(path.join(root,'modules',name,name.split('/').pop()+'.js'),optimized);
                    const html='<!doctype html><a href="/old#authored-fragment" data-paste-io-reply-fragment="story">Read</a>'+targets+'<script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>';
                    const server=http.createServer((req,res)=>{
                        if(req.url==='/old'){res.writeHead(302,{location:'/new#server-fragment'});res.end();}
                        else if(req.url==='/new'){res.setHeader('Content-Type','text/html');res.end(req.headers['x-requested-with'] ? '<h1>Fragment</h1>' : '<!doctype html><title>Full destination</title><h1 id="server-fragment">Full page</h1>');}
                        else {res.setHeader('Content-Type','text/html');res.end(html);}
                    });
                    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
                    const direct=await pw[engine].launch({headless:true,executablePath:engine==='chromium'?process.env.ELEMENTS_CHROMIUM_EXECUTABLE:undefined});
                    try {
                        const page=await direct.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
                        await page.goto('http://127.0.0.1:'+server.address().port+'/');await page.click('a');await page.waitForURL('**/new#server-fragment');
                        assert.equal(await page.title(),'Full destination');assert.deepEqual(errors,[]);
                    } finally {await direct.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
                });
                await check('a later article click supersedes a pending load without stale writes',async()=>{
                    let first;
                    const gate=new Promise(resolve=>first=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<a id="one" href="/one" data-paste-io-reply-fragment="story">One</a><a id="two" href="/two" data-paste-io-reply-fragment="story">Two</a>'+targets,
                        ['fragment_navigation'],async(r,u)=>{
                            if(u.pathname==='/one')await gate;
                            await r.fulfill({contentType:'text/html',body:'<p id="answer">'+u.pathname+'</p>'}).catch(()=>{});
                        });
                    await page.click('#one');await page.waitForSelector('[aria-busy]');await page.click('#two');await page.waitForSelector('#answer');first();
                    assert.equal(await page.locator('#answer').textContent(),'/two');assert.equal(page.url(),'http://paste.test/two');assert.deepEqual(errors,[]);await page.close();
                });
                await check('autosave commits a document-wide reply and silently supersedes an overlapping form request',async()=>{
                    let release;
                    const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<form data-ui-autosave="title" data-autosave-action="/save"><input id="title" name="title"></form><section data-paste-io-reply-fragment-target="story">'+form+'</section>',
                        ['form/form_validity','form/form_html','form/form_autosave'],async(r,u)=>{
                            if(u.pathname==='/submit'){await gate;await r.fulfill({contentType:'text/html',body:'OLD'}).catch(()=>{});}
                            else await r.fulfill({contentType:'application/json',body:envelope('<p id="saved">New content</p>')});
                        });
                    await page.evaluate(()=>{window.failures=0;document.addEventListener('paste.ui.formhtml:failed',()=>failures++);});
                    await page.click('button');await page.waitForSelector('[aria-busy]');await page.fill('#title','saved');await page.waitForSelector('#saved');release();
                    assert.equal(await page.evaluate(()=>failures),0);assert.equal(await page.locator('[aria-busy]').count(),0);
                    assert.equal(await page.locator('form').getAttribute('class'),'not-autosaving');assert.deepEqual(errors,[]);await page.close();
                });
                await check('a detached autosave form cannot place a late document-wide reply',async()=>{
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<form data-ui-autosave="title" data-autosave-action="/save"><input id="title" name="title"></form>'+targets,
                        ['form/form_autosave'],async r=>{await gate;await r.fulfill({contentType:'application/json',body:envelope('STALE')});});
                    await page.fill('#title','edited');await page.waitForSelector('.autosaving');await page.evaluate(()=>document.querySelector('form').remove());release();
                    await page.waitForFunction(()=>!document.querySelector('.autosaving')); // detached immediately; await XHR completion below
                    await page.waitForLoadState('networkidle');assert.equal(await page.locator('section').textContent(),'Old story');assert.deepEqual(errors,[]);await page.close();
                });
                await check('lazy loading accepts a named JSON reply and rejects an obsolete authored URL',async()=>{
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<section id="lazy" data-lazy-load="/old" data-paste-io-reply-fragment-target="story">Old</section>',
                        ['lazy_loader'],async(r,u)=>{if(u.pathname==='/old')await gate;await r.fulfill({contentType:'application/json',body:envelope('<b id="loaded">'+u.pathname+'</b>')});});
                    await page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document));await page.waitForSelector('[aria-busy]');
                    await page.evaluate(()=>document.querySelector('section').setAttribute('data-lazy-load','/new'));release();
                    await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                    assert.equal(await page.locator('#loaded').count(),0);
                    await page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document));await page.waitForSelector('#loaded');
                    assert.equal(await page.locator('#loaded').textContent(),'/new');assert.equal(await page.locator('#lazy').getAttribute('data-lazy-load'),null);assert.deepEqual(errors,[]);await page.close();
                });
                await check('an empty anchor target inherits the base browsing context',async()=>{
                    const {page,errors,requests}=await fixture(browser,optimized,'<base target="other"><iframe name="other"></iframe><a href="/next" target="" data-paste-io-reply-fragment="story">Read</a>'+targets,['fragment_navigation'],async()=>assert.fail('must remain native'));
                    const observed=await page.evaluate(()=>{
                        let native;document.addEventListener('click',e=>{native=!e.defaultPrevented;e.preventDefault();});document.querySelector('a').click();return native;
                    });
                    assert.equal(observed,true);assert.equal(requests.length,0);assert.deepEqual(errors,[]);await page.close();
                });
                await check('a newer native hash navigation cancels an older article request',async()=>{
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<a id="article" href="/article" data-paste-io-reply-fragment="story">Article</a><a id="local" href="#local-section">Local</a><p id="local-section">Local section</p>'+targets,
                        ['fragment_navigation'],async r=>{await gate;await r.fulfill({contentType:'text/html',body:'STALE'}).catch(()=>{});});
                    await page.click('#article');await page.waitForSelector('[aria-busy]');await page.click('#local');await page.waitForURL('**/#local-section');release();
                    await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                    assert.equal(await page.locator('section').textContent(),'Old story');assert.equal(page.url(),'http://paste.test/#local-section');assert.deepEqual(errors,[]);await page.close();
                });
                await check('a same-address replace leaves a pending article request standing',async()=>{
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await fixture(browser,optimized,'<a id="article" href="/article" data-paste-io-reply-fragment="story">Article</a><a id="local" href="#local-section">Local</a><p id="local-section">Local section</p>'+targets,
                        ['fragment_navigation'],async r=>{await gate;await r.fulfill({contentType:'text/html',body:'<p>Article</p>'}).catch(()=>{});});
                    await page.click('#local');await page.waitForURL('**/#local-section');
                    await page.click('#article');await page.waitForSelector('[aria-busy]');
                    await page.evaluate(()=>location.replace(location.hash));release();
                    await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                    assert.equal(await page.locator('section').textContent(),'Article');assert.equal(page.url(),'http://paste.test/article');assert.deepEqual(errors,[]);await page.close();
                });
                // Smoothscroll's section-nav motion lands after an article click: its
                // settle neither cancels the pending request nor takes the placed
                // target's focus.
                const scroller='<style>#second{margin-top:3000px}main{min-height:6000px}</style><nav class="paste-ui-section-nav" data-paste-smoothscroll><a id="to-second" href="#second">Second</a></nav><a id="article" href="/article" data-paste-io-reply-fragment="story">Read</a>'+targets+'<p id="second">Second</p>';
                for(const [name,held] of [['a section-nav motion that lands during an article request leaves it standing',1000],['a section-nav motion that lands after an article is placed leaves its focus',120]]){
                    await check(name,async()=>{
                        const {page,errors}=await fixture(browser,optimized,scroller,['utilities/animation-frame','smoothscroll','fragment_navigation'],
                            async r=>{await new Promise(resolve=>setTimeout(resolve,held));await r.fulfill({contentType:'text/html',body:'<p>Article</p>'}).catch(()=>{});});
                        // Programmatic clicks: Playwright would wait for the moving page to settle.
                        await page.evaluate(()=>{document.getElementById('to-second').click();setTimeout(()=>document.getElementById('article').click(),80);});await page.waitForSelector('[aria-busy]');
                        await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));await page.waitForTimeout(900);
                        assert.equal(await page.locator('section').textContent(),'Article');assert.equal(page.url(),'http://paste.test/article');
                        assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('section')),true);
                        assert.ok(Math.abs(await page.evaluate(()=>document.querySelector('section').getBoundingClientRect().top))<2,'the placed article was scrolled away');assert.deepEqual(errors,[]);await page.close();
                    });
                }
                await check('lazy HTTP errors leave fallback content and the retry marker intact',async()=>{
                    const {page,errors,requests}=await fixture(browser,optimized,'<section data-lazy-load="/lazy">Fallback</section>', ['lazy_loader'],async r=>r.fulfill({status:500,contentType:'text/html',body:'Error page'}));
                    await Promise.all([page.waitForResponse('**/lazy'),page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document))]);await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                    assert.equal(await page.locator('section').textContent(),'Fallback');assert.equal(await page.locator('section').getAttribute('data-lazy-load'),'/lazy');
                    await Promise.all([page.waitForResponse('**/lazy'),page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document))]);await page.waitForFunction(()=>!document.querySelector('[aria-busy]'));
                    assert.equal(requests.length,2);assert.deepEqual(errors,[]);await page.close();
                });
                await check('an independent commit during preparation prevents transmission and clears ownership',async()=>{
                    const {page,errors,requests}=await fixture(browser,optimized,targets,[],async()=>assert.fail('superseded preparation must not transmit'));
                    const result=await page.evaluate(()=>{
                        const target=document.querySelector('section'),fragment=paste.ui.utilities['io-html-fragment'],failed=[];
                        const operation=fragment.load(target,{
                            prepare(){fragment.apply({fragments:{story:{markup:'New'}}});return {url:'/stale'};},
                            onDone(){throw Error('superseded');},onFailed(reason,sent){failed.push([reason,sent]);}
                        });
                        return {started:!!operation,failed,html:target.innerHTML,busy:target.hasAttribute('aria-busy')};
                    });
                    assert.deepEqual(result,{started:false,failed:[['superseded',false]],html:'New',busy:false});assert.equal(requests.length,0);assert.deepEqual(errors,[]);await page.close();
                });
                await check('generic targets and variable bindings survive form member collisions',async()=>{
                    const {page,errors}=await fixture(browser,optimized,'<form data-paste-io-reply-fragment-target="story"><input name="getAttribute"><input name="contains"><input name="innerHTML"><input name="classList"></form>',[],async r=>r.fulfill({contentType:'application/json',body:envelope('<input name="setAttribute"><input name="querySelectorAll"><input data-paste-io-reply-fragment-bind="value=label">')}));
                    await page.evaluate(()=>paste.ui.utilities['io-html-fragment'].load(document.querySelector('form'),{url:'/target',onDone(){window.loaded=true;},onFailed(reason){throw Error(reason);}}));
                    await page.waitForFunction(()=>window.loaded);assert.equal(await page.locator('[data-paste-io-reply-fragment-bind]').inputValue(),'fresh');assert.deepEqual(errors,[]);await page.close();
                });
                await check('scheduled autosave does not transmit after its source form is detached',async()=>{
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors,requests}=await fixture(browser,optimized,'<form data-ui-autosave="title" data-autosave-action="/save"><input id="title" name="title"></form>', ['form/form_autosave'],async r=>{await gate;await r.fulfill({contentType:'application/json',body:'{"meta":{"code":200},"data":{}}'});});
                    await page.evaluate(()=>{const native=window.setTimeout;window.saveTimers=[];window.setTimeout=function(fn,delay){if(delay===10000){saveTimers.push(fn);return 123456;}return native(fn,delay);};});
                    await page.fill('#title','first');await page.waitForSelector('.autosaving');await page.fill('#title','second');await page.evaluate(()=>document.activeElement.blur());release();await page.waitForFunction(()=>saveTimers.length===1);
                    await page.evaluate(()=>{document.querySelector('form').remove();saveTimers[0]();});await page.waitForLoadState('networkidle');
                    assert.equal(requests.length,1);assert.deepEqual(errors,[]);await page.close();
                });
                await check('navigation handles form targets and unrelated form clicks without named-member traps',async()=>{
                    const markup='<a href="/article" data-paste-io-reply-fragment="story">Read</a><form data-paste-io-reply-fragment-target="story"><input name="parentElement"><input name="getAttribute"><button type="button">Unrelated</button></form>';
                    const {page,errors}=await fixture(browser,optimized,markup,['fragment_navigation'],async r=>r.fulfill({contentType:'text/html',body:'<input name="hasAttribute"><input name="setAttribute"><input name="focus"><input name="scrollIntoView"><p>Article</p>'}));
                    // Playwright's own disabled-fieldset walk uses shadowable parentElement.
                    await page.evaluate(()=>document.querySelector('button').click());await page.click('a');await page.waitForSelector('form p');
                    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('form')),true);assert.equal(page.url(),'http://paste.test/article');assert.deepEqual(errors,[]);await page.close();
                });
                await check('lazy adapters handle form targets and roots with named DOM members',async()=>{
                    const markup='<form data-lazy-load="/lazy"><input name="getAttribute"><input name="removeAttribute"><input name="querySelectorAll"><div data-lazy-load="/child">Fallback</div></form>';
                    const {page,errors}=await fixture(browser,optimized,markup,['lazy_loader'],async(r,u)=>r.fulfill({contentType:'text/html',body:'<b>'+u.pathname+'</b>'}));
                    await page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document.querySelector('form')));await page.waitForSelector('div b');
                    await page.evaluate(()=>paste.ui.lazy_loader.load_lazy_content(document.querySelector('form')));await page.waitForSelector('form > b');
                    assert.equal(await page.locator('form > b').textContent(),'/lazy');assert.equal(await page.locator('form').getAttribute('data-lazy-load'),null);assert.deepEqual(errors,[]);await page.close();
                });
                await check('visible lazy forms use native dimensions despite colliding control names',async()=>{
                    const {page,errors}=await fixture(browser,optimized,'<form style="width:100px;height:100px" data-lazy-load="/visible"><input name="offsetWidth"><input name="offsetHeight"></form>', ['lazy_loader'],async r=>r.fulfill({contentType:'text/html',body:'<b>Visible</b>'}));
                    await page.evaluate(()=>paste.ui.lazy_loader.load_visible_content(document));await page.waitForSelector('form b');assert.deepEqual(errors,[]);await page.close();
                });
                await check('both submission adapters retain native noreferrer behavior',async()=>{
                    for(const module of ['form_html','form_apply']){
                        const markup='<section data-paste-io-reply-fragment-target="story">'+form.replace('paste-ui-formhtml',module==='form_html'?'paste-ui-formhtml':'paste-ui-apply').replace('method="post"','method="post" rel="noreferrer"')+'</section>';
                        const {page,errors,requests}=await fixture(browser,optimized,markup,['form/form_validity','form/'+module],async()=>assert.fail('must be native'));
                        const native=await page.evaluate(()=>{let native;document.querySelector('form').addEventListener('submit',e=>{native=!e.defaultPrevented;e.preventDefault();});document.querySelector('button').click();return native;});
                        assert.equal(native,true);assert.equal(requests.length,0);assert.deepEqual(errors,[]);await page.close();
                    }
                });
                await check('an XHR timeout settles a form without replaying an uncertain POST',async()=>{
                    const markup=form.replace('method="post"','method="post" data-paste-form-timeout="30"');
                    const {page,errors}=await fixture(browser,optimized,'<section data-paste-io-reply-fragment-target="story">'+markup+'</section>',
                        ['form/form_validity','form/form_html'],async()=>assert.fail('a stubbed request must not reach the network'));
                    await page.evaluate(()=>{
                        window.sends=[];
                        paste.io.open=function(method,url){
                            const request={responseURL:url,timeout:0,setRequestHeader(){},send(){sends.push(request);},abort(){}};
                            return request;
                        };
                    });
                    await page.click('button');
                    assert.equal(await page.evaluate(()=>sends.length),1);
                    assert.equal(await page.evaluate(()=>sends[0].timeout),30);
                    await page.evaluate(()=>sends[0].ontimeout());
                    await page.waitForSelector('.paste-ui-formhtml-failure');
                    assert.equal(await page.locator('[name=note]').inputValue(),'kept');assert.equal(await page.locator('[aria-busy]').count(),0);assert.equal(await page.evaluate(()=>sends.length),1);assert.deepEqual(errors,[]);await page.close();
                });
            }
        } finally { await browser.close(); }
    }
    console.log(JSON.stringify({results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
