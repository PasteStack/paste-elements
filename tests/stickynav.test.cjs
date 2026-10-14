const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The stickynav threshold contract: the measured anchor must stay
// honest while the nav is stuck — a stuck target's own rect can be a
// fixed-position viewport coordinate, so the module measures a
// normal-flow marker it inserts at the target's slot. Recalibration
// passes (first scroll, load, resize) must therefore work in every
// stuck state.

function fixture(options = {}) {
    const listeners = {};
    const loadedHandlers = [];
    const classes = new Set();
    const state = {
        scrollTop: options.scrollTop || 0,
        viewportWidth: options.viewportWidth || 1200
    };

    function element(tagName, top, height) {
        const attributes = new Map();
        const el = {
            tagName, children: [], parentNode: null,
            rect: {top: top, height: height},
            style: {},
            marginTop: options.marginTop || '0px',
            setAttribute: (k, v) => attributes.set(k, String(v)),
            getAttribute: k => attributes.has(k) ? attributes.get(k) : null,
            hasAttribute: k => attributes.has(k),
            appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
            insertBefore(child, sibling) {
                child.parentNode = el;
                const i = sibling ? el.children.indexOf(sibling) : el.children.length;
                el.children.splice(i < 0 ? el.children.length : i, 0, child);
                return child;
            },
            addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
            removeEventListener: (t, fn) => {
                const list = listeners[t] || [];
                const i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            }
        };
        return el;
    }

    const nav = element('div', 0, options.navHeight === undefined ? 50 : options.navHeight);
    const target = element('div', options.targetTop === undefined ? 100 : options.targetTop, 40);
    target.className = 'sticky-nav-target';
    if (options.minWidth !== undefined) {
        target.setAttribute('data-sticky-min-width', String(options.minWidth));
    }
    const parent = element('div', 0, 0);
    parent.appendChild(target);
    const byId = {
        '_paste_ui_nav_wrap': nav,
        'content': element('div', 0, 0),
        'paste-ui-nav': element('div', 0, 0)
    };
    const document = {
        readyState: options.readyState || 'complete',
        getElementById: id => byId[id] || null,
        createElement: tag => element(tag, 0, 0),
        querySelectorAll: () => [],
        addEventListener: (t, fn) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
        removeEventListener() {}
    };
    const window = {
        pageYOffset: 0,
        getComputedStyle: el => ({marginTop: el.marginTop || '0px'}),
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => {
            const list = listeners[t] || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        }
    };
    const body = {classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c)
    }};
    const dom = {
        querySelector: (sel, ctx) => sel === '.sticky-nav-target' ? target : null,
        getDocumentBody: () => body,
        getScrollTop: () => state.scrollTop,
        getViewportWidth: () => state.viewportWidth,
        Bounds: {fromElement: el => el ? {top: el.rect.top, height: el.rect.height} : {top: 0, height: 0}}
    };
    const fired = [];
    const event = {
        Event: function (context, name) {
            this.context = context;
            this.name = name;
            this.fire = payload => fired.push({name: name, payload: payload});
            this.dispose = function () {};
        },
        DocumentEvent: {loaded: fn => loadedHandlers.push(fn)}
    };
    event.Event.Subscription = function (type, targetEl, fn) {
        targetEl.addEventListener(type, fn);
        this.dispose = () => targetEl.removeEventListener(type, fn);
    };
    // queuedFrames models a real animation-frame queue: callbacks wait
    // for the test's flush, so ordering bugs between a queued write and
    // a later correction are exercisable.
    const frameQueue = [];
    const animation_frame = {
        request: fn => options.queuedFrames ? frameQueue.push(fn) : fn(),
        cancel: () => {}
    };

    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/stickynav/stickynav.js'), 'utf8'), {
        window, document, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.stickynav');
            factory(exports, dom, event, animation_frame);
        }}
    });
    return {
        target, parent, nav, body, classes, state, fired,
        sentinel: () => parent.children[0],
        fireScroll: () => (listeners.scroll || []).slice().forEach(fn => fn({type: 'scroll'})),
        fireResize: () => (listeners.resize || []).slice().forEach(fn => fn({type: 'resize'})),
        fireLoaded: () => loadedHandlers.forEach(fn => fn()),
        flushFrames: () => frameQueue.splice(0).forEach(fn => fn())
    };
}

test('the slot marker keeps the threshold measurable while stuck', () => {
    const f = fixture();
    const sentinel = f.sentinel();
    assert.ok(sentinel, 'a normal-flow marker was inserted before the target');
    assert.strictEqual(f.parent.children[1], f.target, 'the marker sits at the target slot');
    // Slot at document top 100, nav 50 tall → the nav sticks at 50.
    sentinel.rect.top = 100;

    f.state.scrollTop = 75;
    f.fireScroll(); // first-scroll recalibration runs while unstuck
    assert.ok(f.classes.has('paste-fixed-subnav'), 'scrolled past the threshold — stuck');
    assert.ok(f.fired.some(e => e.name === 'navStuck'), 'the stuck event fired');

    // A late layout shift moves the slot down the document — and the
    // stuck target's own rect is now a viewport coordinate, so only
    // the in-flow marker still reads the honest position.
    sentinel.rect.top = 950;
    f.target.rect.top = 20; // fixed to the viewport — not the slot

    f.fireResize(); // the correction pass runs while stuck
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the corrected threshold unsticks a nav that is above it');
    assert.ok(f.fired.some(e => e.name === 'navUnstuck'), 'the unstuck event fired');
});

test('a queued class write applies the latest state, not the queued intent', () => {
    const f = fixture({queuedFrames: true});
    f.sentinel().rect.top = 100;
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks — the class write queues for the frame
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the class lands on the frame, not the event');

    // A correction lands before the frame runs: the threshold moved up,
    // the nav unsticks, and the stale queued add must not win.
    f.sentinel().rect.top = 950;
    f.fireLoaded();
    f.flushFrames();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the pending write applied the newest state — no stale class');
    assert.strictEqual(f.target.stuck, false, 'flag and class agree');
    f.fired.length = 0;

    // And a longer interleave: stick, unstick, re-stick all inside one
    // frame — the single pending apply still writes the newest state.
    f.state.scrollTop = 1200;
    f.fireScroll();
    f.state.scrollTop = 50;
    f.fireScroll();
    f.state.scrollTop = 1200;
    f.fireScroll();
    f.flushFrames();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the newest state wins after the interleave');
    assert.strictEqual(f.target.stuck, true, 'flag and class agree');
    assert.ok(f.fired.some(e => e.name === 'navStuck'), 'stuck event fired');
});

// Width eligibility is part of the desired stuck state: narrowing
// below the declared minimum is a transition the nav must make, not a
// gap in its inputs — the flag, the class, and a still-queued write
// all follow the newest answer.
test('a nav cannot stay stuck below its declared minimum width', () => {
    const f = fixture({queuedFrames: true, viewportWidth: 1200, minWidth: 900});
    f.sentinel().rect.top = 100;
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks at desktop width
    f.flushFrames();
    assert.strictEqual(f.target.stuck, true, 'stuck at the eligible width');
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the class applied');

    // Narrowing past the minimum while stuck: the flag transitions and
    // the coalesced write removes the class — nothing stays visually
    // fixed while the enhancement is ineligible.
    f.state.viewportWidth = 600;
    f.fireResize();
    f.flushFrames();
    assert.strictEqual(f.target.stuck, false,
        'the flag unstuck below the declared minimum');
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the class leaves with the state — flag and class agree');

    // Widening back into eligibility re-sticks at the live position.
    f.state.viewportWidth = 1200;
    f.fireResize();
    f.flushFrames();
    assert.strictEqual(f.target.stuck, true, 'eligibility restored — stuck again');
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the class reapplies');
});

// A narrowing that lands while the stick's own class write is still
// queued must be observed by that write — the pending apply sees the
// ineligible state and never adds the class at all.
test('a queued stick write observes a width correction', () => {
    const f = fixture({queuedFrames: true, viewportWidth: 1200, minWidth: 900});
    f.sentinel().rect.top = 100;
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks — the class write queues for the frame
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the class lands on the frame');

    f.state.viewportWidth = 600;
    f.fireResize(); // unstuck before the queued write can run
    f.flushFrames();
    assert.strictEqual(f.target.stuck, false, 'the correction unstuck it');
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the queued write applied the newest state — no stale class');
});

test('a target without a parent still measures itself', () => {
    // The orphan path is the pre-marker behavior — no marker can be
    // planted, so the target's own rect is the anchor.
    const listeners = {};
    const state = {scrollTop: 0};
    const fired = [];
    const nav = {rect: {top: 0, height: 50}, addEventListener() {}, removeEventListener() {}};
    const target = {
        rect: {top: 100, height: 40}, parentNode: null, style: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        addEventListener() {}, removeEventListener() {}
    };
    const classes = new Set();
    const document = {
        readyState: 'complete',
        getElementById: id => ({'_paste_ui_nav_wrap': nav, 'content': {}, 'paste-ui-nav': {}})[id] || null,
        createElement: tag => ({tagName: tag, style: {}, setAttribute() {}}),
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {}
    };
    const window = {
        getComputedStyle: () => ({marginTop: '0px'}),
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener() {}
    };
    const dom = {
        querySelector: sel => sel === '.sticky-nav-target' ? target : null,
        getDocumentBody: () => ({classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c)}}),
        getScrollTop: () => state.scrollTop,
        getViewportWidth: () => 1200,
        Bounds: {fromElement: el => el && el.rect ? {top: el.rect.top, height: el.rect.height} : {top: 0, height: 0}}
    };
    const event = {
        Event: function (context, name) {
            this.context = context; this.name = name;
            this.fire = p => fired.push({name: name, payload: p});
            this.dispose = function () {};
        },
        DocumentEvent: {loaded: () => {}}
    };
    event.Event.Subscription = function (t, el, fn) { el.addEventListener ? el.addEventListener(t, fn) : (listeners[t] = listeners[t] || []).push(fn); this.dispose = () => {}; };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/stickynav/stickynav.js'), 'utf8'), {
        window, document, console,
        paste: {define(name, deps, factory) { factory({}, dom, event, {request: fn => fn(), cancel: () => {}}); }}
    });
    state.scrollTop = 200; // past the self-measured threshold (100 - 50)
    (listeners.scroll || []).forEach(fn => fn({type: 'scroll'}));
    assert.ok(classes.has('paste-fixed-subnav'), 'the orphan path still sticks past its threshold');
});
