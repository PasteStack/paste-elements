'use strict';
// Actual Paste core, native forms, requests, layout and events. Run source and
// Terser output against the same scenarios; no production network is contacted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const terser = require(process.env.TERSER_MODULE || 'terser');
const root = path.resolve(__dirname, '..');
const core = process.env.PASTE_CORE_JS;
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

async function pageFor(browser, markup, modules, optimized, setup, route) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', async r => {
        if (r.request().url() === 'http://paste.test/') {
            await r.fulfill({contentType:'text/html', body:'<!doctype html><meta charset="utf-8">' + markup});
        } else if (route) await route(r);
        else await r.fulfill({status:404,body:''});
    });
    await page.goto('http://paste.test/');
    for (const name of ['paste','util','oop','guid','dom','event','io']) {
        await page.addScriptTag({content:await source(path.join(core, name + '.js'), optimized)});
    }
    if (setup) await page.evaluate(setup);
    for (const name of ['utilities/form-dom', 'utilities/io-html-fragment', ...modules]) {
        await page.addScriptTag({content:await source(path.join(root,'modules',name,name.split('/').pop()+'.js'),optimized)});
    }
    return {page, errors};
}

(async () => {
    for (const engine of (process.env.ELEMENTS_ENGINES || 'chromium,firefox,webkit').split(',')) {
        // Block browser-owned background traffic too; page routes alone do not
        // cover Firefox's Pocket/new-tab service. All scenario responses are local.
        const browser = await pw[engine].launch({headless:true,
            executablePath:engine==='chromium'?process.env.ELEMENTS_CHROMIUM_EXECUTABLE:undefined,
            proxy:{server:'http://127.0.0.1:9'},
            ...(engine === 'firefox' ? {firefoxUserPrefs:{
                'extensions.pocket.enabled':false,
                'browser.newtabpage.activity-stream.feeds.system.topstories':false,
                'browser.newtabpage.activity-stream.feeds.section.topstories':false,
                'browser.newtabpage.enabled':false,
                'network.proxy.type':1,
                'network.proxy.http':'127.0.0.1','network.proxy.http_port':9,
                'network.proxy.ssl':'127.0.0.1','network.proxy.ssl_port':9,
                'network.proxy.no_proxies_on':''
            }} : {})});
        try {
            for (const optimized of [false,true]) {
                {
                    let sent = 0;
                    const {page,errors} = await pageFor(browser,
                        '<form class="paste-ui-apply" method="post" action="/apply"><input required name="title" value="ready"><input name="elements" value="safe"><input name="same" value="one"><input name="same" value="two"><button name="intent" value="save">Save</button></form>',
                        ['form/form_validity','form/form_apply'], optimized, null, async r => {
                            sent++;
                            assert.match(r.request().postData(), /same=one&same=two/);
                            assert.match(r.request().postData(), /intent=save/);
                            await r.fulfill({contentType:'application/json',body:JSON.stringify({success:{message:'Saved'}})});
                        });
                    await page.click('button');
                    await page.waitForSelector('.paste-ui-apply-success');
                    assert.equal(sent,1);
                    assert.equal(await page.locator('[name=title]').inputValue(),'');
                    assert.equal(await page.locator('form[aria-busy]').count(),0);
                    assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'apply native collection and successful controls',sent});
                    await page.close();
                }
                {
                    let sent = 0;
                    const {page,errors} = await pageFor(browser,
                        '<div id="visible" data-lazy-load="/fragment">Wait</div><div hidden data-lazy-load="/hidden">Hidden</div>',
                        ['lazy_loader'],optimized,null,async r=>{
                            sent++;
                            assert.equal(r.request().url(),'http://paste.test/fragment');
                            await r.fulfill({contentType:'text/html',body:'<span>Loaded</span>'});
                        });
                    assert.equal(sent,0);
                    await page.evaluate(()=>{
                        window.hooks=0;
                        paste.ui.lazy_loader.set_init_new_content(function(el){if(this!==el)throw Error('receiver');hooks++;});
                        paste.ui.lazy_loader.load_visible_content(document);
                        paste.ui.lazy_loader.load_visible_content(document);
                    });
                    await page.waitForSelector('#visible span');
                    assert.equal(sent,1);
                    assert.equal(await page.evaluate(()=>hooks),1);
                    assert.equal(await page.locator('#visible').getAttribute('data-lazy-load'),null);
                    assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'lazy visibility and duplicate suppression',sent});
                    await page.close();
                }
                {
                    const {page,errors} = await pageFor(browser,
                        '<style>.paste-ui-carousel{width:300px}.paste-ui-carousel-wrap{overflow:hidden}.paste-ui-carousel-items{position:relative;display:flex}.paste-ui-carousel-item{flex:0 0 100%}</style><div class="paste-ui-carousel" data-paste-carousel-name="gallery" data-paste-carousel-indicate data-paste-carousel-count data-paste-carousel-broadcast-moves><div class="paste-ui-carousel-wrap"><div class="paste-ui-carousel-items"><div class="paste-ui-carousel-item">1</div><div class="paste-ui-carousel-item">2</div><div class="paste-ui-carousel-item">3</div></div></div></div>',
                        ['utilities/animation-frame','utilities/mediaquery','carousel'],optimized);
                    await page.waitForSelector('.paste-ui-carousel-loaded');
                    await page.evaluate(()=>{window.moves=0;document.addEventListener('carouselMove',()=>moves++);});
                    await page.click('.paste-ui-carousel-controls-next');
                    await page.waitForFunction(()=>document.querySelector('.paste-ui-carousel-items').style.left==='-300px');
                    assert.equal(await page.locator('.paste-ui-carousel-counter').textContent(),'2 / 3');
                    assert.equal(await page.locator('.paste-ui-carousel-counter-current').textContent(),'2');
                    assert.equal(await page.locator('.paste-ui-carousel-counter-total').textContent(),'3');
                    assert.equal(await page.locator('.paste-ui-carousel-indicator-item-active button').textContent(),'2');
                    assert.equal(await page.evaluate(()=>moves),1);
                    assert.equal(await page.evaluate(()=>paste.ui.carousel.gallery.goTo(99)),undefined);
                    assert.equal(await page.locator('.paste-ui-carousel-controls-next').isDisabled(),true);
                    await page.evaluate(()=>paste.ui.carousel.gallery.dispose());
                    assert.equal(await page.locator('.paste-ui-carousel button').count(),0);
                    assert.equal(await page.evaluate(()=>document.querySelector('.paste-ui-carousel-items').style.left),'');
                    assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'carousel pages events and complete disposal'});
                    await page.close();
                }
                {
                    const collisions = ['elements','tagName','classList','getAttribute','hasAttribute','setAttribute','removeAttribute','querySelectorAll','addEventListener','parentElement','checkValidity','insertBefore','firstChild','appendChild','dispatchEvent'];
                    const fields = collisions.map(name=>`<input name="${name}" value="kept">`).join('');
                    let sends=0;
                    const {page,errors}=await pageFor(browser,
                        '<form class="paste-ui-apply" method="post" action="/apply"><input name="title" value="draft">'+fields+'<button>Save</button></form>',
                        ['form/form_validity','form/form_apply'],optimized,null,async r=>{sends++;await r.fulfill({contentType:'application/json',body:'{"success":{"message":"Saved"}}'});});
                    await page.evaluate(()=>document.querySelector('button').click());await page.waitForSelector('.paste-ui-apply-success');
                    assert.equal(sends,1);assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'apply native DOM members survive named form controls',names:collisions});
                    await page.close();
                    const html=await pageFor(browser,
                        '<div data-paste-io-reply-fragment-target><form class="paste-ui-formhtml" method="post" action="/html">'+fields+'<button>Save</button></form></div>',
                        ['form/form_validity','form/form_html'],optimized,null,async r=>r.fulfill({contentType:'text/html',body:'<p role="status" id="answer">Saved</p>'}));
                    await html.page.evaluate(()=>document.querySelector('button').click());await html.page.waitForSelector('#answer');assert.deepEqual(html.errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'formhtml native DOM members survive named form controls'});
                    await html.page.close();
                    const draft=await pageFor(browser,
                        '<form data-ui-autosave="title" data-autosave-action="/draft"><input id="title" name="title">'+fields+'</form>',
                        ['form/form_autosave'],optimized,()=>{window.sends=0;paste.io.open=()=>({send(){sends++;}});});
                    await draft.page.evaluate(()=>{const field=document.getElementById('title');field.value='edited';field.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await draft.page.evaluate(()=>sends),1);assert.deepEqual(draft.errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'autosave binds native controls despite form member collisions'});
                    await draft.page.close();
                    const upload=await pageFor(browser,
                        '<form><input id="upload" name="photo" type="file" data-image-upload-action="/upload"><input type="hidden" data-image-upload-uri data-image-upload-for="upload"><img alt="" data-image-upload-preview data-image-upload-for="upload"><span data-image-upload-message data-image-upload-for="upload"></span>'+fields+'</form>',
                        ['imageupload'],optimized,()=>{window.sends=0;paste.io.open=()=>window.uploadRequest={send(){if(this.timeout!==30000)throw Error('missing timeout');sends++;}};});
                    await upload.page.setInputFiles('#upload',{name:'photo.png',mimeType:'image/png',buffer:Buffer.from([1,2,3])});
                    assert.equal(await upload.page.evaluate(()=>sends),1);
                    await upload.page.evaluate(()=>uploadRequest.ontimeout());
                    assert.equal(await upload.page.getAttribute('#upload','data-image-upload-loading'),null);
                    assert.equal(await upload.page.locator('[data-image-upload-message]').getAttribute('data-image-upload-error-message'),'Error uploading image');
                    assert.equal(await upload.page.locator('[data-image-upload-uri]').inputValue(),'');
                    await upload.page.setInputFiles('#upload',[]);
                    await upload.page.setInputFiles('#upload',{name:'retry.png',mimeType:'image/png',buffer:Buffer.from([1,2,3])});
                    assert.equal(await upload.page.evaluate(()=>sends),2);assert.deepEqual(upload.errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'imageupload binds native controls despite form member collisions'});
                    await upload.page.close();
                    const prevent=await pageFor(browser,
                        '<iframe name="reply"></iframe><form action="/native" target="reply">'+fields+'<button data-prevent-double-submit="true">Save</button></form>',
                        ['prevent_double_submit'],optimized,null,async r=>r.fulfill({contentType:'text/html',body:'Saved'}));
                    await prevent.page.evaluate(()=>document.querySelector('button').click());await prevent.page.waitForFunction(()=>document.querySelector('button').disabled);
                    await prevent.page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
                    assert.equal(await prevent.page.evaluate(()=>document.querySelector('button').disabled),false);assert.deepEqual(prevent.errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'native double-submit guard survives form member collisions and pageshow'});
                    await prevent.page.close();
                }
                {
                    let sends=0;
                    const {page,errors}=await pageFor(browser,
                        '<form class="paste-ui-apply" method="post" action="/apply"><div><label for="email">Email</label><input id="email" name="email" value="x"><input name="other" value="y"></div><input type="hidden" name="token" value="kept"><button>Save</button></form>',
                        ['form/form_validity','form/form_apply'],optimized,()=>{
                            window.hiddenChanges=0;window.reentered=0;
                            document.querySelector('[name=token]').addEventListener('change',()=>hiddenChanges++);
                            document.querySelector('form').addEventListener('formdata',()=>{if(!reentered++){document.querySelector('form').requestSubmit();}});
                        },async r=>{sends++;await r.fulfill({status:400,contentType:'application/json',body:'{"error":{"message":"Fix email","param":"email"}}'});});
                    assert.equal(await page.evaluate(()=>hiddenChanges),1);
                    await page.click('button');await page.waitForSelector('.paste-ui-apply-failure');
                    assert.equal(sends,1);assert.equal(await page.locator('#email').inputValue(),'x');
                    assert.equal(await page.locator('#email').evaluate(e=>e.parentElement.classList.contains('paste-ui-apply-error')),true);
                    assert.equal(await page.locator('[name=token]').inputValue(),'kept');assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'apply reentry suppression, shared error parent, hidden initialization and failure preservation'});
                    await page.close();
                }
                {
                    const {page,errors}=await pageFor(browser,
                        '<form class="paste-ui-apply" method="post" action="/apply"><input name="title" value="ready"><button name="intent" value="save">Save</button></form>',
                        ['form/form_validity','form/form_apply'],optimized,()=>{
                            const Native=window.FormData;window.FormData=function(form){return new Native(form);};
                            window.sends=0;paste.io.open=()=>{sends++;return {send(){}};};
                        });
                    await page.evaluate(()=>document.addEventListener('submit',e=>{window.wasTaken=e.defaultPrevented;e.preventDefault();}));
                    await page.click('button');assert.equal(await page.evaluate(()=>wasTaken),false);assert.equal(await page.evaluate(()=>sends),0);assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'apply leaves unsupported FormData submitter handling native'});
                    await page.close();
                }
                {
                    const {page,errors}=await pageFor(browser,
                        '<form class="paste-ui-apply" method="post"><input name="title" value="ready"><button>Save</button></form>',
                        ['form/form_validity','form/form_apply'],optimized,()=>{
                            HTMLFormElement.prototype.checkValidity=undefined;
                            window.sends=0;paste.io.open=()=>{sends++;return {send(){}};};
                        });
                    await page.evaluate(()=>document.addEventListener('submit',e=>{window.wasTaken=e.defaultPrevented;e.preventDefault();}));
                    await page.click('button');assert.equal(await page.evaluate(()=>wasTaken),false);assert.equal(await page.evaluate(()=>sends),0);assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'apply leaves missing native validity capability untouched'});
                    await page.close();
                }
                {
                    let sends=0, release;
                    const gate=new Promise(r=>{release=r;});
                    const {page,errors}=await pageFor(browser,'<div id="lazy" data-lazy-load="/old">Fallback</div>',
                        ['lazy_loader'],optimized,null,async r=>{sends++;if(sends===1){await gate;}await r.fulfill({contentType:'text/html',body:sends===1?'Old':'New'});});
                    assert.equal(sends,0);
                    await page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document));
                    await page.waitForFunction(()=>document.getElementById('lazy').hasAttribute('data-lazy-load'));
                    await page.evaluate(()=>document.getElementById('lazy').setAttribute('data-lazy-load','/new'));
                    const oldResponse=page.waitForResponse('http://paste.test/old');release();await oldResponse;
                    await page.evaluate(()=>new Promise(requestAnimationFrame));
                    await page.waitForFunction(()=>document.getElementById('lazy').textContent==='Fallback');
                    await page.evaluate(()=>paste.ui.lazy_loader.load_all_content(document));
                    await page.waitForFunction(()=>document.getElementById('lazy').textContent==='New');
                    assert.equal(sends,2);assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'lazy loader stays caller-owned and rejects stale URL completion'});
                    await page.close();
                }
                {
                    let release;const gate=new Promise(resolve=>release=resolve);
                    const {page,errors}=await pageFor(browser,'<div data-lazy-load="/visible" style="width:100px;height:100px">Fallback</div>',
                        ['lazy_loader'],optimized,()=>{
                            window.measurements=0;
                            for(const name of ['offsetWidth','offsetHeight']){
                                const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,name);
                                Object.defineProperty(HTMLElement.prototype,name,{...descriptor,get(){measurements++;return descriptor.get.call(this);}});
                            }
                        },async r=>{await gate;await r.fulfill({contentType:'text/html',body:'Loaded'});});
                    const counts=await page.evaluate(()=>{measurements=0;paste.ui.lazy_loader.load_visible_content(document);const first=measurements;paste.ui.lazy_loader.load_visible_content(document);return [first,measurements];});
                    assert.deepEqual(counts,[2,2]);release();await page.waitForSelector('[data-lazy-load]',{state:'detached'});assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'repeated visible scans reject pending targets before geometry reads'});
                    await page.close();
                }
                {
                    const css = require(process.env.PASTE_SASS_MODULE || 'sass').compile(path.join(root,'modules/carousel/carousel.scss'),{logger:{warn(){},debug(){}}}).css;
                    const {page,errors}=await pageFor(browser,
                        '<style>'+css+'.paste-ui-carousel{width:300px}.paste-ui-carousel-item{width:120px}</style><div id="controls"></div><div class="paste-ui-carousel" data-paste-carousel-name="variable" data-paste-carousel-slide-width="variable" data-paste-carousel-count data-paste-carousel-indicate data-paste-carousel-controlsparent="controls"><div class="paste-ui-carousel-wrap"><div class="paste-ui-carousel-items">'+Array.from({length:5},(_,i)=>'<div class="paste-ui-carousel-item"><a href="#x">Slide '+i+'</a></div>').join('')+'</div></div></div>',
                        ['utilities/animation-frame','utilities/mediaquery','carousel'],optimized);
                    await page.waitForSelector('.paste-ui-carousel-loaded');
                    assert.equal(await page.locator('.paste-ui-carousel > .paste-ui-carousel-indicator button').count(),3);
                    assert.equal(await page.locator('#controls .paste-ui-carousel-indicator').count(),0);
                    assert.equal(await page.locator('.paste-ui-carousel > .paste-ui-carousel-counter').count(),1);
                    await page.evaluate(()=>paste.ui.carousel.variable.goTo(2));
                    await page.waitForFunction(()=>document.querySelector('.paste-ui-carousel-items').style.left==='-300px');
                    assert.equal(await page.locator('.paste-ui-carousel-counter').textContent(),'3 / 3');
                    assert.deepEqual(await page.locator('.paste-ui-carousel-item').evaluateAll(items=>items.map(e=>e.inert)),[true,true,false,false,false]);
                    await page.evaluate(()=>document.querySelector('.paste-ui-carousel').style.width='600px');
                    await page.waitForFunction(()=>document.querySelector('.paste-ui-carousel-counter').textContent==='1 / 1');
                    assert.equal(await page.locator('#controls .paste-ui-carousel-controls-next').isDisabled(),true);
                    assert.equal(await page.locator('.paste-ui-carousel > .paste-ui-carousel-indicator button').count(),1);
                    await page.evaluate(()=>paste.ui.carousel.variable.dispose());
                    assert.equal(await page.locator('#controls button').count(),0);
                    assert.deepEqual(await page.locator('.paste-ui-carousel-item').evaluateAll(items=>items.map(e=>e.inert)),[false,false,false,false,false]);
                    assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'carousel actual CSS, variable pages, final-page clamp, resize, external controls and inert restoration'});
                    await page.close();
                }
                {
                    const {page,errors}=await pageFor(browser,
                        '<style>.paste-ui-carousel{width:300px}.paste-ui-carousel-items{position:relative;display:flex}.paste-ui-carousel-item{flex:0 0 100%}</style><div id="controls"></div><div class="paste-ui-carousel" data-paste-carousel-name="cycle" data-paste-carousel-autocycle="60" data-paste-carousel-controlsparent="controls"><div class="paste-ui-carousel-wrap"><div class="paste-ui-carousel-items"><div class="paste-ui-carousel-item">One</div><div class="paste-ui-carousel-item">Two</div></div></div></div>',
                        ['utilities/animation-frame','utilities/mediaquery','carousel'],optimized);
                    await page.waitForFunction(()=>paste.ui.carousel.cycle && paste.ui.carousel.cycle.current===1);
                    await page.emulateMedia({reducedMotion:'reduce'});
                    await page.waitForFunction(()=>paste.ui.carousel.cycle.autoCycleInterval===null);
                    const state=await page.evaluate(()=>paste.ui.carousel.cycle.current);
                    await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>paste.ui.carousel.cycle.current),state);
                    await page.emulateMedia({reducedMotion:'no-preference'});
                    await page.locator('.paste-ui-carousel-pause').focus();
                    assert.equal(await page.evaluate(()=>paste.ui.carousel.cycle.autoCycleInterval),null);
                    await page.evaluate(()=>document.querySelector('.paste-ui-carousel-pause').click());
                    assert.equal(await page.locator('.paste-ui-carousel-pause').getAttribute('aria-pressed'),'true');
                    await page.evaluate(()=>document.activeElement.blur());
                    assert.equal(await page.evaluate(()=>paste.ui.carousel.cycle.autoCycleInterval),null);
                    await page.evaluate(()=>paste.ui.carousel.cycle.dispose());assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'carousel auto-cycle, reduced motion, explicit pause and external control focus'});
                    await page.close();
                }
                {
                    let release, requests = 0;
                    const gate = new Promise(resolve => { release = resolve; });
                    const {page,errors} = await pageFor(browser,'',[],optimized,null,async r=>{
                        requests++;
                        assert.equal(r.request().url(),'http://paste.test/vendor/jquery.js');
                        await gate;
                        await r.fulfill({contentType:'application/javascript',body:'window.jQuery={ready:true};'});
                    });
                    for (const name of ['jquery','consumer']) {
                        await page.addScriptTag({content:await source(path.join(root,'examples/external-libraries',name+'.js'),optimized)});
                    }
                    assert.equal(await page.evaluate(()=>!!window.example?.['jquery-consumer']?.jquery),false);
                    release();
                    await page.waitForFunction(()=>window.example?.['jquery-consumer']?.jquery?.ready===true);
                    assert.equal(requests,1);
                    assert.deepEqual(errors,[]);
                    results.push({engine,version:browser.version(),optimized,scenario:'named external dependency waits for actual script readiness',requests});
                    await page.close();
                }
            }
        } finally { await browser.close(); }
    }
    const output = process.env.RESTORATION_RESULTS || path.join(root,'target/restoration-results.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(results,null,2)+'\n');
    console.log('PASS',results.length,'source/optimized browser scenarios');
})().catch(error=>{console.error(error);process.exitCode=1;});
