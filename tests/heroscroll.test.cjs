const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource, loadModule} = require('./fakes.cjs');

// The heroscroll contract: no '.paste-ui-hero' markup means no feature
// — no listeners and no work. Scroll-driven opacity and parallax are
// motion effects the module owns, so a reduced-motion preference
// retires them: while the preference holds, the module writes nothing,
// and a mid-session change restores whatever the stylesheet authored.

function fixture(options = {}) {
    const listeners = {};
    const timers = [];
    const subscriptions = [];
    const mqlListeners = [];
    const frames = [];
    const reads = {computedStyle: 0, bounds: 0};
    const reduced = {value: !!options.reduced};

    const state = {
        scrollTop: options.scrollTop || 0,
        viewportHeight: options.viewportHeight || 600,
        viewportWidth: options.viewportWidth || 1024,
        orientation: options.orientation,
        legacyOrientation: options.legacyOrientation
    };

    function Bounds(left, top, width, height) {
        return {
            left, top, width, height,
            getBottom: () => top + height
        };
    }
    Bounds.fromElement = el => {
        reads.bounds++;
        return el ? Bounds(0, el.rect.top, 0, el.rect.height) : null;
    };

    // A CSSStyleDeclaration's two access surfaces: direct properties
    // (style.opacity) and the CSSOM methods (getPropertyValue & co.)
    // share one store, and '' reads back for a property never set.
    function cssStyle(init, priorities) {
        // Both spellings name one declaration — style.backgroundPosition
        // and getPropertyValue('background-position') share a store.
        const camel = n => n.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        const s = Object.assign({}, init || {});
        const prio = {};
        Object.keys(priorities || {}).forEach(k => { prio[camel(k)] = priorities[k]; });
        s.getPropertyValue = n => {
            const v = s[camel(n)] === undefined ? s[n] : s[camel(n)];
            return v === undefined ? '' : v;
        };
        s.getPropertyPriority = n => (prio[camel(n)] || '');
        s.setProperty = (n, v, pr) => { s[camel(n)] = v; prio[camel(n)] = pr || ''; };
        s.removeProperty = n => { delete s[camel(n)]; delete s[n]; delete prio[camel(n)]; };
        return s;
    }

    function hero(id, top, height, attrs = {}) {
        const classList = {
            add: c => elClassSet.add(c),
            remove: c => elClassSet.delete(c),
            contains: c => elClassSet.has(c)
        };
        const elClassSet = new Set(['paste-ui-hero']);
        const attributes = new Map(Object.entries(attrs.hero || {}));
        const image = {
            rect: {top, height},
            style: cssStyle(attrs.imageStyle, attrs.imageStylePrio),
            hasAttribute: k => (attrs.image || {}).hasOwnProperty(k),
            getAttribute: k => (attrs.image || {})[k] || null
        };
        const content = {
            rect: attrs.contentRect || {top, height},
            style: cssStyle(attrs.contentStyle, attrs.contentStylePrio)
        };
        const el = {
            id,
            nodeType: 1,
            tagName: 'SECTION',
            parentNode: null,
            rect: {top, height},
            classList,
            image,
            content,
            nextElementSibling: null,
            nextSibling: null,
            scrollIntoView: (...args) => scrolled.push({el, args}),
            hasAttribute: k => attributes.has(k),
            getAttribute: k => attributes.has(k) ? attributes.get(k) : null,
            setAttribute: (k, v) => attributes.set(k, v)
        };
        return el;
    }

    const scrolled = [];
    const heroes = (options.heroes || []).map(h => hero(h.id, h.top, h.height, h.attrs));
    // Document order: each hero's next element sibling is the following
    // hero unless a test plants something else.
    heroes.forEach((h, i) => { h.nextElementSibling = heroes[i + 1] || null; });
    if (options.arrange) { options.arrange(heroes); }
    const byId = {};

    function classListed() {
        const set = new Set();
        return {
            set,
            classList: {
                add: c => set.add(c),
                remove: c => set.delete(c),
                contains: c => set.has(c)
            }
        };
    }
    const htmlEl = classListed();
    const bodyEl = classListed();
    bodyEl.style = {backgroundSize: '', opacity: ''};
    if (options.backgroundSizeSupported === false) delete bodyEl.style.backgroundSize;

    const dom = {
        getDocumentBody: () => htmlEl,
        get: function (idOrSelector, isQueryOrParent) {
            if (!isQueryOrParent) {
                return byId[idOrSelector] || null;
            }
            return heroes;
        },
        querySelector: function (sel, ctx) {
            if (sel === '.paste-ui-hero-image') { return ctx.image; }
            if (sel === '.paste-ui-hero-content') { return ctx.content; }
            return null;
        },
        getScrollTop: () => state.scrollTop,
        getViewportHeight: () => state.viewportHeight,
        getViewportWidth: () => state.viewportWidth,
        getPixelValue: (el, v) => parseFloat(v) || 0,
        hasCssClass: (el, c) => el.classList.contains(c),
        addCssClass: (el, c) => el.classList.add(c),
        removeCssClass: (el, c) => el.classList.remove(c),
        Bounds
    };

    const util = {
        each: (list, fn) => (list || []).forEach(fn),
        stringStartsWith: (s, p) => s.indexOf(p) === 0,
        stringEndsWith: (s, p) => s.slice(-p.length) === p
    };
    const fired = [];
    const event = {
        Event: function (context, name) {
            this.fire = payload => fired.push({context, name, payload});
            this.dispose = () => {};
        },
        DocumentEvent: {loaded: () => {}}
    };
    event.Event.getEventTarget = e => e.target || null;
    event.Event.Subscription = function (type, targetEl, fn, context, count) {
        const sub = {bound: true};
        (listeners[type] = listeners[type] || []).push(fn);
        subscriptions.push({type, sub, target: targetEl, fn, count});
        this.isBound = () => sub.bound;
        this.detach = () => { sub.bound = false; };
        this.dispose = () => { sub.bound = false; };
    };

    const requests = [];
    const deliver = fn => {
        frames.push(fn);
        return frames.length;
    };
    const animation_frame = {
        request: fn => {
            requests.push(fn);
            return deliver(fn);
        },
        // The phased pair is one frame: the read half, then the
        // write half, on one delivery. requests records the pair.
        requestPhased: (read, write) => {
            requests.push([read, write]);
            return deliver(time => {
                read(time);
                write(time);
            });
        },
        cancel: id => { frames[id - 1] = () => {}; }
    };

    const matchMedia = options.matchMedia === 'absent'
        ? undefined
        : options.matchMedia !== undefined
            ? options.matchMedia
            : (query => ({
                get matches() { return reduced.value; },
                media: query,
                addEventListener: (t, fn) => mqlListeners.push(fn),
                addListener: fn => mqlListeners.push(fn)
            }));
    // The real shared MediaQueryList binding, over this page's
    // matchMedia — the module's policy is the utility's.
    const mediaquery = loadModule({
        file: 'paste/ui/utilities/mediaquery.js',
        name: 'paste.ui.utilities.mediaquery',
        deps: [], impls: [],
        window: {matchMedia}
    }).module;

    // The hash as the Location interface keeps it: written without its
    // '#', read back with it, and a write of the fragment already
    // current navigates nowhere.
    let hash = options.hash || '';
    const navigations = [];
    const location = {
        get href() { return 'https://www.test.local/page?q=1' + (hash || (options.emptyFragment ? '#' : '')); },
        get hash() { return hash; },
        set hash(value) {
            const next = '#' + String(value).replace(/^#/, '');
            if (next !== hash) {
                hash = next;
                navigations.push(next);
            }
        }
    };
    // Session history as a hero click may write it: each pushState is
    // recorded with how many scrolls preceded it.
    const pushes = [];
    const history = {
        state: options.historyState === undefined ? null : options.historyState,
        pushState(state, title, url) {
            if (options.historyRefuses) { throw new Error('SecurityError'); }
            pushes.push({state, title, args: arguments.length, url, scrolledBefore: scrolled.length});
        }
    };
    const window = {
        location,
        history,
        setTimeout: fn => { timers.push(fn); return timers.length; },
        clearTimeout: () => {},
        getComputedStyle: element => {
            if (!element) throw new TypeError('getComputedStyle requires an element');
            reads.computedStyle++;
            return {
                getPropertyValue: name => name === 'background-position'
                ? (options.backgroundPosition === undefined ? '50% 0px' : options.backgroundPosition)
                : ((options.computed || {})[name] || '0px')
            };
        },
        // The screen's orientation as the platform reports it, when a
        // test plants one.
        get orientation() { return state.legacyOrientation; },
        screen: {get orientation() { return state.orientation ? {type: state.orientation} : undefined; }},
        matchMedia
    };
    // A ResizeObserver only when a test plants one: observed records
    // each target and its callback.
    const resizeObservers = [];
    if (options.resizeObserver) {
        window.ResizeObserver = function (callback) {
            const record = {callback, targets: []};
            resizeObservers.push(record);
            this.observe = target => record.targets.push(target);
        };
    }

    const document = {
        // Loaded unless a test defines the module mid-load.
        readyState: options.readyState || 'complete',
        body: bodyEl,
        getElementsByTagName: tag => tag === 'a' ? (options.named || []).filter(n => n.nodeName === 'A') : [bodyEl],
        compatMode: options.quirks ? 'BackCompat' : 'CSS1Compat',
        // The fragment lookup a hero's own entry consults: ids of heroes
        // and of any other elements a test plants, and named elements.
        getElementById: id => byId[id] || (options.elementIds || []).includes(id) ? {id} : null,
        getElementsByName: name => (options.named || []).filter(n => n.name === name)
    };

    const exports = {};
    vm.runInNewContext(
        readModuleSource('paste/ui/heroscroll.js'),
        {
            window, document, console,
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.heroscroll');
                assert.equal(deps.join('|'), ['paste.util', 'paste.dom',
                    'paste.event', 'paste.has', 'paste.ui.utilities.animation-frame',
                    'paste.ui.utilities.mediaquery',
                    'polyfills.getcomputedstyle'].join('|'));
                factory(exports, util, dom, event, {touch: !!options.touch},
                    animation_frame, mediaquery, {});
            }},
        }
    );

    heroes.forEach(h => { if (h.id) { byId[h.id] = h; } });

    return {
        heroes, listeners, subscriptions, timers, frames, reads, state, requests, fired,
        location, navigations, scrolled, resizeObservers, bodyEl, pushes,
        // A click delivered to the subscription bound on one hero.
        clickHero: (heroEl, target, path) => {
            let prevented = false;
            const e = {type: 'click', target: target || heroEl, preventDefault: () => { prevented = true; }};
            if (path) { e.composedPath = () => path; }
            subscriptions.filter(s => s.type === 'click' && s.target === heroEl).forEach(s => s.fn(e));
            return prevented;
        },
        htmlClasses: htmlEl.set, bodyClasses: bodyEl.set,
        fireScroll: () => (listeners.scroll || []).slice().forEach(fn => fn({type: 'scroll'})),
        fireResize: () => (listeners.resize || []).slice().forEach(fn => fn({type: 'resize'})),
        flushTimers: () => timers.splice(0).forEach(fn => fn()),
        flushFrames: () => frames.splice(0).forEach(fn => fn(16)),
        setReduced: v => {
            reduced.value = v;
            mqlListeners.slice().forEach(fn => fn({matches: v}));
        },
        mqlListenerCount: () => mqlListeners.length
    };
}

test('no hero markup binds no listeners and does no work', () => {
    const f = fixture();
    assert.equal(f.subscriptions.length, 0,
        'a page without heroes still carries the module\'s scroll and resize listeners');
    assert.doesNotThrow(() => { f.flushTimers(); f.flushFrames(); },
        'the deferred initial paint threw on an empty hero list');
    assert.doesNotThrow(() => { f.fireScroll(); f.fireResize(); },
        'a bound handler threw on a page that declared nothing');
});

test('the deferred initial paint does not crash with zero heroes', () => {
    const f = fixture();
    f.flushTimers();
    f.flushFrames();
    assert.ok(true);
});

test('a hero gets scrolled effects on the real scroll path', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 0
    });
    assert.equal(f.subscriptions.length, 2, 'scroll and resize subscriptions missing');
    f.flushFrames();

    f.state.scrollTop = 300;
    f.fireScroll();
    f.flushFrames();

    const opacity = f.heroes[0].image.style.opacity;
    assert.equal(typeof opacity, 'string', 'the fade did not write an image opacity');
    assert.ok(Number(opacity) > 0 && Number(opacity) < 1, 'mid-scroll opacity out of range: ' + opacity);
    assert.equal(f.heroes[0].image.style.backgroundAttachment, 'fixed',
        'the parallax pass did not pin the image');
});

test('ordinary scroll input performs no style or geometry reads', () => {
    // The module's cost model: the scroll event arms one frame; the frame
    // runs math over measurements taken at init/resize. getComputedStyle and
    // Bounds.fromElement on the input path are the layout thrash this split
    // exists to prevent.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 0
    });
    f.flushFrames();

    f.reads.computedStyle = 0;
    f.reads.bounds = 0;
    f.state.scrollTop = 300;
    f.fireScroll();

    assert.equal(f.reads.computedStyle, 0, 'scroll input forced a computed style read');
    assert.equal(f.reads.bounds, 0, 'scroll input forced a geometry read');
    assert.equal(f.heroes[0].image.style.opacity, '1',
        'scroll input wrote a style before the frame ran');

    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '0.5',
        'the armed frame did not apply the new scroll position');
});

test('high-frequency scroll input coalesces into one owned frame', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 0
    });
    f.flushFrames();

    for (let i = 0; i < 8; i++) {
        f.state.scrollTop = i * 40;
        f.fireScroll();
    }
    assert.equal(f.frames.length, 1,
        'eight scroll events queued ' + f.frames.length + ' frames — input is not coalesced');

    f.flushFrames();
    assert.equal(f.heroes[0].image.style.backgroundAttachment, 'fixed',
        'the coalesced frame never applied the effect');
});

test('scroll input under reduced motion arms no frame at all', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300,
        reduced: true
    });
    f.flushFrames();
    f.fireScroll();
    assert.equal(f.frames.length, 0,
        'a scroll under a reduced-motion preference still queued a write frame');
});

test('reduced motion at define time keeps the authored presentation', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300,
        reduced: true
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();

    assert.equal(f.heroes[0].image.style.opacity, undefined,
        'an inline opacity was written over a reduced-motion preference');
    assert.equal(f.heroes[0].image.style.backgroundAttachment, undefined,
        'a parallax write ran under a reduced-motion preference');
    assert.equal(f.heroes[0].content.style.opacity, undefined,
        'an inline opacity was written over a reduced-motion preference');
});

test('switching to reduced motion restores what the stylesheet authored', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    assert.equal(typeof f.heroes[0].image.style.opacity, 'string', 'precondition: effect applied');
    assert.ok(f.mqlListenerCount() > 0, 'the module never observes the motion preference');

    f.setReduced(true);

    assert.equal(f.heroes[0].image.style.opacity, '',
        'the module kept a mid-fade inline opacity after the preference changed');
    assert.equal(f.heroes[0].image.style.backgroundAttachment, '',
        'the module kept its parallax pinning after the preference changed');
    assert.equal(f.heroes[0].content.style.opacity, '',
        'the module kept a content fade after the preference changed');

    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '',
        'a scroll under reduced motion wrote an inline style');
});

test('restore returns the authored inline values, not a blanket clear', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            image: {'data-hero-image-fade': ''},
            imageStyle: {opacity: '0.45', backgroundAttachment: 'local', backgroundPosition: '20% 80%'},
            imageStylePrio: {backgroundPosition: 'important'},
            contentStyle: {opacity: '0.9'}
        }}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    // Precondition: the effects overwrote the authored inline values.
    assert.notEqual(f.heroes[0].image.style.backgroundPosition, '20% 80%',
        'precondition: parallax did not take over background position');

    f.setReduced(true);

    assert.equal(f.heroes[0].image.style.opacity, '0.45',
        'restore replaced the authored opacity instead of returning it');
    assert.equal(f.heroes[0].image.style.backgroundAttachment, 'local',
        'restore replaced the authored attachment instead of returning it');
    assert.equal(f.heroes[0].image.style.backgroundPosition, '20% 80%',
        'restore replaced the authored position instead of returning it');
    assert.equal(f.heroes[0].image.style.getPropertyPriority('background-position'), 'important',
        'restore dropped the authored priority');
    assert.equal(f.heroes[0].content.style.opacity, '0.9',
        'restore replaced the authored content opacity instead of returning it');
});

test('restore never touches properties the module did not write', () => {
    // Without data-hero-image-fade the image opacity is never owned —
    // an authored value must survive a restore untouched.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            imageStyle: {opacity: '0.45', backgroundAttachment: 'local', backgroundPosition: '20% 80%'},
            contentStyle: {opacity: '0.9'}
        }}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();

    f.setReduced(true);

    assert.equal(f.heroes[0].image.style.opacity, '0.45',
        'restore cleared an opacity the module never wrote');
    assert.equal(f.heroes[0].image.style.backgroundAttachment, 'local',
        'restore cleared an authored attachment');
    assert.equal(f.heroes[0].image.style.backgroundPosition, '20% 80%',
        'restore cleared an authored position');
    assert.equal(f.heroes[0].content.style.opacity, '0.9',
        'restore cleared an authored content opacity');
});

test('lifting the preference resumes the effect on the next scroll', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();

    f.setReduced(true);
    f.setReduced(false);
    f.flushFrames();

    assert.equal(typeof f.heroes[0].image.style.opacity, 'string',
        'the effect never resumed after the preference lifted');
});

test('the measure phase re-reads geometry on resize, not on scroll', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 0
    });
    f.flushFrames();

    f.reads.computedStyle = 0;
    f.reads.bounds = 0;
    f.fireResize();
    f.flushTimers();
    f.flushFrames();

    assert.ok(f.reads.bounds > 0, 'resize did not re-measure the hero');
    assert.ok(f.reads.computedStyle > 0, 'resize did not refresh the cached style reads');
});

test('a hero outside the viewport gets no presentation writes', () => {
    // Offscreen work paints nothing — the pass leaves it alone until a
    // later frame brings the hero back into the band.
    const f = fixture({
        heroes: [
            {id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}},
            {id: 'h2', top: 2400, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}
        ],
        scrollTop: 0,
        viewportHeight: 600
    });
    f.flushFrames();
    assert.equal(f.heroes[1].image.style.opacity, undefined,
        'a below-fold hero got a fade write');
    assert.equal(f.heroes[1].image.style.backgroundAttachment, undefined,
        'a below-fold hero got a parallax pin');
    assert.equal(f.heroes[1].image.style.backgroundPosition, undefined,
        'a below-fold hero got a parallax position write');

    f.state.scrollTop = 100;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[1].image.style.opacity, undefined,
        'a hero still below the fold got a fade write');

    // Re-entry: the first in-band frame paints before the user sees it.
    f.state.scrollTop = 2100;
    f.fireScroll();
    f.flushFrames();
    assert.equal(typeof f.heroes[1].image.style.opacity, 'string',
        'the returning hero never painted');
    assert.equal(f.heroes[1].image.style.backgroundAttachment, 'fixed',
        'the returning hero never pinned');
});

test('a frame whose values did not change rewrites no styles', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    assert.equal(typeof f.heroes[0].image.style.opacity, 'string',
        'precondition: the effect never applied');

    // Count writes at the style interface — the module's bookkeeping
    // should already know these values stand.
    const writes = [];
    const imageSet = f.heroes[0].image.style.setProperty;
    f.heroes[0].image.style.setProperty = (n, v, p) => { writes.push(n); imageSet(n, v, p); };
    const contentWrites = [];
    const contentSet = f.heroes[0].content.style.setProperty;
    f.heroes[0].content.style.setProperty = (n, v, p) => { contentWrites.push(n); contentSet(n, v, p); };

    // A resize re-measures and re-arms a frame at an unchanged scroll
    // position — every computed value comes out identical.
    f.fireResize();
    f.flushTimers();
    f.flushFrames();
    assert.equal(writes.length, 0,
        'unchanged values still wrote styles: ' + writes.join(','));
    assert.equal(contentWrites.length, 0,
        'unchanged values still wrote content styles: ' + contentWrites.join(','));
});

test('a restored presentation is re-owned on the next motion frame', () => {
    // Restore returns authored values — the written-value memory must
    // reset with it or a resume would leave authored values standing
    // while the bookkeeping claims the effect is applied.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    const before = f.heroes[0].image.style.opacity;
    assert.equal(typeof before, 'string', 'precondition: effect not applied');

    f.setReduced(true);
    assert.equal(f.heroes[0].image.style.opacity, '',
        'precondition: restore never ran');

    f.setReduced(false);
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, before,
        'the resumed frame never re-applied the effect value');
});

test('an unobservable motion preference stands the effects down', () => {
    // matchMedia absent, noncallable, throwing, malformed, or refusing
    // registration — in every shape the module still loads, but the
    // motion enhancement stays authored-side: no frame writes a style
    // it could never restore on a preference flip it cannot observe.
    const hostileShapes = {
        'absent matchMedia': 'absent',
        'noncallable matchMedia': {},
        'a throwing query': () => { throw new Error('matchMedia poisoned'); },
        'a malformed result': () => ({}),
        'a throwing registration': () => ({
            matches: false,
            addEventListener: () => { throw new Error('mql listener poisoned'); }
        })
    };
    for (const [label, shape] of Object.entries(hostileShapes)) {
        const f = fixture({
            heroes: [{id: 'h1', top: 0, height: 600, attrs: {
                image: {'data-hero-image-fade': ''},
                imageStyle: {opacity: 0.6}
            }}],
            scrollTop: 300,
            matchMedia: shape
        });
        assert.equal(f.mqlListenerCount(), 0,
            label + ': a preference listener registered through a hostile query');
        f.fireScroll();
        f.flushFrames();
        assert.equal(f.heroes[0].image.style.opacity, 0.6,
            label + ': an unobservable preference still let a frame write opacity');
        assert.equal(f.heroes[0].image.style.backgroundAttachment, undefined,
            label + ': an unobservable preference still pinned the image');
    }
});

test('a resize burst performs no geometry work until the armed frame', () => {
    // Twenty events arm one pass: the input handler only marks the
    // cache stale — the frame's recalibration reads once per hero.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 0
    });
    f.flushFrames();
    f.reads.computedStyle = 0;
    f.reads.bounds = 0;

    for (let i = 0; i < 20; i++) { f.fireResize(); }
    assert.equal(f.reads.bounds, 0, 'resize input forced a geometry read');
    assert.equal(f.reads.computedStyle, 0, 'resize input forced a computed-style read');
    assert.equal(f.frames.length, 1,
        'a resize burst armed ' + f.frames.length + ' frames instead of one');

    f.flushFrames();
    assert.equal(f.reads.bounds, 2,
        'the coalesced pass did not measure once per hero');
    assert.equal(f.reads.computedStyle, 1,
        'the coalesced pass re-read styles it already owned');
});

test('restore never overwrites a declaration another writer claimed', () => {
    // An external inline write made while the effect held the property
    // is the newer owner — restore must leave its value and priority
    // standing rather than rewind to the old snapshot.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    assert.equal(typeof f.heroes[0].image.style.opacity, 'string',
        'precondition: the effect never claimed the opacity');

    f.heroes[0].image.style.setProperty('opacity', '0.25', 'important');
    f.setReduced(true);

    assert.equal(f.heroes[0].image.style.getPropertyValue('opacity'), '0.25',
        'restore rewound a newer writer\'s opacity');
    assert.equal(f.heroes[0].image.style.getPropertyPriority('opacity'), 'important',
        'restore stripped a newer writer\'s priority');
    // Properties the newer writer did not touch still restore.
    assert.equal(f.heroes[0].image.style.backgroundAttachment, '',
        'restore skipped the still-owned attachment');
});

test('a released record recaptures the baseline current at the next claim', () => {
    // The ownership record leaves on restore: a writer's value in place
    // when the effect resumes is the new baseline — it returns on the
    // next restore rather than the stale snapshot coming back.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    f.setReduced(true);
    f.heroes[0].image.style.setProperty('opacity', '0.6', '');
    f.setReduced(false);
    f.flushFrames();
    assert.equal(typeof f.heroes[0].image.style.opacity, 'string',
        'the effect never resumed after the preference lifted');
    f.setReduced(true);
    assert.equal(f.heroes[0].image.style.getPropertyValue('opacity'), '0.6',
        'a stale captured baseline overwrote the current authored value');
});

test('content entering from the bottom fold gets its authored opacity back', () => {
    // Below the fold the content fade owns opacity 0; in the entering
    // band no rule claims a value — the owned write is released rather
    // than left at 0 over content the user can now see.
    const f = fixture({
        heroes: [{id: 'h1', top: 500, height: 1000, attrs: {
            contentRect: {top: 1200, height: 300},
            contentStyle: {opacity: '0.9'}
        }}],
        scrollTop: 0
    });
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0',
        'precondition: the below-fold content was faded out');
    f.state.scrollTop = 700;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0.9',
        'the entering band left the owned opacity standing');
});

for (const [label, options] of Object.entries({
    'reduced motion': {reduced: true},
    'an unobservable preference': {matchMedia: 'absent'}
})) {
    test('full-height images follow a resize under ' + label, () => {
        const f = fixture(Object.assign({
            heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}],
            viewportHeight: 600
        }, options));
        assert.equal(f.heroes[0].image.style.height, '600px', 'precondition: bind applied the height');
        assert.equal(f.frames.length, 0, 'an empty motion frame was armed at bind');
        f.state.viewportHeight = 900;
        f.fireResize();
        assert.equal(f.frames.length, 1, 'the resize armed no geometry frame');
        f.reads.bounds = 0;
        f.flushFrames();
        assert.equal(f.heroes[0].image.style.height, '900px',
            'the image height ignored the resize');
        // The bounds the height write moved are never read back in the
        // frame that wrote it: the next frame's read phase measures.
        assert.equal(f.reads.bounds, 0, 'the frame read geometry after its own height write');
        assert.equal(f.frames.length, 1, 'the height write armed no measuring frame');
        f.flushFrames();
        assert.ok(f.reads.bounds > 0, 'the resize never re-measured');
        assert.equal(f.frames.length, 0, 'the measuring frame armed another');
        assert.equal(f.heroes[0].image.style.backgroundAttachment, undefined,
            'the geometry frame wrote a motion effect');
    });
}

test('every armed frame reuses one hoisted callback', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}]
    });
    f.flushFrames();
    f.fireScroll();
    f.flushFrames();
    f.fireResize();
    assert.ok(f.requests.length >= 3, 'precondition: several frames armed');
    assert.ok(f.requests.every(pair => Array.isArray(pair)),
        'a frame was armed outside the phased read/write pair');
    assert.ok(f.requests.every(pair => pair[0] === f.requests[0][0] && pair[1] === f.requests[0][1]),
        'an arming minted a new frame callback');
});

// Late layout: hero bounds measured at bind go stale when a resource
// lands above a hero after it. The document's load re-measures once,
// and the subscription is one-shot; a body ResizeObserver re-measures
// whenever the page grows later. Neither re-measures by itself on
// scroll.
test('the document load re-measures hero bounds once', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600}, {id: 'h2', top: 600, height: 600}],
        readyState: 'interactive'
    });
    f.flushFrames();
    const load = f.subscriptions.filter(s => s.type === 'load');
    assert.equal(load.length, 1, 'no load subscription before the document loaded');
    assert.equal(load[0].count, 1, 'the load subscription is not one-shot');
    f.heroes[1].rect = {top: 1800, height: 600};
    f.heroes[1].content.rect = {top: 1800, height: 600};
    f.reads.bounds = 0;
    load[0].fn({type: 'load'});
    f.flushFrames();
    assert.ok(f.reads.bounds > 0, 'load did not re-measure the heroes');
    // At its real position the second hero fills the viewport: its
    // content is in view, which its bind-time position never shows.
    f.state.scrollTop = 1800;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[1].content.style.opacity, '1',
        'the second hero kept its stale position');
});

test('a module defined after load binds no load subscription', () => {
    const f = fixture({heroes: [{id: 'h1', top: 0, height: 600}]});
    assert.equal(f.subscriptions.filter(s => s.type === 'load').length, 0);
});

test('a body resize re-measures hero bounds', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        resizeObserver: true
    });
    f.flushFrames();
    assert.equal(f.resizeObservers.length, 1, 'no body observer');
    assert.deepEqual(f.resizeObservers[0].targets, [f.bodyEl], 'the observer watches the body alone');
    f.reads.bounds = 0;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.reads.bounds, 0, 'precondition: a scroll does not re-measure');
    f.resizeObservers[0].callback([{target: f.bodyEl}]);
    f.flushFrames();
    assert.ok(f.reads.bounds > 0, 'a body resize did not re-measure the heroes');
});

test('touch devices bind no body observer or load re-measure', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600}],
        touch: true, resizeObserver: true, readyState: 'loading'
    });
    assert.equal(f.resizeObservers.length, 0);
    assert.equal(f.subscriptions.length, 0);
});

test('touch capability comes from paste.has and binds no motion listeners', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        touch: true
    });
    assert.equal(f.subscriptions.length, 0, 'a touch page bound scroll or resize listeners');
    assert.ok(f.heroes[0].classList.contains('paste-ui-hero-touch'),
        'the touch class was not applied');
});

test('an unparseable minimum opacity is the default, not a fade that never writes', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            image: {'data-hero-image-fade': '', 'data-hero-min-opacity': 'abc'}
        }}],
        scrollTop: 300
    });
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '0.5',
        'a malformed minimum silenced the fade');
});

test('the loaded marker is written on a page with no heroes', () => {
    const f = fixture();
    assert.ok(f.htmlClasses.has('paste-ui-heroscroll-loaded'),
        'the root element lost its loaded marker on a hero-less page');
    assert.ok(f.bodyClasses.has('paste-ui-heroscroll-loaded'),
        'body lost its loaded marker on a hero-less page');
    assert.equal(f.subscriptions.length, 0, 'the marker brought listeners with it');
});

test('the loaded marker is written on a page with heroes', () => {
    const f = fixture({heroes: [{id: 'h1', top: 0, height: 600}]});
    assert.ok(f.htmlClasses.has('paste-ui-heroscroll-loaded'));
    assert.ok(f.bodyClasses.has('paste-ui-heroscroll-loaded'));
});

test('heroes without an id are never stamped with one', () => {
    const f = fixture({heroes: [
        {id: '', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600}
    ]});
    assert.equal(f.heroes[0].id, '', 'the first hero was given a generated id');
    assert.equal(f.heroes[1].id, '', 'the second hero was given a generated id');
});

test('a hash click navigates to the next hero\'s fragment', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    const prevented = f.clickHero(f.heroes[0]);
    assert.equal(prevented, true, 'the hero click was not claimed');
    assert.deepEqual(f.navigations, ['#h2'], 'the click did not navigate to the next hero\'s fragment');
    assert.equal(f.scrolled.length, 0, 'a fragment navigation also requested its own scroll');
    assert.equal(f.fired.length, 0, 'the module fired an event of its own');
});

test('a hash click to the fragment already current scrolls the next hero into view', () => {
    const f = fixture({hash: '#h2', heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    assert.equal(f.clickHero(f.heroes[0]), true);
    assert.deepEqual(f.navigations, [], 'the hash setter cannot navigate to the current fragment');
    assert.equal(f.scrolled.length, 1, 'nothing moved the visitor to the next hero');
    assert.equal(f.scrolled[0].el, f.heroes[1]);
    assert.deepEqual(f.scrolled[0].args, [], 'the scroll overrode the page\'s scroll CSS');
});

test('a hash click whose next hero has no id scrolls it into view', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600}
    ]});
    assert.equal(f.clickHero(f.heroes[0]), true, 'the click to an unnamed hero was not claimed');
    assert.deepEqual(f.navigations, [], 'the address changed for a hero with no fragment');
    assert.equal(f.location.hash, '');
    assert.equal(f.scrolled.length, 1);
    assert.equal(f.scrolled[0].el, f.heroes[1]);
    assert.equal(f.heroes[1].id, '', 'the hero was given a generated id');
});

// A hero with no id has no fragment, so its scroll gets an entry of its
// own at the unchanged address, written before the scroll: the entry
// the visitor leaves keeps the position it had, and Back returns to it.
test('a hash click to a hero with no id adds a history entry before it scrolls', () => {
    const state = {route: 'kept'};
    const f = fixture({historyState: state, heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600}
    ]});
    assert.equal(f.clickHero(f.heroes[0]), true);
    assert.equal(f.pushes.length, 1, 'the unnamed hero got no history entry of its own');
    assert.equal(f.pushes[0].state, state, 'the entry dropped the page\'s history state');
    assert.equal(f.pushes[0].url, 'https://www.test.local/page?q=1', 'the entry must keep the current address');
    assert.equal(f.pushes[0].scrolledBefore, 0, 'the entry was written after the scroll it should hold');
    assert.equal(f.scrolled.length, 1);
    assert.equal(f.scrolled[0].el, f.heroes[1]);
    assert.deepEqual(f.navigations, []);
});

// The entry for a hero with no id shows that hero. A fragment that names
// an element — the hero being left, any other id, an a element's name —
// or the top of the document becomes the empty fragment: the address no
// longer names what the entry does not show, and an engine that scrolls
// to an entry's fragment on traversal shows the hero. Other fragments,
// such as multistate tokens, stay, and the '#' always does when present.
test('the entry for a hero with no id empties a fragment that names an element', () => {
    const base = 'https://www.test.local/page?q=1';
    const heroes = id => [
        {id, top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600}
    ];
    const cases = [
        {label: 'the hero being left', hash: '#h2', heroId: 'h2', url: base + '#'},
        {label: 'an encoded hero id', hash: '#caf%C3%A9', heroId: 'café', url: base + '#'},
        {label: 'another element', hash: '#contact', elementIds: ['contact'], url: base + '#'},
        {label: 'an a element\'s name', hash: '#legacy', named: [{name: 'legacy', nodeName: 'A'}], url: base + '#'},
        {label: 'a named form control', hash: '#field', named: [{name: 'field', nodeName: 'INPUT'}], url: base + '#field'},
        {label: 'a quirks-mode name differing in case', hash: '#contact', quirks: true,
            named: [{name: 'Contact', nodeName: 'A', getAttribute: () => 'Contact'}], url: base + '#'},
        {label: 'a quirks-mode name differing by the long s', hash: '#SECTION', quirks: true,
            named: [{name: '\u017Fection', nodeName: 'A', getAttribute: () => '\u017Fection'}], url: base + '#'},
        {label: 'a quirks-mode name that folds by final sigma', hash: '#%CE%A3', quirks: true,
            named: [{name: '\u03C2', nodeName: 'A', getAttribute: () => '\u03C2'}], url: base + '#'},
        {label: 'a quirks-mode Deseret name folding across a surrogate pair', hash: '#%F0%90%90%80x', quirks: true,
            named: [{name: '\uD801\uDC28X', nodeName: 'A', getAttribute: () => '\uD801\uDC28X'}], url: base + '#'},
        {label: 'a lone surrogate, which folds as itself', hash: '#qf', quirks: true,
            named: [{name: 'QF\uD801', nodeName: 'A', getAttribute: () => 'QF\uD801'}], url: base + '#qf'},
        {label: 'the dotless i, which does not fold', hash: '#I', quirks: true,
            named: [{name: '\u0131', nodeName: 'A', getAttribute: () => '\u0131'}], url: base + '#I'},
        {label: 'a standards-mode name differing in case', hash: '#contact',
            named: [{name: 'Contact', nodeName: 'A', getAttribute: () => 'Contact'}], url: base + '#contact'},
        {label: 'the top of the document', hash: '#Top', url: base + '#'},
        {label: 'a multistate token', hash: '#area1:b', url: base + '#area1:b'},
        {label: 'a malformed escape', hash: '#%E0%A4%A', url: base + '#%E0%A4%A'},
        {label: 'the empty fragment', hash: '', emptyFragment: true, url: base + '#'},
        {label: 'no fragment at all', hash: '', url: base}
    ];
    for (const c of cases) {
        const f = fixture({hash: c.hash, heroes: heroes(c.heroId || 'h1'), elementIds: c.elementIds,
            named: c.named, emptyFragment: c.emptyFragment, quirks: c.quirks});
        assert.doesNotThrow(() => f.clickHero(f.heroes[0]), c.label);
        assert.equal(f.pushes.length, 1, c.label);
        assert.equal(f.pushes[0].url, c.url, c.label + ': the entry\'s address');
        assert.equal(f.scrolled.length, 1, c.label);
    }
});

// The hero without an id carries the clearance hook only until the next
// hash click: it is set before the scroll and moves on with each click.
test('the destination class marks the unnamed hero a hash click scrolled to, until the next click', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 1200, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h4', top: 1800, height: 600}
    ]});
    const [first, second, third] = f.heroes;
    second.scrollIntoView = () => f.scrolled.push({el: second, marked: second.classList.contains('paste-ui-hero-destination')});
    f.clickHero(first);
    assert.equal(f.scrolled[0].marked, true, 'the class was not set before the scroll');
    f.clickHero(second);
    assert.equal(second.classList.contains('paste-ui-hero-destination'), false, 'the class stayed on a hero left behind');
    assert.equal(third.classList.contains('paste-ui-hero-destination'), true, 'the next unnamed hero was not marked');
    f.clickHero(third);
    assert.equal(third.classList.contains('paste-ui-hero-destination'), false, 'a click to a hero with an id left the mark');
    assert.equal(f.heroes[3].classList.contains('paste-ui-hero-destination'), false, 'a fragment target was marked');
    assert.deepEqual(f.navigations, ['#h4']);
});

test('a hero with an id, or the fragment already current, adds no entry of the module\'s own', () => {
    const named = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    named.clickHero(named.heroes[0]);
    assert.equal(named.pushes.length, 0, 'a fragment navigation also pushed an entry');
    const current = fixture({hash: '#h2', heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    current.clickHero(current.heroes[0]);
    assert.equal(current.pushes.length, 0, 'the fragment already current pushed an entry');
    assert.equal(current.scrolled.length, 1);
});

test('a history that refuses the entry still scrolls to the hero with no id', () => {
    const f = fixture({historyRefuses: true, heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: '', top: 600, height: 600}
    ]});
    assert.doesNotThrow(() => f.clickHero(f.heroes[0]));
    assert.equal(f.scrolled.length, 1, 'a refused entry stopped the scroll');
});

test('a hash click without a following hero stays native', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}}
    ]});
    assert.equal(f.clickHero(f.heroes[0]), false, 'a click was prevented with no next hero');
    assert.deepEqual(f.navigations, []);
    assert.equal(f.scrolled.length, 0);
});

test('the next hero is resolved when the click happens', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    const [first, second] = f.heroes;
    // A hero inserted after discovery is the one navigated to.
    const inserted = {id: 'h3', nodeType: 1, isConnected: true, nextElementSibling: second,
        classList: {contains: c => c === 'paste-ui-hero'}};
    first.nextElementSibling = inserted;
    assert.equal(f.clickHero(first), true);
    assert.deepEqual(f.navigations, ['#h3'], 'the click went to the hero frozen at discovery');
    // A sibling that is not a hero is not navigated to.
    first.nextElementSibling = {id: 'x', nodeType: 1, classList: {contains: () => false}};
    assert.equal(f.clickHero(first), false, 'a click navigated to a sibling that is not a hero');
    // A detached hero is not navigated to.
    second.isConnected = false;
    first.nextElementSibling = second;
    assert.equal(f.clickHero(first), false, 'a click navigated to a disconnected hero');
    // An id removed since discovery leaves a scroll, not a fragment.
    second.isConnected = true;
    second.id = '';
    assert.equal(f.clickHero(first), true);
    assert.deepEqual(f.navigations, ['#h3']);
    assert.equal(f.scrolled.length, 1);
    assert.equal(f.scrolled[0].el, second);
});

test('a click inside an interactive element in the hero is never prevented', () => {
    const interactiveShapes = {
        'a link with href': {tagName: 'A', attrs: {href: '/elsewhere'}},
        'a button': {tagName: 'BUTTON'},
        'an input': {tagName: 'INPUT'},
        'a select': {tagName: 'SELECT'},
        'a textarea': {tagName: 'TEXTAREA'},
        'a label': {tagName: 'LABEL'},
        'a summary': {tagName: 'SUMMARY'},
        'an area with href': {tagName: 'AREA', attrs: {href: '/map'}},
        'an SVG link with href': {tagName: 'a', attrs: {href: '#s'}},
        'an SVG link with xlink:href': {tagName: 'a', attrs: {'xlink:href': '#s'}},
        'an audio with controls': {tagName: 'AUDIO', attrs: {controls: ''}},
        'a video with controls': {tagName: 'VIDEO', attrs: {controls: ''}},
        'an iframe': {tagName: 'IFRAME'},
        'an object': {tagName: 'OBJECT'},
        'an embed': {tagName: 'EMBED'},
        'a tabindex element': {tagName: 'DIV', attrs: {tabindex: '0'}},
        'a contenteditable element': {tagName: 'DIV', attrs: {contenteditable: ''}}
    };
    for (const [label, shape] of Object.entries(interactiveShapes)) {
        const f = fixture({heroes: [
            {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
            {id: 'h2', top: 600, height: 600}
        ]});
        const attrs = shape.attrs || {};
        const control = {
            nodeType: 1, tagName: shape.tagName, parentNode: f.heroes[0],
            hasAttribute: k => Object.prototype.hasOwnProperty.call(attrs, k)
        };
        // The click lands on a text-bearing child of the control.
        const span = {nodeType: 1, tagName: 'SPAN', parentNode: control, hasAttribute: () => false};
        assert.equal(f.clickHero(f.heroes[0], span), false,
            label + ': the module prevented a click an interactive element owns');
        assert.deepEqual(f.navigations, [], label + ': the hero navigated over an interactive click');
        assert.equal(f.scrolled.length, 0, label + ': the hero scrolled over an interactive click');
    }
    // An anchor without href is not interactive: the hero still claims it.
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    const bare = {nodeType: 1, tagName: 'A', parentNode: f.heroes[0], hasAttribute: () => false};
    assert.equal(f.clickHero(f.heroes[0], bare), true, 'a plain anchor without href blocked the hash click');
    // Media without controls is not interactive either.
    const g = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    const video = {nodeType: 1, tagName: 'VIDEO', parentNode: g.heroes[0], hasAttribute: () => false};
    assert.equal(g.clickHero(g.heroes[0], video), true, 'a video without controls blocked the hash click');
});

test('a control inside a shadow root owns its click through the composed path', () => {
    const f = fixture({heroes: [
        {id: 'h1', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'h2', top: 600, height: 600}
    ]});
    const hero = f.heroes[0];
    // Retargeted to the host, the event target is a plain element; the
    // composed path still names the button inside the shadow root.
    const host = {nodeType: 1, tagName: 'X-WIDGET', parentNode: hero, hasAttribute: () => false};
    const shadowRoot = {nodeType: 11};
    const button = {nodeType: 1, tagName: 'BUTTON', parentNode: shadowRoot, hasAttribute: () => false};
    assert.equal(f.clickHero(hero, host, [button, shadowRoot, host, hero, {nodeType: 9}]), false,
        'the module prevented a click a shadow-root button owns');
    assert.deepEqual(f.navigations, []);
    assert.equal(f.scrolled.length, 0);
    // The walk stops at the hero: what lies above it never counts.
    const above = {nodeType: 1, tagName: 'DIV', hasAttribute: k => k === 'tabindex'};
    assert.equal(f.clickHero(hero, host, [host, hero, above]), true,
        'an interactive ancestor above the hero blocked the hash click');
});

test('a percentage background position is not read as pixels', () => {
    // center → '50% 50%': the parallax base is 0, never 50px.
    const pct = fixture({
        heroes: [{id: 'h1', top: 0, height: 600}],
        scrollTop: 300, backgroundPosition: '50% 50%'
    });
    const px = fixture({
        heroes: [{id: 'h1', top: 0, height: 600}],
        scrollTop: 300, backgroundPosition: '50% 0px'
    });
    pct.flushFrames();
    px.flushFrames();
    assert.ok(px.heroes[0].image.style.backgroundPosition, 'precondition: the parallax wrote');
    assert.equal(pct.heroes[0].image.style.backgroundPosition,
        px.heroes[0].image.style.backgroundPosition,
        'a 50% vertical position moved the parallax base by 50px');
});

test('a px background position is the parallax base', () => {
    const base = fixture({heroes: [{id: 'h1', top: 0, height: 600}], backgroundPosition: '50% 0px', scrollTop: 300});
    const shifted = fixture({heroes: [{id: 'h1', top: 0, height: 600}], backgroundPosition: '0px 40px', scrollTop: 300});
    base.flushFrames();
    shifted.flushFrames();
    const y = f => Number(/ (-?\d+)px$/.exec(f.heroes[0].image.style.backgroundPosition)[1]);
    assert.equal(y(shifted) - y(base), 40, 'the authored px offset was not the base');
});

test('a multi-layer background position contributes no base offset', () => {
    const base = fixture({heroes: [{id: 'h1', top: 0, height: 600}], backgroundPosition: '50% 0px', scrollTop: 300});
    const layered = fixture({heroes: [{id: 'h1', top: 0, height: 600}], scrollTop: 300,
        backgroundPosition: '0px 40px, 50% 50%'});
    base.flushFrames();
    layered.flushFrames();
    assert.ok(base.heroes[0].image.style.backgroundPosition, 'precondition: the parallax wrote');
    assert.equal(layered.heroes[0].image.style.backgroundPosition,
        base.heroes[0].image.style.backgroundPosition,
        'a multi-layer value was half-parsed into a base offset');
});

test('the base offset is read once, never from the module\'s own write', () => {
    const f = fixture({heroes: [{id: 'h1', top: 0, height: 600}], backgroundPosition: '50% 0px', scrollTop: 0});
    f.flushFrames();
    const first = f.heroes[0].image.style.backgroundPosition;
    f.reads.computedStyle = 0;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.backgroundPosition, first,
        'a resize re-read the parallax write as the authored base');
});

test('a jump past the fade floor still writes the floor', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            image: {'data-hero-image-fade': '', 'data-hero-min-opacity': '0.4'}
        }}],
        scrollTop: 0
    });
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '1', 'precondition: the fade began at full opacity');
    // One frame from fully visible to almost gone: the raw fade value
    // (0.1) is below the floor, and the floor must land.
    f.state.scrollTop = 540;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '0.4',
        'the image kept its last opacity above the floor');
});

test('a minimum opacity above 1 is the default', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            image: {'data-hero-image-fade': '', 'data-hero-min-opacity': '2'}
        }}],
        scrollTop: 300
    });
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '0.5',
        'an out-of-range minimum pinned the fade');
});

test('a minimum opacity of 1 holds the image opaque', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {
            image: {'data-hero-image-fade': '', 'data-hero-min-opacity': '1'}
        }}],
        scrollTop: 300
    });
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.opacity, '1');
});

test('touch devices follow resizes for full-height images', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}],
        viewportHeight: 600, viewportWidth: 400, touch: true
    });
    assert.equal(f.heroes[0].image.style.height, '600px', 'precondition: bind applied the height');
    assert.deepEqual(f.subscriptions.map(s => s.type), ['resize'],
        'a touch page bound more than the geometry resize');
    f.state.viewportHeight = 420;
    f.state.viewportWidth = 700;
    f.reads.bounds = 0;
    f.reads.computedStyle = 0;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '420px', 'an orientation change left the height stale');
    assert.equal(f.reads.bounds + f.reads.computedStyle, 0, 'a touch resize measured for motion');
    assert.equal(f.heroes[0].image.style.opacity, undefined, 'a touch frame wrote a motion effect');
});

test('owned writes are not read back; the declaration is read only at release', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        scrollTop: 300
    });
    f.flushFrames();
    const style = f.heroes[0].image.style;
    const original = style.getPropertyValue;
    let reads = 0;
    style.getPropertyValue = n => { reads += 1; return original(n); };
    for (const top of [100, 200, 350, 420]) {
        f.state.scrollTop = top;
        f.fireScroll();
        f.flushFrames();
    }
    assert.equal(reads, 0, 'the frame read back its own writes ' + reads + ' times');
    f.setReduced(true);
    assert.ok(reads > 0, 'the release never checked ownership');
    assert.equal(style.opacity, '', 'the release did not restore the authored opacity');
});

test('a touch height-only resize keeps the full-height override', () => {
    // The mobile toolbar collapsing mid-scroll changes only the height:
    // re-sizing the hero would shift everything below it.
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}],
        viewportHeight: 600, viewportWidth: 400, touch: true, orientation: 'portrait-primary'
    });
    f.state.viewportHeight = 680;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '600px', 'a toolbar resize re-sized the hero');
    f.state.viewportHeight = 380;
    f.state.orientation = 'landscape-primary';
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '380px', 'an orientation change left the height stale');
    // A width change after a toolbar-only change still re-applies.
    f.state.viewportHeight = 420;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '380px');
    f.state.viewportWidth = 900;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '420px', 'a width change left the height stale');
});

test('a non-touch height-only resize still follows the viewport', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}],
        viewportHeight: 600
    });
    f.state.viewportHeight = 700;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '700px');
});

test('scroll input reads the kept preference, not the media query', () => {
    let reads = 0;
    const listeners = [];
    const mql = {
        get matches() { reads += 1; return false; },
        addEventListener: (t, fn) => listeners.push(fn)
    };
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        matchMedia: () => mql
    });
    f.flushFrames();
    reads = 0;
    for (let n = 0; n < 10; n += 1) {
        f.state.scrollTop = 10 * n;
        f.fireScroll();
        assert.equal(f.frames.length, 1, 'precondition: the scroll armed a frame');
        f.flushFrames();
    }
    assert.equal(reads, 10, 'ten scroll frames read the media query ' + reads + ' times, not once each');
});

test('a preference read that throws never escapes a frame', () => {
    let poisoned = false;
    const mql = {
        get matches() {
            if (poisoned) { throw new Error('matches poisoned'); }
            return false;
        },
        addEventListener() {}
    };
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {'data-hero-image-fade': ''}}}],
        matchMedia: () => mql
    });
    f.flushFrames();
    poisoned = true;
    f.state.scrollTop = 300;
    f.fireScroll();
    assert.doesNotThrow(() => f.flushFrames(), 'the preference read escaped the frame');
    assert.doesNotThrow(() => { f.fireScroll(); f.flushFrames(); },
        'the preference read escaped a later scroll');
});

test('the parallax writes its attachment once and skips an unchanged rounded offset', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {}}}]
    });
    const writes = [];
    const style = f.heroes[0].image.style;
    const set = style.setProperty;
    style.setProperty = (n, v, p) => { writes.push(n + '=' + v); set(n, v, p); };
    f.flushFrames();
    for (const top of [100, 200, 300]) {
        f.state.scrollTop = top;
        f.fireScroll();
        f.flushFrames();
    }
    assert.equal(writes.filter(w => w.indexOf('background-attachment') === 0).length, 1,
        'the attachment was rewritten on every move: ' + writes.join(' '));
    const positions = writes.filter(w => w.indexOf('background-position') === 0).length;
    // A sub-pixel move rounds to the same offset and writes nothing.
    f.state.scrollTop = 300.4;
    f.fireScroll();
    f.flushFrames();
    assert.equal(writes.filter(w => w.indexOf('background-position') === 0).length, positions,
        'an unchanged rounded offset was rewritten');
    // A restore and resume re-owns the attachment.
    f.setReduced(true);
    f.setReduced(false);
    f.state.scrollTop = 200;
    f.fireScroll();
    f.flushFrames();
    assert.equal(style.backgroundAttachment, 'fixed', 'a resumed parallax did not re-own its attachment');
});

test('fractional content margins are kept, not truncated', () => {
    const f = fixture({
        heroes: [{id: 'h1', top: 0, height: 600, attrs: {image: {}}}],
        computed: {'margin-top': '100.5px'},
        scrollTop: 300
    });
    f.flushFrames();
    // Visible band: top 100.5, height 499.5; 199.5px of it has left.
    assert.equal(f.heroes[0].content.style.opacity, String(Math.round((1 - 199.5 / 499.5) * 1000) / 1000),
        'the fade used a truncated margin');
});

// The old image filter remains a discrete fallback, with no simulated rendering.
test('a host without background-size keeps the declared image in its legacy filter', () => {
    const f = fixture({backgroundSizeSupported: false,
        computed: {'background-image': 'url("https://example.test/hero.png")'},
        heroes: [{id: 'hero', top: 0, height: 600}]});
    assert.equal(f.heroes[0].image.style.backgroundImage, 'none');
    assert.equal(f.heroes[0].image.style.filter,
        "progid:DXImageTransform.Microsoft.AlphaImageLoader(src='https://example.test/hero.png', sizingMethod='scale');");
});

test('a legacy numeric orientation change recalibrates a full-height touch hero', () => {
    const f = fixture({touch: true, legacyOrientation: 0, viewportWidth: 600, viewportHeight: 600,
        heroes: [{id: 'hero', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}]});
    assert.equal(f.heroes[0].image.style.height, '600px');
    f.state.viewportHeight = 400;
    f.state.legacyOrientation = 90;
    f.fireResize();
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.height, '400px');
});

test('scrolling after a hero recalibration does not remeasure bounds', () => {
    const f = fixture({heroes: [{id: 'hero', top: 100, height: 600}]});
    f.flushFrames();
    f.fireResize();
    f.flushFrames();
    f.reads.bounds = 0;
    f.state.scrollTop = 200;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.reads.bounds, 0);
});

test('hash-click traversal passes non-element nodes and respects a deeper control', () => {
    const f = fixture({heroes: [
        {id: 'one', top: 0, height: 600, attrs: {hero: {'data-hero-hashclick': ''}}},
        {id: 'two', top: 600, height: 600}
    ]});
    const hero = f.heroes[0];
    const span = {nodeType: 1, tagName: 'SPAN', hasAttribute: () => false};
    const shadow = {nodeType: 11};
    const button = {nodeType: 1, tagName: 'BUTTON', hasAttribute: () => false};
    assert.equal(f.clickHero(hero, span, [span, button, shadow, hero]), false);
    assert.equal(f.clickHero(hero, span, [span, shadow, hero]), true);
});

test('a hero with no content still measures and paints its background', () => {
    const f = fixture({heroes: [{id: 'hero', top: 0, height: 600}],
        scrollTop: 200, arrange(heroes) { heroes[0].content = null; },
        computed: {'background-position': '50% 0px'}});
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.backgroundPosition, '50% -60px');
});

test('parallax caps the image at its document top and rounds either side of the origin', () => {
    for (const [scrollTop, backgroundY, expected] of [
        [0, 20, 0], [2, 0, -1], [0.5, 0.6, 0], [1.5, 0.6, 0],
        [0, -0.7, 0], [0.5, -0.3, -1], [200, 20, -40]
    ]) {
        const f = fixture({heroes: [{id: 'hero', top: 0, height: 600}], scrollTop,
            backgroundPosition: '50% ' + backgroundY + 'px'});
        f.flushFrames();
        assert.equal(f.heroes[0].image.style.backgroundPosition, '50% ' + expected + 'px',
            JSON.stringify({scrollTop, backgroundY}));
    }
});

test('each hero evaluates its own content fade against the first hero offset', () => {
    const f = fixture({scrollTop: 150, heroes: [
        {id: 'one', top: 100, height: 600, attrs: {contentRect: {top: 100, height: 1000}, contentStyle: {opacity: '0.8'}}},
        {id: 'two', top: 300, height: 200, attrs: {contentRect: {top: 300, height: 200}}}
    ]});
    f.flushFrames();
    assert.equal(f.heroes[1].content.style.opacity, '1');
    assert.equal(f.heroes[0].content.style.opacity, '0.85');
    f.state.scrollTop = 0;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0.8', 'entering content restores its authored opacity');
    f.state.scrollTop = 150;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0.85');
});

test('a full-height recalibration does not write an unchanged height again', () => {
    const f = fixture({heroes: [{id: 'hero', top: 0, height: 600, attrs: {image: {'force-full-height': ''}}}]});
    f.flushFrames();
    const image = f.heroes[0].image;
    let height = image.style.height, writes = 0;
    Object.defineProperty(image.style, 'height', {get: () => height, set(value) { height = value; writes += 1; }});
    f.state.viewportHeight = 700;
    f.fireResize();
    f.flushFrames();
    assert.equal(height, '700px');
    assert.equal(writes, 1);
    f.fireResize();
    f.flushFrames();
    assert.equal(writes, 1);
});

test('returning from reduced motion reclaims the same content opacity', () => {
    const f = fixture({heroes: [{id: 'hero', top: 0, height: 600, attrs: {contentStyle: {opacity: '0.8'}}}], scrollTop: 300});
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0.5');
    f.setReduced(true);
    assert.equal(f.heroes[0].content.style.opacity, '0.8');
    f.setReduced(false);
    f.flushFrames();
    assert.equal(f.heroes[0].content.style.opacity, '0.5');
});

test('negative document origins keep below-band parallax at full speed and retire content above the offset', () => {
    const f = fixture({heroes: [
        {id: 'origin', top: -700, height: 800},
        {id: 'visible', top: 300, height: 300}
    ]});
    f.flushFrames();
    assert.equal(f.heroes[1].image.style.backgroundPosition, '50% 300px');
    f.state.scrollTop = 100;
    f.fireScroll();
    f.flushFrames();
    assert.equal(f.heroes[1].image.style.backgroundPosition, '50% 200px');
});

test('a short hero uses its bottom edge for parallax', () => {
    const f = fixture({heroes: [{id: 'hero', top: 0, height: 400}], scrollTop: 100});
    f.flushFrames();
    assert.equal(f.heroes[0].image.style.backgroundPosition, '50% -90px');
});

test('content above a positive first-hero offset is fully faded', () => {
    const f = fixture({heroes: [
        {id: 'origin', top: 500, height: 600},
        {id: 'overlap', top: 100, height: 200, attrs: {contentStyle: {opacity: '0.8'}}}
    ]});
    f.flushFrames();
    assert.equal(f.heroes[1].content.style.opacity, '0');
});
