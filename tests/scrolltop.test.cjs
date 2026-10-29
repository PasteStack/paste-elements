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
const {readModuleSource} = require('./fakes.cjs');

// The scrolltop contract: a declared anchor to the current page (same path
// and search, no fragment or an empty one) returns to the top without a
// reload. The module runs the browser's own navigation to the empty
// fragment, then replaces the entry's address with the page's own so no
// "#" remains. It scrolls nothing and reads no motion preference: the
// browser and the page's CSS own the scroll. Every opt-out stays native.
// Real scrolling, history and event order are covered by the browser checks.

function anchor(attributes) {
    const attrs = Object.assign({href: 'http://site.test/'}, attributes || {});
    const resolved = new URL(attrs.href);
    return {
        nodeName: 'A', _attrs: attrs,
        protocol: resolved.protocol, host: resolved.host,
        pathname: resolved.pathname, search: resolved.search,
        hash: resolved.hash, username: resolved.username, password: resolved.password,
        hasAttribute(name) { return name in this._attrs; },
        getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; }
    };
}

function fixture(options = {}) {
    const log = [];
    const bound = {};
    const declared = options.declared === undefined ? true : options.declared;
    const current = new URL(options.href || 'http://site.test/');
    const location = {
        protocol: current.protocol,
        host: current.host,
        pathname: current.pathname,
        search: current.search,
        get href() { return options.href || current.href; },
        set href(value) { log.push(['navigate', value]); },
        replace(value) { log.push(['replace', value]); }
    };
    const history = {
        state: options.state === undefined ? null : options.state,
        pushState: () => log.push(['pushState'])
    };
    if (options.replaceState !== false) {
        history.replaceState = (state, title, url) => {
            log.push(['replaceState', state, url]);
            if (options.refuse) { throw new Error('refused'); }
        };
    }
    const window = {
        name: options.name || '',
        get top() { return options.nested ? {} : window; },
        location,
        history,
        scrollTo: () => log.push(['scrollTo']),
        matchMedia: () => { log.push(['matchMedia']); return {matches: false}; }
    };
    Object.defineProperty(window, 'pageYOffset', {get: () => { log.push(['pageYOffset']); return 400; }});
    const baseTarget = options.baseTarget;
    const context = {
        window,
        document: {
            querySelector: sel => sel.indexOf('data-paste-scrolltop') >= 0 ? (declared ? {} : null) :
                sel === 'base[target]' && baseTarget ? {getAttribute: () => baseTarget} : null
        },
        paste: {
            define(name, deps, factory) {
                factory({}, {bind(type, target, handler) { bound[type] = handler; }});
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(readModuleSource('paste/ui/scrolltop.js'), context);
    return {
        log,
        bound: () => bound.click !== undefined,
        click(target, mods) {
            const e = Object.assign({
                target, button: 0, defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; }
            }, mods || {});
            bound.click(e);
            return e;
        }
    };
}

test('a declared anchor to the current page navigates to the empty fragment, then drops the "#"', () => {
    const f = fixture();
    assert.ok(f.bound());
    const e = f.click(anchor({'data-paste-scrolltop': ''}));
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(f.log, [['navigate', 'http://site.test/#'], ['replaceState', 'paste.ui.scrolltop', 'http://site.test/']]);
});

test('a repeat activation replaces the entry this module rewrote, as a native "#" link does', () => {
    const f = fixture({state: 'paste.ui.scrolltop'});
    f.click(anchor({'data-paste-scrolltop': ''}));
    assert.deepEqual(f.log, [['replace', 'http://site.test/#'], ['replaceState', 'paste.ui.scrolltop', 'http://site.test/']]);
    const g = fixture({state: {owner: 'another script'}});
    g.click(anchor({'data-paste-scrolltop': ''}));
    assert.deepEqual(g.log.map(entry => entry[0]), ['navigate', 'replaceState']);
});

test('a click inside the anchor, such as on its logo image, is the anchor\'s click', () => {
    const f = fixture();
    const a = anchor({'data-paste-scrolltop': ''});
    const image = {nodeName: 'IMG', parentNode: {nodeName: 'SPAN', parentNode: a}};
    assert.equal(f.click(image).defaultPrevented, true);
    assert.deepEqual(f.log.map(entry => entry[0]), ['navigate', 'replaceState']);
});

test('the module scrolls nothing and reads no position or motion preference', () => {
    const f = fixture();
    f.click(anchor({'data-paste-scrolltop': ''}));
    for (const name of ['scrollTo', 'matchMedia', 'pageYOffset', 'pushState']) {
        assert.equal(f.log.some(entry => entry[0] === name), false, name);
    }
});

test('a bare "#" href and a query string keep the page address', () => {
    const f = fixture();
    f.click(anchor({'data-paste-scrolltop': '', href: 'http://site.test/#'}));
    assert.deepEqual(f.log.map(entry => entry[entry.length - 1]), ['http://site.test/#', 'http://site.test/']);
    const g = fixture({href: 'http://site.test/list?page=2'});
    g.click(anchor({'data-paste-scrolltop': '', href: 'http://site.test/list?page=2'}));
    assert.deepEqual(g.log.map(entry => entry[entry.length - 1]), ['http://site.test/list?page=2#', 'http://site.test/list?page=2']);
});

test('an empty query in the address is kept, so the navigation stays in the document', () => {
    const f = fixture({href: 'http://site.test/list?'});
    f.click(anchor({'data-paste-scrolltop': '', href: 'http://site.test/list?'}));
    assert.deepEqual(f.log.map(entry => entry[entry.length - 1]), ['http://site.test/list?#', 'http://site.test/list?']);
});

test('from a real fragment the click still returns to the top', () => {
    const f = fixture({href: 'http://site.test/#company'});
    f.click(anchor({'data-paste-scrolltop': ''}));
    assert.deepEqual(f.log, [['navigate', 'http://site.test/#'], ['replaceState', 'paste.ui.scrolltop', 'http://site.test/']]);
});

test('from an address already ending in "#" the click returns to the top and drops the "#", whichever way the href is spelled', () => {
    for (const href of ['http://site.test/', 'http://site.test/#']) {
        const f = fixture({href: 'http://site.test/#'});
        const e = f.click(anchor({'data-paste-scrolltop': '', href}));
        assert.equal(e.defaultPrevented, true, href);
        assert.deepEqual(f.log, [['navigate', 'http://site.test/#'], ['replaceState', 'paste.ui.scrolltop', 'http://site.test/']], href);
    }
});

test('a refused address rewrite does not escape the click', () => {
    const f = fixture({refuse: true});
    assert.doesNotThrow(() => f.click(anchor({'data-paste-scrolltop': ''})));
    assert.deepEqual(f.log.map(entry => entry[0]), ['navigate', 'replaceState']);
});

test('undeclared anchors, non-empty fragments and other pages stay native', () => {
    const f = fixture();
    for (const attrs of [
        {href: 'http://site.test/'},
        {'data-paste-scrolltop': '', href: 'http://site.test/#company'},
        {'data-paste-scrolltop': '', href: 'http://site.test/labs'},
        {'data-paste-scrolltop': '', href: 'http://site.test/?x=1'},
        {'data-paste-scrolltop': '', href: 'http://other.test/'},
        {'data-paste-scrolltop': '', href: 'ftp://site.test/'},
        {'data-paste-scrolltop': '', href: 'http://u@site.test/'},
        {'data-paste-scrolltop': '', href: 'http://:p@site.test/'}
    ]) {
        assert.equal(f.click(anchor(attrs)).defaultPrevented, false, JSON.stringify(attrs));
    }
    assert.equal(f.log.length, 0);
});

test('the same host under another protocol is another page', () => {
    const f = fixture({href: 'https://site.test/'});
    assert.equal(f.click(anchor({'data-paste-scrolltop': '', href: 'http://site.test/'})).defaultPrevented, false);
    assert.equal(f.log.length, 0);
});

test('modified, secondary and already handled clicks stay native', () => {
    const f = fixture();
    const a = anchor({'data-paste-scrolltop': ''});
    for (const mods of [{metaKey: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}, {button: 2}, {defaultPrevented: true}]) {
        f.click(a, mods);
    }
    assert.equal(f.log.length, 0);
});

test('a referrer policy or noreferrer still returns to the top: no request is made', () => {
    for (const extra of [{referrerpolicy: 'no-referrer'}, {rel: 'noopener noreferrer'}]) {
        const f = fixture();
        assert.equal(f.click(anchor(Object.assign({'data-paste-scrolltop': ''}, extra))).defaultPrevented, true, JSON.stringify(extra));
        assert.deepEqual(f.log.map(entry => entry[0]), ['navigate', 'replaceState']);
    }
});

test('download, ping and other contexts stay native', () => {
    const f = fixture();
    for (const extra of [{download: ''}, {target: '_blank'}, {ping: '/p'}]) {
        assert.equal(f.click(anchor(Object.assign({'data-paste-scrolltop': ''}, extra))).defaultPrevented, false, JSON.stringify(extra));
    }
    const g = fixture({baseTarget: 'frame'});
    assert.equal(g.click(anchor({'data-paste-scrolltop': ''})).defaultPrevented, false);
    // <base target> applies to an empty target attribute too.
    assert.equal(g.click(anchor({'data-paste-scrolltop': '', target: ''})).defaultPrevented, false);
    assert.equal(f.log.length + g.log.length, 0);
});

test('an explicit _self target or the window\'s own name is the current context', () => {
    const f = fixture();
    assert.equal(f.click(anchor({'data-paste-scrolltop': '', target: '_SELF'})).defaultPrevented, true);
    const g = fixture({name: 'me'});
    assert.equal(g.click(anchor({'data-paste-scrolltop': '', target: 'me'})).defaultPrevented, true);
    assert.deepEqual(g.log.map(entry => entry[0]), ['navigate', 'replaceState']);
});

test('in a top-level window _top and _parent name the current context; in a frame they stay native', () => {
    const f = fixture();
    for (const target of ['_top', '_Parent']) {
        assert.equal(f.click(anchor({'data-paste-scrolltop': '', target})).defaultPrevented, true, target);
    }
    const g = fixture({nested: true});
    for (const target of ['_top', '_parent']) {
        assert.equal(g.click(anchor({'data-paste-scrolltop': '', target})).defaultPrevented, false, target);
    }
    assert.equal(g.log.length, 0);
});

test('nothing binds without a declaration or without replaceState', () => {
    assert.equal(fixture({declared: false}).bound(), false);
    assert.equal(fixture({replaceState: false}).bound(), false);
});
