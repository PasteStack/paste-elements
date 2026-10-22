'use strict';

// The fake frame driver stands in for paste.ui.utilities.animation-frame
// in every behaviour suite, so it must keep the real batch's contract
// where a module can observe it: a throwing callback never stops the
// rest of its batch — every phase still runs, in order — and the error
// still surfaces. The same batch runs against both, and both must run
// the same callbacks in the same order and report the first error.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {frameDriver, readModuleSource} = require('./fakes.cjs');

function realBatch() {
    const frames = [];
    const timers = [];
    const exports = {};
    const window = {
        requestAnimationFrame: function (callback) {
            frames.push(callback);
            return frames.length;
        },
        cancelAnimationFrame: function () {},
        performance: {now: function () { return 1; }}
    };
    vm.runInNewContext(readModuleSource('paste/ui/utilities/animation-frame.js'), {
        window: window,
        setTimeout: function (callback) {
            timers.push(callback);
            return timers.length;
        },
        isFinite: isFinite,
        Object: Object,
        Date: Date,
        paste: {define: function (name, deps, factory) { factory(exports); }}
    });
    return {
        api: exports,
        // Delivers the pending host frame, then every task the batch
        // queued; returns the errors those tasks raise, in order.
        tick: function (time) {
            const raised = [];
            frames.splice(0).forEach(function (callback) {
                try {
                    callback(time);
                } catch (error) {
                    raised.push(error);
                }
            });
            timers.splice(0).forEach(function (callback) {
                try {
                    callback();
                } catch (error) {
                    raised.push(error);
                }
            });
            return raised;
        }
    };
}

function fakeBatch() {
    const driver = frameDriver();
    return {
        api: driver,
        tick: function (time) {
            try {
                driver.tick(time);
            } catch (error) {
                return [error];
            }
            return [];
        }
    };
}

function throwingBatch(batch) {
    const ran = [];
    const first = new Error('first read');
    const second = new Error('plain');
    batch.api.requestPhased(function () {
        ran.push('read-a');
        throw first;
    }, function () {
        ran.push('write-a');
    });
    batch.api.request(function () {
        ran.push('plain');
        throw second;
    });
    batch.api.requestPhased(function () {
        ran.push('read-b');
    }, function () {
        ran.push('write-b');
    });
    const raised = batch.tick(100);
    return {ran: ran, raised: raised, first: first};
}

test('a throwing callback finishes its batch and its error surfaces, as in the real batch', () => {
    const real = throwingBatch(realBatch());
    const fake = throwingBatch(fakeBatch());
    assert.deepEqual(real.ran, ['read-a', 'read-b', 'plain', 'write-a', 'write-b'],
        'the real batch stopped or reordered after a throw');
    assert.deepEqual(fake.ran, real.ran, 'the fake batch diverges from the real one after a throw');
    assert.ok(real.raised.indexOf(real.first) !== -1, 'the real batch lost the first error');
    assert.equal(fake.raised.length, 1, 'the fake reports one error per batch');
    assert.equal(fake.raised[0], fake.first, 'the fake reports the first error of the batch');
});

test('the next batch runs normally after a throwing one', () => {
    const fake = fakeBatch();
    throwingBatch(fake);
    const ran = [];
    fake.api.request(function () {
        ran.push('next');
    });
    assert.deepEqual(fake.tick(200), []);
    assert.deepEqual(ran, ['next']);
});

// Browser counterpart: "platform ResizeObserver reports sizes, not position
// or descendants" in ElementsBrowserChecks. Explicit deliveries must still
// respect the native observer's target set and disconnect/reobserve lifetime.
test('ResizeObserver reports only registered targets and can observe again after disconnect', () => {
    const {resizeObserverRegistry, Element} = require('./fakes.cjs');
    const {ResizeObserver} = resizeObserverRegistry();
    const parent = new Element('div');
    const child = new Element('div');
    const seen = [];
    const observer = new ResizeObserver(entries => seen.push(entries.map(entry => entry.target)));
    observer.observe(parent);
    observer.observe(parent);
    observer.trigger();
    assert.deepEqual(seen, [[parent]], 'observe is idempotent');
    seen.length = 0;
    parent.appendChild(child);
    observer.trigger(child);
    assert.deepEqual(seen, [], 'observing a parent does not observe later children');
    observer.disconnect();
    observer.trigger(parent);
    assert.deepEqual(seen, [], 'disconnect removes all observations');
    observer.observe(child);
    observer.trigger();
    assert.deepEqual(seen, [[child]], 'reobserve starts a new observation set');
});

test('img.src reflects its attribute against the live document base', () => {
    const {Element} = require('./fakes.cjs');
    const image = new Element('img');
    image.ownerDocument = {baseURI: 'https://example.test/first/'};
    assert.equal(image.src, '');
    image.src = 'frame.png';
    assert.equal(image.getAttribute('src'), 'frame.png');
    assert.equal(image.src, 'https://example.test/first/frame.png');
    image.ownerDocument.baseURI = 'https://example.test/second/';
    assert.equal(image.src, 'https://example.test/second/frame.png');
    image.setAttribute('src', '/root.png');
    assert.equal(image.src, 'https://example.test/root.png');
});

test('Bounds.fromElement matches real core for fixed, sticky and boxless viewport rectangles', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const {boundsFromElement} = require('./fakes.cjs');
    assert.ok(process.env.PASTE_CORE_JS, 'PASTE_CORE_JS is required');
    const source = fs.readFileSync(path.join(process.env.PASTE_CORE_JS, 'dom.js'), 'utf8');
    const start = source.indexOf('dom.Bounds.fromElement = function');
    const end = source.indexOf('\n        };', start);
    assert.ok(start > 0 && end > start, 'real core Bounds function was not found');
    const document = {documentElement: {clientLeft: 2, clientTop: 3}};
    const window = {pageXOffset: 11, pageYOffset: 500};
    const dom = {
        Bounds: function (left = 0, top = 0, width = 0, height = 0) {
            Object.assign(this, {left, top, width, height});
            this.getBottom = () => top + height;
        },
        getDocumentBody: () => document.documentElement,
        getScrollLeft: () => window.pageXOffset,
        getScrollTop: () => window.pageYOffset
    };
    vm.runInNewContext(source.slice(start, end + '\n        };'.length), {dom, document});
    for (const [kind, top, width, height, display] of [
        ['fixed', 10, 40, 20, 'block'], ['sticky', 0, 40, 20, 'block'],
        ['contents', 0, 0, 0, 'contents'], ['hidden', 0, 0, 0, 'none']
    ]) {
        const element = {tagName: 'DIV', style: {display}, offsetWidth: width, offsetHeight: height,
            getBoundingClientRect: () => ({left: 10, top})};
        for (const scroll of [0, 500, 900]) {
            window.pageYOffset = scroll;
            const fake = boundsFromElement(element, document, window);
            const real = dom.Bounds.fromElement(element);
            for (const key of ['left', 'top', 'width', 'height']) assert.equal(fake[key], real[key], kind + ' ' + key);
            element.offsetHeight += 5;
            assert.equal(fake.getBottom(), real.getBottom(), 'Bounds is a measurement snapshot');
            element.offsetHeight -= 5;
        }
    }
});

// Browser counterpart: "platform mutation and intersection delivery contracts".
test('MutationObserver batches filtered writes and drops pending records at disconnect', async () => {
    const {Element, mutationObserverRegistry} = require('./fakes.cjs');
    const {MutationObserver} = mutationObserverRegistry();
    const parent = new Element('div');
    const child = new Element('div');
    const deliveries = [];
    const observer = new MutationObserver(records => deliveries.push(records.map(r => [r.type, r.attributeName || null])));
    observer.observe(parent, {attributes: true, attributeFilter: ['src'], childList: true});
    observer.observe(parent, {attributes: true, attributeFilter: ['src'], childList: true});
    parent.setAttribute('src', 'a');
    parent.setAttribute('alt', 'ignored');
    parent.appendChild(child);
    child.setAttribute('src', 'unobserved descendant');
    assert.deepEqual(deliveries, [], 'native mutations do not deliver synchronously');
    await Promise.resolve();
    assert.deepEqual(deliveries, [[['attributes', 'src'], ['childList', null]]]);
    parent.setAttribute('src', 'discard');
    observer.disconnect();
    await Promise.resolve();
    assert.equal(deliveries.length, 1);
    observer.observe(child, {attributeFilter: ['src']});
    child.setAttribute('src', 'b');
    await Promise.resolve();
    assert.deepEqual(deliveries[1], [['attributes', 'src']]);
    assert.throws(() => observer.observe(parent, {childList: true, subtree: true}), /not modelled/);
});

test('IntersectionObserver delivers supplied geometry asynchronously only for watched targets', async () => {
    const {Element, intersectionObserverRegistry} = require('./fakes.cjs');
    const {IntersectionObserver} = intersectionObserverRegistry();
    const target = new Element('div');
    const other = new Element('div');
    const seen = [];
    const observer = new IntersectionObserver(entries => seen.push(entries.map(e => e.isIntersecting)));
    observer.observe(target);
    observer.observe(target);
    observer.trigger([{target, isIntersecting: false}, {target: other, isIntersecting: true}]);
    assert.deepEqual(seen, []);
    await Promise.resolve();
    assert.deepEqual(seen, [[false]]);
    observer.trigger([{target, isIntersecting: true}]);
    await Promise.resolve();
    assert.deepEqual(seen, [[false], [true]]);
    observer.unobserve(target);
    observer.trigger([{target, isIntersecting: false}]);
    await Promise.resolve();
    assert.equal(seen.length, 2);
    assert.throws(() => observer.trigger(), /not modelled/);
});

test('the shared fake refuses CSS motion and computed background transitions', () => {
    const {Element, loadModule} = require('./fakes.cjs');
    const host = new Element('div');
    host.style.scrollBehavior = 'smooth';
    assert.throws(() => { host.scrollTop = 500; }, /not modelled/);
    host.style.scrollBehavior = 'auto';
    host.scrollTop = 500;
    assert.equal(host.scrollTop, 500);
    const loaded = loadModule({file: 'paste/ui/utilities/mediaquery.js', name: 'paste.ui.utilities.mediaquery', deps: [], impls: []});
    assert.throws(() => loaded.window.scrollTo(0, 500), /not modelled/);
    host.style.transition = 'background-image .2s';
    assert.throws(() => loaded.window.getComputedStyle(host).getPropertyValue('background-image'), /not modelled/);
});

// DOM observe() rejects contradictory options even if childList is enabled.
// Browser counterpart: "platform mutation and intersection delivery contracts".
test('MutationObserver rejects explicitly disabled attributes with attribute options', () => {
    const {Element, mutationObserverRegistry} = require('./fakes.cjs');
    const {MutationObserver} = mutationObserverRegistry();
    const observer = new MutationObserver(() => {});
    const element = new Element('img');
    for (const attributeOption of [{attributeFilter: ['src']}, {attributeOldValue: true}]) {
        assert.throws(() => observer.observe(element, {childList: true, attributes: false, ...attributeOption}), TypeError);
    }
    assert.doesNotThrow(() => observer.observe(element, {attributeFilter: ['src']}));
    observer.disconnect();
});

test('element connection follows membership while ownerDocument survives detachment', () => {
    const {Element, openUiStack} = require('./fakes.cjs');
    const parent = new Element('div', 'parent'), child = new Element('img', 'child');
    parent.appendChild(child);
    const stack = openUiStack({elements: {parent}});
    assert.equal(child.isConnected, true);
    assert.equal(child.ownerDocument, stack.document);
    parent.removeChild(child);
    assert.equal(child.isConnected, false);
    assert.equal(child.ownerDocument, stack.document);
    stack.document.body.appendChild(child);
    assert.equal(child.isConnected, true);
});
