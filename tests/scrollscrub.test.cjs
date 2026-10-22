'use strict';

// The scrollscrub element contract: a declared scope binds at define
// time, measures its root's offset into progress, and publishes exactly
// one thing — '--paste-scrub-progress' on the scope, written only when
// it changes. Reverse scroll reverses progress; a degenerate range
// withdraws the property so the authored default stands; malformed
// markup stays inert.

const test = require('node:test');
const assert = require('assert/strict');
const {openUiStack, Element, FakeSubscription, frameDriver, mutationObserverRegistry} = require('./fakes.cjs');

function progressOf(scope) {
    return scope.style.getPropertyValue('--paste-scrub-progress');
}

function scrollTo(window, document, offset) {
    window.pageYOffset = offset;
    window.fireEvent('scroll');
}

function declaredScopeWritesProgress() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});

    // First pass: the declared range is measured without waiting for
    // the user to scroll — subject scroll-space 1600..1800, viewport 800,
    // so S=800 and E=1800.
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('scroll');
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0', 'before the range the progress is zero');

    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0.5', 'mid-range publishes the fraction');
}

function reverseScrollMovesProgressBack() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});

    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1800);
    scope.rect = {top: -200, bottom: 0, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '1');

    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0.5', 'scrolling back unwinds the published value');

    scrollTo(stack.window, stack.document, 0);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0', 'the start restores');
}

function elementRootScopesFollowTheScroller() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 0;
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(scope);
    const stack = openUiStack({elements: {scroller: scroller}, scrollscrub: true});
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0');

    scroller.scrollTop = 600;
    scroller.fireEvent('scroll');
    stack.driver.tick(32);
    // range = 1600 - 400 = 1200; 600 / 1200 = 0.5
    assert.strictEqual(progressOf(scope), '0.5', 'the element scroller drives its own scopes');

    // A window scroll must not touch a scope bound to another root.
    scrollTo(stack.window, stack.document, 5000);
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0.5', 'unrelated roots do not leak into the scope');
}

function multipleScopesShareTheWindowRoot() {
    FakeSubscription.reset();
    const first = new Element('div', 'first');
    const second = new Element('div', 'second');
    [first, second].forEach(function (scope) {
        scope.setAttribute('data-paste-scrollscrub', '');
    });
    const stack = openUiStack({elements: {first: first, second: second}, scrollscrub: true});

    first.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    second.rect = {top: 2600, bottom: 2800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    first.rect = {top: 300, bottom: 500, width: 100, height: 200};
    second.rect = {top: 1300, bottom: 1500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(first), '0.5');
    assert.strictEqual(progressOf(second), '0', 'each scope measures its own subject');
}

function degenerateRangeWithdrawsTheProperty() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    // bottom bottom → top top: the subject scrolls its own height
    // through the viewport; E - S = viewport - height, so a subject
    // that outgrows the viewport turns the range degenerate.
    scope.setAttribute('data-scrub-start', 'bottom bottom');
    scope.setAttribute('data-scrub-end', 'top top');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});

    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    // S = 1800-800 = 1000, E = 1600; 300/600 = 0.5
    assert.strictEqual(progressOf(scope), '0.5', 'a live range writes');

    // A layout change collapses the span: the subject now outgrows the
    // viewport — the property withdraws rather than freezing.
    scope.rect = {top: 300, bottom: 1200, width: 100, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '', 'the authored default stands again');
}

// A window resize can change a nested scroller's range without any
// element-level signal: no scroll fires, and a 'resize' listener on
// the scroller element itself never hears the window. The shared
// window subscription must re-measure every scope — published
// progress follows the changed range with no other input at all.
function windowResizeReachesNestedScopes() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.id = 'scroller';
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 0;
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(scope);
    const stack = openUiStack({elements: {scroller: scroller}, scrollscrub: true});
    stack.driver.tick(16);

    scroller.scrollTop = 600;
    scroller.fireEvent('scroll');
    stack.driver.tick(32);
    // range = 1600 - 400 = 1200; 600 / 1200 = 0.5
    assert.strictEqual(progressOf(scope), '0.5', 'the scroller drives its scopes');

    // The window resize grows the scroller's box: same scrollTop, but
    // the range is now 1600 - 800 = 800 → 600 / 800 = 0.75. Neither a
    // scroll event nor an element 'resize' exists to carry this — only
    // the shared window subscription reaches the scope.
    scroller.clientHeight = 800;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0.75',
        'window resize re-measures a nested-root scope');
}

// A timer that records what a module reports instead of throwing it
// into the test process: each callback runs at once and any error it
// throws is kept.
function reportingTimer() {
    const reported = [];
    const timer = function (callback) {
        try {
            callback();
        } catch (error) {
            reported.push(error);
        }
        return reported.length;
    };
    return {timer: timer, reported: reported};
}

// A malformed scope keeps its authored baseline and is reported once —
// a descriptive TypeError rethrown from the captured timer, never a
// console line — while a valid sibling still binds.
function malformedDeclarationStaysInert() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'nowhere');
    const unresolved = new Element('div', 'unresolved');
    unresolved.setAttribute('data-paste-scrollscrub', '');
    unresolved.setAttribute('data-scrub-root', '#missing');
    const valid = new Element('div', 'valid');
    valid.setAttribute('data-paste-scrollscrub', '');
    valid.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const reports = reportingTimer();
    const stack = openUiStack({
        elements: {scope: scope, unresolved: unresolved, valid: valid},
        scrollscrub: true,
        window: {setTimeout: reports.timer}
    });
    stack.driver.tick(16);
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '', 'a bad declaration writes nothing');
    assert.strictEqual(progressOf(unresolved), '', 'an unresolved selector writes nothing');
    assert.strictEqual(progressOf(valid), '0', 'a malformed sibling cost the valid scope');
    assert.strictEqual(reports.reported.length, 2, 'each malformed scope reports exactly once');
    assert.ok(reports.reported.every(error => error.name === 'TypeError'),
        'a report was not a TypeError');
    assert.match(reports.reported[0].message, /#scope: scrub-start/);
    assert.match(reports.reported[1].message, /#unresolved: scrub-root/);
}

// A host-supplied WeakMap that throws is the same browser boundary as a
// hostile observer: the define sweep does not throw, every scope binds,
// and the scroll inputs carry the feature alone.
function hostileWeakMapLeavesScrollInputs() {
    FakeSubscription.reset();
    const first = new Element('div', 'first');
    first.setAttribute('data-paste-scrollscrub', '');
    const second = new Element('div', 'second');
    second.setAttribute('data-paste-scrollscrub', '');
    first.rect = second.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    let stack;
    assert.doesNotThrow(function () {
        stack = openUiStack({
            elements: {first: first, second: second},
            scrollscrub: true,
            window: {WeakMap: function () { throw new Error('hostile WeakMap'); }}
        });
    }, 'a hostile WeakMap escaped the define sweep');
    stack.driver.tick(16);
    assert.strictEqual(progressOf(first), '0');
    assert.strictEqual(progressOf(second), '0', 'the second scope never bound');
    assert.strictEqual(stack.resizeObservers.length, 0, 'an observer stood without its index');
}

// One scope whose page or platform code throws during bind — here a root
// scroller whose listener registration refuses — costs only itself:
// the define sweep continues, a later declaration binds, and a page
// or platform failure is not reported as a malformed declaration.
function throwingBindCostsOnlyItsScope() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'hostile-root');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.addEventListener = function () { throw new Error('listeners refused'); };
    const hostile = new Element('div', 'hostile');
    hostile.setAttribute('data-paste-scrollscrub', '');
    hostile.setAttribute('data-scrub-mode', 'container');
    hostile.setAttribute('data-scrub-root', '#hostile-root');
    scroller.appendChild(hostile);
    const valid = new Element('div', 'valid');
    valid.setAttribute('data-paste-scrollscrub', '');
    valid.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const reports = reportingTimer();
    let stack;
    assert.doesNotThrow(function () {
        stack = openUiStack({
            elements: {scroller: scroller, valid: valid},
            scrollscrub: true,
            window: {setTimeout: reports.timer}
        });
    }, 'a throwing scope escaped the define sweep');
    stack.driver.tick(16);
    assert.strictEqual(progressOf(valid), '0', 'a later declaration lost its binding');
    assert.strictEqual(reports.reported.length, 0, 'a page or platform failure was reported as a malformed declaration');
}

// No declared scope: the module asks for nothing — no subscriptions,
// no observers, no scheduled frames.
function noDeclarationsStayQuiet() {
    FakeSubscription.reset();
    const stack = openUiStack({elements: {}, scrollscrub: true});
    stack.driver.tick(16);
    assert.strictEqual(FakeSubscription.registry.length, 0, 'no subscriptions without a scope');
    assert.strictEqual(stack.resizeObservers.length, 0, 'no observers without a scope');
    assert.strictEqual(stack.driver.pending(), 0, 'no frames scheduled');
}

function bindMeasuresOnTheFirstFrame() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    // No input at all — the first scheduled pass publishes the measured
    // position of a page already scrolled on arrival.
    stack.window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'a mid-page load publishes on the first pass');
}

// Withdrawing the property forgets the published value: 0.5 →
// degenerate → 0.5 again is still a write — the removal is the state,
// not the number last seen.
function recoveredRangeRewritesAnIdenticalValue() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'bottom bottom');
    scope.setAttribute('data-scrub-end', 'top top');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'a live range writes');

    scope.rect = {top: 300, bottom: 1200, width: 100, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '', 'the authored default stands');

    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0.5',
        'an identical recovered value still rewrites after withdrawal');
}

// The frame pass reads every dirty scope before any property writes —
// a write can restyle the geometry a later read relies on, so
// read-then-write per scope would be a layout-invalidation pattern.
function readsCompleteBeforeAnyWrite() {
    FakeSubscription.reset();
    const order = [];
    const first = new Element('div', 'first');
    const second = new Element('div', 'second');
    [first, second].forEach(function (scope, index) {
        const tag = index === 0 ? 'A' : 'B';
        scope.setAttribute('data-paste-scrollscrub', '');
        const read = scope.getBoundingClientRect.bind(scope);
        scope.getBoundingClientRect = function () {
            order.push('read:' + tag);
            return read();
        };
        const set = scope.style.setProperty.bind(scope.style);
        scope.style.setProperty = function (name, value, priority) {
            order.push('write:' + tag);
            return set(name, value, priority);
        };
    });
    const stack = openUiStack({elements: {first: first, second: second}, scrollscrub: true});

    first.rect = {top: 300, bottom: 500, width: 100, height: 200};
    second.rect = {top: 1300, bottom: 1500, width: 100, height: 200};
    stack.window.pageYOffset = 1300;
    stack.window.fireEvent('scroll');
    stack.driver.tick(16);

    const reads = order.filter(function (entry) { return entry.indexOf('read:') === 0; });
    const writes = order.filter(function (entry) { return entry.indexOf('write:') === 0; });
    assert.strictEqual(reads.length, 2, 'both scopes measured');
    assert.strictEqual(writes.length, 2, 'both scopes wrote');
    const lastRead = Math.max(order.indexOf('read:A'), order.indexOf('read:B'));
    const firstWrite = Math.min(order.indexOf('write:A'), order.indexOf('write:B'));
    assert.ok(lastRead < firstWrite,
        'every read lands before any write in the pass — got ' + order.join(', '));
}

// Discovery and the first measurement never wait on load — but a
// resource that finishes after discovery can move a subject without
// changing its box, and neither resize nor scroll carries that shift.
// When activation ran before the document's own load, one module-owned
// 'load' subscription dirties every scope once; the ordinary scheduled
// pass re-measures and corrects the published value.
function initialLoadReMeasuresShiftedGeometry() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({
        elements: {scope: scope}, scrollscrub: true,
        document: {readyState: 'loading'}
    });
    // Subject scroll-space 1600..1800 at offset 900 → progress 0.1.
    stack.window.pageYOffset = 900;
    scope.rect = {top: 700, bottom: 900, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.1',
        'immediate discovery still publishes the first measurement');

    // A late resource above the subject pushes it 200px down the
    // document — the subject's own box is unchanged in size, and no
    // scroll or resize ever fires to carry the shift.
    scope.rect = {top: 900, bottom: 1100, width: 100, height: 200};
    stack.document.readyState = 'complete';
    stack.window.fireEvent('load');
    stack.driver.tick(32);
    // New scroll-space 1800..2000: S=1000, E=2000, offset 900 → 0.
    assert.strictEqual(progressOf(scope), '0',
        'the load correction re-measures the moved subject');
}

// Activation after the document's own load already measured final
// geometry — a load subscription then would be a listener with
// nothing left to do.
function lateActivationAddsNoLoadListener() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    openUiStack({elements: {scope: scope}, scrollscrub: true});
    assert.strictEqual(FakeSubscription.registry.filter(function (s) {
        return s.name === 'load';
    }).length, 0, 'a scope bound after load never subscribes to it');
}

// A scope bound while the page loads subscribes to the window load once;
// the subscription retires with its first delivery, so a later load
// event (a third-party synthetic one, say) re-measures nothing.
function loadSubscriptionRetiresAfterOneDelivery() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({
        elements: {scope: scope}, scrollscrub: true, document: {readyState: 'loading'}
    });
    stack.driver.tick(16);
    const loads = FakeSubscription.registry.filter(function (s) {
        return s.name === 'load' && s.target === stack.window;
    });
    assert.strictEqual(loads.length, 1, 'one load subscription while loading');
    stack.window.fireEvent('load');
    assert.strictEqual(stack.driver.pending(), 1, 'the load re-measures every scope');
    stack.driver.tick(32);
    assert.notStrictEqual(loads[0].isBound(), true, 'the load subscription outlived its delivery');
    stack.window.fireEvent('load');
    assert.strictEqual(stack.driver.pending(), 0, 'a second load was treated as an input');
}

// The same no-scope quiet holds while the page is still loading — the
// correction subscription exists only where scopes exist.
function loadingPageWithoutScopesStaysQuiet() {
    FakeSubscription.reset();
    const stack = openUiStack({
        elements: {}, scrollscrub: true, document: {readyState: 'loading'}
    });
    stack.driver.tick(16);
    assert.strictEqual(FakeSubscription.registry.length, 0,
        'no subscriptions without a scope, loading or not');
    assert.strictEqual(stack.resizeObservers.length, 0,
        'no observers without a scope');
    assert.strictEqual(stack.driver.pending(), 0, 'no frames scheduled');
}

// A hostile observer facility is a browser boundary, not a veto: the
// scroll and resize inputs a scope already owns carry it alone.
function poisonedObserverKeepsScrollFallback() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({
        elements: {scope: scope},
        scrollscrub: true,
        window: {ResizeObserver: function () { throw new Error('observer poisoned'); }}
    });

    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5',
        'a constructor that throws killed the scroll fallback with it');
}

// observe() refusing one target costs that declaration its resize
// coverage only — every other host keeps its observer, and the refused
// scope still answers its scroll inputs.
function refusedObservationOnlyLosesItsOwnTarget() {
    FakeSubscription.reset();
    const refused = new Element('div', 'refused');
    refused.setAttribute('data-paste-scrollscrub', '');
    const kept = new Element('div', 'kept');
    kept.setAttribute('data-paste-scrollscrub', '');
    // A bottom-to-top range collapses when the subject outgrows the
    // viewport — the resize entry is what re-measures it.
    kept.setAttribute('data-scrub-start', 'bottom bottom');
    kept.setAttribute('data-scrub-end', 'top top');
    const observers = [];
    const stack = openUiStack({
        elements: {refused: refused, kept: kept},
        scrollscrub: true,
        window: {ResizeObserver: function (callback) {
            const observer = {observed: []};
            observer.observe = function (target) {
                if (target === refused) {
                    throw new Error('observe refused');
                }
                observer.observed.push(target);
            };
            observer.unobserve = function () {};
            observer.disconnect = function () {};
            observer.trigger = function () {
                callback(observer.observed.map(function (t) { return {target: t}; }), observer);
            };
            observers.push(observer);
            return observer;
        }}
    });

    refused.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    kept.rect = {top: 1600, bottom: 1800, width: 100, height: 200};

    // A resize notification still reaches the host the observer accepted.
    kept.rect = {top: 300, bottom: 1200, width: 100, height: 900};
    observers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(16);
    assert.strictEqual(progressOf(kept), '',
        'a refused sibling cost the accepted scope its observer coverage');

    // And the refused scope still scrubs on its remaining inputs.
    scrollTo(stack.window, stack.document, 1300);
    refused.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(32);
    assert.strictEqual(progressOf(refused), '0.5',
        'the refused scope lost its scroll fallback too');
}

// One observer owns every declared scope's targets — N scopes are not
// N observers.
function declaredScopesShareOneObserver() {
    FakeSubscription.reset();
    const scopes = [];
    const elements = {};
    for (let i = 0; i < 5; i += 1) {
        const scope = new Element('div', 's' + i);
        scope.setAttribute('data-paste-scrollscrub', '');
        elements['s' + i] = scope;
        scopes.push(scope);
    }
    const stack = openUiStack({elements: elements, scrollscrub: true});
    assert.strictEqual(stack.resizeObservers.length, 1,
        'each scope constructed its own ResizeObserver');
    // Five subjects, plus the viewport root's content boxes every
    // viewport-root scope shares — the root element and the body (the
    // subjects are themselves the body's children) — one record each,
    // not one per scope.
    assert.strictEqual(stack.resizeObservers[0].observed.length, 7,
        'the shared observer did not take every scope\'s target');
}

// A root selector naming the document's own scroller is the viewport
// root: the window's scroll drives it and the offset counts once.
function documentRootSelectorScrubsWithThePage() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-root', 'html');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0', 'the html-rooted scope never published');
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0.5',
        'an html root froze — the page scroll never reached it');
}

// Container mode on the viewport root measures the page's own
// scrollable span: content growing below changes that span with no
// scroll, no window resize and no change to the scope's box — the
// observed root element is what reports it.
function viewportContainerFollowsDocumentGrowth() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    const root = stack.document.documentElement;
    root.clientHeight = 800;
    root.scrollHeight = 2400;
    stack.window.pageYOffset = 800;
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'precondition: the page fraction published');

    // The root element has auto height here, so its own box is what
    // grows — and the only target the observer reports.
    root.scrollHeight = 4000;
    const observer = stack.resizeObservers[0];
    assert.ok(observer.observed.indexOf(root) >= 0,
        'the viewport-root scope does not watch the document box');
    observer.trigger(root);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), String(800 / 3200),
        'document growth below the scope never re-measured');
}

// Inputs arriving before the frame runs arm one pass: the pending mark
// is set before the request.
function inputsBeforeTheFrameArmOnePass() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    let calls = 0;
    const driver = frameDriver();
    const requestPhased = driver.requestPhased;
    driver.requestPhased = function (read, write) {
        calls += 1;
        return requestPhased(read, write);
    };
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true, frameDriver: driver});
    scrollTo(stack.window, stack.document, 100);
    stack.window.fireEvent('resize');
    scrollTo(stack.window, stack.document, 200);
    assert.strictEqual(calls, 1, 'one frame was armed per input');
    driver.tick(16);
    scrollTo(stack.window, stack.document, 1300);
    assert.strictEqual(calls, 2, 'the next input after the pass did not arm again');
}

// An observer delivery whose list length is not a whole count is
// malformed: it reports nothing and never loops.
function fractionalEntryCountReportsNothing() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    stack.driver.tick(16);
    const observer = stack.resizeObservers[0];
    let reads = 0;
    const entries = new Proxy({length: 1.5}, {get: function (target, key) {
        if (key === 'length') {
            return target.length;
        }
        reads += 1;
        if (reads > 100) {
            throw new Error('runaway delivery loop');
        }
        return undefined;
    }});
    assert.doesNotThrow(function () {
        observer.callback(entries, observer);
        observer.callback({length: -1}, observer);
        observer.callback({length: Infinity}, observer);
        observer.callback({length: '1'}, observer);
    });
    assert.strictEqual(reads, 0, 'a malformed list was walked');
    assert.strictEqual(stack.driver.pending(), 0, 'a malformed list scheduled a pass');
}

// Under html { height: 100% } the root element's box never changes
// as the page grows: a real ResizeObserver reports only the content box
// that actually grew — here a section under the body.
function documentGrowthReportsThroughABodyChild() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    const section = new Element('section', 'section');
    const stack = openUiStack({elements: {scope: scope, section: section}, scrollscrub: true});
    const root = stack.document.documentElement;
    root.clientHeight = 800;
    root.scrollHeight = 2400;
    stack.window.pageYOffset = 800;
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'precondition: the page fraction published');
    root.scrollHeight = 4000;
    const observer = stack.resizeObservers[0];
    assert.ok(observer.observed.indexOf(section) >= 0, 'the growing body child is not watched');
    observer.trigger(section);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), String(800 / 3200),
        'content growth under a fixed-height root element never re-measured');
}

// A nested root that cannot scroll at bind becomes scrollable when its
// content grows: the scroller's box is unchanged and nothing scrolls,
// but the watched content wrapper reports the growth.
function nestedRootBecomingScrollableReMeasures() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 400;
    scroller.scrollTop = 0;
    const wrapper = new Element('div', 'wrapper');
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-root', '#scroller');
    wrapper.appendChild(scope);
    scroller.appendChild(wrapper);
    const stack = openUiStack({elements: {scroller: scroller}, scrollscrub: true});
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '', 'precondition: a non-scrolling root writes nothing');
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    const observer = stack.resizeObservers[0];
    assert.ok(observer.observed.indexOf(wrapper) >= 0, 'the root content wrapper is not watched');
    observer.trigger(wrapper);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0.5', 'the root that became scrollable never re-measured');
}

// The frame callback is one module-scope function — arming a frame
// never mints a closure.
function frameCallbackIsHoisted() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const driver = frameDriver();
    const seen = [];
    const requestPhased = driver.requestPhased;
    driver.requestPhased = function (read, write) {
        seen.push([read, write]);
        return requestPhased(read, write);
    };
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true, frameDriver: driver});
    driver.tick(16);
    scrollTo(stack.window, stack.document, 100);
    driver.tick(32);
    assert.strictEqual(seen.length, 2, 'precondition: two frames armed');
    assert.strictEqual(seen[0][0], seen[1][0], 'each arming minted a new read callback');
    assert.strictEqual(seen[0][1], seen[1][1], 'each arming minted a new write callback');
}

// The observer is shared across declarations: an entry naming no
// target is skipped on its own and the valid entries still deliver.
function malformedObserverEntrySkipsOnlyItself() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'bottom bottom');
    scope.setAttribute('data-scrub-end', 'top top');
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true});
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'precondition: a live range writes');
    const observer = stack.resizeObservers[0];
    scope.rect = {top: 300, bottom: 1200, width: 100, height: 900};
    assert.doesNotThrow(function () {
        observer.callback([null, {}, {target: scope}], observer);
    }, 'a malformed entry escaped the observer callback');
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '',
        'the valid entry beside the malformed ones never re-measured');
}

// A real ResizeObserver reports only the boxes whose size changed:
// a nested subject that grows, or an element root whose own box
// resizes, each re-measures its scope on its own entry.
function onlyTheResizedBoxReMeasures() {
    FakeSubscription.reset();
    const wrapper = new Element('div', 'wrapper');
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'bottom bottom');
    scope.setAttribute('data-scrub-end', 'top top');
    wrapper.appendChild(scope);
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    const contained = new Element('div', 'contained');
    contained.setAttribute('data-paste-scrollscrub', '');
    contained.setAttribute('data-scrub-mode', 'container');
    contained.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(contained);
    const stack = openUiStack({elements: {wrapper: wrapper, scroller: scroller}, scrollscrub: true});
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'precondition: the nested subject publishes');
    assert.strictEqual(progressOf(contained), '0.5', 'precondition: the container publishes');
    const observer = stack.resizeObservers[0];
    // The subject outgrows the viewport: the range collapses.
    scope.rect = {top: 300, bottom: 1200, width: 100, height: 900};
    observer.trigger(scope);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '', 'the resized subject never re-measured');
    // The scroller's own box grows: its scrollable span shrinks.
    scroller.clientHeight = 1000;
    observer.trigger(scroller);
    stack.driver.tick(48);
    assert.strictEqual(progressOf(contained), '1', 'the resized element root never re-measured');
}

// Each case registers with the Node test runner under its function name.
test(declaredScopeWritesProgress);
test(reverseScrollMovesProgressBack);
test(elementRootScopesFollowTheScroller);
test(multipleScopesShareTheWindowRoot);
test(degenerateRangeWithdrawsTheProperty);
test(malformedDeclarationStaysInert);
test(noDeclarationsStayQuiet);
test(bindMeasuresOnTheFirstFrame);
test(recoveredRangeRewritesAnIdenticalValue);
test(windowResizeReachesNestedScopes);
test(readsCompleteBeforeAnyWrite);
test(initialLoadReMeasuresShiftedGeometry);
test(lateActivationAddsNoLoadListener);
test(loadSubscriptionRetiresAfterOneDelivery);
test(loadingPageWithoutScopesStaysQuiet);
test(poisonedObserverKeepsScrollFallback);
test(refusedObservationOnlyLosesItsOwnTarget);
test(declaredScopesShareOneObserver);
test(documentRootSelectorScrubsWithThePage);
test(viewportContainerFollowsDocumentGrowth);
test(inputsBeforeTheFrameArmOnePass);
test(fractionalEntryCountReportsNothing);
test(documentGrowthReportsThroughABodyChild);
test(nestedRootBecomingScrollableReMeasures);
test(hostileWeakMapLeavesScrollInputs);
test(throwingBindCostsOnlyItsScope);
test(onlyTheResizedBoxReMeasures);
test(frameCallbackIsHoisted);
test(malformedObserverEntrySkipsOnlyItself);

// The root's own scroll moves only the offset against endpoints the
// scope already located: a scroll-only frame reads no layout for any
// scope, in view or not, and still publishes the right progress. What
// can move the endpoints — a resize — measures afresh.
function scrollOnlyFramesReadNoLayout() {
    FakeSubscription.reset();
    const page = new Element('div', 'page');
    const scopes = [];
    let rects = 0;
    for (let index = 0; index < 5; index += 1) {
        const scope = new Element('section', 's' + index);
        scope.setAttribute('data-paste-scrollscrub', '');
        scope.rect = {top: 1600 + index * 3000, bottom: 1800 + index * 3000, width: 100, height: 200};
        const rect = scope.getBoundingClientRect.bind(scope);
        scope.getBoundingClientRect = () => { rects += 1; return rect(); };
        page.appendChild(scope);
        scopes.push(scope);
    }
    const stack = openUiStack({elements: {page: page}, scrollscrub: true});
    stack.driver.tick(16);
    assert.strictEqual(rects, 5, 'precondition: the first frame measured every scope');
    rects = 0;
    // Layout follows the scroll, but nothing reads it.
    scopes.forEach(function (scope, index) {
        scope.rect = {top: 300 + index * 3000, bottom: 500 + index * 3000, width: 100, height: 200};
    });
    scrollTo(stack.window, stack.document, 1300);
    stack.driver.tick(32);
    assert.strictEqual(rects, 0, 'a scroll-only frame re-measured layout');
    assert.strictEqual(progressOf(scopes[0]), '0.5');
    assert.strictEqual(progressOf(scopes[1]), '0');
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(rects, 5, 'a resize did not re-measure every scope');
    assert.strictEqual(progressOf(scopes[0]), '0.5');
}

// The page's scroll moves a nested root and the subjects inside it
// together: the endpoints in the root's scroll space do not change, so
// a page scroll re-measures nothing and writes nothing, and the
// module subscribes to the window's scroll only for the viewport root.
function pageScrollLeavesNestedScopesUnmeasured() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 2000;
    scroller.scrollTop = 0;
    scroller.rect = {top: 0, bottom: 400, width: 300, height: 400};
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.setAttribute('data-scrub-start', 'top bottom');
    scope.setAttribute('data-scrub-end', 'top top');
    // root-space top 400: start 0, end 400.
    scope.rect = {top: 400, bottom: 600, width: 300, height: 200};
    let rects = 0;
    const rect = scope.getBoundingClientRect.bind(scope);
    scope.getBoundingClientRect = () => { rects += 1; return rect(); };
    scroller.appendChild(scope);
    const stack = openUiStack({elements: {scroller: scroller}, scrollscrub: true});
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0', 'precondition: the nested scope published');
    rects = 0;
    // The page scrolls the scroller and its subject up by 200 together.
    scroller.rect = {top: -200, bottom: 200, width: 300, height: 400};
    scope.rect = {top: 200, bottom: 400, width: 300, height: 200};
    stack.window.pageYOffset = 200;
    stack.window.fireEvent('scroll');
    stack.driver.tick(32);
    assert.strictEqual(rects, 0, 'a page scroll re-measured a nested scope');
    scroller.scrollTop = 200;
    scroller.fireEvent('scroll');
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0.5', 'the nested root\'s own scroll still drives the scope');
    assert.strictEqual(rects, 0, 'the root\'s own scroll re-measured layout');
}

test(scrollOnlyFramesReadNoLayout);
test(pageScrollLeavesNestedScopesUnmeasured);

// Appended content changes the range without resizing the scroller or any
// previously watched child. Later growth must be observed on the new box.
test('appended and removed content refreshes range and resize coverage', () => {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(scope);
    const mutations = [];
    const stack = openUiStack({elements: {scroller}, scrollscrub: true,
        window: {MutationObserver: function (callback) {
            this.observe = (target, options) => mutations.push({target, options, callback});
        }}});
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5');
    assert.strictEqual(mutations.length, 1, 'one content observer per root');
    assert.strictEqual(mutations[0].target, scroller, 'the nested root observes itself');
    assert.strictEqual(JSON.stringify(mutations[0].options), '{"childList":true}',
        'the nested root observes its direct children only');
    const added = new Element('div', 'added');
    scroller.appendChild(added);
    scroller.scrollHeight = 2800;
    mutations[0].callback([{target: scroller, type: 'childList'}]);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0.25');
    const resize = stack.resizeObservers[0];
    assert.ok(resize.observed.includes(added), 'new content is watched for later growth');
    scroller.scrollHeight = 3400;
    resize.trigger(added);
    stack.driver.tick(48);
    assert.strictEqual(progressOf(scope), '0.2');
    scroller.removeChild(added);
    scroller.scrollHeight = 1600;
    mutations[0].callback([{target: scroller, type: 'childList'}]);
    stack.driver.tick(64);
    assert.strictEqual(progressOf(scope), '0.5');
    assert.ok(!resize.observed.includes(added), 'removed content is released');
});

// The viewport root's content list is the body's children, so the body's
// own child list is all its observer watches: text and markup churn
// deeper in the page resizes a watched box when it matters and never
// re-measures on its own. A child added to the body is picked up.
test('the viewport root observes only the body child list', () => {
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    const mutations = [];
    const stack = openUiStack({elements: {scope}, scrollscrub: true,
        window: {MutationObserver: function (callback) {
            this.observe = (target, options) => mutations.push({target, options, callback});
        }}});
    stack.driver.tick(16);
    const body = stack.document.body;
    assert.strictEqual(mutations.length, 1, 'one content observer for the viewport root');
    assert.strictEqual(mutations[0].target, body, 'the viewport root observes the body');
    assert.strictEqual(JSON.stringify(mutations[0].options), '{"childList":true}',
        'the viewport root observes the body child list only');
    const added = new Element('div', 'added');
    body.appendChild(added);
    mutations[0].callback([{target: body, type: 'childList'}]);
    stack.driver.tick(32);
    const resize = stack.resizeObservers[0];
    assert.ok(resize.observed.includes(added), 'a child added to the body is watched for growth');
    body.removeChild(added);
    mutations[0].callback([{target: body, type: 'childList'}]);
    stack.driver.tick(48);
    assert.ok(!resize.observed.includes(added), 'a child removed from the body is released');
});

test('separate nested roots retain independent offsets and shared roots bind once', () => {
    FakeSubscription.reset();
    const roots = [new Element('div', 'one'), new Element('div', 'two')];
    const scopes = [];
    for (const root of roots) {
        root.clientHeight = 400;
        root.scrollHeight = 1600;
        root.scrollTop = 0;
        for (let index = 0; index < 2; index += 1) {
            const scope = new Element('div', root.id + index);
            scope.setAttribute('data-paste-scrollscrub', '');
            scope.setAttribute('data-scrub-mode', 'container');
            scope.setAttribute('data-scrub-root', '#' + root.id);
            root.appendChild(scope);
            scopes.push(scope);
        }
    }
    const stack = openUiStack({elements: {one: roots[0], two: roots[1]}, scrollscrub: true});
    stack.driver.tick(16);
    for (const root of roots) {
        assert.equal(FakeSubscription.registry.filter(subscription =>
            subscription.target === root && subscription.name === 'scroll').length, 1);
    }
    roots[0].scrollTop = 300;
    roots[0].fireEvent('scroll');
    stack.driver.tick(32);
    assert.deepEqual(scopes.map(progressOf), ['0.25', '0.25', '0', '0']);
    roots[1].scrollTop = 900;
    roots[1].fireEvent('scroll');
    stack.driver.tick(48);
    assert.deepEqual(scopes.map(progressOf), ['0.25', '0.25', '0.75', '0.75']);
});

test('a removed content box is observed again when reattached', async () => {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const mutations = require('./fakes.cjs').mutationObserverRegistry();
    const stack = openUiStack({elements: {scope}, scrollscrub: true,
        window: {MutationObserver: mutations.MutationObserver}});
    stack.driver.tick(16);
    const body = stack.document.body;
    const child = new Element('div', 'child');
    const resize = stack.resizeObservers[0];
    for (let round = 0; round < 2; round += 1) {
        body.appendChild(child);
        await Promise.resolve();
        stack.driver.tick(32 + round * 32);
        assert.ok(resize.observed.includes(child), 'an attached child must be watched');
        body.removeChild(child);
        await Promise.resolve();
        stack.driver.tick(48 + round * 32);
        assert.equal(resize.observed.includes(child), false);
    }
});

test('an inactive scope leaves newly authored progress alone after withdrawing its own value', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 100, bottom: 200, width: 100, height: 100};
    const stack = openUiStack({elements: {scope}, scrollscrub: true});
    stack.driver.tick(16);
    assert.notEqual(progressOf(scope), '');
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
    scope.clientRects = [];
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.equal(progressOf(scope), '');
    scope.style.setProperty('--paste-scrub-progress', '0.7');
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.equal(progressOf(scope), '0.7');
});

test('unchanged progress makes no repeated custom-property write', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 100, bottom: 200, width: 100, height: 100};
    let writes = 0;
    const set = scope.style.setProperty.bind(scope.style);
    scope.style.setProperty = (...args) => { writes += 1; set(...args); };
    const stack = openUiStack({elements: {scope}, scrollscrub: true});
    stack.driver.tick(16);
    assert.equal(writes, 1);
    stack.window.fireEvent('scroll');
    stack.driver.tick(32);
    assert.equal(writes, 1);
});

test('a failed resize-observer constructor is attempted only once for all scopes', () => {
    const one = new Element('div', 'one'), two = new Element('div', 'two');
    for (const scope of [one, two]) scope.setAttribute('data-paste-scrollscrub', '');
    let attempts = 0;
    const stack = openUiStack({elements: {one, two}, scrollscrub: true, window: {
        ResizeObserver: function () { attempts += 1; throw new Error('unavailable'); }
    }});
    stack.driver.tick(16);
    assert.equal(attempts, 1);
    assert.notEqual(progressOf(one), '');
    assert.notEqual(progressOf(two), '');
});

test('viewport container progress responds when the body itself resizes', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    const stack = openUiStack({elements: {scope}, scrollscrub: true});
    stack.document.documentElement.clientHeight = 800;
    stack.document.documentElement.scrollHeight = 1600;
    stack.window.pageYOffset = 400;
    stack.driver.tick(16);
    assert.equal(progressOf(scope), '0.5');
    const observer = stack.resizeObservers[0];
    assert.ok(observer.observed.includes(stack.document.body));
    stack.document.documentElement.scrollHeight = 2400;
    observer.trigger(stack.document.body);
    stack.driver.tick(32);
    assert.equal(progressOf(scope), '0.25');
});

test('returning to a visible document remeasures a moved subject', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 0, bottom: 800, width: 100, height: 800};
    const stack = openUiStack({elements: {scope}, scrollscrub: true});
    stack.driver.tick(16);
    assert.equal(progressOf(scope), '0.5');
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    scope.rect = {top: 800, bottom: 1600, width: 100, height: 800};
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(32);
    assert.equal(progressOf(scope), '0');
});

test('an initially unrendered scope preserves its authored progress fallback', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
    scope.clientRects = [];
    scope.style.setProperty('--paste-scrub-progress', '0.7');
    const stack = openUiStack({elements: {scope}, scrollscrub: true});
    stack.driver.tick(16);
    assert.equal(progressOf(scope), '0.7');
});

test('a child-list refresh keeps body resize coverage for viewport scopes', async () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-mode', 'container');
    const mutations = mutationObserverRegistry();
    const stack = openUiStack({elements: {scope}, scrollscrub: true,
        window: {MutationObserver: mutations.MutationObserver}});
    const root = stack.document.documentElement;
    root.clientHeight = 800;
    root.scrollHeight = 1600;
    stack.window.pageYOffset = 400;
    stack.driver.tick(16);
    assert.equal(progressOf(scope), '0.5');
    stack.document.body.appendChild(new Element('div', 'new-content'));
    await Promise.resolve();
    stack.driver.tick(32);
    const observer = stack.resizeObservers[0];
    assert.ok(observer.observed.includes(stack.document.body));
    root.scrollHeight = 2400;
    observer.trigger(stack.document.body);
    stack.driver.tick(48);
    assert.equal(progressOf(scope), '0.25');
});

test('two scopes sharing one subject both respond to its resize', () => {
    const one = new Element('div', 'one'), two = new Element('div', 'two');
    const subject = new Element('div', 'subject');
    subject.rect = {top: 0, bottom: 800, width: 100, height: 800};
    for (const scope of [one, two]) {
        scope.setAttribute('data-paste-scrollscrub', '');
        scope.setAttribute('data-scrub-subject', '#subject');
    }
    const stack = openUiStack({elements: {one, two, subject}, scrollscrub: true});
    stack.driver.tick(16);
    assert.equal(progressOf(one), '0.5');
    assert.equal(progressOf(two), '0.5');
    subject.rect = {top: 0, bottom: 1600, width: 100, height: 1600};
    stack.resizeObservers[0].trigger(subject);
    stack.driver.tick(32);
    assert.equal(progressOf(one), String(1 / 3));
    assert.equal(progressOf(two), String(1 / 3));
});

// A subject inside a fixed-size wrapper (#app { height: 100% }) moves
// when content before it inside the wrapper changes, while the wrapper
// — the box the viewport root's content list watches — keeps its size.
// The subject's path is watched: the wrapper's child list re-measures
// the scope, and the wrapper's children are resize-watched, an added
// child included; a removed one is released.
test('a subject inside a fixed-size wrapper re-measures when content before it changes', () => {
    FakeSubscription.reset();
    const app = new Element('div', 'app');
    const top = new Element('div', 'top');
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    app.appendChild(top);
    app.appendChild(scope);
    const mutations = [];
    const stack = openUiStack({elements: {app}, scrollscrub: true,
        window: {MutationObserver: function (callback) {
            this.observe = (target, options) => mutations.push({target, options, callback});
        }}});
    // Viewport 800; subject at 1600..1800 in the page: S = 800, E = 1800.
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'precondition: the nested subject publishes');
    const path = mutations.filter(m => m.target === app);
    assert.strictEqual(path.length, 1, 'the wrapper on the subject\'s path is not observed');
    assert.strictEqual(JSON.stringify(path[0].options), '{"childList":true}',
        'the path observer watches more than child lists');
    const resize = stack.resizeObservers[0];
    assert.ok(resize.observed.includes(top), 'content before the subject in the wrapper is not resize-watched');
    // 500px inserted before the subject inside the wrapper: the wrapper
    // keeps its size, the subject moves down by 500 (S = 1300, E = 2300).
    const added = new Element('div', 'added');
    app.insertBefore(added, scope);
    scope.rect = {top: 800, bottom: 1000, width: 100, height: 200};
    path[0].callback([{target: app, type: 'childList'}]);
    stack.driver.tick(32);
    assert.strictEqual(progressOf(scope), '0', 'an insertion inside the wrapper left the endpoints stale');
    assert.ok(resize.observed.includes(added), 'the inserted box is not watched for later growth');
    // The inserted box grows by 500 more: a resize the path reports.
    scope.rect = {top: 1300, bottom: 1500, width: 100, height: 200};
    resize.trigger(added);
    stack.driver.tick(48);
    scrollTo(stack.window, stack.document, 2300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(64);
    assert.strictEqual(progressOf(scope), '0.5', 'growth of a path box left the endpoints stale');
    app.removeChild(added);
    path[0].callback([{target: app, type: 'childList'}]);
    stack.driver.tick(80);
    assert.ok(!resize.observed.includes(added), 'a box removed from the path is still watched');
    assert.ok(resize.observed.includes(scope), 'the subject lost its own watch');
});

// A host that refuses the frame makes requestPhased throw. The refused
// request armed nothing, so the pending mark must not outlive it: the
// next input asks again and its pass publishes the progress.
test('a refused frame request leaves the next input free to ask again', () => {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const driver = frameDriver();
    const requestPhased = driver.requestPhased;
    let refusals = 1;
    let calls = 0;
    driver.requestPhased = function (read, write) {
        calls += 1;
        if (refusals > 0) {
            refusals -= 1;
            throw new Error('frame refused');
        }
        return requestPhased(read, write);
    };
    const stack = openUiStack({elements: {scope: scope}, scrollscrub: true, frameDriver: driver});
    assert.strictEqual(calls, 1, 'the bind asked for its first pass');
    scrollTo(stack.window, stack.document, 1300);
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    assert.strictEqual(calls, 2, 'the input after a refused request did not ask again');
    driver.tick(16);
    assert.strictEqual(progressOf(scope), '0.5', 'the pass after a refused request never ran');
});
