const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource, loadModule, frameDriver} = require('./fakes.cjs');

function fixture(options = {}) {
    const listeners = new Map();
    const observers = [];
    const mutations = [];
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
        return {
            className, style: style(), children: [], parentElement: undefined,
            // The platform's parentNode and parentElement agree for an
            // element child — the module judges membership by parentNode.
            get parentNode() { return this.parentElement; },
            nodeType: 1,
            hidden: false, disabled: false, textContent: '', isConnected: true,
            clientWidth: width,
            // Layout width: transforms never reach it.
            get offsetWidth() { return this.clientWidth; },
            getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
            hasAttribute: key => attributes.has(key),
            setAttribute: (key, value) => attributes.set(key, String(value)),
            removeAttribute: key => attributes.delete(key),
            matches: selector => selector === '.' + className,
            querySelector: () => null,
            contains(node) { return node === this || this.children.includes(node); },
            // In-flow geometry: items sit in one row at the authored gap
            // (or wrap one per row when options.wrapped); the running
            // layout stacks every item at the list's start, so their
            // boxes carry no gap at all. options.scale is an ancestor
            // transform: every rectangle is drawn at that scale.
            getBoundingClientRect() {
                const parent = this.parentElement;
                const index = parent && parent.children ? parent.children.indexOf(this) : 0;
                const gap = options.layoutGap === undefined ? 16 : options.layoutGap;
                const runningLayout = parent && parent.parentElement &&
                    parent.parentElement.getAttribute('data-paste-marquee-state') === 'running';
                const step = runningLayout ? 0 : this.clientWidth + gap;
                const left = options.wrapped ? 0 : index * step;
                const top = options.wrapped && !runningLayout ? index * (height + gap) : 0;
                const k = options.scale || 1;
                return {width: this.clientWidth * k, height: height * k, left: left * k,
                    right: (left + this.clientWidth) * k, top: top * k};
            },
            addEventListener(type, fn) { listeners.set(this.className + ':' + type, fn); },
            removeEventListener(type, fn) {
                const key = this.className + ':' + type;
                if (listeners.get(key) === fn) listeners.delete(key);
            }
        };
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
        readyState: options.readyState || 'loading',
        activeElement: null,
        documentElement: element('html', 0),
        querySelectorAll: () => [root],
        addEventListener(type, fn) { listeners.set('document:' + type, fn); },
        removeEventListener(type, fn) {
            if (listeners.get('document:' + type) === fn) listeners.delete('document:' + type);
        }
    };
    const frames = frameDriver();
    const window = {
        WeakMap,
        CSS: {supports: () => true},
        getComputedStyle: () => ({columnGap: options.columnGap === undefined ? '16px' : options.columnGap,
            paddingLeft: options.paddingLeft || '0px', paddingRight: options.paddingRight || '0px'}),
        matchMedia: () => media,
        ResizeObserver: class {
            constructor(fn) { this.callback = fn; this.targets = new Set(); observers.push(this); }
            observe(target) { this.targets.add(target); }
            unobserve(target) { this.targets.delete(target); }
            disconnect() { this.targets.clear(); }
        },
        MutationObserver: class {
            constructor(fn) { this.callback = fn; this.watches = []; mutations.push(this); }
            observe(target, opts) { this.watches.push({target, opts}); }
            disconnect() { this.watches = []; }
        }
    };
    if (options.unsupported) window.ResizeObserver = undefined;
    if (options.css !== undefined) window.CSS = options.css;
    if (options.matchMediaThrows) {
        window.matchMedia = () => { throw new Error('matchMedia poisoned'); };
    }
    if (options.observerThrows) {
        window.ResizeObserver = class {
            constructor() { throw new Error('observer poisoned'); }
        };
    }
    if (options.observeListThrows) {
        const RO = window.ResizeObserver;
        let listThrew = false;
        window.ResizeObserver = class extends RO {
            observe(target) {
                if (!listThrew && target.className === 'paste-ui-marquee-items') {
                    listThrew = true;
                    throw new Error('observe poisoned');
                }
                super.observe(target);
            }
        };
    }
    if (options.observeItemThrows) {
        const RO = window.ResizeObserver;
        let itemThrew = false;
        window.ResizeObserver = class extends RO {
            observe(target) {
                if (!itemThrew && target.className === 'paste-ui-marquee-item') {
                    itemThrew = true;
                    throw new Error('observe poisoned');
                }
                super.observe(target);
            }
        };
    }
    if (options.mutationObserveThrows) {
        const MO = window.MutationObserver;
        window.MutationObserver = class extends MO {
            observe() { throw new Error('mutation observe poisoned'); }
        };
    }
    if (options.mutationObserveThrowsOnList) {
        const MO = window.MutationObserver;
        window.MutationObserver = class extends MO {
            observe(target, opts) {
                if (target === list) { throw new Error('mutation observe poisoned'); }
                super.observe(target, opts);
            }
        };
    }
    if (options.observePoison) {
        // A refusal armed after binding: the first root observes its
        // children cleanly, a later append is refused.
        const RO = window.ResizeObserver;
        window.ResizeObserver = class extends RO {
            observe(target) {
                if (options.observePoison.armed && target.className === 'paste-ui-marquee-item') {
                    throw new Error('observe poisoned');
                }
                super.observe(target);
            }
        };
    }
    if (options.legacyMedia) {
        // An older engine's MediaQueryList: only the addListener pair.
        delete media.addEventListener;
        delete media.removeEventListener;
        media.addListener = fn => { listeners.set('media:change', fn); };
        media.removeListener = () => { listeners.delete('media:change'); };
    }
    if (options.silentMedia) {
        // A query result that offers no way to hear a change.
        delete media.addEventListener;
        delete media.removeEventListener;
    }
    if (options.cancelFrameNoop) {
        // The cancellation never lands — the queued frame still runs,
        // so only the retired binding's own guards keep it inert.
        frames.cancel = () => {};
    }
    if (options.mediaAddThrows) {
        media.addEventListener = () => { throw new Error('media subscribe poisoned'); };
    }
    if (options.mediaRemoveThrows) {
        media.removeEventListener = () => { throw new Error('media unsubscribe poisoned'); };
    }
    if (options.cssThrows) {
        window.CSS = {supports: () => { throw new Error('supports poisoned'); }};
    }
    const roots = [root];
    if (options.twin) {
        const root2 = element('paste-ui-marquee', 600);
        root2.setAttribute('data-paste-marquee', '');
        root2.setAttribute('data-paste-marquee-duration', '45');
        const list2 = element('paste-ui-marquee-items', 600);
        const toggle2 = element('paste-ui-marquee-toggle', 100);
        list2.children = Array.from({length: 6}, () => element('paste-ui-marquee-item', 200));
        list2.children.forEach(item => { item.parentElement = list2; });
        root2.children = [list2, toggle2];
        list2.parentElement = toggle2.parentElement = root2;
        root2.querySelector = selector => ({'.paste-ui-marquee-items': list2, '.paste-ui-marquee-toggle': toggle2}[selector] || null);
        roots.push(root2);
    }
    if (options.firstRootThrows) {
        // A root whose markup read throws partway through its bind.
        root.querySelector = () => { throw new Error('querySelector poisoned'); };
    }
    document.querySelectorAll = () => roots;
    const exports = {};
    const subscriptions = [];
    const event = {
        DocumentEvent: {loaded: fn => { subscriptions.push(fn); }},
        Event: {Subscription: function (type, target, handler) {
            target.addEventListener(type, handler);
            // Core's Subscription disposes through dispose (remove is
            // its alias) — the module calls dispose directly.
            this.dispose = this.remove = () => target.removeEventListener(type, handler);
        }}
    };
    // Authored state a test plants must exist before the module defines:
    // the footer convention means markup — and its styles — precede the
    // module, and define is when initialization reads them.
    if (options.beforeDefine) { options.beforeDefine({root, list, toggle}); }
    // The real shared MediaQueryList binding over this page's matchMedia.
    const mediaquery = loadModule({
        file: 'paste/ui/utilities/mediaquery.js',
        name: 'paste.ui.utilities.mediaquery',
        deps: [], impls: [],
        window: {matchMedia: window.matchMedia}
    }).module;
    vm.runInNewContext(readModuleSource('paste/ui/marquee.js'), {
        window, document, isFinite, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.marquee');
            assert.equal(deps.join('|'), 'paste.event|paste.ui.utilities.animation-frame|paste.ui.utilities.mediaquery');
            factory(exports, event, frames, mediaquery);
        }}
    });
    let frameTime = 0;
    const flushFrames = () => {
        let guard = 0;
        while (frames.pending() && guard < 10) {
            guard += 1;
            frameTime += 16;
            frames.tick(frameTime);
        }
    };
    // The bind-time measurement runs on the first frame after define.
    if (!options.deferFirstFrame) { flushFrames(); }
    return {
        root, list, toggle, media, document, exports, listeners, observers,
        mutations, subscriptions, element, frames, flushFrames,
        // A child-list delivery names exactly what changed — the module
        // processes the records' own node lists, nothing else.
        // The refresh a mutation asks for waits for a frame like a
        // resize — the helper delivers the record and runs the frame.
        mutate: (added, removed) => {
            mutations[0].callback([{
                type: 'childList', target: list,
                addedNodes: added || [], removedNodes: removed || []
            }]);
            flushFrames();
        },
        // Several records in one delivery, in DOM-mutation order.
        mutateRecords: records => {
            mutations[0].callback(records.map(r => ({
                type: 'childList', target: list,
                addedNodes: r.added || [], removedNodes: r.removed || []
            })));
            flushFrames();
        }
    };
}

test('the module exposes no imperative surface — markup alone binds the list', () => {
    const f = fixture();
    assert.deepEqual(Object.keys(f.exports), []);
    assert.equal(f.exports.init, undefined);
});

test('one original per item, CSS geometry and offscreen endpoints', () => {
    const f = fixture();
    const originals = f.list.children.slice();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.deepEqual(f.list.children, originals);
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-item-size'), '200px');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '45s');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-row-height'), '80px');
    assert.equal(f.toggle.disabled, false);
    assert.equal(f.toggle.hidden, false);
    const delays = originals.map(item => parseFloat(item.style.getPropertyValue('--paste-marquee-delay')));
    assert.equal(new Set(delays).size, originals.length);
    delays.forEach((delay, i) => {
        const x = 1296 - 200 + delay / 45 * 1296;
        assert.ok(Math.abs(x - i * 216) < 0.000001);
    });
    assert.equal(f.observers.length, 1);
});

test('the authored toggle pauses and resumes the motion', () => {
    const f = fixture();
    const click = f.listeners.get('paste-ui-marquee-toggle:click');
    click();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
    assert.equal(f.toggle.textContent, 'Resume motion');
    click();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    click();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
});

test('reduced motion reacts live and keeps the user pause preference', () => {
    const f = fixture();
    f.listeners.get('paste-ui-marquee-toggle:click')();
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
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
        assert.equal(f.toggle.hidden, true);
        assert.deepEqual(f.list.children, originals);
    });
}

test('resize changes eligibility without writing every-frame positions', () => {
    const f = fixture();
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.list.clientWidth = 600;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('a burst of resize notifications coalesces into one remeasure', () => {
    const f = fixture();
    f.observers[0].callback();
    f.observers[0].callback();
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1,
        'three resize deliveries enqueued three refreshes');
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('list mutations re-measure declaratively — and only the list is watched', () => {
    const f = fixture();
    // The observer's whole world is this list's own children: no
    // document subtree, no attribute command channel.
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].watches.length, 1,
        'the module observes more than one surface');
    assert.equal(f.mutations[0].watches[0].target, f.list,
        'the observed surface is not the marquee list');
    // The opts literal is constructed inside the module's vm realm — its
    // prototype is not this realm's, so compare the flags, not the object.
    assert.equal(f.mutations[0].watches[0].opts.childList, true,
        'the watch does not cover list children');
    assert.equal(Object.keys(f.mutations[0].watches[0].opts).length, 1,
        'the watch reaches beyond direct list children');
    // Appended content joins the measurement set without any imperative call.
    const extra = f.element('paste-ui-marquee-item', 200);
    extra.parentElement = f.list;
    f.list.children.push(extra);
    f.mutate([extra]);
    assert.ok(parseFloat(extra.style.getPropertyValue('--paste-marquee-delay')) < 0,
        'appended item was never assigned a stagger delay');
    assert.equal(f.observers[0].targets.has(extra), true,
        'appended item is not observed for resizes');
    // Removed content leaves the measurement set.
    f.list.children.pop();
    f.mutate([], [extra]);
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px',
        'a removed item stayed in the measured distance');
});

test('a removed item leaves the ResizeObserver target set and loses its owned delay', () => {
    const f = fixture();
    const removed = f.list.children[f.list.children.length - 1];
    assert.ok(f.observers[0].targets.has(removed));
    assert.notEqual(removed.style.getPropertyValue('--paste-marquee-delay'), '');
    f.list.children.pop();
    removed.parentElement = undefined;
    f.mutate([], [removed]);
    assert.equal(f.observers[0].targets.has(removed), false,
        'a removed item is still owned by the ResizeObserver');
    assert.equal(removed.style.getPropertyValue('--paste-marquee-delay'), '',
        'a removed item kept the module-owned delay');
});

test('repeated append/remove churn keeps observer ownership bounded', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
        const extra = f.element('paste-ui-marquee-item', 200);
        extra.parentElement = f.list;
        f.list.children.push(extra);
        f.mutate([extra]);
        assert.equal(f.observers[0].targets.size, f.list.children.length + 1,
            'observer targets diverged from membership after append ' + i);
        f.list.children.pop();
        extra.parentElement = undefined;
        f.mutate([], [extra]);
        assert.equal(f.observers[0].targets.size, f.list.children.length + 1,
            'observer targets diverged from membership after removal ' + i);
    }
    assert.equal(f.observers[0].targets.size, 7,
        'churn accumulated stale observed targets');
});

test('a reinserted item is re-observed and re-measured', () => {
    const f = fixture();
    const item = f.list.children[f.list.children.length - 1];
    f.list.children.pop();
    item.parentElement = undefined;
    f.mutate([], [item]);
    assert.equal(f.observers[0].targets.has(item), false);
    item.parentElement = f.list;
    f.list.children.push(item);
    f.mutate([item]);
    assert.equal(f.observers[0].targets.has(item), true,
        'a reinserted item was not re-observed');
    assert.ok(parseFloat(item.style.getPropertyValue('--paste-marquee-delay')) < 0,
        'a reinserted item was not assigned a stagger delay');
});

test('removing one item does not disturb the remaining observed items', () => {
    const f = fixture();
    const removed = f.list.children[0];
    const rest = f.list.children.slice(1);
    f.list.children.splice(0, 1);
    removed.parentElement = undefined;
    f.mutate([], [removed]);
    assert.equal(f.observers[0].targets.has(removed), false);
    rest.forEach(item => assert.ok(f.observers[0].targets.has(item),
        'a remaining item lost its observation'));
    assert.ok(f.observers[0].targets.has(f.list),
        'the list itself lost its observation');
});

test('a permanently unsupported capability installs no ongoing work', () => {
    const f = fixture({unsupported: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.hidden, true);
    assert.equal(f.observers.length, 0,
        'an unsupported marquee created a ResizeObserver');
    assert.equal(f.mutations.length, 0,
        'an unsupported marquee created a MutationObserver');
    assert.equal(f.listeners.size, 0,
        'an unsupported marquee still bound listeners');
});

test('no observer is registered on the document', () => {
    const f = fixture();
    const watched = f.mutations.flatMap(m => m.watches.map(w => w.target));
    assert.ok(!watched.includes(f.document.documentElement),
        'a whole-document subtree observer was registered');
    assert.ok(watched.every(target => target === f.list),
        'an observer reached outside its own list');
});

test('the binding is page-lifetime — detaching the root unwires nothing', () => {
    const f = fixture();
    // Element bindings live as long as the page does; a detached root is
    // the application's to manage, not the module's lifecycle problem.
    f.root.isConnected = false;
    f.mutations[0].callback([{type: 'childList', target: f.list}]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.mutations[0].watches.length, 1,
        'a mutation detached the module from its own list');
});

test('focus in original content switches back to an accessible static layout', () => {
    const f = fixture();
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
});

test('leaving focus re-evaluates eligibility instead of holding a pause nobody chose', () => {
    const f = fixture();
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.document.activeElement = null;
    f.listeners.get('paste-ui-marquee-items:focusout')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.toggle.textContent, 'Pause motion');
    // A pause the user asked for still survives a focus visit.
    f.listeners.get('paste-ui-marquee-toggle:click')();
    f.document.activeElement = f.list.children[0];
    f.listeners.get('paste-ui-marquee-items:focusin')();
    f.document.activeElement = null;
    f.listeners.get('paste-ui-marquee-items:focusout')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'paused');
    assert.equal(f.toggle.textContent, 'Resume motion');
});

test('binding is immediate at define and the first measurement runs on the next frame', () => {
    const f = fixture({deferFirstFrame: true});
    // The module binds whatever declarations exist at define time;
    // there is no parse event to wait for and no readiness surface.
    assert.equal(f.listeners.get('document:DOMContentLoaded'), undefined);
    assert.equal(f.observers.length, 1);
    assert.ok(f.listeners.get('paste-ui-marquee-toggle:click'), 'the toggle was not bound at define');
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), null,
        'the define measured and wrote inside its own turn');
    assert.equal(f.frames.pending(), 1, 'the define did not arm one frame');
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('a scheduled refresh reads in the read phase and writes in the write phase', () => {
    const f = fixture({deferFirstFrame: true});
    const log = [];
    let phase = 'outside';
    f.frames.onPhase = name => { phase = name; };
    const box = f.list.children[0].getBoundingClientRect;
    f.list.children[0].getBoundingClientRect = function () {
        log.push('read:' + phase);
        return box.call(this);
    };
    const setAttribute = f.root.setAttribute;
    f.root.setAttribute = (key, value) => {
        log.push('write:' + phase);
        setAttribute(key, value);
    };
    f.flushFrames();
    assert.deepEqual([...new Set(log)], ['read:read', 'write:write'],
        'a frame refresh mixed its reads and writes across phases');
});

test('late-loaded module initializes even after the shared load event fired', () => {
    const f = fixture({readyState: 'complete'});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.subscriptions.length, 0);
    assert.equal(f.observers.length, 1);
});

test('authored important geometry and delays are replaced with owned plain values', () => {
    const f = fixture({beforeDefine: ({list}) => {
        list.style.setProperty('--paste-marquee-distance', '9px', 'important');
        list.children[0].style.setProperty('--paste-marquee-delay', '7s', 'important');
    }});
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px');
    assert.equal(f.list.style.getPropertyPriority('--paste-marquee-distance'), '');
    assert.ok(parseFloat(f.list.children[0].style.getPropertyValue('--paste-marquee-delay')) < 0);
    assert.equal(f.list.children[0].style.getPropertyPriority('--paste-marquee-delay'), '');
});

// CSS present but supports missing: the probe answers "unsupported",
// never throws TypeError and leaves the authored page half-bound.
test('CSS without a callable supports leaves the authored static state', () => {
    const f = fixture({css: {}});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.disabled, true, 'a dead toggle must not invite clicks');
    assert.equal(f.observers.length, 0, 'an unsupported marquee observes anyway');
    assert.equal(f.subscriptions.length, 0, 'an unsupported marquee subscribes anyway');
});

test('a throwing CSS.supports answers unsupported the same way', () => {
    const f = fixture({cssThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.observers.length, 0);
});

test('a throwing matchMedia probe leaves the authored static state', () => {
    const f = fixture({matchMediaThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.disabled, true);
    assert.equal(f.observers.length, 0);
});

test('a throwing ResizeObserver constructor falls back to static', () => {
    const f = fixture({observerThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.disabled, true);
});

test('a refused observation on one item returns the root to static', () => {
    // Motion eligibility requires observing every moving child — a
    // refused observation means geometry could go stale unseen, so the
    // whole binding stands down rather than run half-covered.
    const f = fixture({observeItemThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.hidden, true,
        'a binding that stood down left its pause control enabled');
    assert.equal(f.listeners.get('paste-ui-marquee-toggle:click'), undefined,
        'a binding that stood down left a click listener bound');
});

test('a throwing observe on the list itself unwinds every earlier claim', () => {
    const f = fixture({observeListThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.toggle.hidden, true);
    assert.equal(f.listeners.size, 0,
        'a failed bind left subscriptions behind');
    assert.equal(f.observers[0].targets.size, 0,
        'a failed bind left observation claims behind');
});

test('a throwing mutation registration unwinds observer, media and subscriptions', () => {
    const f = fixture({mutationObserveThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.listeners.size, 0,
        'a failed registration left listeners subscribed');
    assert.equal(f.observers[0].targets.size, 0,
        'a failed registration left the list observed');
});

test('a throwing media-listener registration leaves the root static and clean', () => {
    const f = fixture({mediaAddThrows: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.listeners.size, 0);
    assert.equal(f.observers.length, 0,
        'an unobservable preference still built observers');
});

test('one root\'s failed setup does not stop a later root binding', () => {
    const f = fixture({observeListThrows: true, twin: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    const twin = f.document.querySelectorAll('[data-paste-marquee]')[1];
    assert.equal(twin.getAttribute('data-paste-marquee-state'), 'running',
        'a sibling root never bound after the first root failed');
});

test('a queued refresh cannot revive a binding teardown retired', () => {
    // A frame refresh is already queued when coverage fails and the
    // cancellation never lands, so only the retired binding's own
    // guards keep that delivery inert — it must never mark the root
    // running or enable a listenerless toggle.
    const poison = {armed: false};
    const f = fixture({observePoison: poison, cancelFrameNoop: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running',
        'precondition: the marquee never ran');
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1, 'precondition: no refresh was queued');
    poison.armed = true;
    const extra = f.element('paste-ui-marquee-item', 200);
    extra.parentElement = f.list;
    f.list.children.push(extra);
    f.mutate([extra]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static',
        'a queued refresh revived a dead binding');
    assert.equal(f.toggle.hidden, true,
        'a queued refresh re-enabled a control with no listener');
});

test('a newer delay writer survives its item leaving the list', () => {
    // The surrender only takes back the declaration it wrote: a
    // stylesheet-managed value installed after the last owned write —
    // priority included — stays on the departing item untouched.
    const f = fixture();
    const removed = f.list.children[f.list.children.length - 1];
    removed.style.setProperty('--paste-marquee-delay', '-7s', 'important');
    f.list.children.pop();
    removed.parentElement = undefined;
    f.mutate([], [removed]);
    assert.equal(removed.style.getPropertyValue('--paste-marquee-delay'), '-7s',
        'the surrender removed a newer writer\'s delay');
    assert.equal(removed.style.getPropertyPriority('--paste-marquee-delay'), 'important',
        'the surrender dropped a newer writer\'s priority');
});

test('records are judged forward by final membership — a moved item stays owned', () => {
    // One delivery can name the same node twice: removed, then added
    // back (a move within the list). Walking the records backwards
    // would process the add before the remove and drop the node.
    const f = fixture();
    const moved = f.list.children[2];
    f.mutateRecords([{removed: [moved]}, {added: [moved]}]);
    assert.equal(f.observers[0].targets.has(moved), true,
        'a node moved within the list lost its observation');
    assert.ok(parseFloat(moved.style.getPropertyValue('--paste-marquee-delay')) < 0,
        'a node moved within the list lost its owned delay');

    // Added then removed in one delivery: the node is gone, so it is
    // released however the records ordered it.
    const transient = f.element('paste-ui-marquee-item', 200);
    f.mutateRecords([{added: [transient]}, {removed: [transient]}]);
    assert.equal(f.observers[0].targets.has(transient), false,
        'a node no longer in the list stayed observed');
});

test('a child-list change measures on the next frame, never inside the delivery', () => {
    const f = fixture();
    const extra = f.element('paste-ui-marquee-item', 200);
    extra.parentElement = f.list;
    f.list.children.push(extra);
    f.mutations[0].callback([{type: 'childList', target: f.list, addedNodes: [extra], removedNodes: []}]);
    assert.equal(extra.style.getPropertyValue('--paste-marquee-delay'), '',
        'the mutation delivery measured synchronously');
    assert.equal(f.frames.pending(), 1, 'the mutation did not queue the frame refresh');
    // A resize arriving before the frame runs coalesces into it.
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1, 'resize and mutation queued two refreshes');
    f.flushFrames();
    assert.ok(parseFloat(extra.style.getPropertyValue('--paste-marquee-delay')) < 0,
        'the deferred refresh never measured the new item');
});

test('the duration attribute is re-read on every refresh', () => {
    const f = fixture();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '45s');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-row-height'), '80px');
    assert.equal(f.toggle.disabled, false);
    f.root.setAttribute('data-paste-marquee-duration', '30');
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '30s',
        'a changed duration was ignored at the next refresh');
    f.root.setAttribute('data-paste-marquee-duration', 'nope');
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static',
        'an invalid duration at refresh kept the list moving');
});

for (const value of ['0x2', '0b1', '1e1', '-5', '+5', '', ' 5']) {
    test('a non-decimal duration "' + value + '" keeps the list static', () => {
        const f = fixture({duration: value});
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    });
}

test('a decimal duration with a fraction animates', () => {
    const f = fixture({duration: '30.5'});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '30.5s');
});

test('a departing item gets its authored delay back, priority included', () => {
    const f = fixture({beforeDefine: ({list}) => {
        list.children[5].style.setProperty('--paste-marquee-delay', '7s', 'important');
    }});
    const item = f.list.children[5];
    assert.ok(parseFloat(item.style.getPropertyValue('--paste-marquee-delay')) < 0,
        'precondition: the module owns the delay');
    f.list.children.pop();
    item.parentElement = undefined;
    f.mutate([], [item]);
    assert.equal(item.style.getPropertyValue('--paste-marquee-delay'), '7s',
        'the authored delay value was not restored');
    assert.equal(item.style.getPropertyPriority('--paste-marquee-delay'), 'important',
        'the authored delay priority was not restored');
});

test('standing down returns the list geometry it owned', () => {
    const poison = {armed: false};
    const f = fixture({observePoison: poison, beforeDefine: ({list}) => {
        list.style.setProperty('--paste-marquee-duration', '9s', 'important');
    }});
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px',
        'precondition: geometry written');
    const first = f.list.children[0];
    poison.armed = true;
    const extra = f.element('paste-ui-marquee-item', 200);
    extra.parentElement = f.list;
    f.list.children.push(extra);
    f.mutate([extra]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    for (const name of ['--paste-marquee-distance', '--paste-marquee-item-size',
        '--paste-marquee-row-height']) {
        assert.equal(f.list.style.getPropertyValue(name), '',
            name + ' outlived the binding that owned it');
    }
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '9s',
        'the authored duration declaration was not restored');
    assert.equal(f.list.style.getPropertyPriority('--paste-marquee-duration'), 'important');
    assert.equal(first.style.getPropertyValue('--paste-marquee-delay'), '',
        'an item kept its owned delay after the binding stood down');
    assert.equal(f.listeners.size, 0, 'standing down releases every listener');
    assert.equal(f.observers[0].targets.size, 0, 'standing down releases every observed size');
    assert.equal(f.mutations[0].watches.length, 0, 'standing down releases mutation observation');
});

test('an addListener-only preference query still binds and reacts', () => {
    const f = fixture({legacyMedia: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running',
        'an older engine\'s observable preference left the list static');
    f.media.matches = true;
    f.listeners.get('media:change')();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static',
        'the legacy listener never delivered the preference change');
});

test('a preference query with no listener API keeps the list static', () => {
    const f = fixture({silentMedia: true});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static',
        'motion ran under a preference that could never be observed');
    assert.equal(f.observers.length, 0, 'an unobservable preference still built observers');
});

test('a media query whose removal throws cannot stop a later root binding', () => {
    // The first root stands down after its preference listener is
    // registered; the platform refuses the removal. Teardown must not
    // throw out of the define, and the sibling still binds.
    let f;
    assert.doesNotThrow(() => {
        f = fixture({observeListThrows: true, twin: true, mediaRemoveThrows: true});
    }, 'a refused preference removal escaped the define');
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    const twin = f.document.querySelectorAll('[data-paste-marquee]')[1];
    assert.equal(twin.getAttribute('data-paste-marquee-state'), 'running',
        'a sibling root never bound after the first root\'s removal threw');
});

test('a retired binding ignores a preference change its removal could not stop', () => {
    const poison = {armed: false};
    const f = fixture({observePoison: poison, mediaRemoveThrows: true});
    const change = f.listeners.get('media:change');
    poison.armed = true;
    const extra = f.element('paste-ui-marquee-item', 200);
    extra.parentElement = f.list;
    f.list.children.push(extra);
    f.mutate([extra]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    change();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static',
        'a preference change revived a retired binding');
});

test('a percentage gap is resolved, not read as pixels', () => {
    // The layout cannot show a gap here (one item per row), so the
    // computed 10% resolves against the 600px list: 60px.
    const f = fixture({wrapped: true, columnGap: '10%', layoutGap: 60});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 260) + 'px',
        'a percentage gap was read as px');
});

test('a percentage gap resolves against the content box, padding excluded', () => {
    const f = fixture({wrapped: true, columnGap: '10%', paddingLeft: '50px', paddingRight: '50px'});
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 250) + 'px');
});

test('the gap is measured from in-flow item geometry when the layout shows it', () => {
    // The computed value is an expression the module cannot resolve;
    // the boxes of the first two items say 24px.
    const f = fixture({columnGap: 'calc(1rem + 8px)', layoutGap: 24});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 224) + 'px',
        'the measured gap was not used');
    const delays = f.list.children.map(item => parseFloat(item.style.getPropertyValue('--paste-marquee-delay')));
    delays.forEach((delay, i) => {
        const x = 6 * 224 - 200 + delay / 45 * 6 * 224;
        assert.ok(Math.abs(x - i * 224) < 0.000001, 'item ' + i + ' delay ignores the measured gap');
    });
});

test('a refresh in the running layout does not mistake stacked boxes for a gap', () => {
    // Running, the items are absolutely positioned: their boxes say
    // nothing about the gap, so the resolved computed value stands in.
    const f = fixture();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px',
        'a running refresh measured the stacked layout as the gap');
});

test('an unresolvable gap with no in-flow measurement keeps the list static', () => {
    const f = fixture({wrapped: true, columnGap: 'calc(1rem + 8px)'});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
});

test('an authored important value equal to the owned one is still taken over plainly', () => {
    // Same value, different priority: the owned write must still land,
    // so the module's declaration is the plain one it records.
    const f = fixture({beforeDefine: ({list}) => {
        list.style.setProperty('--paste-marquee-distance', '1296px', 'important');
    }});
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), '1296px');
    assert.equal(f.list.style.getPropertyPriority('--paste-marquee-distance'), '',
        'an equal-valued important declaration kept its priority');
});

test('a newer writer with the same value but a priority keeps the declaration', () => {
    // Ownership is value and priority: an equal value re-declared
    // important by another writer is no longer the module's.
    const f = fixture();
    const removed = f.list.children[f.list.children.length - 1];
    const owned = removed.style.getPropertyValue('--paste-marquee-delay');
    removed.style.setProperty('--paste-marquee-delay', owned, 'important');
    f.list.children.pop();
    removed.parentElement = undefined;
    f.mutate([], [removed]);
    assert.equal(removed.style.getPropertyValue('--paste-marquee-delay'), owned,
        'the surrender removed a newer writer\'s equal-valued declaration');
    assert.equal(removed.style.getPropertyPriority('--paste-marquee-delay'), 'important');
});

test('an expression gap keeps its in-flow measurement while running', () => {
    // calc() and max() gaps resolve only through the in-flow layout;
    // the running layout hides them. Refreshes while running keep the
    // last measured gap instead of demoting the list every other frame.
    const f = fixture({columnGap: 'calc(1rem + 8px)', layoutGap: 24});
    const states = [];
    const setAttribute = f.root.setAttribute;
    f.root.setAttribute = (key, value) => {
        if (key === 'data-paste-marquee-state') { states.push(value); }
        setAttribute(key, value);
    };
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    for (let n = 0; n < 4; n += 1) {
        f.observers[0].callback();
        f.flushFrames();
    }
    assert.deepEqual(states, [], 'the running list changed state on refresh');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 224) + 'px',
        'the running refresh lost the measured gap');
});

test('an in-flow pitch wider than the computed gap holds the running state', () => {
    // Margins or distributed space widen the in-flow pitch past the
    // computed column gap: 3 x (200 + 70) fits a 600px list, 3 x
    // (200 + 16) would not. Both states test the fit against the same
    // measured pitch, so the list does not flip on every refresh.
    const f = fixture({count: 3, columnGap: '16px', layoutGap: 70});
    const states = [];
    const setAttribute = f.root.setAttribute;
    f.root.setAttribute = (key, value) => {
        if (key === 'data-paste-marquee-state') { states.push(value); }
        setAttribute(key, value);
    };
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    for (let n = 0; n < 4; n += 1) {
        f.observers[0].callback();
        f.flushFrames();
    }
    assert.deepEqual(states, [], 'the running list flipped state on refresh');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (3 * 270) + 'px');
});

test('a scheduled refresh coalesces until its frame runs, then re-arms', () => {
    const f = fixture();
    f.list.clientWidth = 1200;
    f.observers[0].callback();
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1);
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    f.list.clientWidth = 600;
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1, 'the first refresh left the binding marked scheduled');
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('a root whose bind throws does not stop a later root binding', () => {
    let f;
    assert.doesNotThrow(() => { f = fixture({firstRootThrows: true, twin: true}); },
        'one root\'s failure escaped the define');
    const twin = f.document.querySelectorAll('[data-paste-marquee]')[1];
    assert.equal(twin.getAttribute('data-paste-marquee-state'), 'running',
        'a later root never bound after an earlier root threw');
});

for (const value of ['.5', '4.']) {
    test('a decimal duration "' + value + '" animates', () => {
        const f = fixture({duration: value});
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
        assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), Number(value) + 's');
    });
}

test('a space-padded duration keeps the list static', () => {
    assert.equal(fixture({duration: '5 '}).root.getAttribute('data-paste-marquee-state'), 'static');
});

test('the running translation mirrors under a right-to-left direction', () => {
    const fs = require('fs');
    const path = require('path');
    const scss = fs.readFileSync(path.join(__dirname, '../modules/marquee/_mixin.scss'), 'utf8');
    const frames = /@keyframes paste-ui-marquee\s*\{([\s\S]*?)\n  \}/.exec(scss);
    assert.ok(frames, 'the keyframes are missing');
    const transforms = frames[1].match(/transform:[^;]*;/g);
    assert.equal(transforms.length, 2);
    transforms.forEach(t => assert.ok(/calc\(var\(--paste-marquee-inline-sign\) \*/.test(t),
        'a keyframe translates physically, ignoring the inline direction: ' + t));
    assert.ok(/\.paste-ui-marquee:dir\(rtl\)\s*\{\s*--paste-marquee-inline-sign: -1;/.test(scss),
        'no right-to-left sign under :dir(rtl)');
    assert.ok(/\[dir="rtl"\] \.paste-ui-marquee,[\s\S]*?--paste-marquee-inline-sign: -1;/.test(scss),
        'no dir-attribute fallback for engines without :dir()');
    assert.ok(/--paste-marquee-inline-sign: 1;/.test(scss), 'no left-to-right default sign');
});

test('an omitted duration uses the documented native CSS duration', () => {
    const f = fixture({beforeDefine: ({root}) => root.removeAttribute('data-paste-marquee-duration')});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-duration'), '45s');
});

for (const [gap, distance] of [['normal', '1200px'], ['16px', '1296px']]) {
    test('a wrapped list resolves its computed ' + gap + ' gap', () => {
        const f = fixture({wrapped: true, columnGap: gap});
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
        assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), distance);
    });
}

test('one delivery processes every added and removed node across multiple records', () => {
    const f = fixture();
    const removed = f.list.children.splice(0, 2);
    removed.forEach(item => { item.parentElement = undefined; });
    const added = [f.element('paste-ui-marquee-item', 200), f.element('paste-ui-marquee-item', 200)];
    added.forEach(item => { item.parentElement = f.list; f.list.children.push(item); });
    f.mutateRecords([{added}, {removed}]);
    removed.forEach(item => {
        assert.equal(f.observers[0].targets.has(item), false);
        assert.equal(item.style.getPropertyValue('--paste-marquee-delay'), '');
    });
    added.forEach(item => assert.equal(f.observers[0].targets.has(item), true));
});

test('a previously owned node already absent at delivery is released even in an added record', () => {
    const f = fixture();
    const removed = f.list.children.pop();
    removed.parentElement = undefined;
    f.mutate([removed]);
    assert.equal(f.observers[0].targets.has(removed), false);
    assert.equal(removed.style.getPropertyValue('--paste-marquee-delay'), '');
});

test('a refused observation from a removed record cancels pending work and leaves the root static', () => {
    const poison = {armed: false};
    const f = fixture({observePoison: poison});
    f.observers[0].callback();
    assert.equal(f.frames.pending(), 1);
    const item = f.element('paste-ui-marquee-item', 200);
    item.parentElement = f.list;
    f.list.children.push(item);
    poison.armed = true;
    f.mutations[0].callback([{type: 'childList', target: f.list, addedNodes: [], removedNodes: [item]}]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
    assert.equal(f.frames.pending(), 0, 'terminal teardown left its frame queued');
    assert.equal(f.toggle.hidden, true);
});

test('a mixed added-and-removed record releases every departing item', () => {
    const f = fixture();
    const removed = f.list.children.splice(0, 2);
    removed.forEach(item => { item.parentElement = undefined; });
    const added = [f.element('paste-ui-marquee-item', 200)];
    added[0].parentElement = f.list;
    f.list.children.push(added[0]);
    f.mutate(added, removed);
    removed.forEach(item => {
        assert.equal(f.observers[0].targets.has(item), false);
        assert.equal(item.style.getPropertyValue('--paste-marquee-delay'), '');
    });
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
});

test('an observer-construction refusal releases its media-query listener', () => {
    const f = fixture({observerThrows: true});
    assert.equal(f.listeners.has('media:change'), false);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
});

test('subpixel-equal items use the first item as the published width', () => {
    const f = fixture({beforeDefine({list}) { list.children[1].clientWidth = 200.005; }});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-item-size'), '200px');
});

test('a duplicate membership notification keeps a known item running', () => {
    const f = fixture({beforeDefine({list}) { list.children[0].style.setProperty('--paste-marquee-delay', '7s'); }});
    const item = f.list.children[0];
    f.mutate([item]);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.ok(f.observers[0].targets.has(item));
    f.list.children.shift();
    item.parentElement = undefined;
    f.mutate([], [item]);
    assert.equal(item.style.getPropertyValue('--paste-marquee-delay'), '7s');
});

for (const field of ['addedNodes', 'removedNodes']) {
    test('refused ' + field + ' observation ends the batch before later items can reacquire watches', () => {
        const f = fixture();
        const refused = f.element('paste-ui-marquee-item', 200);
        const later = f.element('paste-ui-marquee-item', 200);
        for (const item of [refused, later]) { item.parentElement = f.list; f.list.children.push(item); }
        const observe = f.observers[0].observe.bind(f.observers[0]);
        f.observers[0].observe = target => {
            if (target === refused) throw new Error('one target refused');
            observe(target);
        };
        const record = {addedNodes: [], removedNodes: []};
        record[field] = [refused, later];
        f.mutations[0].callback([record]);
        assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'static');
        assert.equal(f.observers[0].targets.size, 0);
    });
}

// The running layout hides the gap, so a running refresh carries the
// last in-flow gap forward by the computed gap's own change: a
// breakpoint that moves the authored gap while the list runs moves the
// running pitch with it — in either direction — and margins the
// in-flow pitch included stay included.
test('a running list follows a computed gap change', () => {
    const options = {columnGap: '16px', layoutGap: 16};
    const f = fixture(options);
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 216) + 'px');
    options.columnGap = '48px';
    options.layoutGap = 48;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 248) + 'px',
        'the running pitch kept the gap measured before the change');
    options.columnGap = '16px';
    options.layoutGap = 16;
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 216) + 'px',
        'the running pitch did not follow a shrinking gap');
});

test('a running list keeps in-flow margins when the computed gap changes', () => {
    // In flow the gap reads 70px: the 16px column gap plus 54px of
    // margins. A computed change to 32px makes it 86px.
    const options = {count: 3, columnGap: '16px', layoutGap: 70};
    const f = fixture(options);
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (3 * 270) + 'px');
    options.columnGap = '32px';
    f.observers[0].callback();
    f.flushFrames();
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (3 * 286) + 'px');
});

// An ancestor transform draws every rectangle scaled; the written
// geometry is the list's own layout pixels. The list's rendered width
// over its layout width undoes the scale.
test('geometry under a scaled ancestor is written in layout pixels', () => {
    const f = fixture({scale: 0.5});
    assert.equal(f.root.getAttribute('data-paste-marquee-state'), 'running');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-item-size'), '200px',
        'the item size was written at its rendered scale');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-row-height'), '80px');
    assert.equal(f.list.style.getPropertyValue('--paste-marquee-distance'), (6 * 216) + 'px',
        'the pitch was written at its rendered scale');
});
