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
// Native presentation, source and optimized. All responses are local fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const terser = require(process.env.TERSER_MODULE || 'terser');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'modules');
const core = process.env.PASTE_CORE_JS;
const results = [];
const cache = new Map();
async function source(file, optimized) {
    const key = file + optimized;
    if (!cache.has(key)) {
        const text = fs.readFileSync(file, 'utf8');
        cache.set(key, optimized ? (await terser.minify(text, {ecma: 5})).code : text);
    }
    return cache.get(key);
}
async function sequence(browser, optimized, intro, buffer) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', async route => {
        if (route.request().url().endsWith('/')) {
            return route.fulfill({contentType: 'text/html', body:
                '<!doctype html><style>body{margin:0}.scope{height:1000px}#host{display:block;width:100px;height:100px}footer{height:2000px}</style>' +
                '<div class="scope" data-paste-scrollscrub data-scrub-start="top top" data-scrub-end="bottom top">' +
                '<button id="skip" type="button" hidden>Skip</button><i id="host" data-paste-imagesequence="#frames" data-sequence-playback="queued" data-sequence-playback-fps="30" data-sequence-from="' + (intro ? 3 : 0) + '" ' +
                (buffer ? 'data-sequence-scrub-buffer-frames="2" ' : '') +
                (intro ? 'data-sequence-intro-from="0" data-sequence-intro-to="3" data-sequence-intro-duration-ms="600" data-sequence-intro-skip="#skip"' : '') +
                '></i><script type="application/json" id="frames">' + JSON.stringify({frames: Array.from({length: 6}, (_, i) => ({src: '/f' + i + '.svg', width: 100, height: 100}))}) + '</script></div><footer></footer>'});
        }
        await new Promise(resolve => setTimeout(resolve, 80));
        return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'});
    });
    await page.goto('http://paste.test/');
    await page.evaluate(() => {
        window.seen = [];
        new MutationObserver(() => {
            const match = /f([0-9]+)\.svg/.exec(document.getElementById('host').style.backgroundImage);
            if (match && seen.at(-1) !== +match[1]) seen.push(+match[1]);
        }).observe(document.getElementById('host'), {attributes: true});
    });
    const files = ['paste', 'util', 'oop', 'guid', 'dom', 'event'].map(n => path.join(core, n + '.js'))
        .concat(['utilities/animation-frame', 'utilities/scrollrange', 'utilities/imageresolution', 'utilities/mediaquery', 'imagesequence'].map(n => path.join(base, n, n.split('/').at(-1) + '.js')));
    for (const file of files) await page.addScriptTag({content: await source(file, optimized)});
    return {page, errors};
}
(async () => {
    for (const engine of (process.env.ELEMENTS_ENGINES || 'chromium').split(',')) {
        const browser = await pw[engine].launch({headless: true, proxy: {server: 'http://127.0.0.1:9'},
            executablePath: engine === 'chromium' ? process.env.ELEMENTS_CHROMIUM_EXECUTABLE : undefined});
        try {
            for (const optimized of [false, true]) {
                for (const intro of [false, true]) {
                    for (const buffer of [false, true]) {
                        const {page, errors} = await sequence(browser, optimized, intro, buffer);
                        if (intro) await page.waitForFunction(() => seen.includes(1));
                        await page.evaluate(() => scrollTo(0, 1000));
                        await page.waitForFunction(() => seen.at(-1) === 5);
                        assert.deepEqual(await page.evaluate(() => seen), [0, 1, 2, 3, 4, 5]);
                        await page.evaluate(() => scrollTo(0, 0));
                        await page.waitForFunction(expected => seen.at(-1) === expected, intro ? 3 : 0);
                        assert.deepEqual(errors, []);
                        results.push({engine, version: browser.version(), optimized, scenario: 'ordered travel and reverse', intro, buffer, seen: await page.evaluate(() => seen)});
                        await page.close();
                    }
                }
                {
                    const {page, errors} = await sequence(browser, optimized, true, false);
                    await page.waitForFunction(() => seen.includes(1));
                    await page.evaluate(() => { scrollTo(0, 1000); document.getElementById('skip').click(); });
                    await page.waitForFunction(() => seen.at(-1) === 5);
                    assert.equal(await page.locator('#skip').isVisible(), false);
                    assert.deepEqual(errors, []);
                    results.push({engine, optimized, scenario: 'explicit skip reaches current scroll destination', seen: await page.evaluate(() => seen)});
                    await page.close();
                }
                {
                    const page = await browser.newPage();
                    await page.goto('about:blank');
                    await page.evaluate(() => { window.paste = {define: (n, d, f) => { window.formDom = {}; f(formDom); }}; });
                    await page.addScriptTag({content: await source(path.join(base, 'utilities/form-dom/form-dom.js'), optimized)});
                    // Exact v7 helper supplies the comparison, never production code.
                    const before = process.env.PASTE_BASE_MODULES;
                    if (!before) throw Error('PASTE_BASE_MODULES is required for the equivalent-work benchmark');
                    await page.evaluate(() => { window.currentFormDom = formDom; });
                    await page.addScriptTag({content: await source(path.join(before, 'utilities/form-dom/form-dom.js'), optimized)});
                    const samples = await page.evaluate(() => {
                        const form = document.createElement('form');
                        form.innerHTML = '<input name="getAttribute"><input name="classList"><input name="addEventListener">';
                        form.setAttribute('data-x', 'ok');
                        const get = currentFormDom.getAttribute;
                        const result = {generic: [], captured: []};
                        for (let round = 0; round < 9; round++) {
                            for (const kind of round % 2 ? ['captured', 'generic'] : ['generic', 'captured']) {
                                const start = performance.now();
                                for (let i = 0; i < 100000; i++) {
                                    const value = kind === 'generic' ? formDom.get(form, 'getAttribute').call(form, 'data-x') : get.call(form, 'data-x');
                                    if (value !== 'ok') throw Error('collision');
                                }
                                result[kind].push(performance.now() - start);
                            }
                        }
                        if (currentFormDom.classList.call(form) !== Object.getOwnPropertyDescriptor(Element.prototype, 'classList').get.call(form)) throw Error('getter');
                        let count = 0;
                        currentFormDom.addEventListener.call(form, 'test', function () { if (this !== form) throw Error('receiver'); count++; });
                        currentFormDom.dispatchEvent.call(form, new Event('test'));
                        if (count !== 1) throw Error('binding');
                        return result;
                    });
                    results.push({engine, optimized, scenario: 'collision-safe native operations and equivalent reads', readsPerSample: 100000, samplesMs: samples});
                    await page.close();
                }
            }
        } finally { await browser.close(); }
    }
    fs.mkdirSync(path.join(root, 'target'), {recursive: true});
    fs.writeFileSync(path.join(root, 'target/queued-playback-results.json'), JSON.stringify(results, null, 2));
    console.log(results.length + ' native scenarios/benchmarks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
