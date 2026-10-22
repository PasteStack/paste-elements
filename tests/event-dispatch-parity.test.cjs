'use strict';

// The fake/real-core dispatch parity gate: core's PasteEvent picks a
// dispatchContext once — a defaultContext carrying nodeType dispatches
// on itself, anything else (window, null) dispatches on the document
// (core src/js/event.js). The shared fake must produce the identical
// delivery matrix, or module tests asserting event delivery are proving
// behavior no browser shows. This test drives the same subscriber
// matrix — document-bound, window-bound and element-bound subscriptions
// plus the Event's own subscribe — through both implementations and
// asserts the observable results agree: which listeners ran, how many
// times, what payload they saw, and that a disposed subscription hears
// nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');
const {loadModule, listenerSurface, FakeEvent, FakeSubscription} = require('./fakes.cjs');

// The core checkout is explicit configuration: PASTE_CORE_JS names the
// src/js directory of a paste release or checkout (the CI job clones it
// under target/). A guessed sibling path would compare the fake against
// a checkout that may not exist — the gate refuses instead.
const coreDir = process.env.PASTE_CORE_JS;
const coreAvailable = !!coreDir && fs.existsSync(path.join(coreDir, 'event.js'));

function requireCore() {
    assert.ok(coreDir,
        'PASTE_CORE_JS is not set — name the src/js directory of a paste release or checkout');
    assert.ok(coreAvailable,
        'PASTE_CORE_JS does not contain event.js: ' + coreDir);
}

// A page both implementations share the shape of: document, window and
// one element — each carrying the listener surface the real DOM would.
function fakePage() {
    const el = {};
    const stack = loadModule({
        file: 'paste/ui/utilities/scrollrange.js',
        name: 'paste.ui.utilities.scrollrange',
        deps: [], impls: [],
        elements: {main: new (require('./fakes.cjs').Element)('div')}
    });
    return {
        document: stack.document,
        window: stack.window,
        element: stack.elements.main,
        EventImpl: FakeEvent,
        bindImpl: function (name, target, method, context, executeCount) {
            return new FakeSubscription(name, target, method, context, executeCount);
        }
    };
}

// Real paste core in a vm realm: window is the global so ambient
// `window`, `document` and `paste` resolve exactly as they do on a page.
function realPage() {
    const realWindow = listenerSurface({});
    realWindow.window = realWindow;
    realWindow.setTimeout = setTimeout;
    realWindow.clearTimeout = clearTimeout;
    const realDocument = listenerSurface({nodeType: 9});
    realDocument.documentElement = listenerSurface({nodeType: 1});
    realDocument.readyState = 'complete';
    realDocument.head = {nodeType: 1};
    realDocument.createEvent = function () {
        return {
            initEvent: function (name, bubbles, cancelable) {
                this.type = name;
                this.bubbles = bubbles;
                this.cancelable = cancelable;
            }
        };
    };
    realWindow.document = realDocument;
    realWindow.navigator = {};
    vm.createContext(realWindow);
    ['paste.js', 'guid.js', 'util.js', 'event.js'].forEach(function (file) {
        vm.runInContext(fs.readFileSync(path.join(coreDir, file), 'utf8'), realWindow, {filename: file});
    });
    const event = realWindow.paste.event;
    const element = listenerSurface({nodeType: 1});
    // Inside the context, `window` is the contextified global proxy — a
    // different identity than the raw sandbox object held out here.
    // Core's `element_or_eventContext === window` test must see the
    // proxy it compares against, or a window-contexted subscription is
    // correctly (but misleadingly) treated as a foreign context.
    const inContextWindow = vm.runInContext('window', realWindow);
    return {
        document: realDocument,
        window: inContextWindow,
        element: element,
        EventImpl: event.Event,
        bindImpl: function (name, target, method, context, executeCount) {
            // event['bind'] constructs a PasteSubscription — the real
            // core's only subscription path.
            return event['bind'](name, target, method, context, executeCount);
        }
    };
}

// One subscriber matrix per page: a subscription bound on the document,
// one on the window, one on the element, and one through the Event's
// own subscribe — then fire once with a payload and record who heard
// what and how often.
function runMatrix(page, context, payload) {
    FakeSubscription.reset();
    const name = 'navStuck';
    const ev = new page.EventImpl(context, name);
    const calls = {document: 0, window: 0, element: 0, eventSub: 0};
    const payloads = {document: [], window: [], element: [], eventSub: []};
    const record = function (key) {
        return function (domEvent, data) {
            calls[key] += 1;
            payloads[key].push(data);
        };
    };
    const subs = [
        page.bindImpl(name, page.document, record('document')),
        page.bindImpl(name, page.window, record('window')),
        page.bindImpl(name, page.element, record('element'))
    ];
    const eventSub = ev.subscribe(record('eventSub'));
    ev.fire(payload);
    // Snapshot the first fire's counts — the counters keep accumulating
    // through the second fire, and a live alias would credit it to the
    // first.
    const first = {
        calls: {document: calls.document, window: calls.window,
            element: calls.element, eventSub: calls.eventSub},
        payloads: {document: payloads.document.slice(), window: payloads.window.slice(),
            element: payloads.element.slice(), eventSub: payloads.eventSub.slice()}
    };
    // Second fire: a persistent subscription hears it again — delivery
    // is once per fire, never suppressed and never doubled.
    ev.fire(payload);
    subs.forEach(function (sub) {
        if (sub && typeof sub.dispose === 'function') {
            sub.dispose();
        } else if (sub && typeof sub.remove === 'function') {
            sub.remove();
        }
    });
    eventSub.dispose();
    ev.fire(payload);
    return {first: first, totalCalls: calls};
}

function assertMatrixEqual(fake, real, label) {
    ['document', 'window', 'element', 'eventSub'].forEach(function (key) {
        assert.equal(
            fake.first.calls[key], real.first.calls[key],
            label + ': ' + key + '-bound subscriber count differs from real core');
        assert.deepEqual(
            fake.first.payloads[key], real.first.payloads[key],
            label + ': ' + key + '-bound payload differs from real core');
        assert.equal(
            fake.totalCalls[key], real.totalCalls[key],
            label + ': ' + key + '-bound delivery after a second fire and disposal differs');
    });
}

test('document-contexted events reach the document subscription once per fire', () => {
    requireCore();
    const fake = fakePage();
    const real = realPage();
    const payload = {stuck: true};
    assertMatrixEqual(
        runMatrix(fake, fake.document, payload),
        runMatrix(real, real.document, payload),
        'document context');
});

test('element-contexted events dispatch on the element, not the document', () => {
    requireCore();
    const fake = fakePage();
    const real = realPage();
    assertMatrixEqual(
        runMatrix(fake, fake.element, {stuck: false}),
        runMatrix(real, real.element, {stuck: false}),
        'element context');
});

test('window-contexted events dispatch on the document — never the window', () => {
    requireCore();
    const fake = fakePage();
    const real = realPage();
    const fakeResult = runMatrix(fake, fake.window, 'payload');
    const realResult = runMatrix(real, real.window, 'payload');
    assertMatrixEqual(fakeResult, realResult, 'window context');
    // The documented core behavior the fake must reproduce: a
    // window-contexted fire reaches the document-bound subscription and
    // never the window-bound one.
    assert.equal(realResult.first.calls.document, 1,
        'real core did not dispatch a window-contexted event on the document');
    assert.equal(realResult.first.calls.window, 0,
        'real core dispatched a window-contexted event on the window');
});

// The subscription contract beyond dispatch: an executeCount counts
// deliveries down and retires the subscription after the last one
// (true means one; zero or absent means unlimited), a context is the
// method's `this`, and a target that is neither a node nor the window
// binds to the document. Modules lean on all three — a self-retiring
// load wake, a one-shot blur — so the fake must agree with core on
// every row, or a test proves retirement no browser shows.
function runSubscriptionRows(page) {
    FakeSubscription.reset();
    const name = 'paritySignal';
    const elementEvent = new page.EventImpl(page.element, name);
    const documentEvent = new page.EventImpl(page.document, name);
    const counts = {once: 0, onceTrue: 0, twice: 0, unlimited: 0, foreign: 0};
    const contexts = [];
    const context = {label: 'owner'};
    const counter = function (key) {
        return function () {
            counts[key] += 1;
        };
    };
    const once = page.bindImpl(name, page.element, counter('once'), null, 1);
    page.bindImpl(name, page.element, counter('onceTrue'), null, true);
    page.bindImpl(name, page.element, counter('twice'), null, 2);
    page.bindImpl(name, page.element, counter('unlimited'), null, 0);
    page.bindImpl(name, page.element, function () {
        contexts.push(this === context);
    }, context);
    // A plain object is no node and no window: core binds the
    // subscription to the document instead.
    page.bindImpl(name, {}, counter('foreign'));
    elementEvent.fire('first');
    elementEvent.fire('second');
    elementEvent.fire('third');
    documentEvent.fire('document');
    return {
        counts: counts,
        contexts: contexts,
        onceBound: typeof once.isBound === 'function' ? once.isBound() : undefined
    };
}

test('executeCount, context and foreign targets behave as in core', () => {
    requireCore();
    const fake = runSubscriptionRows(fakePage());
    const real = runSubscriptionRows(realPage());
    assert.deepEqual(real.counts, {once: 1, onceTrue: 1, twice: 2, unlimited: 3, foreign: 1},
        'the core reference rows changed');
    assert.deepEqual(fake.counts, real.counts, 'delivery counts differ from real core');
    assert.deepEqual(fake.contexts, real.contexts, 'method context differs from real core');
    assert.deepEqual(real.contexts, [true, true, true], 'core no longer applies the context');
    assert.equal(fake.onceBound, real.onceBound, 'a retired subscription reports a different binding');
});

// The rows above combine at real call sites: a counted subscription with
// a context, and a foreign target with both. The count still retires the
// subscription after its last delivery, the context is still `this` on
// every delivery it makes, and a foreign target still binds the document
// — with the count and context intact.
function runCombinedRows(page) {
    FakeSubscription.reset();
    const name = 'parityCombined';
    const elementEvent = new page.EventImpl(page.element, name);
    const documentEvent = new page.EventImpl(page.document, name);
    const context = {label: 'owner'};
    const seen = {countedContext: [], foreignContext: []};
    const recorder = function (key) {
        return function () {
            seen[key].push(this === context);
        };
    };
    const counted = page.bindImpl(name, page.element, recorder('countedContext'), context, 2);
    const foreign = page.bindImpl(name, {}, recorder('foreignContext'), context, 1);
    elementEvent.fire('first');
    elementEvent.fire('second');
    elementEvent.fire('third');
    documentEvent.fire('document-1');
    documentEvent.fire('document-2');
    return {
        seen: seen,
        countedBound: typeof counted.isBound === 'function' ? counted.isBound() : undefined,
        foreignBound: typeof foreign.isBound === 'function' ? foreign.isBound() : undefined
    };
}

test('context with executeCount, and a foreign target with both, behave as in core', () => {
    requireCore();
    const fake = runCombinedRows(fakePage());
    const real = runCombinedRows(realPage());
    assert.deepEqual(real.seen, {countedContext: [true, true], foreignContext: [true]},
        'the core reference rows changed');
    assert.deepEqual(fake.seen, real.seen, 'counted or foreign deliveries differ from real core');
    assert.equal(fake.countedBound, real.countedBound, 'a retired counted subscription reports a different binding');
    assert.equal(fake.foreignBound, real.foreignBound, 'a retired foreign subscription reports a different binding');
});

// Two pages, one after the other: a window-targeted subscription created
// in page 1 after page 2 has loaded must bind page 1's own window. In
// core each page's realm has its own `window`, so the binding is per
// page by construction. A native event on page 1's window reaches it;
// page 2's window and document never do.
function runTwoPageWindowRow(makePage) {
    const pageOne = makePage();
    const pageTwo = makePage();
    const name = 'resize';
    const heard = [];
    const subscription = pageOne.bindImpl(name, pageOne.window, function () {
        heard.push('page-one');
    });
    const deliver = function (target) {
        if (typeof target.dispatchEvent === 'function') {
            target.dispatchEvent({type: name});
        } else {
            target.fireEvent(name);
        }
    };
    deliver(pageTwo.window);
    deliver(pageTwo.document);
    const afterOtherPage = heard.length;
    deliver(pageOne.window);
    if (subscription && typeof subscription.dispose === 'function') {
        subscription.dispose();
    } else if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
    }
    return {afterOtherPage: afterOtherPage, afterOwnWindow: heard.length};
}

test('real core: a page-one window subscription created after page two loads binds page one', () => {
    requireCore();
    assert.deepEqual(runTwoPageWindowRow(realPage), {afterOtherPage: 0, afterOwnWindow: 1},
        'core bound a page-one window subscription somewhere other than page one\'s window');
});

test('fake: a page-one window subscription created after page two loads binds page one', () => {
    requireCore();
    assert.deepEqual(runTwoPageWindowRow(fakePage), {afterOtherPage: 0, afterOwnWindow: 1},
        'the fake bound a page-one window subscription somewhere other than page one\'s window');
});
