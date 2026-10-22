'use strict';

// Shared doubles for the declarative modules' public-contract tests. Each test
// loads a real module source into a vm context with these fakes; only the
// browser APIs a module touches are doubled — the modules under test are
// the real ones.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// PASTE_SOURCE_ROOT swaps the module root — the contract suites run
// against this checkout's modules by default and against the
// manifest-selected built output when the variable points at a flat
// copy of a consumer's dist tree.
const sourceRoot = process.env.PASTE_SOURCE_ROOT ||
    path.join(__dirname, '../modules');

function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

// Owned-promise ops settle through real promise continuations: a test
// fires image.succeed()/fail(), then awaits one macrotask turn so every
// pending .then bookkeeping ran before asserting.
function settlePromises() {
    return new Promise(function (resolve) {
        setImmediate(resolve);
    });
}

// Land every image the registry knows, across the extra waves a settle
// can admit: loads started by a freed slot exist only after the round
// that settled it, so a few rounds lands everything outstanding.
async function settleAll(images, width, height) {
    for (let round = 0; round < 4; round += 1) {
        images.forEach(function (image) { image.succeed(width || 800, height || 450); });
        await settlePromises();
    }
}

// A MediaQueryList the test flips by hand: set() changes matches and
// fires change listeners — the mid-session preference flip a module
// must answer. Plant on the fake window as matchMedia's return.
function mediaQueryList() {
    const mql = {
        matches: false,
        listeners: [],
        addEventListener: function (name, listener) {
            mql.listeners.push(listener);
        },
        // Removal really removes, so a leaked listener stays visible to
        // the suites (listeners.length after a module lets go).
        removeEventListener: function (name, listener) {
            const index = mql.listeners.indexOf(listener);
            if (index !== -1) {
                mql.listeners.splice(index, 1);
            }
        },
        set: function (value) {
            mql.matches = value;
            mql.listeners.slice().forEach(function (listener) {
                listener({matches: value});
            });
        }
    };
    return mql;
}

// The document the last loadModule built — the fallback dispatch
// target for Events created on a non-node context, mirroring core's
// dispatchContext rule (core event.js: a defaultContext without a
// nodeType dispatches on document, never on the context itself).
let activeDocument = null;
// Every window loadModule has built, mapped to its own document. Core
// binds a Subscription targeted at its realm's window as given, and a
// window-context Event dispatches on that window's document; a test with
// two pages keeps each page's subscriptions on its own window.
const knownWindows = new Map();

function FakeEvent(context, name) {
    this.context = context;
    this.name = name;
    this.handlers = [];
}
FakeEvent.prototype.subscribe = function (method) {
    const event = this;
    const subscription = {disposed: false};
    subscription.dispose = function () {
        if (subscription.disposed) {
            return;
        }
        subscription.disposed = true;
        const index = event.handlers.indexOf(method);
        if (index >= 0) {
            event.handlers.splice(index, 1);
        }
    };
    event.handlers.push(method);
    return subscription;
};
FakeEvent.prototype.fire = function (payload) {
    this.handlers.slice().forEach((method) => method({type: this.name}, payload));
    // Core's dispatch rule: a context carrying a nodeType dispatches on
    // itself; any other context — window, null — dispatches on the
    // document. A window-contexted Event therefore reaches document-bound
    // subscriptions and never window-bound ones, exactly as
    // PasteEvent's dispatchContext selects. Element targets go through
    // fireEvent so direct addEventListener observers see it, and
    // Subscription listeners ride the same dispatch because the fake
    // Subscription registers through addEventListener.
    const dispatchTarget = this.context && this.context.nodeType ? this.context :
        (knownWindows.get(this.context) || activeDocument);
    if (dispatchTarget && typeof dispatchTarget.fireEvent === 'function') {
        dispatchTarget.fireEvent(this.name, payload);
    } else {
        FakeSubscription.fire(this.name, dispatchTarget, payload);
    }
};
FakeEvent.prototype.dispose = function () {
    this.handlers.length = 0;
};

// The fake mirrors core's PasteSubscription (core src/js/event.js) in
// every respect a module can observe: a target carrying a nodeType, or
// the page's window, is bound as given — anything else binds to the
// document; a context, when given, is `this` for the method; an
// executeCount counts deliveries down and retires the subscription
// after the last one (true means 1, zero or absent means unlimited);
// remove() and dispose() are the same retirement, and isBound()
// reports whether deliveries still reach the method.
class FakeSubscription {
    constructor(name, target, method, context, executeCount) {
        if (executeCount === true) {
            executeCount = 1;
        }
        const bindable = (target && target.nodeType) || (target && knownWindows.has(target));
        this.name = name;
        this.requestedTarget = target;
        this.target = bindable ? target : activeDocument;
        this.method = method;
        this.context = context;
        this.executeCount = executeCount || 0;
        this.bound = true;
        this.disposed = false;
        const subscription = this;
        // Core's listenerHandler: the count decrements on every
        // delivery, the method runs with its context, and the last
        // counted delivery removes the listener after the call.
        this.handler = function (domEvent, payload) {
            const remove = (subscription.executeCount -= 1) === 0;
            if (subscription.bound === false || subscription.disposed) {
                return;
            }
            if (remove) {
                subscription.bound = false;
            }
            if (subscription.context) {
                subscription.method.call(subscription.context, domEvent, payload);
            } else {
                subscription.method(domEvent, payload);
            }
            if (remove) {
                subscription.dispose();
            }
        };
        // A real Subscription wraps addEventListener — element targets get
        // the same surface so fireEvent and FakeSubscription.fire agree.
        if (this.target && typeof this.target.addEventListener === 'function') {
            this.target.addEventListener(name, this.handler);
            this.domBound = true;
        }
        FakeSubscription.registry.push(this);
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        // Core's remove() deletes the binding flag: isBound() then
        // answers undefined, not false.
        this.bound = undefined;
        if (this.domBound && this.target && typeof this.target.removeEventListener === 'function') {
            this.target.removeEventListener(this.name, this.handler);
        }
    }
    remove() {
        this.dispose();
    }
    isBound() {
        return this.bound;
    }
    static fire(name, target, payload) {
        FakeSubscription.registry.slice().forEach((subscription) => {
            if (!subscription.disposed && !subscription.domBound &&
                    subscription.name === name && subscription.target === target) {
                subscription.handler({type: name, target: target}, payload);
            }
        });
    }
    static reset() {
        FakeSubscription.registry.length = 0;
    }
}
FakeSubscription.registry = [];
// Core exposes the same constructor as event['Event']['Subscription'].
FakeEvent.Subscription = FakeSubscription;

const eventModule = {
    Event: FakeEvent,
    Subscription: FakeSubscription,
    DocumentEvent: {
        loaded: function (method) {
            return new FakeSubscription('loaded', null, method || function () {});
        }
    }
};

// Plain listener storage for contexts that are not elements — window and
// document get the same add/remove/fire surface an element carries so a
// real Subscription attaches to them the way it would on a page.
function listenerSurface(target) {
    target.listeners = target.listeners || {};
    target.addEventListener = target.addEventListener || function (name, listener) {
        (target.listeners[name] = target.listeners[name] || []).push(listener);
    };
    target.removeEventListener = target.removeEventListener || function (name, listener) {
        const list = target.listeners[name] || [];
        const index = list.indexOf(listener);
        if (index >= 0) {
            list.splice(index, 1);
        }
    };
    target.fireEvent = target.fireEvent || function (name, payload) {
        const domEvent = {type: name, target: target, data: payload};
        (target.listeners[name] || []).slice().forEach((listener) => listener(domEvent, payload));
    };
    // The entry point core's PasteEvent.fire uses — a ready-built event
    // object delivered to every listener registered for its type.
    target.dispatchEvent = target.dispatchEvent || function (ev) {
        ev.target = ev.target || target;
        (target.listeners[ev.type] || []).slice().forEach((listener) => listener(ev));
        return true;
    };
    return target;
}

// A CSSStyleDeclaration-shaped surface: setProperty/getPropertyValue/
// removeProperty over a properties map, while direct field assignment
// (style.backgroundImage = x) still lands and reads back — the shape
// modules write through and fixtures assert against.
// The element currently holding focus — document.activeElement reads
// it; blur() drops it back to nothing, as hiding the control does on
// a page.
let activeElement = null;
const mutationWatches = new WeakMap();
function mutated(target, record) {
    for (const observer of mutationWatches.get(target) || []) observer.enqueue(record);
}

class StyleDeclaration {
    constructor() {
        this.properties = {};
        this.priorities = {};
    }
    setProperty(name, value, priority) {
        this.properties[name] = String(value);
        this.priorities[name] = priority || '';
    }
    getPropertyValue(name) {
        if (this.properties[name] !== undefined) {
            return this.properties[name];
        }
        const camel = String(name).replace(/-([a-z])/g, function (match, letter) {
            return letter.toUpperCase();
        });
        return this[camel] !== undefined ? String(this[camel]) : '';
    }
    getPropertyPriority(name) {
        return this.priorities[name] || '';
    }
    removeProperty(name) {
        delete this.properties[name];
        delete this.priorities[name];
    }
}

// Core Bounds uses viewport position plus document scroll, even for fixed,
// sticky and boxless nodes. Callers supply measured offsets; this fake does
// not infer layout from CSS.
function boundsFromElement(element, document, window) {
    const empty = () => ({left: 0, top: 0, width: 0, height: 0, getBottom() { return 0; }});
    if (!element || element.style.display === 'none' || element.tagName === 'HTML') return empty();
    if (typeof element.getBoundingClientRect !== 'function') throw new Error('not modelled: legacy element bounds');
    const rect = element.getBoundingClientRect();
    const body = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
    const left = rect.left - body.clientLeft + window.pageXOffset;
    const top = rect.top - body.clientTop + window.pageYOffset;
    const width = element.offsetWidth, height = element.offsetHeight;
    return {left, top, width, height, getBottom() { return top + height; }};
}

class Element {
    constructor(tagName, id) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.id = id || '';
        this.attributes = {};
        this.children = [];
        this.parentNode = null;
        this.nextSibling = null;
        this.style = new StyleDeclaration();
        this.className = '';
        this.listeners = {};
        let scrollTop = 0;
        Object.defineProperty(this, 'scrollTop', {
            get: () => scrollTop,
            set: value => {
                const behavior = this.style.getPropertyValue('scroll-behavior') ||
                    (this.computedStyle && this.computedStyle['scroll-behavior']);
                if (behavior === 'smooth') throw new Error('not modelled: CSS smooth scrolling');
                scrollTop = value;
            }
        });
        // Border-box vs content-box: a bordered scroller's scroll-space
        // origin sits this far below getBoundingClientRect().top.
        this.clientTop = 0;
        this.rect = {top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100};
        if (this.tagName === 'IMG') {
            // An authored img fixture defaults to the ordinary settled
            // state — complete with pixels. A fixture modelling the
            // in-flight or broken baseline overrides these itself.
            this.complete = true;
            this.naturalWidth = 1;
            this.naturalHeight = 1;
            Object.defineProperty(this, 'src', {
                configurable: true,
                get: () => {
                    const raw = this.getAttribute('src');
                    if (raw === null) return '';
                    let node = this;
                    while (node && !node.ownerDocument) node = node.parentNode;
                    const base = node && node.ownerDocument ? node.ownerDocument.baseURI : 'http://localhost/';
                    try { return new URL(raw, base).href; } catch (_) { return raw; }
                },
                set: value => this.setAttribute('src', value)
            });
        }
    }
    get ownerDocument() { return this._ownerDocument || null; }
    set ownerDocument(document) { this.adoptDocument(document); }
    get isConnected() {
        const document = this.ownerDocument;
        return !!document && (this === document.documentElement || document.documentElement.contains(this));
    }
    adoptDocument(document) {
        this._ownerDocument = document;
        this.children.forEach(child => child.adoptDocument(document));
    }
    appendChild(child) {
        child.parentNode = this;
        if (this.ownerDocument) child.adoptDocument(this.ownerDocument);
        this.children.push(child);
        mutated(this, {type: 'childList', target: this, addedNodes: [child], removedNodes: []});
        return child;
    }
    insertBefore(child, sibling) {
        child.parentNode = this;
        if (this.ownerDocument) child.adoptDocument(this.ownerDocument);
        const index = sibling ? this.children.indexOf(sibling) : this.children.length;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        mutated(this, {type: 'childList', target: this, addedNodes: [child], removedNodes: []});
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) {
            this.children.splice(index, 1);
            child.parentNode = null;
            mutated(this, {type: 'childList', target: this, addedNodes: [], removedNodes: [child]});
        }
        return child;
    }
    contains(child) {
        return child === this || this.children.some((candidate) => candidate.contains(child));
    }
    // Subtree query, matching document.querySelectorAll's contract: the
    // element itself is not in its own result set.
    querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
            node.children.forEach((child) => {
                if (matchesSelector(child, selector)) {
                    found.push(child);
                }
                walk(child);
            });
        };
        walk(this);
        return found;
    }
    querySelector(selector) {
        const found = this.querySelectorAll(selector);
        return found.length ? found[0] : null;
    }
    setAttribute(name, value) {
        const oldValue = this.getAttribute(name);
        this.attributes[name] = String(value);
        mutated(this, {type: 'attributes', target: this, attributeName: name, oldValue});
    }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    hasAttribute(name) {
        return this.getAttribute(name) !== null;
    }
    removeAttribute(name) {
        if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
            const oldValue = this.attributes[name];
            delete this.attributes[name];
            mutated(this, {type: 'attributes', target: this, attributeName: name, oldValue});
        }
    }
    addEventListener(name, listener) {
        (this.listeners[name] = this.listeners[name] || []).push(listener);
    }
    removeEventListener(name, listener) {
        const listeners = this.listeners[name] || [];
        const index = listeners.indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
    }
    // A real Subscription delivers (domEvent, payload) — the payload rides
    // the event's data property, exactly as a dispatched DOM event carries
    // what the publisher fired.
    fireEvent(name, payload) {
        const domEvent = {type: name, target: this, data: payload};
        (this.listeners[name] || []).slice().forEach((listener) => listener(domEvent, payload));
    }
    dispatchEvent(ev) {
        ev.target = ev.target || this;
        (this.listeners[ev.type] || []).slice().forEach((listener) => listener(ev));
        return true;
    }
    getBoundingClientRect() {
        return this.rect;
    }
    // A rendered element contributes its box; a fixture hiding one
    // plants clientRects = [] — display:none's answer. A rendered
    // zero-size point still reports its (empty) rect, matching the
    // platform's own distinction.
    getClientRects() {
        return this.clientRects === undefined ? [this.rect] : this.clientRects;
    }
    focus() {
        activeElement = this;
    }
    blur() {
        if (activeElement === this) {
            activeElement = null;
        }
    }
}

// Matches the selector shapes modules scan and resolve: '[data-x]' and
// '[data-x="v"]' for define-time sweeps, '#id' for declared fragment and
// element references, '.class' and tag names for the rest.
function matchesSelector(element, selector) {
    selector = String(selector || '').trim();
    if (selector.charAt(0) === '#') {
        return element.id === selector.slice(1);
    }
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (match) {
        const value = element.getAttribute(match[1]);
        return value !== null && (match[2] === undefined || value === match[2]);
    }
    if (selector.charAt(0) === '.') {
        return (element.className || '').split(/\s+/).indexOf(selector.slice(1)) >= 0;
    }
    return (element.tagName || '').toLowerCase() === selector.toLowerCase();
}



// A native Image the test settles by hand: the registry records it
// when src assigns — construction issues no request on the platform,
// so only a src assignment counts as a request. succeed()
// fires onload, fail() fires onerror — the delayed and out-of-order
// completions the fixtures compose.
function imageRegistry() {
    const images = [];
    function Image() {
        const listeners = {};
        let currentSrc = '';
        const image = {
            // A platform Image is an element: core's Subscription binds
            // it as given only because it carries a nodeType.
            nodeType: 1,
            tagName: 'IMG',
            onload: null,
            onerror: null,
            naturalWidth: 0,
            naturalHeight: 0,
            crossOrigin: null,
            referrerPolicy: '',
            decodeShouldFail: false,
            // Set before decode() runs to settle that decode by hand:
            // image.resolveDecode() / image.rejectDecode() then finish
            // it, so a test can interleave other work with the decode.
            deferDecode: false,
            resolveDecode: null,
            rejectDecode: null,
            // decode() answers a real promise settling on a later turn
            // — never inside the load dispatch — and rejects when told
            // to: the module must treat decode as the completion, not
            // load.
            decode: function () {
                return new Promise(function (resolve, reject) {
                    if (image.deferDecode) {
                        image.resolveDecode = resolve;
                        image.rejectDecode = function () {
                            reject(new Error('EncodingError'));
                        };
                        return;
                    }
                    setImmediate(function () {
                        if (image.decodeShouldFail) {
                            reject(new Error('EncodingError'));
                        } else {
                            resolve();
                        }
                    });
                });
            },
            addEventListener: function (name, fn) {
                (listeners[name] = listeners[name] || []).push(fn);
            },
            removeEventListener: function (name, fn) {
                const list = listeners[name] || [];
                const index = list.indexOf(fn);
                if (index >= 0) {
                    list.splice(index, 1);
                }
            }
        };
        image.succeed = function (width, height) {
            image.naturalWidth = width || image.naturalWidth;
            image.naturalHeight = height || image.naturalHeight;
            (listeners.load || []).slice().forEach(function (fn) {
                fn.call(image, {type: 'load', target: image});
            });
            if (image.onload) {
                image.onload();
            }
        };
        image.fail = function () {
            (listeners.error || []).slice().forEach(function (fn) {
                fn.call(image, {type: 'error', target: image});
            });
            if (image.onerror) {
                image.onerror();
            }
        };
        Object.defineProperty(image, 'src', {
            enumerable: true,
            get: function () {
                return currentSrc;
            },
            set: function (value) {
                currentSrc = value;
                // An empty src starts no request; a real URL does.
                if (value) {
                    images.push(image);
                }
            }
        });
        return image;
    }
    return {Image: Image, images: images};
}

// A ResizeObserver the test triggers by hand: observe() records targets,
// trigger() fires the callback, disconnect() silences it.
function resizeObserverRegistry(disabled) {
    const observers = [];
    const ResizeObserver = disabled ? undefined : function (callback) {
        const observer = {callback: callback, observed: [], disconnected: false};
        observer.observe = function (target) {
            observer.disconnected = false;
            if (!observer.observed.includes(target)) observer.observed.push(target);
        };
        observer.unobserve = function (target) {
            const index = observer.observed.indexOf(target);
            if (index >= 0) {
                observer.observed.splice(index, 1);
            }
        };
        observer.disconnect = function () {
            observer.disconnected = true;
            observer.observed.length = 0;
        };
        observer.trigger = function (target) {
            if (!observer.disconnected) {
                // No argument means every watched box reports a change —
                // one entry per observed target, as the real API sends.
                const entries = (target === undefined ? observer.observed : observer.observed.filter(watched => watched === target))
                    .map(watched => ({target: watched}));
                if (entries.length) observer.callback(entries, observer);
            }
        };
        observers.push(observer);
        return observer;
    };
    return {ResizeObserver: ResizeObserver, observers: observers};
}

// Native mutation delivery for the direct attributes/children used by the
// image and scroll-range fixtures. Unsupported observation cannot silently
// pretend to watch a tree. CSS style parsing and text nodes belong in browsers.
function mutationObserverRegistry() {
    const instances = [];
    function MutationObserver(callback) {
        const watches = new Map();
        let pending = [];
        let scheduled = false;
        const observer = {
            observed: [],
            observe(target, options) {
                if (options.attributes === false &&
                    (options.attributeFilter !== undefined || options.attributeOldValue === true)) {
                    throw new TypeError('attribute options require attribute observation');
                }
                if (!(target instanceof Element) || options.subtree || options.characterData ||
                    ((options.attributes || options.attributeFilter) &&
                     (!options.attributeFilter || options.attributeFilter.includes('style')))) {
                    throw new Error('not modelled: subtree, text or style mutation observation');
                }
                if (!options.childList && !options.attributes && !options.attributeFilter)
                    throw new TypeError('an observation type is required');
                if (!watches.has(target)) observer.observed.push(target);
                watches.set(target, {...options});
                if (!mutationWatches.has(target)) mutationWatches.set(target, new Set());
                mutationWatches.get(target).add(observer);
            },
            enqueue(record) {
                const options = watches.get(record.target);
                if (!options || (record.type === 'childList' ? !options.childList :
                    !options.attributeFilter?.includes(record.attributeName))) return;
                pending.push({...record, oldValue: options.attributeOldValue ? record.oldValue : null});
                if (!scheduled) {
                    scheduled = true;
                    queueMicrotask(() => {
                        scheduled = false;
                        const records = observer.takeRecords();
                        if (records.length) callback(records, observer);
                    });
                }
            },
            takeRecords() { const records = pending; pending = []; return records; },
            disconnect() {
                for (const target of watches.keys()) mutationWatches.get(target).delete(observer);
                watches.clear(); observer.observed.length = 0; pending = [];
            }
        };
        instances.push(observer);
        return observer;
    }
    return {MutationObserver, instances};
}

// Geometry is explicitly supplied by a test, never inferred from rects that
// lack clipping, scroll margins and rendering state. Delivery is asynchronous.
function intersectionObserverRegistry() {
    const observers = [];
    function IntersectionObserver(callback, options = {}) {
        const observer = {
            callback, options, observed: [],
            observe(target) { if (!this.observed.includes(target)) this.observed.push(target); },
            unobserve(target) { this.observed = this.observed.filter(item => item !== target); },
            disconnect() { this.observed = []; },
            trigger(entries) {
                if (!Array.isArray(entries) || entries.some(entry => typeof entry.isIntersecting !== 'boolean'))
                    throw new Error('not modelled: intersection geometry; supply measured entries');
                const records = entries.filter(entry => this.observed.includes(entry.target));
                if (records.length) queueMicrotask(() => callback(records, observer));
            }
        };
        observers.push(observer);
        return observer;
    }
    return {IntersectionObserver, observers};
}

// An animation-frame queue the test pumps by hand, modelled on the
// module's shared batch: request() queues a plain callback,
// requestPhased(read, write) queues a measure-then-mutate pair under one
// id, cancel() withdraws whatever of an id has not run, and tick(now)
// runs everything queued at that instant in three phases — every phased
// read, then every plain callback, then every phased write, each in
// request order. A request made during a tick lands in the next one.
// A throwing callback does not stop its batch: every remaining callback
// of every phase still runs, and the first error is rethrown from tick()
// once the batch is done — the real batch reports it on a later task,
// the fake hands it to the test that pumped the frame.
// The pass's supplied time is the fixture's. A test may set
// driver.onPhase to observe the phase boundaries ('read', 'plain',
// 'write').
function frameDriver() {
    let queued = [];
    let running = [];
    let nextId = 1;
    const enqueue = function (read, plain, write) {
        const id = nextId;
        nextId += 1;
        queued.push({id: id, read: read, plain: plain, write: write});
        return id;
    };
    const withdraw = function (list, id) {
        list.forEach(function (entry) {
            if (entry.id === id) {
                entry.read = undefined;
                entry.plain = undefined;
                entry.write = undefined;
            }
        });
    };
    const runPhase = function (key, now, failures) {
        if (typeof driver.onPhase === 'function') {
            driver.onPhase(key);
        }
        running.forEach(function (entry) {
            const callback = entry[key];
            if (callback !== undefined) {
                entry[key] = undefined;
                try {
                    callback(now);
                } catch (error) {
                    failures.push(error);
                }
            }
        });
    };
    const driver = {
        onPhase: null,
        request: function (callback) {
            return enqueue(undefined, callback, undefined);
        },
        requestPhased: function (read, write) {
            return enqueue(read, undefined, write);
        },
        cancel: function (id) {
            // A cancel during a tick reaches the running batch too.
            withdraw(running, id);
            withdraw(queued, id);
            queued = queued.filter(function (entry) {
                return entry.read !== undefined || entry.plain !== undefined ||
                    entry.write !== undefined;
            });
        },
        tick: function (now) {
            const failures = [];
            running = queued;
            queued = [];
            try {
                runPhase('read', now, failures);
                runPhase('plain', now, failures);
                runPhase('write', now, failures);
            } finally {
                running = [];
            }
            if (failures.length > 0) {
                throw failures[0];
            }
        },
        pending: function () {
            return queued.length;
        }
    };
    return driver;
}





// A spec's `file` is the module's asset key ('paste/ui/x.js',
// 'paste/ui/utilities/x.js'). A flat distribution keeps every file at its
// asset key; a checkout keeps elements under modules/<name>/<name>.js and
// the paste.ui.utilities modules under modules/utilities/<name>/<name>.js.
// Both layouts resolve through here.
function nestedSourcePath(file) {
    const base = path.basename(file);
    const name = base.slice(0, -path.extname(base).length);
    return file.indexOf('/utilities/') !== -1 ?
        path.join(sourceRoot, 'utilities', name, base) :
        path.join(sourceRoot, name, base);
}

function moduleSourcePath(file) {
    const flat = path.join(sourceRoot, file);
    if (fs.existsSync(flat)) {
        return flat;
    }
    return nestedSourcePath(file);
}

// Reads a runtime module through the same resolver the stacks use —
// every behaviour suite that evaluates a module's source through here
// honors PASTE_SOURCE_ROOT, so a dist tree override actually tests the
// distribution. The source gates and the fixture host read the
// checkout's own modules/ tree regardless. A required
// file missing from the selected root fails the suite with both paths
// it was sought under; it never falls back to the checkout silently.
function readModuleSource(file) {
    const flat = path.join(sourceRoot, file);
    const nested = nestedSourcePath(file);
    if (!fs.existsSync(flat) && !fs.existsSync(nested)) {
        throw new Error(
            'module asset ' + file + ' not found under ' + sourceRoot +
            ' (looked for ' + flat + ' and ' + nested + ')');
    }
    return fs.readFileSync(moduleSourcePath(file), 'utf8');
}

// Loads one paste module into a fresh vm context. `spec` supplies the
// source asset key, the expected module name, and the
// dependency implementations in declaration order. `elements` maps IDs for
// getElementById and is also the pool querySelectorAll scans — modules
// self-bind whatever declarations exist at define time, so plant declared
// elements here before the module source runs. `sharedWindow` and
// `sharedDocument` let separately loaded modules observe one page.
function loadModule(spec) {
    const sourcePath = moduleSourcePath(spec.file);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const holder = {};
    const elements = (spec.elements || {});
    // A fresh page starts with nothing focused; focus never leaks from a
    // previous test's document into this one.
    if (!spec.sharedDocument) {
        activeElement = null;
    }
    // A shared document lets modules loaded in separate vm contexts see
    // one DOM: declared ids resolve across module boundaries exactly as
    // they do on a page. Queries walk the live tree, so fragments planted
    // after a module's define still resolve.
    const document = spec.sharedDocument || listenerSurface(Object.assign({
        nodeType: 9,
        documentElement: spec.documentElement || new Element('html'),
        body: new Element('body'),
        hidden: false,
        readyState: 'complete',
        // The base authored image URLs resolve against — a page on a CDN
        // or behind a different document base asserts its own value.
        baseURI: 'http://localhost/',
        createElement: function (tagName) {
            return new Element(tagName);
        },
        getElementById: function (id) {
            const find = (node) => {
                if (node.id === id) {
                    return node;
                }
                let found = null;
                (node.children || []).forEach((child) => {
                    found = found || find(child);
                });
                return found;
            };
            return find(document.documentElement);
        },
        querySelectorAll: function (selector) {
            return matchesSelector(document.documentElement, selector) ?
                [document.documentElement].concat(document.documentElement.querySelectorAll(selector)) :
                document.documentElement.querySelectorAll(selector);
        },
        querySelector: function (selector) {
            const found = document.querySelectorAll(selector);
            return found.length ? found[0] : null;
        }
    }, spec.document || {}));
    document.documentElement.ownerDocument = document;
    if (!document.body.parentNode) {
        // Sweeps root at documentElement: the body must live beneath it
        // for declared markup to be found.
        document.documentElement.appendChild(document.body);
    }
    if (!Object.prototype.hasOwnProperty.call(document, 'activeElement')) {
        Object.defineProperty(document, 'activeElement', {
            configurable: true,
            get: function () {
                return activeElement;
            }
        });
    }
    if (!document.documentElement.parentNode) {
        // The document's own root: clientHeight/clientWidth are the
        // layout viewport modules measure against; the fixture keeps
        // them equal to inner* so either basis measures the same.
        if (document.documentElement.clientHeight === undefined) {
            document.documentElement.clientHeight = 800;
        }
        if (document.documentElement.clientWidth === undefined) {
            document.documentElement.clientWidth = 600;
        }
    }
    // Non-node Event contexts dispatch on the document per core's rule —
    // the fake needs the page's document to do the same.
    activeDocument = document;
    const window = spec.sharedWindow || {};
    const windowDefaults = {
        innerHeight: 800,
        innerWidth: 600,
        pageYOffset: 0,
        scrollTo: function () { throw new Error('not modelled: viewport scrolling; use a browser'); },
        devicePixelRatio: 1,
        navigator: {connection: {}},
        performance: {now: function () { return nowMs(); }},
        // The document's own address — session-scoped state keys off
        // it, so a fixture page carries one and a test overrides it to
        // stand up a second page on the same origin.
        location: {href: 'http://localhost/'},
        sessionStorage: {
            getItem: function () { return null; },
            setItem: function () {},
            removeItem: function () {}
        },
        matchMedia: function () {
            return {matches: false, addEventListener: function () {}, removeEventListener: function () {}};
        },
        // The computed style a fixture plants on an element as
        // `computedStyle` — standard properties read the element's own
        // map, '--*' custom properties inherit through ancestors the way
        // the cascade resolves them, and the cascade's own precedence
        // decides what answers: an inline declaration outranks a normal
        // stylesheet entry, a stylesheet '... !important' value outranks
        // a normal inline, and an inline !important outranks everything.
        getComputedStyle: function (element) {
            const css = element.computedStyle || {};
            const transition = element.style.getPropertyValue('transition') || css.transition ||
                element.style.getPropertyValue('transition-property') || css['transition-property'];
            return {
                getPropertyValue: function (name) {
                    if (name === 'background-image' && transition && /(?:all|background)/.test(transition))
                        throw new Error('not modelled: computed background-image transitions; use a browser');
                    const isCustom = String(name).substr(0, 2) === '--';
                    let node = element;
                    let sheetValue;
                    let sheetImportant = false;
                    while (node) {
                        if (node.computedStyle && node.computedStyle[name] !== undefined) {
                            sheetValue = String(node.computedStyle[name]);
                            if ((/\s*!important\s*$/).test(sheetValue)) {
                                sheetImportant = true;
                                sheetValue = sheetValue.replace(/\s*!important\s*$/, '');
                            }
                            break;
                        }
                        if (!isCustom) {
                            break;
                        }
                        node = node.parentNode;
                    }
                    let inlineValue = '';
                    let inlineImportant = false;
                    if (element && element.style &&
                            typeof element.style.getPropertyValue === 'function') {
                        inlineValue = element.style.getPropertyValue(name);
                        inlineImportant = typeof element.style.getPropertyPriority === 'function' &&
                            element.style.getPropertyPriority(name) === 'important';
                    }
                    if (inlineValue !== '' && (inlineImportant || !sheetImportant)) {
                        return inlineValue;
                    }
                    return sheetValue === undefined ? '' : sheetValue;
                }
            };
        },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        URL: URL,
        WeakMap: WeakMap,
        Image: function () {}
    };
    // Defaults fill only what a shared window has not already planted:
    // the image registry a stack composed must survive every module's
    // window merge.
    Object.keys(windowDefaults).forEach(function (key) {
        if (window[key] === undefined) {
            window[key] = windowDefaults[key];
        }
    });
    Object.assign(window, spec.window || {});
    listenerSurface(window);
    knownWindows.set(window, document);
    // Spec elements belong to the document a browser would put them in:
    // attached under body so declaration sweeps rooted at documentElement
    // find them. An element nested in a fixture-built fragment attaches
    // its root ancestor — reparenting the element would detach it from
    // the fragment the test composed. On a shared document, elements
    // already attached stay.
    Object.keys(elements).forEach(function (id) {
        const element = elements[id];
        if (element && element.nodeType === 1) {
            let root = element;
            while (root.parentNode) {
                root = root.parentNode;
            }
            if (root !== document.documentElement && root.nodeType === 1) {
                document.body.appendChild(root);
            }
        }
    });
    const context = {
        paste: {
            define: function (name, dependencies, factory) {
                assert.strictEqual(name, spec.name);
                assert.strictEqual(dependencies.join('|'), spec.deps.join('|'));
                holder.module = factory.apply(null, [{}].concat(spec.impls));
            }
        },
        document: document,
        window: window,
        navigator: window.navigator,
        console: console
    };
    // spec.globals shadows realm intrinsics for capability-absence tests —
    // an own `Promise: undefined` on the context reads as undefined inside
    // the module, exactly the missing-capability surface a browser without
    // the API presents.
    Object.assign(context, spec.globals || {});
    vm.createContext(context);
    vm.runInContext(source, context, {filename: sourcePath});
    return {module: holder.module, document: document, window: window, elements: elements};
}







// The declarative-element stack: the shared geometry and image helpers
// load once, then each ui module's own define-time sweep binds the
// planted markup — `env.elements` is the page, `env.scrollscrub`,
// `env.imagesequence` and `env.progressiveresolution` say which
// enhancements are on it, `env.window` shapes the browser surface. The
// frame driver is manual: scrolls and resizes mark work dirty, and
// `driver.tick()` is the animation-frame pass the test runs.
function openUiStack(env) {
    env = env || {};
    FakeSubscription.reset();
    const driver = env.frameDriver || frameDriver();
    const imageReg = imageRegistry();
    const resizeReg = resizeObserverRegistry(env.noResizeObserver);
    const sharedWindow = Object.assign({
        ResizeObserver: resizeReg.ResizeObserver,
        Image: imageReg.Image
    }, env.window || {});
    const scrollrangeLoaded = loadModule({
        file: 'paste/ui/utilities/scrollrange.js',
        name: 'paste.ui.utilities.scrollrange',
        deps: [], impls: [],
        elements: env.elements, document: env.document,
        sharedDocument: env.sharedDocument, sharedWindow: sharedWindow,
        globals: env.globals
    });
    const imageresolutionLoaded = loadModule({
        file: 'paste/ui/utilities/imageresolution.js',
        name: 'paste.ui.utilities.imageresolution',
        deps: ['paste.event'], impls: [eventModule],
        elements: env.elements,
        sharedDocument: scrollrangeLoaded.document, sharedWindow: sharedWindow,
        globals: env.globals
    });
    const mediaqueryLoaded = loadModule({
        file: 'paste/ui/utilities/mediaquery.js',
        name: 'paste.ui.utilities.mediaquery',
        deps: [], impls: [],
        elements: env.elements,
        sharedDocument: scrollrangeLoaded.document, sharedWindow: sharedWindow,
        globals: env.globals
    });
    const modules = {
        scrollrange: scrollrangeLoaded.module,
        imageresolution: imageresolutionLoaded.module,
        mediaquery: mediaqueryLoaded.module
    };
    if (env.scrollscrub !== false) {
        modules.scrollscrub = loadModule({
            file: 'paste/ui/scrollscrub.js',
            name: 'paste.ui.scrollscrub',
            deps: ['paste.event', 'paste.ui.utilities.animation-frame', 'paste.ui.utilities.scrollrange'],
            impls: [eventModule, driver, modules.scrollrange],
            elements: env.elements,
            sharedDocument: imageresolutionLoaded.document, sharedWindow: sharedWindow,
            globals: env.globals
        }).module;
    }
    if (env.imagesequence) {
        modules.imagesequence = loadModule({
            file: 'paste/ui/imagesequence.js',
            name: 'paste.ui.imagesequence',
            deps: ['paste.event', 'paste.ui.utilities.animation-frame',
                'paste.ui.utilities.scrollrange', 'paste.ui.utilities.imageresolution',
                'paste.ui.utilities.mediaquery'],
            impls: [eventModule, driver, modules.scrollrange, modules.imageresolution,
                modules.mediaquery],
            elements: env.elements,
            sharedDocument: imageresolutionLoaded.document, sharedWindow: sharedWindow,
            globals: env.globals
        }).module;
    }
    if (env.progressiveresolution) {
        modules.progressiveresolution = loadModule({
            file: 'paste/ui/progressiveresolution.js',
            name: 'paste.ui.progressiveresolution',
            deps: ['paste.event', 'paste.ui.utilities.animation-frame', 'paste.ui.utilities.imageresolution',
                'paste.ui.utilities.mediaquery'],
            impls: [eventModule, driver, modules.imageresolution, modules.mediaquery],
            elements: env.elements,
            sharedDocument: imageresolutionLoaded.document, sharedWindow: sharedWindow,
            globals: env.globals
        }).module;
    }
    return {
        modules: modules,
        document: imageresolutionLoaded.document,
        window: sharedWindow,
        elements: env.elements || {},
        driver: driver,
        images: imageReg.images,
        resizeObservers: resizeReg.observers
    };
}






module.exports = {
    Element: Element,
    boundsFromElement: boundsFromElement,
    FakeEvent: FakeEvent,
    FakeSubscription: FakeSubscription,
    eventModule: eventModule,
    listenerSurface: listenerSurface,
    matchesSelector: matchesSelector,
    StyleDeclaration: StyleDeclaration,
    imageRegistry: imageRegistry,
    resizeObserverRegistry: resizeObserverRegistry,
    mutationObserverRegistry: mutationObserverRegistry,
    intersectionObserverRegistry: intersectionObserverRegistry,
    frameDriver: frameDriver,
    loadModule: loadModule,
    moduleSourcePath: moduleSourcePath,
    readModuleSource: readModuleSource,
    openUiStack: openUiStack,
    settlePromises: settlePromises,
    settleAll: settleAll,
    mediaQueryList: mediaQueryList,
    nowMs: nowMs
};
