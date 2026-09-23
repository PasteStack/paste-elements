const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
    const listeners = new Map();
    const observers = [];
    const frames = new Map();
    const scheduled = [];
    const cancelled = [];
    let frameId = 0;
    function flushFrames() {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(fn => fn());
    }
    const style = () => {
        const values = new Map();
        return {
            getPropertyValue: key => values.get(key)?.value || '',
            getPropertyPriority: key => values.get(key)?.priority || '',
            setProperty: (key, value, priority = '') => values.set(key, {value: String(value), priority}),
            removeProperty: key => values.delete(key)
        };
    };
    function element(className, width, height = 80) {
        const attributes = new Map();
        const el = {
            className, style: style(), children: [], parentElement: undefined,
            hidden: false, disabled: false, textContent: '',
            clientWidth: width,
            getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
            hasAttribute: key => attributes.has(key),
            setAttribute: (key, value) => attributes.set(key, String(value)),
            removeAttribute: key => attributes.delete(key),
            matches: selector => selector === '.' + className,
            querySelector: () => null,
            contains(node) { return node === el || el.children.includes(node); },
            getBoundingClientRect() { return {width: el.clientWidth, height}; },
            addEventListener(type, fn) { listeners.set(el.className + ':' + type, fn); },
            removeEventListener(type, fn) {
                const key = el.className + ':' + type;
                if (listeners.get(key) === fn) listeners.delete(key);
            }
        };
        return el;
    }
    const root = element('paste-ui-marquee', options.width || 600);
    root.setAttribute('data-paste-marquee', '');
    root.setAttribute('data-paste-marquee-duration', options.duration === undefined ? '45' : options.duration);
    const list = element('paste-ui-marquee-items', root.clientWidth);
    const toggle = element('paste-ui-marquee-toggle', 100);
    toggle.hidden = toggle.disabled = true;
    toggle.textContent = 'Pause motion';
    list.children = Array.from({length: options.count ?? 6}, () => element('paste-ui-marquee-item', 200));
    list.children.forEach(item => { item.parentElement = list; });
    if (options.interactive) list.children[0].querySelector = () => ({});
    root.children = [list, toggle];
    list.parentElement = toggle.parentElement = root;
    root.querySelector = selector => ({'.paste-ui-marquee-items': list, '.paste-ui-marquee-toggle': toggle}[selector] || null);
    root.contains = node => root.children.includes(node) || list.children.includes(node);
    const media = {
        matches: !!options.reduced,
        addEventListener(type, fn) { listeners.set('media:' + type, fn); },
        removeEventListener(type) { listeners.delete('media:' + type); }
    };
    const document = {
        activeElement: null,
        querySelectorAll: () => (options.autoInit === false ? [] : [root])
    };
    const window = {
        WeakMap,
        CSS: {supports: () => true},
        getComputedStyle: () => ({columnGap: '16px'}),
        matchMedia: () => media,
        requestAnimationFrame(fn) {
            frameId += 1;
            frames.set(frameId, fn);
            scheduled.push(frameId);
            return frameId;
        },
        cancelAnimationFrame(id) {
            if (frames.delete(id)) {
                cancelled.push(id);
            }
        },
        ResizeObserver: function (fn) {
            const targets = new Set();
            const observer = {
                callback: fn,
                targets,
                observe(target) { targets.add(target); },
                unobserve(target) { targets.delete(target); },
                disconnect() { targets.clear(); }
            };
            observers.push(observer);
            return observer;
        }
    };
    if (options.unsupported) window.ResizeObserver = undefined;
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/marquee/marquee.js'), 'utf8'), {
        window, document, WeakMap, isFinite, Number, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.marquee');
            assert.equal(deps.length, 0);
            factory(exports);
        }}
    });
    // Roots present when the module runs are initialized during evaluation.
    return {root, list, toggle, media, document, exports, listeners, observers, element, frames, scheduled, cancelled, flushFrames};
}

test('one original per item, idempotent initialization, CSS geometry and offscreen endpoints', () => {
    const f = fixture();
    const originals = f.list.children.slice();
    const control = f.exports.init(f.root);
    assert.equal(f.exports.init(f.root), control);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.deepEqual(f.list.children, originals);
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-item-size'), '200px');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '45s');
    assert.equal(f.toggle.hidden, false);
    const delays = originals.map(item => parseFloat(item.style.getPropertyValue('--paste-marquee-delay')));
    assert.equal(new Set(delays).size, originals.length);
    delays.forEach((delay, i) => {
        const x = 1296 - 200 + delay / 45 * 1296;
        assert.ok(Math.abs(x - i * 216) < 0.000001);
    });
    assert.equal(f.observers.length, 1);
});

test('pause restores readable layout; resume re-enables CSS motion', () => {
    const f = fixture();
    const control = f.exports.init(f.root);
    control.pause();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
    assert.equal(f.toggle.textContent, 'Resume motion');
    control.resume();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    f.listeners.get('paste-ui-marquee-toggle:click')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
});

test('reduced motion reacts live and keeps the user pause preference', () => {
    const f = fixture();
    const control = f.exports.init(f.root);
    control.pause();
    f.media.matches = true;
    f.listeners.get('media:change')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.hidden, true);
    f.media.matches = false;
    f.listeners.get('media:change')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
});

for (const [name, options] of Object.entries({
    empty: {count: 0}, single: {count: 1}, short: {count: 2},
    reduced: {reduced: true}, interactive: {interactive: true},
    unavailableObserver: {unsupported: true}, invalidDuration: {duration: 'NaN'},
    infiniteDuration: {duration: 'Infinity'}, negativeDuration: {duration: '-1'}
})) {
    test(name + ' keeps a static usable list without cloning', () => {
        const f = fixture(options);
        const originals = f.list.children.slice();
        f.exports.init(f.root);
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
        assert.equal(f.toggle.hidden, true);
        assert.deepEqual(f.list.children, originals);
    });
}

test('resize changes eligibility without writing every-frame positions', () => {
    const f = fixture();
    f.exports.init(f.root);
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.list.clientWidth = 600;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('a resize notification refreshes on the next frame, not synchronously', () => {
    const f = fixture();
    f.exports.init(f.root);
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
});

test('notifications before the frame runs coalesce into one refresh', () => {
    const f = fixture();
    f.exports.init(f.root);
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    f.observers[0].callback();
    f.observers[0].callback();
    assert.equal(f.scheduled.length, 1);
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.flushFrames();
    assert.equal(f.scheduled.length, 1);
});

test('dispose cancels a pending resize refresh', () => {
    const f = fixture();
    const control = f.exports.init(f.root);
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    control.dispose();
    assert.deepEqual(f.cancelled, [f.scheduled[0]]);
    f.flushFrames();
    assert.equal(f.root.hasAttribute('data-paste-marquee-state'), false);
});

test('a notification after dispose schedules nothing', () => {
    const f = fixture();
    const control = f.exports.init(f.root);
    control.dispose();
    f.observers[0].callback();
    assert.equal(f.scheduled.length, 0);
    assert.equal(f.frames.size, 0);
});

test('refresh owns only its properties and disposal restores originals and subscriptions', () => {
    // autoInit: false keeps init manual so the owned-property snapshot happens
    // after the important inline value is in place.
    const f = fixture({autoInit: false});
    const first = f.list.children[0];
    first.style.setProperty('--paste-marquee-delay', '12s', 'important');
    f.list.style.setProperty('color', 'red');
    const control = f.exports.init(f.root);
    const removed = f.list.children.pop();
    control.refresh();
    assert.equal(removed.style.getPropertyValue('--paste-marquee-delay'), '');
    assert.equal(f.observers[0].targets.has(removed), false);
    control.dispose();
    control.dispose();
    assert.equal(first.style.getPropertyValue('--paste-marquee-delay'), '12s');
    assert.equal(first.style.getPropertyPriority('--paste-marquee-delay'), 'important');
    assert.equal(f.list.style.getPropertyValue('color'), 'red');
    assert.equal(f.root.hasAttribute('data-paste-marquee-state'), false);
    assert.equal(f.toggle.hidden, true);
    // Every listener the controller registered is gone. The module's own
    // document-ready listener is not the controller's to remove.
    assert.deepEqual(
        [...f.listeners.keys()].filter(key => !key.startsWith('document:')),
        []
    );
    assert.equal(f.observers[0].targets.size, 0);
    control.resume();
    assert.equal(f.root.hasAttribute('data-paste-marquee-state'), false);
    assert.notEqual(f.exports.init(f.root), control);
});

test('focus in original content switches back to an accessible static layout', () => {
    const f = fixture();
    f.exports.init(f.root);
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
});

test('leaving focus re-evaluates eligibility instead of holding a pause nobody chose', () => {
    const f = fixture();
    const control = f.exports.init(f.root);
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.document.activeElement = null;
    f.listeners.get('paste-ui-marquee-items:focusout')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.toggle.textContent, 'Pause motion');
    // A pause the user asked for still survives a focus visit.
    control.pause();
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    f.document.activeElement = null;
    f.listeners.get('paste-ui-marquee-items:focusout')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
    assert.equal(f.toggle.textContent, 'Resume motion');
});

test('roots present when the module runs are initialized at module evaluation', () => {
    const f = fixture();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.observers.length, 1);
    assert.equal(typeof f.listeners.get('paste-ui-marquee-toggle:click'), 'function');
    f.exports.init(f.root);
    assert.equal(f.observers.length, 1);
});

test('owned important geometry and delays are removed before replacement and restored on disposal', () => {
    // autoInit: false so init snapshots these important values as pre-existing.
    const f = fixture({autoInit: false});
    f.list.style.setProperty('--paste-marquee-distance', '9px', 'important');
    f.list.children[0].style.setProperty('--paste-marquee-delay', '7s', 'important');
    const control = f.exports.init(f.root);
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px');
    assert.equal(f.list.style.getPropertyPriority('--paste-marquee-distance'), '');
    assert.ok(parseFloat(f.list.children[0].style.getPropertyValue('--paste-marquee-delay')) < 0);
    assert.equal(f.list.children[0].style.getPropertyPriority('--paste-marquee-delay'), '');
    control.dispose();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '9px');
    assert.equal(f.list.style.getPropertyPriority('--paste-marquee-distance'), 'important');
    assert.equal(f.list.children[0].style.getPropertyValue('--paste-marquee-delay'), '7s');
    assert.equal(f.list.children[0].style.getPropertyPriority('--paste-marquee-delay'), 'important');
});
