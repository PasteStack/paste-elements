const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The scrollspy contract: the nav's active marker must track the
// section geometry the document actually has — measured at define
// time (the markup already exists when paste defines), corrected once
// after resources settle, and re-measured whenever a resize can have
// reflowed the sections. A link whose target does not exist is dead
// markup: it contributes no breakpoint and must not poison the live
// ones. Below the declared minimum width the spy is ineligible — and
// ineligibility clears the lit state it owned.

function fixture(options = {}) {
    const listeners = {};
    const subscriptions = [];
    const state = {
        scrollTop: options.scrollTop || 0,
        viewportWidth: options.viewportWidth === undefined ? 1200 : options.viewportWidth,
        // A document long enough that its bottom is never reached
        // unless a test says otherwise.
        scrollHeight: options.scrollHeight === undefined ? 100000 : options.scrollHeight,
        viewportHeight: options.viewportHeight === undefined ? 800 : options.viewportHeight,
        // The root's clientHeight: the viewport less a horizontal
        // scrollbar. Equal to the window's height unless a test says so.
        clientHeight: options.clientHeight
    };

    function section(top) {
        return {rect: {top: top, height: 100}};
    }

    // links: array of {hash} — a hash naming nothing in `sections`
    // models a dead anchor.
    const specs = options.links === undefined
        ? ['#one', '#two', '#three']
        : options.links;
    const sections = options.sections || {
        'one': section(500),
        'two': section(1500),
        'three': section(2500)
    };

    const sharedParents = options.sharedParents || {};
    const links = specs.map(function (hash, index) {
        if (sharedParents[index] !== undefined) {
            return {hash: hash, parentElement: sharedParents[index]};
        }
        const li = {classes: new Set()};
        return {
            hash: hash,
            parentElement: {
                classes: li.classes,
                hasClass: c => li.classes.has(c)
            }
        };
    });

    const parent = options.noParent ? null : {
        rect: {top: 0, height: options.navHeight === undefined ? 50 : options.navHeight},
        getAttribute: name => name === 'data-spy-min-width'
            ? (options.minWidth === undefined ? null : String(options.minWidth))
            : null,
        hasAttribute: name => name === 'data-spy-touch' && !!options.spyTouch
    };

    const classWrites = [];
    const layoutReads = {width: 0, scrollHeight: 0, clientHeight: 0};
    const dom = {
        querySelector: function (sel) {
            if (sel === '[data-paste-scrollspy]' || sel === '.paste-ui-section-nav') {
                return parent;
            }
            return null;
        },
        get: function (idOrSelector, isQueryOrParent) {
            if (!isQueryOrParent) {
                return sections[idOrSelector] || null;
            }
            return links;
        },
        stripIdHash: function (elementId) {
            return elementId.charAt(0) === '#' ? elementId.slice(1) : elementId;
        },
        getScrollTop: () => state.scrollTop,
        getViewportWidth: () => { layoutReads.width += 1; return state.viewportWidth; },
        getScrollHeight: () => { layoutReads.scrollHeight += 1; return state.scrollHeight; },
        getViewportHeight: () => state.viewportHeight,
        getDocumentBody: () => ({
            get clientHeight() {
                layoutReads.clientHeight += 1;
                return state.clientHeight === undefined ? state.viewportHeight : state.clientHeight;
            }
        }),
        Bounds: {
            fromElement: function (el) {
                return el ? {top: el.rect.top, height: el.rect.height} : null;
            }
        },
        addCssClass: function (el, cls) { classWrites.push(['add', el]); if (el) el.classes.add(cls); },
        removeCssClass: function (el, cls) { classWrites.push(['remove', el]); if (el) el.classes.delete(cls); }
    };

    const event = {
        Event: function () {}
    };
    const recordSubscription = (type, targetEl, fn, context, executeCount) => {
        (listeners[type] = listeners[type] || []).push(fn);
        subscriptions.push({type, executeCount});
    };
    event.Event.Subscription = function (type, targetEl, fn, context, executeCount) {
        recordSubscription(type, targetEl, fn, context, executeCount);
        this.isBound = () => true;
        this.detach = () => {};
        this.dispose = () => {};
    };
    event.bind = recordSubscription;

    const featuredetection = {touch: options.touch === undefined ? false : options.touch};

    // The scroll handler coalesces through animation-frame — the
    // fixture pumps the queue so tests decide when a pass runs, and a
    // counted position read proves one evaluation per pass.
    const frames = [];
    const requested = [];
    const requestedWrites = [];
    const deliver = cb => {
        frames.push(cb);
        return frames.length;
    };
    const animation_frame = {
        request: cb => {
            requested.push(cb);
            return deliver(cb);
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
    const scrollTopReads = {count: 0};
    const originalGetScrollTop = dom.getScrollTop;
    dom.getScrollTop = function () {
        scrollTopReads.count += 1;
        return originalGetScrollTop();
    };
    const boundsReads = {count: 0};
    const originalFromElement = dom.Bounds.fromElement;
    dom.Bounds.fromElement = function (el) {
        boundsReads.count += 1;
        return originalFromElement(el);
    };

    const exports = {};
    vm.runInNewContext(
        readModuleSource('paste/ui/scrollspy.js'),
        {
            window: {decodeURIComponent: decodeURIComponent, ResizeObserver: options.ResizeObserver},
            document: {readyState: options.readyState || 'loading', body: {nodeName: 'BODY'}},
            console,
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.scrollspy');
                assert.equal(deps.join('|'),
                    'paste.dom|paste.event|paste.has|paste.ui.utilities.animation-frame');
                factory(exports, dom, event, featuredetection, animation_frame);
            }},
            decodeURIComponent
        }
    );

    return {
        links,
        listeners,
        classWrites,
        sections,
        state,
        subscriptions,
        scrollTopReads,
        boundsReads,
        layoutReads,
        requested,
        requestedWrites,
        pendingFrames: () => frames.length,
        fireScroll: () => (listeners.scroll || []).slice().forEach(fn => fn({type: 'scroll'})),
        fireResize: () => (listeners.resize || []).slice().forEach(fn => fn({type: 'resize'})),
        fireLoaded: () => (listeners.load || []).slice().forEach(fn => fn({type: 'load'})),
        loadedHandlerCount: () => (listeners.load || []).length,
        pump: () => frames.splice(0).forEach(fn => fn(16))
    };
}

test('no scrollspy declaration binds no listeners', () => {
    const f = fixture({noParent: true});
    assert.equal(f.listeners.scroll, undefined, 'a scroll listener was bound with nothing to spy');
    assert.equal(f.listeners.resize, undefined, 'a resize listener was bound with nothing to spy');
});

test('the spy measures and answers at define time, not after load', () => {
    const f = fixture({scrollTop: 1600});
    assert.ok(f.listeners.scroll, 'no scroll subscription existed until the load event');
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'the section under the scroll position was not lit before load');
    f.fireLoaded();
    assert.ok(f.links[1].parentElement.classes.has('active'), 'the load recalibration lost the lit section');
});

test('a link whose target is missing is skipped, not fatal', () => {
    const f = fixture({links: ['#one', '#gone', '#three']});
    assert.ok(f.listeners.scroll, 'one dead anchor silenced the whole nav');

    f.state.scrollTop = 600;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'), 'first section not lit inside its range');

    f.state.scrollTop = 2600;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[2].parentElement.classes.has('active'),
        'the last live link did not take over after the dead one');
    assert.ok(!f.links[1].parentElement.classes.has('active'), 'a dead anchor was lit');
});

test('an empty or bare hash is skipped', () => {
    const f = fixture({links: ['', '#', '#one']});
    f.state.scrollTop = 600;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[2].parentElement.classes.has('active'), 'the only live link was not lit');
});

test('a hash whose id contains selector syntax still resolves by id', () => {
    const f = fixture({
        links: ['#sec.one'],
        sections: {'sec.one': {rect: {top: 500, height: 100}}}
    });
    f.state.scrollTop = 600;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'an id containing a dot was parsed as a selector instead of an id');
});

test('resize re-measures section geometry', () => {
    const f = fixture({scrollTop: 1600});
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'), 'section two not lit at its top');

    // A reflow pushed section two below section three's old slot — the
    // stored breakpoints are stale, and at the same scroll position
    // the marker must move back to section one. The re-measure runs
    // on the next frame, not inside the event.
    f.sections.two.rect.top = 3000;
    f.fireResize();
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'a re-measure did not light the section that now owns this scroll position');
    assert.ok(!f.links[1].parentElement.classes.has('active'),
        'a stale breakpoint kept a moved section lit');
});

test('crossing below the minimum width clears the lit state the spy owned', () => {
    const f = fixture({scrollTop: 1600, minWidth: 900});
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'), 'section not lit above the minimum');

    f.state.viewportWidth = 800;
    f.fireResize();
    f.pump();
    assert.ok(!f.links[1].parentElement.classes.has('active'),
        'a lit marker survived the enhancement becoming ineligible');

    f.state.viewportWidth = 1200;
    f.fireResize();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'returning above the minimum did not relight the current section');
});

test('the load correction re-measures geometry that settled after define', () => {
    const f = fixture({scrollTop: 1600});
    assert.ok(f.links[1].parentElement.classes.has('active'), 'define-time measure did not light');
    assert.ok(f.loadedHandlerCount() > 0, 'no post-load recalibration was registered');

    // A late resource shifted section two below the scroll position —
    // the load correction re-measures and the marker follows.
    f.sections.two.rect.top = 3000;
    const boundsBefore = f.boundsReads.count;
    const writesBefore = f.classWrites.length;
    f.fireLoaded();
    assert.equal(f.boundsReads.count, boundsBefore, 'the load event measured outside the frame');
    assert.equal(f.classWrites.length, writesBefore, 'the load event moved the marker outside the frame');
    assert.equal(f.pendingFrames(), 1, 'the load event armed no pass');
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'the load correction did not re-measure the shifted section');
    assert.ok(!f.links[1].parentElement.classes.has('active'),
        'a section shifted past the scroll position stayed lit');
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
    assert.equal(f.loadedHandlerCount(), 0,
        'a post-load recalibration was scheduled after load already passed');
    assert.ok(f.listeners.scroll, 'the scroll subscription was lost with it');
});

test('a scroll burst before one frame selects once against the latest position', () => {
    const f = fixture({scrollTop: 1600});
    const readsBeforeBurst = f.scrollTopReads.count;

    // Scroll marks the selection dirty only — no position read, no
    // group walk, and one armed frame for the whole burst.
    for (let i = 0; i < 250; i += 1) {
        f.state.scrollTop = 600 + i;
        f.fireScroll();
    }
    assert.equal(f.scrollTopReads.count, readsBeforeBurst,
        'scroll notifications read the position synchronously');

    f.pump();
    assert.equal(f.scrollTopReads.count, readsBeforeBurst + 1,
        'one frame did not produce one selection evaluation');
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'the selection did not land at the burst\'s final position');
});

test('a 250-event resize burst pays one recalibration on the next frame', () => {
    const f = fixture({scrollTop: 1600});
    const boundsBefore = f.boundsReads.count;
    const scrollBefore = f.scrollTopReads.count;
    for (let i = 0; i < 250; i += 1) { f.fireResize(); }
    assert.equal(f.pendingFrames(), 1,
        'each resize notification armed its own measure pass');
    // Layout moved during the burst — the frame measures the final
    // geometry, not the 250 intermediate states.
    f.sections.two.rect.top = 3000;
    f.pump();
    // One measure pass costs four bounds reads: the nav and each of
    // the three targets — a section's start is its predecessor's end,
    // so no target is measured twice.
    assert.equal(f.boundsReads.count - boundsBefore, 4,
        'the burst measured something other than once');
    assert.equal(f.scrollTopReads.count - scrollBefore, 1,
        'the burst re-read the scroll position more than once');
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'the recalibrated breakpoints did not light the owning section');
});

test('a scroll marking stale selection still resolves on one frame', () => {
    // Selection and geometry share the one armed frame: scrolls inside
    // a resize burst are selected after the re-measure, on the new
    // breakpoints — not against the stale ones.
    const f = fixture({scrollTop: 0});
    f.fireResize();
    f.state.scrollTop = 600;
    f.fireScroll();
    f.fireResize();
    assert.equal(f.pendingFrames(), 1, 'geometry and selection armed two passes');
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'the shared frame did not select against fresh geometry');
});

test('below the minimum width scrolling arms no frame and resizes measure nothing', () => {
    const f = fixture({scrollTop: 1600, minWidth: 900, viewportWidth: 800});
    assert.ok(!f.links[1].parentElement.classes.has('active'), 'an ineligible spy lit a section');
    const boundsBefore = f.boundsReads.count;
    for (let i = 0; i < 10; i += 1) { f.fireScroll(); }
    assert.equal(f.pendingFrames(), 0, 'scrolls below the minimum armed a frame');
    f.fireResize();
    assert.equal(f.pendingFrames(), 1, 'a resize must still arm one frame to notice the width');
    f.pump();
    assert.equal(f.boundsReads.count, boundsBefore, 'an ineligible resize re-measured the sections');
    f.state.viewportWidth = 1200;
    f.fireResize();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'returning above the minimum did not measure and light the section');
});

test('a touch device without the opt-in binds no listeners at all', () => {
    const f = fixture({touch: true, scrollTop: 1600});
    assert.equal(f.listeners.scroll, undefined, 'a touch page bound scroll');
    assert.equal(f.listeners.resize, undefined, 'a touch page bound resize');
    assert.equal(f.listeners.load, undefined, 'a touch page bound load');
    assert.equal(f.boundsReads.count, 0, 'a touch page measured sections');
});

test('the touch opt-in still spies', () => {
    const f = fixture({touch: true, spyTouch: true, scrollTop: 1600});
    assert.ok(f.links[1].parentElement.classes.has('active'));
});

test('the last section is active at the bottom of the page', () => {
    // Section three starts at 2500 but the page can only scroll to
    // 2200: its top never reaches the threshold.
    const f = fixture({scrollHeight: 3000, viewportHeight: 800});
    f.state.scrollTop = 2200;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[2].parentElement.classes.has('active'),
        'the short last section never activated at maximum scroll');
    assert.ok(!f.links[1].parentElement.classes.has('active'));
    f.state.scrollTop = 2000;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'leaving the bottom did not hand back to the section in view');
});

test('a page that cannot scroll does not light the last section', () => {
    const f = fixture({scrollHeight: 800, viewportHeight: 800, scrollTop: 0});
    assert.ok(!f.links[2].parentElement.classes.has('active'),
        'a non-scrolling page treated offset 0 as the bottom');
});

test('the minimum width retains decimal prefix parsing', () => {
    // Anything but digits is no minimum at all; '0' is a minimum of
    // zero. The attribute text is read untrimmed.
    for (const value of ['abc', '0', '', '-5', '9e2', '9.5']) {
        const f = fixture({scrollTop: 1600, minWidth: value, viewportWidth: 800});
        assert.ok(f.links[1].parentElement.classes.has('active'),
            value + ': a malformed minimum made the spy ineligible');
    }
    for (const value of ['900', ' 900', '900 ', '900.', '900px']) {
        const f = fixture({scrollTop:1600,minWidth:value,viewportWidth:800});
        assert.ok(!f.links[1].parentElement.classes.has('active'), value);
    }
});

test('every armed pass reuses one hoisted callback', () => {
    const f = fixture({scrollTop: 0});
    f.fireScroll();
    f.pump();
    f.fireResize();
    f.pump();
    assert.equal(f.requested.length, 2);
    assert.strictEqual(f.requested[0], f.requested[1], 'an arming minted a new frame callback');
    assert.equal(f.requestedWrites.length, 2, 'a pass was armed outside the phased read/write pair');
    assert.strictEqual(f.requestedWrites[0], f.requestedWrites[1], 'an arming minted a new write callback');
});

// The pass is phased: its read half takes the width, geometry and
// position and moves no marker; the write half moves the marker and
// reads nothing.
test('a pass reads only in its read phase and writes only in its write phase', () => {
    const f = fixture({scrollTop: 0});
    f.state.scrollTop = 600;
    f.fireResize();
    const read = f.requested[f.requested.length - 1];
    const write = f.requestedWrites[f.requestedWrites.length - 1];
    const classesBefore = f.links.map(link => link.parentElement.classes.has('active'));
    f.boundsReads.count = 0;
    f.scrollTopReads.count = 0;
    read(16);
    assert.ok(f.boundsReads.count > 0 && f.scrollTopReads.count > 0,
        'precondition: the resize pass measured in its read phase');
    assert.deepEqual(f.links.map(link => link.parentElement.classes.has('active')), classesBefore,
        'the read phase moved the marker');
    f.boundsReads.count = 0;
    f.scrollTopReads.count = 0;
    write(16);
    assert.equal(f.boundsReads.count + f.scrollTopReads.count, 0, 'the write phase read geometry');
    assert.notDeepEqual(f.links.map(link => link.parentElement.classes.has('active')), classesBefore,
        'the write phase never moved the marker');
});

test('a document that grew without a resize is not lit at its old bottom', () => {
    // Measured at 3000 tall; lazy content then doubles the page with no
    // resize. At 2200 — its bottom before growing — section two is on screen.
    const f = fixture({scrollHeight: 3000, viewportHeight: 800,
        sections: {one: {rect: {top: 500, height: 100}}, two: {rect: {top: 1500, height: 100}},
            three: {rect: {top: 3100, height: 100}}}});
    f.state.scrollHeight = 6000;
    f.state.scrollTop = 2200;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'a stale bottom lit the last section mid-page');
    assert.ok(!f.links[2].parentElement.classes.has('active'));
});

test('the bottom rule needs the last section\'s top inside the viewport', () => {
    // The page is at its bottom, but the last section starts below the
    // viewport (it is in a hidden or overflowed region): nothing lights it.
    const f = fixture({scrollHeight: 3000, viewportHeight: 800,
        sections: {one: {rect: {top: 500, height: 100}}, two: {rect: {top: 1500, height: 100}},
            three: {rect: {top: 3050, height: 100}}}});
    f.state.scrollTop = 2200;
    f.fireScroll();
    f.pump();
    assert.ok(!f.links[2].parentElement.classes.has('active'),
        'a last section below the viewport was lit at the bottom');
    assert.ok(f.links[1].parentElement.classes.has('active'));
});

test('a page that scrolls only one pixel is not at its bottom at the top', () => {
    const f = fixture({scrollHeight: 801, viewportHeight: 800, scrollTop: 0,
        sections: {one: {rect: {top: 0, height: 100}}, two: {rect: {top: 400, height: 100}}},
        links: ['#one', '#two']});
    assert.ok(!f.links[1].parentElement.classes.has('active'),
        'offset 0 on a one-pixel scroll lit the last section');
    assert.ok(f.links[0].parentElement.classes.has('active'));
});

test('the bottom is judged with clientHeight, not the window height', () => {
    // A horizontal scrollbar takes 15px: the window says 800, the root
    // 785. At 2200 the page (3000 tall) still has 15px to go.
    const f = fixture({scrollHeight: 3000, viewportHeight: 800, clientHeight: 785});
    f.state.scrollTop = 2200;
    f.fireScroll();
    f.pump();
    assert.ok(!f.links[2].parentElement.classes.has('active'),
        'the window height declared the bottom 15px early');
    f.state.scrollTop = 2215;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[2].parentElement.classes.has('active'), 'the real bottom did not light the last section');
});

test('links sharing a parent keep it lit across their sections', () => {
    const shared = {classes: new Set()};
    const f = fixture({sharedParents: {0: shared, 1: shared}});
    f.state.scrollTop = 600;
    f.fireScroll();
    f.pump();
    assert.ok(shared.classes.has('active'), 'the shared parent was not lit in section one');
    f.classWrites.length = 0;
    f.state.scrollTop = 1600;
    f.fireScroll();
    f.pump();
    assert.ok(shared.classes.has('active'), 'moving between links on one parent cleared it');
    assert.equal(f.classWrites.length, 0, 'the shared parent was rewritten');
    f.state.scrollTop = 2600;
    f.fireScroll();
    f.pump();
    assert.ok(!shared.classes.has('active'));
    assert.ok(f.links[2].parentElement.classes.has('active'));
    assert.deepEqual(f.classWrites.map(w => w[0]), ['remove', 'add'],
        'the next marker landed before the previous one left');
});

test('the nav height offsets every section start', () => {
    // Section one starts at 500 under a 50px nav: lit from 450.
    const f = fixture({scrollTop: 0});
    f.state.scrollTop = 460;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[0].parentElement.classes.has('active'),
        'the nav height did not offset the first section start');
    // Section two starts at 1500: lit from 1450, ending section one.
    f.state.scrollTop = 1460;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'),
        'the nav height did not offset the next section start');
    assert.ok(!f.links[0].parentElement.classes.has('active'));
});

test('a viewport exactly at the minimum width is ineligible', () => {
    const at = fixture({scrollTop: 1600, minWidth: 900, viewportWidth: 900});
    assert.ok(!at.links[1].parentElement.classes.has('active'), 'the spy ran at exactly its minimum');
    const above = fixture({scrollTop: 1600, minWidth: 900, viewportWidth: 901});
    assert.ok(above.links[1].parentElement.classes.has('active'), 'the spy did not run one pixel above it');
});

// The load correction is a geometry pass like a resize: it reads the
// width the viewport has when the pass runs, not the one stored at
// define time.
test('the load pass judges eligibility on the current width', () => {
    const f = fixture({scrollTop: 1600, minWidth: 900, viewportWidth: 1200});
    assert.ok(f.links[1].parentElement.classes.has('active'), 'precondition: lit at define time');
    f.state.viewportWidth = 800;
    f.fireLoaded();
    f.pump();
    assert.ok(!f.links[1].parentElement.classes.has('active'),
        'the load pass measured and lit on a stale width');
});

test('a scroll pass reads no viewport width', () => {
    const f = fixture({scrollTop: 0});
    f.layoutReads.width = 0;
    for (let i = 0; i < 5; i += 1) {
        f.state.scrollTop = 600 + i * 300;
        f.fireScroll();
        f.pump();
    }
    assert.equal(f.layoutReads.width, 0, 'a scroll pass read the viewport width');
    f.fireResize();
    f.pump();
    assert.equal(f.layoutReads.width, 1, 'the resize pass did not read the width');
});

test('past the last breakpoint the bottom rule reads no layout', () => {
    const f = fixture({scrollTop: 0});
    f.layoutReads.scrollHeight = 0;
    f.layoutReads.clientHeight = 0;
    f.state.scrollTop = 2600; // beyond the last section's start
    f.fireScroll();
    f.pump();
    assert.ok(f.links[2].parentElement.classes.has('active'), 'the last section is not lit');
    assert.equal(f.layoutReads.scrollHeight + f.layoutReads.clientHeight, 0,
        'the stored comparison did not answer before the bottom rule');
});

test('encoded section fragments resolve raw ids first, then decoded ids', () => {
    for (const [hash, sections, at, selected] of [
        ['#caf%C3%A9', {'café': {rect: {top: 500, height: 100}}}, 600, true],
        ['#caf%C3%A9', {'caf%C3%A9': {rect: {top: 500, height: 100}}, 'café': {rect: {top: 1500, height: 100}}}, 600, true],
        ['#%bad', {'%bad': {rect: {top: 500, height: 100}}}, 600, true],
        ['#%bad', {'undefined': {rect: {top: 500, height: 100}}}, 600, false]
    ]) {
        const f = fixture({links: [hash], sections, scrollTop: at});
        f.pump();
        assert.equal(f.links[0].parentElement.classes.has('active'), selected, hash);
    }
});

test('section ownership changes exactly at the navigation clearance threshold, including the last section', () => {
    const f = fixture({scrollTop: 1449});
    assert.ok(f.links[0].parentElement.classes.has('active'));
    for (const [top, active] of [[1450, 1], [2449, 1], [2450, 2], [2500, 2]]) {
        f.state.scrollTop = top;
        f.fireScroll();
        f.pump();
        assert.deepEqual(f.links.map(link => link.parentElement.classes.has('active')),
            f.links.map((link, index) => index === active), 'section at scrollTop ' + top);
    }
});

test('a scroll after resize uses cached geometry until another layout input', () => {
    const f = fixture();
    f.fireResize();
    f.pump();
    f.boundsReads.count = 0;
    f.state.scrollTop = 1600;
    f.fireScroll();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'));
    assert.equal(f.boundsReads.count, 0);
});

test('an initially ineligible spy waits for resize to refresh viewport eligibility', () => {
    const f = fixture({viewportWidth: 800, minWidth: 1000, scrollTop: 1600});
    assert.equal(f.links.some(link => link.parentElement.classes.has('active')), false);
    f.state.viewportWidth = 1200;
    f.fireScroll();
    f.pump();
    assert.equal(f.links.some(link => link.parentElement.classes.has('active')), false);
    f.fireResize();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'));
});


test('late content growth recalibrates the spy through one observed pass', () => {
    const observed = [];
    let changed;
    const f = fixture({scrollTop: 1600, readyState: 'complete',
        ResizeObserver: class {
            constructor(callback) { changed = callback; }
            observe(target) { observed.push(target); }
        }});
    assert.equal(observed.length, 5, 'the body, nav and three linked sections are observed');
    assert.ok(f.links[1].parentElement.classes.has('active'));
    const before = f.boundsReads.count;
    f.sections.two.rect.top = 3000;
    f.sections.three.rect.top = 4000;
    for (let i = 0; i < 25; i += 1) changed();
    assert.equal(f.pendingFrames(), 1);
    assert.equal(f.boundsReads.count, before, 'observer delivery measured synchronously');
    f.pump();
    assert.equal(f.boundsReads.count - before, 4);
    assert.ok(f.links[0].parentElement.classes.has('active'), 'the marker kept the pre-growth section');
});

test('an unavailable layout observer leaves resize correction intact', () => {
    const f = fixture({ResizeObserver: function () { throw new Error('unavailable'); }});
    f.state.scrollTop = 1600;
    f.fireResize();
    f.pump();
    assert.ok(f.links[1].parentElement.classes.has('active'));
});

test('absent and touch-ineligible spies read no viewport width and construct no observer', () => {
    for (const options of [{noParent: true}, {touch: true}, {links: []}]) {
        let observers = 0;
        const f = fixture({...options, ResizeObserver: function () { observers += 1; }});
        assert.equal(f.layoutReads.width, 0);
        assert.equal(observers, 0);
    }
});
