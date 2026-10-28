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

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource, frameDriver} = require('./fakes.cjs');

// Restore the supplied per-nav declaration contract. A stable authored
// target supplies the threshold; no wrapper/sibling/transform inference.
function fixture(configs = [{}], options = {}) {
    const state = {scroll: 0, width: 1200}, operations = [], bindings = [], observers = [], mutations = [];
    const frames = frameDriver(), rootClasses = new Set();
    const target = (name, bottom) => ({name, bottom, hidden: false,
        getClientRects() { operations.push(['boxes', name]); return this.hidden ? [] : [{}]; },
        getBoundingClientRect() { operations.push(['rect', name]); return {bottom: this.bottom - state.scroll}; }
    });
    const targets = {'#first': target('first', 200), '#second': target('second', 400)};
    const navs = configs.map((cfg, index) => {
        const attrs = Object.assign({'data-paste-sticky-nav': ''}, cfg.attrs), classes = new Set(cfg.classes || []);
        return {classes, cfg, nodeType: 1, attached: true, querySelectorAll: () => [], getBoundingClientRect: () => ({top: (cfg.top === undefined ? 150 : cfg.top) - state.scroll}), getAttribute: key => Object.hasOwn(attrs, key) ? attrs[key] : null,
            classList: {add(name) { operations.push(['write', index, 'add', name]); classes.add(name); },
                remove(name) { operations.push(['write', index, 'remove', name]); classes.delete(name); }}};
    });
    const window = {WeakMap: options.noWeakMap ? undefined : WeakMap};
    if (!options.noMutations) window.MutationObserver = class {
        constructor(callback) { this.callback = callback; mutations.push(this); }
        observe(el, config) { this.target = el; this.config = config; }
    };
    if (!options.noObserver) window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(el) { if (!this.targets.includes(el)) this.targets.push(el); }
        disconnect() { this.targets = []; }
    };
    const document = {readyState: options.readyState || 'complete', documentElement: {classList: rootClasses, contains: el => el.attached !== false}};
    let api;
    vm.runInNewContext(readModuleSource('paste/ui/stickynav.js'), {window, document,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.stickynav');
            assert.deepEqual(Array.from(deps), ['paste.dom', 'paste.event', 'paste.ui.utilities.animation-frame']);
            api = factory({}, {
                get(selector, all) { assert.equal(selector, '[data-paste-sticky-nav]'); assert.equal(all, true); return navs.filter(el => el.attached); },
                querySelector(selector) {
                    if (selector === '[data-paste-sticky-target]') return options.noFallback ? null : targets['#first'];
                    if (selector === '[') throw new SyntaxError('bad selector');
                    if (selector === '#self') return navs[0];
                    return targets[selector] || null;
                }, getViewportWidth: () => state.width, getScrollTop: () => state.scroll
            }, {bind(type, el, fn, context, count) { bindings.push({type, el, fn, count}); }}, frames);
        }}
    });
    const fire = type => { for (const binding of bindings.filter(b => b.type === type)) { binding.fn(); } };
    return {navs, targets, state, operations, bindings, observers, mutations, frames, rootClasses, api, fire,
        flush() { frames.tick(16); },
        active(index = 0) { return navs[index].classes.has('paste-ui-sticky-active'); }};
}

test('the default target bottom drives only its marked nav class', () => {
    const f = fixture();
    assert.equal(f.frames.pending(), 1);
    f.flush();
    assert.equal(f.active(), false);
    assert.equal(f.navs[0].classes.has('paste-ui-sticky'), true);
    f.state.scroll = 199; f.fire('scroll'); f.flush(); assert.equal(f.active(), false);
    f.state.scroll = 200; f.fire('scroll'); f.flush(); assert.equal(f.active(), true);
    f.state.scroll = 100; f.fire('scroll'); f.flush(); assert.equal(f.active(), false);
    assert.equal(f.rootClasses.size, 0);
    assert.deepEqual(Object.keys(f.api).sort(), ['init', 'updateSticky']);
});

test('explicit targets support independent navs in the same document', () => {
    const f = fixture([{}, {attrs: {'data-paste-sticky-nav': '#second'}}]);
    f.state.scroll = 300; f.flush();
    assert.equal(f.active(0), true); assert.equal(f.active(1), false);
    f.state.scroll = 450; f.fire('scroll'); f.flush();
    assert.equal(f.active(0), true); assert.equal(f.active(1), true);
    assert.equal(f.bindings.filter(b => b.type === 'scroll').length, 1);
    assert.equal(f.observers.length, 1);
});

test('a burst shares one frame and reads every box before class writes', () => {
    const f = fixture([{}, {attrs: {'data-paste-sticky-nav': '#second'}}]);
    f.fire('scroll'); f.fire('resize'); f.observers[0].callback();
    assert.equal(f.frames.pending(), 1);
    f.flush();
    const firstWrite = f.operations.findIndex(op => op[0] === 'write');
    assert.ok(firstWrite > 0);
    assert.ok(f.operations.slice(firstWrite).every(op => op[0] === 'write'));
    f.operations.length = 0; f.fire('scroll'); f.flush();
    assert.equal(f.operations.filter(op => op[0] === 'write').length, 0);
});

test('minimum width is local to the nav and crossing it clears the class', () => {
    const f = fixture([{attrs: {'data-paste-sticky-nav': '', 'data-sticky-min-width': '768'}}]);
    f.state.scroll = 300; f.flush(); assert.equal(f.active(), true);
    f.state.width = 768; f.fire('resize'); f.flush(); assert.equal(f.active(), false);
    f.operations.length = 0; f.fire('scroll'); f.flush();
    assert.equal(f.operations.length, 0, 'ineligible nav measured a target');
    f.state.width = 769; f.fire('resize'); f.flush(); assert.equal(f.active(), true);
});

for (const value of ['0', '-1', ' 800 ', '1e3', 'NaN']) {
    test(`minimum-width declaration ${JSON.stringify(value)} does not disable a narrow nav`, () => {
        const f = fixture([{attrs: {'data-paste-sticky-nav': '', 'data-sticky-min-width': value}}]);
        f.state.width = 320; f.state.scroll = 300; f.flush(); assert.equal(f.active(), true);
    });
}

test('a hidden target stays inactive and can become eligible after observation', () => {
    const f = fixture();
    f.targets['#first'].hidden = true; f.state.scroll = 300; f.flush(); assert.equal(f.active(), false);
    assert.equal(f.operations.filter(op => op[0] === 'rect').length, 0);
    f.targets['#first'].hidden = false; f.observers[0].callback(); f.flush(); assert.equal(f.active(), true);
});

test('a shifted declared target is remeasured on the next scroll or size report', () => {
    const f = fixture();
    f.state.scroll = 300; f.flush(); assert.equal(f.active(), true);
    f.targets['#first'].bottom = 500; f.fire('scroll'); f.flush(); assert.equal(f.active(), false);
    f.targets['#first'].bottom = 250; f.observers[0].callback(); f.flush(); assert.equal(f.active(), true);
});

test('invalid and self targets retain their authored baseline', () => {
    for (const attrs of [{'data-paste-sticky-nav': '['}, {'data-paste-sticky-nav': '#self'}]) {
        const f = fixture([{attrs}], {noFallback: true});
        assert.equal(f.bindings.length, 0);
        assert.equal(f.frames.pending(), 0);
        assert.equal(f.operations.length, 0);
    }
});

test('no nav declarations means no observation, listener or frame', () => {
    const f = fixture([]);
    assert.equal(f.bindings.length, 0); assert.equal(f.observers.length, 0); assert.equal(f.frames.pending(), 0);
});

test('initial stale active state is reset, and late page load gets one refresh', () => {
    const f = fixture([{classes: ['paste-ui-sticky-active']}], {readyState: 'loading', noObserver: true});
    f.fire('DOMContentLoaded');
    f.flush(); assert.equal(f.active(), false);
    assert.equal(f.bindings.find(b => b.type === 'load').count, 1);
    f.state.scroll = 400; f.fire('load'); f.flush(); assert.equal(f.active(), true);
});

test('absent targets retain own-position threshold and synchronous refresh', () => {
 const f=fixture([{}],{noFallback:true});f.flush();assert.equal(f.active(),false);
 f.state.scroll=150;f.api.updateSticky();assert.equal(f.active(),true);
 f.state.scroll=149;f.api.updateSticky();assert.equal(f.active(),false);
 f.api.init();f.flush();assert.equal(f.bindings.filter(b=>b.type==='scroll').length,1);
});


test('ineligible scrolls do not request frames, resize reactivates', () => {
 const f=fixture([{attrs:{'data-sticky-min-width':'1400'}}]);f.flush();
 f.fire('scroll');assert.equal(f.frames.pending(),0);
 f.state.width=1500;f.state.scroll=300;f.fire('resize');f.flush();assert.equal(f.active(),true);
 f.fire('scroll');assert.equal(f.frames.pending(),1);
});

test('detached nav targets are released and reinsertion preserves the initial own threshold', () => {
 const f=fixture([{}],{noFallback:true});f.flush();
 const nav=f.navs[0];nav.attached=false;
 f.mutations[0].callback([{removedNodes:[nav],addedNodes:[]}]);
 f.state.scroll=200;f.fire('scroll');assert.equal(f.frames.pending(),0);
 nav.cfg.top=999;nav.attached=true;
 f.mutations[0].callback([{removedNodes:[],addedNodes:[nav]}]);f.flush();
 assert.equal(f.active(),true,'reinsertion replaced the original 150px threshold');
});

test('one removed nav cannot unobserve a surviving nav shared target', () => {
 const f=fixture([{},{}]);f.flush();f.navs[0].attached=false;
 f.mutations[0].callback([{removedNodes:[f.navs[0]],addedNodes:[]}]);f.flush();
 assert.ok(f.observers[0].targets.includes(f.targets['#first']));
 f.navs[1].attached=false;f.mutations[0].callback([{removedNodes:[f.navs[1]],addedNodes:[]}]);
 assert.ok(!f.observers[0].targets.includes(f.targets['#first']));
});

test('init before mutation delivery restores target watches and does not duplicate records', () => {
 const f=fixture();f.flush();const nav=f.navs[0];nav.attached=false;f.api.init();
 assert.ok(!f.observers[0].targets.includes(f.targets['#first']));
 nav.attached=true;f.api.init();f.mutations[0].callback([{removedNodes:[nav],addedNodes:[nav]}]);f.flush();
 assert.ok(f.observers[0].targets.includes(f.targets['#first']));
 f.operations.length=0;f.state.scroll=300;f.fire('scroll');f.flush();
 assert.equal(f.operations.filter(x=>x[0]==='rect').length,1);
});

test('added subtrees only restore known navs, including one without its original marker', () => {
 const f=fixture();f.flush();const nav=f.navs[0];nav.attached=false;
 f.mutations[0].callback([{removedNodes:[nav],addedNodes:[]}]);nav.attached=true;
 const subtree={nodeType:1,firstElementChild:nav,querySelectorAll(selector){assert.equal(selector,'*');return [nav,{nodeType:1}];}};
 f.mutations[0].callback([{removedNodes:[],addedNodes:[subtree]}]);f.state.scroll=300;f.flush();assert.equal(f.active(),true);
});

test('without mutation observation init retires and restores weakly known navs', () => {
 const f=fixture([{}],{noMutations:true});f.flush();f.navs[0].attached=false;f.api.init();
 assert.ok(!f.observers[0].targets.includes(f.targets['#first']));
 f.navs[0].attached=true;f.api.init();f.state.scroll=300;f.flush();assert.equal(f.active(),true);
});

test('without WeakMap the original discovery path remains idempotent', () => {
 const f=fixture([{}],{noWeakMap:true});f.api.init();f.flush();
 assert.equal(f.mutations.length,0);assert.equal(f.bindings.filter(x=>x.type==='scroll').length,1);
});


test('new leaf elements do not trigger descendant discovery or enhancement', () => {
 const f=fixture();f.flush();
 const leaf={nodeType:1,firstElementChild:null,querySelectorAll(){throw new Error('leaf queried');}};
 f.mutations[0].callback([{removedNodes:[],addedNodes:[leaf]}]);
 assert.equal(f.frames.pending(),0);
});
