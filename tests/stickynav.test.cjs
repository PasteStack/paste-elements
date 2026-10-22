const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource, boundsFromElement} = require('./fakes.cjs');

// The stickynav threshold contract: the measured anchor must stay
// honest while the nav is stuck — a stuck target's own rect is a
// fixed-position viewport coordinate, so the module measures from an
// anchor that neither the target's flow state nor the scroll offset
// moves (the nearest in-flow previous sibling's bottom, else its
// parent's top) and inserts nothing. Recalibration passes (first
// scroll, load, resize) must therefore work in every stuck state.
//
// Geometry in the fixture is scroll-aware the way core's
// Bounds.fromElement is (viewport rect plus scroll offset): an in-flow
// element's rect.top is its document position, while an element out of
// the flow (position fixed or sticky, or the target while the stuck
// class is on the page) or with no box at all keeps a viewport rect, so
// its document position moves with every scroll. rect.top is where the
// box is drawn: a transform on the element itself (its computed
// matrix) draws it away from its layout box, and the module takes that
// transform back out of the anchor's rect.

function fixture(options = {}) {
    const listeners = {};
    const subscriptions = [];
    const classes = new Set(options.initialClasses || []);
    const reads = {bounds: 0, writes: 0};
    const observers = [];
    const state = {
        scrollTop: options.scrollTop || 0,
        viewportWidth: options.viewportWidth || 1200
    };

    function element(tagName, top, height) {
        const attributes = new Map();
        const el = {
            tagName, nodeType: 1, children: [], parentNode: null,
            rect: {top: top, height: height},
            style: {},
            // Computed position and display; boxless: no CSS box at all.
            position: 'static',
            display: 'block',
            boxless: false,
            getClientRects: () => el.boxless ? [] : [el.rect],
            // Layout offsets: offsetParent is null, so offsetTop is the
            // document position. A transform draws the box elsewhere
            // (rect.top) without moving its layout (layoutTop); a
            // sticky box's offset carries its stuck shift, a fixed
            // one's is a viewport coordinate. Each read counts as a
            // geometry read alongside the Bounds measurements.
            layoutTop: undefined,
            offsetParent: null,
            clientTop: 0,
            get offsetTop() {
                reads.bounds++;
                if (el.boxless) return 0;
                if (el.position === 'sticky') return el.rect.top + state.scrollTop;
                return el.layoutTop === undefined ? el.rect.top : el.layoutTop;
            },
            get offsetHeight() { return el.boxless ? 0 : el.rect.height; },
            offsetWidth: 100,
            // The viewport rect: an in-flow box's document position less
            // the scroll offset; a fixed or sticky one (or the target
            // while stuck) is a viewport coordinate already.
            getBoundingClientRect() {
                reads.bounds++;
                const viewport = el.position === 'fixed' || el.position === 'sticky' ||
                    (el.viewportBox && el.viewportBox());
                const top = el.boxless ? 0 : el.rect.top - (viewport ? 0 : state.scrollTop);
                return {top: top, bottom: top + (el.boxless ? 0 : el.rect.height)};
            },
            marginTop: options.marginTop || '0px',
            setAttribute: (k, v) => attributes.set(k, String(v)),
            getAttribute: k => attributes.has(k) ? attributes.get(k) : null,
            hasAttribute: k => attributes.has(k),
            // appendChild/insertBefore move a node: a node has one
            // parent — it leaves its old slot when it lands in the new.
            appendChild(child) {
                if (child.parentNode && child.parentNode.children) {
                    const at = child.parentNode.children.indexOf(child);
                    if (at >= 0) child.parentNode.children.splice(at, 1);
                }
                child.parentNode = el;
                el.children.push(child);
                return child;
            },
            insertBefore(child, sibling) {
                if (child.parentNode && child.parentNode.children) {
                    const at = child.parentNode.children.indexOf(child);
                    if (at >= 0) child.parentNode.children.splice(at, 1);
                }
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
    // The page's stuck CSS fixes the target to the viewport.
    target.viewportBox = () => classes.has('paste-fixed-subnav');
    if (options.minWidth !== undefined) {
        target.setAttribute('data-sticky-min-width', String(options.minWidth));
    }
    const parent = element('div', 0, 0);
    // The previous sibling whose bottom edge is the anchor: it ends
    // where the target's slot begins unless a test moves it.
    const above = element('div', 0, options.targetTop === undefined ? 100 : options.targetTop);
    // Siblings between the anchor and the target: each spec names the
    // computed position and display, and whether the element has a box.
    const between = (options.between || []).map(spec => {
        const el = element(spec.tagName || 'div', spec.top || 0, spec.height || 0);
        el.position = spec.position || 'static';
        el.display = spec.display || 'block';
        el.boxless = !!spec.boxless;
        el.transform = spec.transform;
        el.layoutTop = spec.layoutTop;
        if (spec.svg) {
            // An svg root has no layout offsets, only its rect.
            delete el.offsetTop;
            delete el.offsetHeight;
            el.getBoundingClientRect = () => ({
                top: el.rect.top - state.scrollTop,
                bottom: el.rect.top + el.rect.height - state.scrollTop
            });
        }
        return el;
    });
    let previous = null;
    if (!options.firstChild) {
        parent.appendChild(above);
        previous = above;
    }
    between.forEach(el => {
        parent.appendChild(el);
        el.previousElementSibling = previous;
        previous = el;
    });
    target.previousElementSibling = previous;
    parent.appendChild(target);
    const byId = {
        '_paste_ui_nav_wrap': options.missingNav ? null : nav,
        'content': options.withoutChrome ? null : element('div', 0, 0),
        'paste-ui-nav': options.withoutChrome ? null : element('div', 0, 0)
    };
    if (options.fixedNavContent && byId.content) {
        byId.content.appendChild(options.fixedNavContent);
    }
    const document = {
        readyState: options.readyState || 'loading',
        getElementById: id => byId[id] || null,
        createElement: tag => { throw new Error('the module created a ' + tag + ' element'); },
        querySelectorAll: () => [],
        addEventListener: (t, fn) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
        removeEventListener() {}
    };
    const window = {
        pageYOffset: 0,
        getComputedStyle: el => ({
            marginTop: el.marginTop || '0px',
            marginBottom: el.marginBottom || '0px',
            paddingTop: el.paddingTop || '0px',
            position: el.position || 'static',
            display: el.display || 'block',
            transform: el.transform || 'none',
            transformOrigin: '0px 0px',
            translate: el.translate || 'none'
        }),
        // A ResizeObserver only when the test asks for one; it records
        // what is observed and delivers when the test resizes a box.
        ResizeObserver: options.resizeObserver ? function (callback) {
            observers.push({callback, observed: []});
            const record = observers[observers.length - 1];
            this.observe = el => record.observed.push(el);
        } : undefined,
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => {
            const list = listeners[t] || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        }
    };
    const body = {classList: {
        add: c => { reads.writes += 1; classes.add(c); },
        remove: c => { reads.writes += 1; classes.delete(c); },
        contains: c => classes.has(c)
    }};
    const sectionNav = options.sectionNavMinWidth === undefined ? null : element('nav', 0, 0);
    if (sectionNav) {
        sectionNav.setAttribute('data-sticky-min-width', options.sectionNavMinWidth);
    }
    const dom = {
        querySelector: (sel, ctx) =>
            sel === '.sticky-nav-target' ? target
                : sel === '.fixed-nav-content' ? (options.fixedNavContent || null)
                    : sel === '.paste-ui-section-nav' ? sectionNav
                        : null,
        getDocumentBody: () => body,
        getScrollTop: () => state.scrollTop,
        getViewportWidth: () => state.viewportWidth,
        // Core's Bounds.fromElement: the viewport rect plus the scroll
        // offset. A boxless element's rect is all zeros.
        Bounds: {fromElement: el => {
            reads.bounds++;
            if (!el) return boundsFromElement(null);
            const viewport = el.position === 'fixed' || el.position === 'sticky' ||
                (el.viewportBox && el.viewportBox());
            const measured = {
                tagName: (el.tagName || 'div').toUpperCase(), style: el.style || {},
                offsetWidth: 100, offsetHeight: el.boxless ? 0 : el.rect.height,
                getBoundingClientRect: () => ({left: 0,
                    top: el.boxless ? 0 : el.rect.top - (viewport ? 0 : state.scrollTop)})
            };
            return boundsFromElement(measured, {documentElement: {clientLeft: 0, clientTop: 0}},
                {pageXOffset: 0, pageYOffset: state.scrollTop});
        }}
    };
    const fired = [];
    const event = {
        Event: function (context, name) {
            this.context = context;
            this.name = name;
            this.fire = payload => {
                fired.push({name: name, payload: payload});
                // Core's dispatch rule: a context carrying no nodeType —
                // this module only ever contexts on window — dispatches
                // on the document, so delivery lands with the
                // document-bound listeners a consumer registers. A raw
                // DOM listener receives the event alone — the fired
                // data rides on it as pasteEventData, where a
                // Subscription unwraps it, exactly as core does.
                const dispatchTarget = context && context.nodeType ? context : document;
                const domEvent = {type: name, target: dispatchTarget, pasteEventData: payload};
                (listeners['doc:' + name] || []).slice().forEach(fn => fn(domEvent));
            };
            this.dispose = function () {};
        }
    };
    // A core Subscription hands its handler the event plus the fired
    // data — it unwraps pasteEventData, the DOM itself never invents
    // a second argument.
    const subscribed = fn => ev => fn(ev, ev ? ev.pasteEventData : undefined);
    event.Event.Subscription = function (type, targetEl, fn, context, executeCount) {
        subscriptions.push({type, executeCount});
        const wrapped = subscribed(fn);
        targetEl.addEventListener(type, wrapped);
        this.dispose = () => targetEl.removeEventListener(type, wrapped);
    };
    event.bind = (type, targetEl, fn, context, executeCount) => {
        subscriptions.push({type, executeCount});
        targetEl.addEventListener(type, subscribed(fn));
    };
    // Frames are always asynchronous, as the real scheduler's are: a
    // request only queues. Without queuedFrames the input helpers drain
    // the queue right after delivering their event; with it the test
    // flushes, so ordering bugs between a queued write and a later
    // correction are exercisable.
    const frameQueue = [];
    const requested = [];
    const requestedWrites = [];
    const deliver = fn => frameQueue.push(fn);
    const animation_frame = {
        request: fn => {
            requested.push(fn);
            return deliver(fn);
        },
        // The phased pair is one frame: the read half, then the write
        // half, on one delivery. requested records the read half,
        // requestedWrites the write half.
        requestPhased: (read, write) => {
            requested.push(read);
            requestedWrites.push(write);
            return deliver(time => {
                read(time);
                write(time);
            });
        },
        cancel: () => {}
    };
    const drain = () => {
        let guard = 0;
        while (frameQueue.length && guard++ < 100) {
            frameQueue.splice(0).forEach(fn => fn());
        }
    };
    const settle = () => { if (!options.queuedFrames) { drain(); } };

    const exports = {};
    vm.runInNewContext(readModuleSource('paste/ui/stickynav.js'), {
        window, document, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.stickynav');
            assert.equal(deps.join('|'),
                'paste.dom|paste.event|paste.has|paste.ui.utilities.animation-frame');
            factory(exports, dom, event, {touch: !!options.touch}, animation_frame);
        }}
    });
    settle();
    return {
        target, parent, above, between, nav, body, classes, state, fired, listeners, subscriptions,
        document, event, reads, byId, requested, requestedWrites, observers,
        // Delivers a box change on el to every observer watching it.
        fireBoxChange: el => {
            observers.filter(o => o.observed.includes(el)).forEach(o => o.callback([{target: el}]));
            settle();
        },
        // Moves the anchor edge: the target's slot follows it.
        slot: y => { above.rect.height = y; },
        fireScroll: () => { (listeners.scroll || []).slice().forEach(fn => fn({type: 'scroll'})); settle(); },
        fireResize: () => { (listeners.resize || []).slice().forEach(fn => fn({type: 'resize'})); settle(); },
        fireLoaded: () => { (listeners.load || []).slice().forEach(fn => fn({type: 'load'})); settle(); },
        pendingFrames: () => frameQueue.length,
        // Drain, not one pass: a frame's own work can arm the next —
        // the queue settles only when nothing new was queued.
        flushFrames: drain
    };
}

test('the anchor keeps the threshold measurable while stuck — and nothing is inserted', () => {
    const f = fixture();
    assert.deepEqual(f.parent.children, [f.above, f.target],
        'the module inserted a node beside the target');
    // Slot at document top 100, nav 50 tall → the nav sticks at 50.
    f.slot(100);

    f.state.scrollTop = 75;
    f.fireScroll(); // first-scroll recalibration runs while unstuck
    assert.ok(f.classes.has('paste-fixed-subnav'), 'scrolled past the threshold — stuck');
    assert.ok(f.fired.some(e => e.name === 'navStuck'), 'the stuck event fired');

    // A late layout shift moves the slot down the document — and the
    // stuck target's own rect is now a viewport coordinate, so only
    // the anchor still reads the honest position.
    f.slot(950);
    f.target.rect.top = 20; // fixed to the viewport — not the slot

    f.fireResize(); // the correction pass runs while stuck
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the corrected threshold unsticks a nav that is above it');
    assert.ok(f.fired.some(e => e.name === 'navUnstuck'), 'the unstuck event fired');
    assert.strictEqual(f.target.stuck, undefined,
        'the module kept its state off the element');
});

test('a queued class write applies the latest state, not the queued intent', () => {
    const f = fixture({queuedFrames: true});
    f.slot(100);
    f.fireScroll(); // the first scroll's recalibration, at the top
    f.flushFrames();
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks — the class write queues for the frame
    assert.equal(f.pendingFrames(), 1, 'precondition: the stick armed the frame');
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the class lands on the frame, not the event');
    assert.equal(f.fired.length, 0, 'the stick announced before its class write');

    // A correction lands before the frame runs: the slot moved down,
    // the nav unsticks, and the stale queued add must not win.
    f.slot(950);
    f.target.rect.top = 950;
    f.fireLoaded();
    f.flushFrames();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the pending write applied the newest state — no stale class');
    assert.deepEqual(f.fired, [],
        'a stick and unstick that cancelled before the write announced a class never applied');
    assert.strictEqual(f.target.stuck, undefined, 'no expando on the element');

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
    assert.deepEqual(f.fired.map(e => e.name), ['navStuck'],
        'the frame announced anything but the one class change it wrote');
});

// Width eligibility is part of the desired stuck state: narrowing
// below the declared minimum is a transition the nav must make, not a
// gap in its inputs — the flag, the class, and a still-queued write
// all follow the newest answer.
test('a nav cannot stay stuck below its declared minimum width', () => {
    const f = fixture({queuedFrames: true, viewportWidth: 1200, minWidth: 900});
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks at desktop width
    f.flushFrames();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the class applied at the eligible width');
    f.fired.length = 0;

    // Narrowing past the minimum while stuck: the flag transitions and
    // the coalesced write removes the class — nothing stays visually
    // fixed while the enhancement is ineligible, and the transition
    // announces through the same event consumers already watch.
    f.state.viewportWidth = 600;
    f.fireResize();
    f.flushFrames();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the class leaves with the state — unstuck below the minimum');
    const unstuck = f.fired.filter(e => e.name === 'navUnstuck');
    assert.strictEqual(unstuck.length, 1,
        'width ineligibility unsticks through navUnstuck');
    assert.strictEqual(unstuck[0].payload, f.target,
        'the event carries the same target as any unstick');

    // Resizes already below the minimum change nothing — the
    // transition, not the input, is what announces.
    f.fired.length = 0;
    f.state.viewportWidth = 500;
    f.fireResize();
    f.flushFrames();
    assert.strictEqual(f.fired.filter(e => e.name === 'navUnstuck').length, 0,
        'a repeated below-threshold resize does not reannounce');

    // Widening back into eligibility re-sticks at the live position.
    f.state.viewportWidth = 1200;
    f.fireResize();
    f.flushFrames();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the class reapplies');
    assert.ok(f.fired.some(e => e.name === 'navStuck'),
        'the re-stick announces through navStuck');
});

// A narrowing that lands while the stick's own class write is still
// queued must be observed by that write — the pending apply sees the
// ineligible state and never adds the class at all.
test('a queued stick write observes a width correction', () => {
    const f = fixture({queuedFrames: true, viewportWidth: 1200, minWidth: 900});
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll(); // sticks — the class write queues for the frame
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the class lands on the frame');

    f.state.viewportWidth = 600;
    f.fireResize(); // unstuck before the queued write can run
    f.flushFrames();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the queued write applied the newest state — no stale class');
});

test('a first-child target anchors on its parent\'s top', () => {
    const f = fixture({firstChild: true, targetTop: 300});
    assert.deepEqual(f.parent.children, [f.target]);
    f.parent.rect.top = 280; // the target sits 20px into its parent
    f.fireResize();
    f.state.scrollTop = 245; // threshold 280 + 20 - 50 = 250
    f.fireScroll();
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck above the threshold');
    f.state.scrollTop = 250;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the threshold');
    // Stuck: the target's own rect is a viewport coordinate; the parent
    // moved 100px down — the slot follows the parent, not the target.
    f.target.rect.top = 0;
    f.parent.rect.top = 380;
    f.fireResize();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the stuck threshold followed the fixed target instead of the anchor');
});

test('the load recalibration subscription retires after one run', () => {
    const f = fixture();
    const loadSub = f.subscriptions.filter(s => s.type === 'load');
    assert.equal(loadSub.length, 1,
        'the post-load recalibration was not a load subscription');
    assert.equal(loadSub[0].executeCount, 1,
        'the recalibration subscription outlives the load it serves');
});

test('a module that defines after load subscribes no recalibration', () => {
    const f = fixture({readyState: 'complete'});
    assert.equal(f.subscriptions.filter(s => s.type === 'load').length, 0,
        'a post-load recalibration was scheduled after load already passed');
    assert.equal((f.listeners.scroll || []).length, 1,
        'the scroll subscription was lost with it');
});

test('the events announce transitions, not scroll telemetry', () => {
    const f = fixture();
    f.slot(100);
    f.state.scrollTop = 75;

    f.fireScroll();
    assert.strictEqual(f.fired.filter(e => e.name === 'navStuck').length, 1,
        'the stick announced once');

    // Still past the threshold: more scrolls change nothing — a
    // per-scroll event stream forces every consumer to dedupe.
    f.fireScroll();
    f.fireScroll();
    assert.strictEqual(f.fired.filter(e => e.name === 'navStuck').length, 1,
        'further scrolls while stuck reannounced');
    assert.strictEqual(f.fired.filter(e => e.name === 'navUnstuck').length, 0,
        'an unstuck announcement fired while stuck');

    f.state.scrollTop = 0;
    f.fireScroll();
    assert.strictEqual(f.fired.filter(e => e.name === 'navUnstuck').length, 1,
        'the unstick announced once');
    f.fireScroll();
    assert.strictEqual(f.fired.filter(e => e.name === 'navUnstuck').length, 1,
        'further scrolls below the threshold reannounced');
    assert.strictEqual(f.target.stuck, undefined, 'no expando on the element');
});

test('the nav never announced unstuck before it ever stuck', () => {
    const f = fixture();
    f.slot(100);
    // scrollTop stays below the threshold — plain scrolling must say
    // nothing at all.
    f.fireScroll();
    f.fireScroll();
    assert.strictEqual(f.fired.length, 0,
        'navUnstuck fired for a nav that was never stuck');
});

test('without the navigation wrapper the nav sticks at offset zero', () => {
    const f = fixture({missingNav: true});
    assert.equal((f.listeners.scroll || []).length, 1,
        'the target went inert without the navigation wrapper');
    f.slot(100);
    f.state.scrollTop = 99;
    f.fireScroll(); // the first scroll recalibrates
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck before the slot reached the top');
    f.state.scrollTop = 100;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick with the slot at the viewport top');
    f.fireResize();
    f.fireLoaded();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'a recalibration without the wrapper lost the slot');
});

test('#paste-ui-nav and #content are not required', () => {
    const f = fixture({withoutChrome: true});
    assert.equal((f.listeners.scroll || []).length, 1,
        'the module still gated on ids it never reads');
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the nav never stuck without the unread ids');
});

test('a fired announcement reaches document-bound subscribers with its payload', () => {
    // Core dispatches a window-contexted Event on the document — the
    // consumer-facing guarantee is delivery to a document subscriber,
    // not just a recorded fire() call. A Subscription unwraps the
    // payload; a raw DOM listener sees the event alone.
    const f = fixture();
    const heard = [];
    const rawArgs = [];
    f.event.bind('navStuck', f.document, (domEvent, payload) => heard.push(payload));
    f.document.addEventListener('navStuck', function () { rawArgs.push(arguments.length); });
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.equal(heard.length, 1, 'the stuck announcement never reached the document');
    assert.equal(heard[0], f.target, 'the delivered payload was not the sticky target');
    assert.deepEqual(rawArgs, [1],
        'a raw DOM listener received an invented payload argument');
    const windowHeard = [];
    (f.listeners['navStuck'] || []).forEach(fn => windowHeard.push(fn));
    assert.equal(windowHeard.length, 0,
        'window-bound listeners saw a window-contexted dispatch core never sends');
});

test('authored fixed-nav content keeps its ancestry — the class is the only hook', () => {
    // An interactive subtree's behaviour lives in its ancestry: form
    // association, delegated listeners, labels and focus all resolve
    // through parentNode. The module's whole presentation surface is
    // the body class — the authored node must never be reparented or
    // cloned, so a stuck nav is a stylesheet decision, not a DOM move.
    // The fixture's content element is the authored parent here — it
    // stands in for the form or section the page declared the
    // .fixed-nav-content under.
    const fixedNavContent = {
        className: 'fixed-nav-content', children: [], parentNode: null,
        rect: {top: 0, height: 0}, style: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        addEventListener() {}, removeEventListener() {},
        appendChild(child) {
            child.parentNode = fixedNavContent;
            fixedNavContent.children.push(child);
            return child;
        },
        insertBefore(child, sibling) {
            child.parentNode = fixedNavContent;
            const i = sibling ? fixedNavContent.children.indexOf(sibling) : fixedNavContent.children.length;
            fixedNavContent.children.splice(i < 0 ? fixedNavContent.children.length : i, 0, child);
            return child;
        }
    };
    const input = {
        tagName: 'INPUT', children: [], parentNode: null,
        rect: {top: 0, height: 0}, style: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        addEventListener() {}, removeEventListener() {}
    };
    fixedNavContent.appendChild(input);

    const f = fixture({fixedNavContent: fixedNavContent});
    const authored = f.byId.content;

    // The module defined — the authored chain content > .fixed-nav-
    // content > input is exactly what the page declared: the node's
    // identity, its parent, and the subtree below it all survived.
    assert.strictEqual(fixedNavContent.parentNode, authored,
        'the fixed-nav content left its authored parent');
    assert.strictEqual(input.parentNode, fixedNavContent,
        'a control inside the content lost its authored parent');
    assert.ok(!f.byId['paste-ui-nav'].children.includes(fixedNavContent),
        'the content was moved into the navigation chrome');
    // Sticking and unsticking the nav touches the body class alone —
    // the subtree's ancestry is not part of the presentation cycle.
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    f.state.scrollTop = 0;
    f.fireScroll();
    assert.strictEqual(fixedNavContent.parentNode, authored,
        'a stick/unstick cycle reparented the authored content');
});

test('a resize burst measures once on the armed frame', () => {
    // Twenty events record only the need: the frame's recalibration
    // performs one measurement set and evaluates the state once, on
    // the latest inputs.
    const f = fixture({queuedFrames: true});
    f.slot(100);
    f.reads.bounds = 0;

    for (let i = 0; i < 20; i++) { f.fireResize(); }
    assert.equal(f.reads.bounds, 0,
        'resize input measured geometry before the frame ran');
    assert.equal(f.pendingFrames(), 1,
        'a resize burst armed ' + f.pendingFrames() + ' frames instead of one');

    f.flushFrames();
    // Unstuck, one set is three reads: the nav, the anchor, and the
    // target itself — the in-flow target is what fixes the anchor's
    // distance to the slot.
    assert.equal(f.reads.bounds, 3,
        'the coalesced pass did not perform exactly one measurement set');
});

// The target sits wherever its collapsed margin puts it. The threshold
// takes the measured anchor-to-target distance, never anchor +
// marginTop: with a 40px target margin collapsing against a 10px one
// above, the target is 30px below the anchor, not 40.
test('the threshold follows collapsed margins, not anchor plus marginTop', () => {
    const f = fixture({marginTop: '40px', targetTop: 130});
    f.slot(100);
    f.target.rect.top = 130;
    f.fireResize();
    // Threshold = 100 + 30 - 50 = 80; anchor + marginTop would say 90.
    f.state.scrollTop = 85;
    f.fireScroll();
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'),
        'the nav stuck late: the threshold added the uncollapsed margin');

    // While stuck the target's rect is a viewport coordinate; the
    // anchor plus the measured distance still names the slot.
    f.slot(300);
    f.target.rect.top = 0;
    f.fireResize();
    f.state.scrollTop = 260; // threshold now 300 + 30 - 50 = 280
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the stuck threshold lost the measured slot distance');
    f.state.scrollTop = 281;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the nav did not stick at the moved slot');
});

test('a declared minimum width of zero is honored, not skipped', () => {
    // "0" on the target is a value: the section nav's 900 must not
    // replace it.
    const f = fixture({minWidth: 0, sectionNavMinWidth: '900', viewportWidth: 600});
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'),
        'a zero minimum fell through to the section nav\'s');
});

test('a malformed minimum width is ignored, not read as NaN', () => {
    for (const value of ['abc', '-5', '1e3', '']) {
        const f = fixture({minWidth: value, sectionNavMinWidth: '900', viewportWidth: 600});
        f.slot(100);
        f.state.scrollTop = 75;
        f.fireScroll();
        assert.ok(!f.classes.has('paste-fixed-subnav'),
            value + ': the malformed value replaced the section nav\'s minimum');
    }
    // Whole numbers are digits only, read untrimmed: a near-miss
    // spelling of an eligible minimum must not be read as one.
    for (const value of [' 500', '500 ', '500.', '500.0', '5e2', '+500']) {
        const f = fixture({minWidth: value, sectionNavMinWidth: '900', viewportWidth: 600});
        f.slot(100);
        f.state.scrollTop = 75;
        f.fireScroll();
        assert.ok(!f.classes.has('paste-fixed-subnav'),
            JSON.stringify(value) + ': a non-whole-number spelling was read as a minimum');
    }
});

test('touch capability comes from paste.has and keeps the baseline', () => {
    const f = fixture({touch: true});
    assert.equal((f.listeners.scroll || []).length, 0, 'a touch page bound scroll');
    assert.deepEqual(f.parent.children, [f.above, f.target], 'a touch page changed the DOM');
});

test('the first scroll measures in the owned frame, not the scroll event', () => {
    const f = fixture({queuedFrames: true});
    f.flushFrames();
    f.reads.bounds = 0;
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.equal(f.reads.bounds, 0, 'the first scroll measured inside the event');
    assert.equal(f.pendingFrames(), 1, 'the first scroll armed no frame');
    f.flushFrames();
    assert.equal(f.reads.bounds, 3, 'the frame did not measure');
    assert.ok(f.classes.has('paste-fixed-subnav'),
        'the frame did not evaluate and write on the corrected threshold');
    assert.equal(f.requested.length, f.requested.filter(fn => fn === f.requested[0]).length,
        'the measurement and the class write armed separate frames');
});

test('a viewport exactly at the minimum width is ineligible', () => {
    const f = fixture({viewportWidth: 900, minWidth: 900});
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the nav stuck at exactly its minimum width');
    const g = fixture({viewportWidth: 901, minWidth: 900});
    g.slot(100);
    g.state.scrollTop = 75;
    g.fireScroll();
    g.fireScroll();
    assert.ok(g.classes.has('paste-fixed-subnav'), 'the nav did not stick one pixel above its minimum');
});

test('the class lands on the element getDocumentBody returns', () => {
    // In standards mode that is the root element — the fixture's
    // getDocumentBody stands in for it; nothing else receives the class.
    const f = fixture();
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.ok(f.body.classList.contains('paste-fixed-subnav'));
});

// The frame's measurement is its read phase: a transition it decides
// is announced from the write phase, after the class lands, so no
// listener runs between this frame's reads and another module's.
test('a transition the frame measures is announced after its class write', () => {
    const f = fixture({queuedFrames: true});
    f.flushFrames();
    f.slot(100);
    f.state.scrollTop = 75;
    f.fired.length = 0;
    f.fireScroll(); // the first scroll only marks geometry
    assert.equal(f.fired.length, 0, 'the first scroll announced before its frame');
    const classAtAnnouncement = [];
    const push = f.fired.push.bind(f.fired);
    f.fired.push = entry => {
        classAtAnnouncement.push(f.classes.has('paste-fixed-subnav'));
        return push(entry);
    };
    f.flushFrames();
    assert.ok(f.fired.some(e => e.name === 'navStuck'), 'the frame-decided transition never announced');
    assert.deepEqual(classAtAnnouncement, [true],
        'the announcement ran before the class write — inside the read phase');
});

test('frame callbacks are hoisted, not minted per arming', () => {
    const f = fixture({queuedFrames: true});
    f.flushFrames();
    f.slot(100);
    f.state.scrollTop = 75;
    f.fireScroll();
    f.flushFrames();
    f.state.scrollTop = 0;
    f.fireScroll();
    f.flushFrames();
    f.fireResize();
    f.fireLoaded();
    f.flushFrames();
    const distinct = f.requested.filter((fn, i, all) => all.indexOf(fn) === i);
    assert.equal(distinct.length, 1,
        'arming minted new callbacks: ' + f.requested.length + ' requests, ' + distinct.length + ' distinct');
    assert.equal(f.requestedWrites.length, f.requested.length,
        'a frame was armed outside the phased read/write pair');
    assert.equal(f.requestedWrites.filter((fn, i, all) => all.indexOf(fn) === i).length, 1,
        'arming minted new write callbacks');
});

// Siblings whose document position moves with the scroll (fixed or
// sticky), or that have no box at all (script, [hidden], hidden input,
// display: contents), cannot anchor the slot: a recalibration deep in
// the page would carry the threshold along with the scroll offset. An
// absolutely positioned sibling moves independently of the slot.
const DRIFTING_SIBLINGS = {
    script: {tagName: 'script', display: 'none', boxless: true},
    hidden: {display: 'none', boxless: true},
    'hidden input': {tagName: 'input', display: 'none', boxless: true},
    'display: contents': {display: 'contents', boxless: true},
    'position: fixed': {position: 'fixed', height: 10},
    'position: sticky': {position: 'sticky', height: 20},
    'position: absolute': {position: 'absolute', top: 5000, height: 10, movesTo: 7000}
};

for (const [kind, spec] of Object.entries(DRIFTING_SIBLINGS)) {
    test('a ' + kind + ' sibling before the target does not drag the threshold while stuck', () => {
        // The in-flow box above ends at 600, the slot is at 600, the
        // nav is 50 tall: the threshold is 550 wherever the page is.
        const f = fixture({targetTop: 600, between: [spec]});
        f.slot(600);
        f.state.scrollTop = 100;
        f.fireScroll(); // the first scroll recalibrates, unstuck
        f.state.scrollTop = 2000;
        f.fireScroll();
        assert.ok(f.classes.has('paste-fixed-subnav'), 'precondition: stuck deep in the page');

        if (spec.movesTo !== undefined) {
            f.between[0].rect.top = spec.movesTo; // the slot stays put
        }
        f.fireResize(); // recalibrates while stuck, 2000px down
        assert.ok(f.classes.has('paste-fixed-subnav'),
            'the recalibration moved the threshold below the scroll position');
        f.state.scrollTop = 551;
        f.fireScroll();
        assert.ok(f.classes.has('paste-fixed-subnav'), 'unstuck below the slot');
        f.state.scrollTop = 549;
        f.fireScroll();
        assert.ok(!f.classes.has('paste-fixed-subnav'), 'still stuck above the slot');
        f.state.scrollTop = 550;
        f.fireScroll();
        assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the slot');
    });
}

test('with no in-flow sibling before it the target anchors on its parent', () => {
    const f = fixture({
        firstChild: true,
        targetTop: 300,
        between: [DRIFTING_SIBLINGS.script, DRIFTING_SIBLINGS['position: fixed']]
    });
    f.parent.rect.top = 280;
    f.fireResize();
    f.state.scrollTop = 2000;
    f.fireScroll(); // the first scroll recalibrates — stuck
    f.state.scrollTop = 1000;
    f.fireScroll();
    f.fireResize(); // and again while stuck, elsewhere in the page
    assert.ok(f.classes.has('paste-fixed-subnav'), 'a skipped sibling anchored the stuck threshold');
    f.state.scrollTop = 249; // threshold 280 + 20 - 50 = 250
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the parent fallback lost the slot');
    f.state.scrollTop = 250;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the parent-anchored slot');
});

test('a display: contents parent passes the fallback to the ancestor that draws a box', () => {
    // A boxless parent has no position of its own: anchored on it, the
    // threshold would not follow the slot when the ancestor moves.
    const f = fixture({firstChild: true, targetTop: 300});
    const grand = {rect: {top: 280, height: 0}, offsetTop: 280, offsetHeight: 0, offsetParent: null,
        display: 'block', parentNode: null, clientTop: 0,
        getBoundingClientRect: () => ({top: grand.rect.top - f.state.scrollTop, bottom: grand.rect.top - f.state.scrollTop})};
    f.parent.display = 'contents';
    f.parent.boxless = true;
    f.parent.parentNode = grand;
    f.fireResize();
    f.state.scrollTop = 2000;
    f.fireScroll(); // the first scroll recalibrates — stuck
    f.state.scrollTop = 1000;
    f.fireScroll();
    f.fireResize(); // and again while stuck, elsewhere in the page
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the boxless parent dragged the stuck threshold');
    f.state.scrollTop = 249; // threshold 280 + 20 - 50 = 250
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'the ancestor fallback lost the slot');
    f.state.scrollTop = 250;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the ancestor-anchored slot');
    // Stuck, the ancestor moves 100px down: the slot follows it.
    f.target.rect.top = 0;
    grand.rect.top = 380;
    grand.offsetTop = 380;
    f.fireResize();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the stuck threshold stayed with the boxless parent instead of the ancestor');
    f.state.scrollTop = 350;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the moved ancestor-anchored slot');
});

// A transform changes where a sibling is drawn, not where it is laid
// out: the anchor is the transformed sibling's layout box. When that box
// grows while the nav is stuck (a hero sized in vw, with a translateZ(0)
// hint, across a resize), the slot follows it; when a scroll-linked
// effect toggles the transform between measures, the anchor element and
// its distance to the slot stay paired.
test('a transformed sibling anchors by its layout box while stuck', () => {
    // Above ends at 600; the transformed sibling is laid out 600-700 but
    // drawn 300px lower; the slot is at 700, the nav 50 tall.
    const f = fixture({
        targetTop: 700,
        between: [{transform: 'matrix(1, 0, 0, 1, 0, 300)', layoutTop: 600, top: 900, height: 100}]
    });
    f.slot(600);
    f.state.scrollTop = 100;
    f.fireScroll(); // the first scroll recalibrates, unstuck
    f.state.scrollTop = 2000;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'precondition: stuck deep in the page');

    // While stuck the sibling grows by 100 and is drawn elsewhere again.
    const hero = f.between[0];
    hero.rect.height = 200;
    hero.rect.top = 1800;
    hero.transform = 'matrix(1, 0, 0, 1, 0, 1200)';
    f.target.rect.top = 0;
    f.fireResize();
    f.state.scrollTop = 700; // the slot is now 800: threshold 750
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the stuck threshold ignored the transformed sibling growing above the slot');
    f.state.scrollTop = 750;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the moved slot');
});

test('a transform toggled between measures keeps the anchor and its distance paired', () => {
    // In flow, the sibling above the slot is untransformed; by the time
    // the stuck pass measures, a scroll-linked effect has transformed it.
    const f = fixture({targetTop: 800, between: [{layoutTop: 600, top: 600, height: 200}]});
    f.slot(600);
    f.state.scrollTop = 100;
    f.fireScroll(); // the first scroll recalibrates, unstuck
    f.state.scrollTop = 2000;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'precondition: stuck deep in the page');

    const parallax = f.between[0];
    parallax.transform = 'matrix(1, 0, 0, 1, 0, 100)';
    parallax.rect.top = 700;
    f.target.rect.top = 0;
    f.fireResize(); // threshold stays 800 - 50 = 750
    f.state.scrollTop = 700;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the nav stayed stuck above its slot: the anchor changed under the measured distance');
    f.state.scrollTop = 749;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck above the slot');
    f.state.scrollTop = 750;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the slot');
});

// An inline svg has no offsets: its rect anchors the slot, and a
// threshold never becomes NaN, which would freeze the nav in its state.
test('an svg sibling without layout offsets anchors by its rect', () => {
    const f = fixture({targetTop: 700, between: [{svg: true, tagName: 'svg', top: 600, height: 100}]});
    f.slot(600);
    f.state.scrollTop = 100;
    f.fireScroll(); // the first scroll recalibrates, unstuck
    f.state.scrollTop = 649;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck above the slot');
    f.state.scrollTop = 2000;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick deep in the page');

    f.between[0].rect.height = 50; // the svg scales down across a resize
    f.target.rect.top = 0;
    f.fireResize();
    f.state.scrollTop = 620; // the slot is now 650: threshold 600
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'unstuck past the slot after the svg shrank');
    f.state.scrollTop = 599;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck above the slot after the svg shrank');
});

// A target with no box (display: none at a breakpoint) has no slot: its
// rect is an origin that would read as stuck at the top of the page.
test('a target with no box does not stick until a measure finds its slot', () => {
    const f = fixture({targetTop: 600});
    f.slot(600);
    f.target.boxless = true;
    f.fireResize();
    f.state.scrollTop = 6;
    f.fireScroll();
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'a hidden target stuck near the top of the page');
    f.state.scrollTop = 3000;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'a hidden target stuck deep in the page');

    f.target.boxless = false; // shown again, at a wider viewport
    f.fireResize();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the shown target did not stick past its slot');
    f.state.scrollTop = 549;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'stuck above the slot');
    f.state.scrollTop = 550;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the slot');
});

// A transition the scroll event decides is announced from the frame
// that writes its class: a listener sees the class it is told about.
test('a transition the scroll decides is announced after its class write', () => {
    const f = fixture({queuedFrames: true});
    f.slot(100);
    f.fireScroll(); // the first scroll's recalibration, at the top
    f.flushFrames();
    const seen = [];
    f.document.addEventListener('navStuck', () => seen.push(['navStuck', f.classes.has('paste-fixed-subnav')]));
    f.document.addEventListener('navUnstuck', () => seen.push(['navUnstuck', f.classes.has('paste-fixed-subnav')]));

    f.state.scrollTop = 75;
    f.fireScroll();
    assert.deepEqual(seen, [], 'the stick announced from the scroll event');
    f.flushFrames();
    assert.deepEqual(seen, [['navStuck', true]], 'the stick announced without its class');

    f.state.scrollTop = 0;
    f.fireScroll();
    assert.deepEqual(seen.length, 1, 'the unstick announced from the scroll event');
    f.flushFrames();
    assert.deepEqual(seen, [['navStuck', true], ['navUnstuck', false]],
        'the unstick announced while the class was still on the page');
});

// A transition the scroll decides while the class is not yet written
// leaves the target in the flow: a geometry pass in the same frame
// still reads the target's own slot, and corrects the transition.
test('a geometry pass in the frame of an unwritten stick measures the in-flow slot', () => {
    const f = fixture({queuedFrames: true});
    f.slot(100);
    f.fireScroll();
    f.flushFrames(); // threshold 100 - 50 = 50
    // A late layout change pushes the target 200px below its anchor.
    f.target.rect.top = 300;
    f.fireResize();
    f.state.scrollTop = 75;
    f.fireScroll(); // past the stale threshold: sticks, class unwritten
    f.flushFrames(); // the slot is 300: the threshold is 250
    assert.ok(!f.classes.has('paste-fixed-subnav'),
        'the pass kept the stale slot distance of a target still in the flow');
    assert.deepEqual(f.fired, [], 'a stick the same frame corrected was announced');
    f.state.scrollTop = 250;
    f.fireScroll();
    f.flushFrames();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'did not stick at the corrected slot');
});

test('restored scroll position is evaluated before the first scroll event', () => {
    const f = fixture({scrollTop: 75});
    assert.equal(f.classes.has('paste-fixed-subnav'), true);
    assert.deepEqual(f.fired.map(event => event.name), ['navStuck']);
});

test('an authored stale sticky class is cleared when the slot is still below the viewport', () => {
    const f = fixture({initialClasses: ['paste-fixed-subnav']});
    assert.equal(f.classes.has('paste-fixed-subnav'), false);
    assert.equal(f.fired.length, 0);
});

test('scroll transitions after calibration do not measure geometry again', () => {
    const f = fixture();
    f.fireScroll();
    f.reads.bounds = 0;
    f.state.scrollTop = 75;
    f.fireScroll();
    assert.equal(f.classes.has('paste-fixed-subnav'), true);
    assert.equal(f.reads.bounds, 0, 'a plain scroll transition recalibrated geometry');
});

test('a resize that preserves state performs no repeated class write', () => {
    const f = fixture({scrollTop: 75});
    assert.equal(f.classes.has('paste-fixed-subnav'), true);
    f.reads.writes = 0;
    f.fireResize();
    assert.equal(f.classes.has('paste-fixed-subnav'), true);
    assert.equal(f.reads.writes, 0, 'unchanged state wrote the class again');
});

// Stuck at 2000 with the slot at 600 (nav 50 tall, threshold 550), then
// a resize while stuck after the test's change; returns the fixture.
function stuckThenResized(options, change) {
    const f = fixture(Object.assign({targetTop: 600}, options));
    f.slot(600);
    f.state.scrollTop = 100;
    f.fireScroll(); // the first scroll recalibrates, unstuck
    f.state.scrollTop = 2000;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), 'precondition: stuck deep in the page');
    change(f);
    f.target.rect.top = 0;
    f.fireResize();
    return f;
}

function thresholdIs(f, threshold, message) {
    f.state.scrollTop = threshold - 1;
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), message + ': stuck above ' + threshold);
    f.state.scrollTop = threshold;
    f.fireScroll();
    assert.ok(f.classes.has('paste-fixed-subnav'), message + ': not stuck at ' + threshold);
}

// The anchor is the sibling's drawn rect: layout offsets are whole
// pixels summed over every offset parent, and they ignore an ancestor's
// transform, which moves the slot as much as the sibling.
test('the anchor follows the drawn sibling, not its rounded layout offsets', () => {
    const f = stuckThenResized({}, s => {
        // An ancestor's transform (or fractional offsets) draws the
        // sibling 80px from where its offsets say; the slot moves too.
        s.above.layoutTop = 0;
        s.above.rect.top = 80;
    });
    thresholdIs(f, 630, 'the threshold ignored where the sibling is drawn');
});

test('a transformed inline svg sibling anchors by its rect less its own transform', () => {
    const f = stuckThenResized({between: [{svg: true, tagName: 'svg', top: 600, height: 0}], targetTop: 600}, s => {
        const svg = s.between[0];
        svg.transform = 'matrix(1, 0, 0, 1, 0, -120)';
        svg.rect.top = 480; // drawn 120px up; its slot below stays at 600
    });
    thresholdIs(f, 550, 'the svg\'s own transform moved the threshold');
});

test('a translate property on the sibling is taken out of its rect', () => {
    const f = stuckThenResized({}, s => {
        s.above.translate = '0px 75px';
        s.above.rect.top = 75;
    });
    thresholdIs(f, 550, 'the sibling\'s translate moved the threshold');
});

// The only in-flow sibling is hidden at a breakpoint while the nav is
// stuck: the anchor becomes the parent, whose content box — inside its
// border and padding — is where the target now starts.
test('an anchor that changes while stuck keeps the slot where the flow puts the target', () => {
    const f = stuckThenResized({}, s => {
        s.parent.rect.top = 300;
        s.parent.clientTop = 13;
        s.parent.paddingTop = '9px';
        s.above.boxless = true;
    });
    thresholdIs(f, 272, 'the parent anchor missed its border and padding');
});

test('a sibling margin that changes while stuck moves the slot with it', () => {
    const f = stuckThenResized({}, s => {
        s.above.marginBottom = '30px';
    });
    thresholdIs(f, 580, 'the threshold kept the old margin');
});

// A ResizeObserver re-measures when the target is revealed late (a
// class, [hidden], a panel shown) or the content above it grows, with
// no resize at all.
test('a target revealed after define sticks at its slot without a resize', () => {
    const f = fixture({targetTop: 600, resizeObserver: true});
    f.slot(600);
    f.target.boxless = true;
    f.fireResize();
    f.state.scrollTop = 2000;
    f.fireScroll();
    f.fireScroll();
    assert.ok(!f.classes.has('paste-fixed-subnav'), 'a hidden target stuck');
    assert.ok(f.observers.some(o => o.observed.includes(f.target)), 'the target is not observed');
    f.target.boxless = false;
    f.fireBoxChange(f.target);
    assert.ok(f.classes.has('paste-fixed-subnav'), 'the revealed target did not stick past its slot');
    thresholdIs(f, 550, 'the revealed target');
});

test('content growing above the target moves the threshold without a resize', () => {
    const f = fixture({targetTop: 600, resizeObserver: true});
    f.slot(600);
    f.fireScroll();
    thresholdIs(f, 550, 'precondition');
    f.state.scrollTop = 0;
    f.fireScroll();
    f.slot(800);
    f.target.rect.top = 800;
    f.fireBoxChange(f.parent);
    thresholdIs(f, 750, 'the threshold stayed above grown content');
});

test('without ResizeObserver nothing is observed and a resize still re-measures', () => {
    const f = fixture({targetTop: 600});
    assert.equal(f.observers.length, 0);
    f.slot(800);
    f.target.rect.top = 800;
    f.fireResize();
    thresholdIs(f, 750, 'the resize did not re-measure');
});

// A display: contents target draws no box of its own: its first child
// that does names the slot.
test('a display: contents target is measured through its first drawn child', () => {
    const f = fixture({targetTop: 600});
    const child = {rect: {top: 600, height: 40}, getClientRects: () => [child.rect],
        getBoundingClientRect: () => ({top: child.rect.top - f.state.scrollTop}), nextElementSibling: null};
    f.target.boxless = true;
    f.target.display = 'contents';
    f.target.firstElementChild = child;
    f.slot(600);
    f.fireResize();
    thresholdIs(f, 550, 'the display: contents target');
});
