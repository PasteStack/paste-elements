const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modules = path.join(__dirname, '..', 'modules');

function load(file, sandbox) {
    vm.runInNewContext(fs.readFileSync(path.join(modules, file), 'utf8'), sandbox);
}

function scrollspyFixture(options) {
    const opts = options || {};
    const nav = {
        attrs: opts.attrs || {},
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name);
        }
    };
    const sectionLink = hash => ({hash, parentElement: {classes: new Set()}});
    const controlLink = hash => ({hash, classes: ['paste-ui-section-nav-toggle'], parentElement: {classes: new Set()}});
    const links = [
        sectionLink('#one'),
        sectionLink('#two'),
        controlLink('#site-sections'),
        controlLink('#site-sections-toggle')
    ];
    const targets = {'#one': {top: 100}, '#two': {top: 500}};
    const measured = [];
    const handlers = {};
    const dom = {
        requestedSelector: null,
        querySelector(sel) {
            if (sel === '[data-paste-scrollspy]' || sel === '.paste-ui-section-nav') { return nav; }
            return targets[sel] || null;
        },
        get(sel, parent) {
            this.requestedSelector = sel;
            assert.equal(parent, nav);
            return sel.includes(':not(.paste-ui-section-nav-toggle)') ? links.filter(l => !l.classes) : links;
        },
        getScrollTop() { return opts.scrollTop; },
        getViewportWidth() { return 1280; },
        addCssClass(el, name) { el.classes.add(name); },
        removeCssClass(el, name) { el.classes.delete(name); },
        Bounds: {
            fromElement(el) {
                measured.push(el);
                assert.ok(!el.classes || !el.classes.includes('paste-ui-section-nav-toggle'),
                    'scrollspy measured a disclosure control');
                return el === nav ? {top: 0, height: 65} : {top: el.top, height: 100};
            }
        }
    };
    const util = {each(list, fn) { list.forEach(fn); }};
    const Event = function () {};
    Event.Subscription = function (type, target, handler) {
        handlers[type] = handler;
        this.attach = () => {};
        this.detach = () => {};
    };
    const event = {Event, DocumentEvent: {loaded(fn) { fn(); }}};
    load('scrollspy/scrollspy.js', {
        window: {},
        paste: {define(name, dependencies, factory) {
            assert.equal(name, 'paste.ui.scrollspy');
            factory({}, dom, util, event, {touch: !!opts.touch});
        }}
    });
    return {
        nav,
        links,
        dom,
        measured,
        active(index) { return links[index].parentElement.classes.has('active'); },
        scrollTo(value) { opts.scrollTop = value; handlers.scroll(); }
    };
}

function smoothscrollFixture() {
    const nav = {};
    const subscriptions = [];
    const fired = [];
    const Event = function (target, name) {
        const handlers = [];
        this.subscribe = handler => {
            handlers.push(handler);
            return {attach() {}, detach() {}};
        };
        this.fire = data => {
            fired.push({name, data});
            handlers.forEach(handler => handler(null, data));
        };
    };
    Event.Subscription = function (type, target, handler) {
        subscriptions.push({type, target, handler});
        this.attach = () => {};
        this.detach = () => {};
    };
    const dom = {
        querySelector(sel) { return sel === '.paste-ui-section-nav' ? nav : null; },
        querySelectorAll(sel) { return sel === '.paste-ui-section-nav' ? [nav] : []; },
        get(sel) { return [{id: sel.slice(1), top: 500}]; },
        getScrollTop() { return 0; },
        getScrollHeight() { return 4000; },
        getViewportHeight() { return 800; },
        Bounds: {fromElement(el) { return {top: el.top || 0, height: 65}; }}
    };
    const util = {each(list, fn) { list.forEach(fn); }};
    load('smoothscroll/smoothscroll.js', {
        window: {scrollTo() {}, setTimeout() { return 0; }, clearTimeout() {}, history: {}},
        document: {},
        history: {},
        paste: {define(name, dependencies, factory) {
            assert.equal(name, 'paste.ui.smoothscroll');
            factory({}, util, dom, {Event});
        }}
    });
    const clicks = subscriptions.filter(s => s.type === 'click').map(s => s.handler);
    assert.equal(clicks.length, 1);
    return {click: clicks[0], smoothscrolls: () => fired.filter(e => e.name === 'smoothscroll')};
}

test('scrollspy excludes disclosure controls from measurement and grouping', () => {
    const f = scrollspyFixture({scrollTop: 0});
    assert.ok(f.dom.requestedSelector.includes(':not(.paste-ui-section-nav-toggle)'));
    assert.deepEqual(f.measured.filter(el => el.classes), []);
    f.scrollTo(50);
    assert.ok(f.active(0));
    assert.ok(!f.active(1));
    f.scrollTo(450);
    assert.ok(!f.active(0));
    assert.ok(f.active(1));
    assert.ok(!f.links[2].parentElement.classes.has('active'));
    assert.ok(!f.links[3].parentElement.classes.has('active'));
});

test('scrollspy stays inactive on touch without the opt-in attribute', () => {
    const f = scrollspyFixture({touch: true, scrollTop: 450});
    f.scrollTo(50);
    f.scrollTo(450);
    assert.ok(!f.active(0));
    assert.ok(!f.active(1));
});

test('scrollspy opts in on touch when data-spy-touch is present', () => {
    const f = scrollspyFixture({touch: true, attrs: {'data-spy-touch': 'false'}, scrollTop: 0});
    f.scrollTo(450);
    assert.ok(f.active(1));
});

test('smoothscroll yields to native fragment navigation inside a disclosure nav', () => {
    const f = smoothscrollFixture();
    const disclosure = {};
    const anchor = {
        nodeName: 'A',
        hash: '#site-sections',
        closest(sel) { return sel === '.paste-ui-section-nav-disclosure' ? disclosure : null; }
    };
    const span = {nodeName: 'SPAN', parentNode: anchor};
    let prevented = false;
    f.click({target: span, preventDefault() { prevented = true; }});
    assert.equal(prevented, false);
    assert.equal(f.smoothscrolls().length, 0);
});

test('smoothscroll still animates section links outside a disclosure nav', () => {
    const f = smoothscrollFixture();
    const anchor = {nodeName: 'A', hash: '#one', closest() { return null; }};
    const span = {nodeName: 'SPAN', parentNode: anchor};
    let prevented = false;
    f.click({target: span, preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    const fired = f.smoothscrolls();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].data.newURL, 'one');
});
