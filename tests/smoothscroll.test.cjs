const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The smoothscroll contract: fragment navigation is the browser's. The
// module never prevents a click, never writes history and never
// requests a scroll; after an accepted same-document fragment click it
// waits for the navigation to land — hashchange for a new fragment, a
// task for the fragment already current — and moves focus to the
// target. The fake host below plays the browser's part: a click its
// listeners leave unprevented navigates, which changes the address and
// fires hashchange only when the fragment changes. Motion, clearance,
// :target and history traversal are exercised on real engines in
// ElementsBrowserChecks.

function fixture(options = {}) {
    const listeners = {};
    const timers = [];

    const byId = options.elements || {};
    const state = {hash: options.hash || ''};

    function anchor(href, extras) {
        // jsdom-free URL decomposition for the click-path checks.
        const m = /^((https?:)\/\/([^/:]+)(:\d+)?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href) || [];
        const attrs = (extras && extras.attrs) || {};
        return {
            nodeName: 'A',
            href,
            hash: m[7] || '',
            protocol: m[2] || 'http:',
            hostname: m[3] || 'www.test.local',
            port: (m[4] || '').slice(1),
            pathname: m[5] || '/',
            search: m[6] || '',
            target: (extras && extras.target) || '',
            parentNode: null,
            closest: () => null,
            hasAttribute: name => attrs.hasOwnProperty(name) ||
                (name === 'target' && extras !== undefined && extras.target !== undefined)
        };
    }

    const section = {
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener() {}
    };

    const refuse = what => () => { throw new Error(what + ' is the browser\'s, never the module\'s'); };
    const window = {
        location: {
            hostname: 'www.test.local',
            protocol: 'http:',
            port: '',
            pathname: '/',
            search: options.search || '',
            get hash() { return state.hash; }
        },
        history: {pushState: refuse('pushState'), replaceState: refuse('replaceState')},
        setTimeout: options.noTimers ? undefined : (fn, delay) => { timers.push({fn, delay}); return timers.length; },
        scrollTo: refuse('scrollTo'),
        addEventListener: (t, fn) => { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn); },
        removeEventListener: (t, fn) => {
            const list = listeners['win:' + t] || [];
            const at = list.indexOf(fn);
            if (at >= 0) { list.splice(at, 1); }
        },
        matchMedia: refuse('the CSS motion policy'),
        name: options.windowName || ''
    };
    // A top-level window is its own parent and top; a framed one is not.
    window.parent = options.framed ? {} : window;
    window.top = options.framed ? window.parent : window;

    const document = {
        title: 't',
        // The focused element, as a target() records it.
        get activeElement() {
            return Object.keys(byId).map(id => byId[id]).find(el => el && el.focused) || null;
        },
        getElementById: id => byId[id] || null,
        getElementsByName: name => (options.named || []).filter(el => el.getAttribute('name') === name),
        getElementsByTagName: tag => tag === 'a' ? (options.named || []).filter(el => el.nodeName === 'A') : [],
        compatMode: options.quirks ? 'BackCompat' : 'CSS1Compat',
        addEventListener: (t, fn) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
        removeEventListener: (t, fn) => {
            const list = listeners['doc:' + t] || [];
            const at = list.indexOf(fn);
            if (at >= 0) { list.splice(at, 1); }
        },
        querySelector: sel => {
            if (sel === ':target') {
                // The browser's own target, as a test plants it; an engine
                // without :target support throws.
                if (options.targetUnsupported) { throw new SyntaxError(':target'); }
                return options.browserTarget ? options.browserTarget() : null;
            }
            return sel === 'base[target]' && options.baseTarget ? {target: options.baseTarget} : null;
        }
    };

    const dom = {
        querySelectorAll: sel => sel === '[data-paste-smoothscroll]'
            ? (options.declarations === undefined ? [section] : options.declarations)
            : (options.navDeclarations || [])
    };
    const event = {Event: {}};
    event.Event.Subscription = function (type, el, fn) {
        el.addEventListener(type, fn);
        // Disposal is faithful: the native listener leaves with it.
        this.dispose = () => el.removeEventListener(type, fn);
    };

    Object.values(byId).forEach(el => {
        el.scrollIntoView = refuse('scrollIntoView');
    });
    const ns = {};
    vm.runInNewContext(
        readModuleSource('paste/ui/smoothscroll.js'),
        {
            window, document,
            history: window.history,
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.smoothscroll');
                assert.equal(deps.join('|'), 'paste.dom|paste.event');
                factory(ns, dom, event);
            }},
            setTimeout: refuse('the global setTimeout')
        }
    );

    const fireWindow = name => (listeners['win:' + name] || []).slice().forEach(fn => fn({type: name}));
    // The browser's part after the listeners return: an unprevented
    // click on a same-document fragment changes the address, and a
    // changed fragment fires hashchange.
    const navigate = hash => {
        if (state.hash !== hash) {
            state.hash = hash;
            fireWindow('hashchange');
        }
    };

    return {
        section, state, ns, listeners, byId, window, timers, anchor, navigate, fireWindow,
        // The click as the listeners see it; the event object stays
        // readable after dispatch, as a real one does.
        dispatch: (target, mods) => {
            const ev = {
                type: 'click', target,
                defaultPrevented: false,
                preventDefault: () => { ev.defaultPrevented = true; }
            };
            Object.assign(ev, mods || {});
            (listeners.click || []).slice().forEach(fn => fn(ev));
            return ev;
        },
        // A primary click the browser then navigates; returns whether
        // any listener prevented it.
        click(a, mods) {
            const ev = this.dispatch(a, mods);
            if (!ev.defaultPrevented) {
                navigate(a.hash);
            }
            return ev.defaultPrevented;
        },
        flushTimers: () => timers.splice(0).forEach(t => t.fn()),
        watchers: () => (listeners['win:hashchange'] || []).length
    };
}

function target(env) {
    env = env || {};
    const attrs = env.attrs || {};
    const listeners = {};
    const t = {
        id: env.id || 'section-b',
        tagName: env.tagName || 'DIV',
        disabled: env.disabled === true,
        focused: false,
        focusArgs: undefined,
        hasAttribute: n => attrs.hasOwnProperty(n),
        getAttribute: n => attrs[n] === undefined ? null : attrs[n],
        setAttribute: (n, v) => { attrs[n] = v; },
        removeAttribute: n => { delete attrs[n]; },
        addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); },
        removeEventListener: (n, fn) => {
            const list = listeners[n];
            if (list) { const i = list.indexOf(fn); if (i >= 0) { list.splice(i, 1); } }
        },
        fire: (n, how) => {
            if (n === 'blur' && !(how && how.keepFocus)) { t.focused = false; }
            (listeners[n] || []).slice().forEach(fn => fn({type: n}));
        },
        listenerCount: n => (listeners[n] || []).length,
        focus: arg => { t.focused = true; t.focusArgs = arg; }
    };
    return t;
}

test('a same-document fragment click stays native and focuses its target once it lands', () => {
    const f = fixture({elements: {'section-b': target()}});
    const el = f.byId['section-b'];
    const ev = f.dispatch(f.anchor('/#section-b'));
    assert.equal(ev.defaultPrevented, false, 'the module prevented the browser\'s fragment navigation');
    assert.equal(el.focused, false, 'focus moved before the navigation landed');
    assert.equal(f.watchers(), 1, 'no arrival watcher waited on the navigation');
    f.navigate('#section-b');
    assert.equal(el.focused, true, 'the landed navigation did not focus its target');
    assert.equal(el.focusArgs && el.focusArgs.preventScroll, true,
        'focusing was allowed to move the browser\'s scroll position');
    assert.equal(f.watchers(), 0, 'the arrival watcher outlived its navigation');
});

test('the module writes no history and requests no scroll', () => {
    // The fake history and scroll methods throw: any call fails the click.
    const f = fixture({elements: {'section-b': target()}});
    assert.doesNotThrow(() => f.click(f.anchor('/#section-b')));
    assert.equal(f.byId['section-b'].focused, true);
});

test('a modified click gets no focus handling', () => {
    const f = fixture({elements: {'section-b': target()}});
    for (const mods of [{metaKey: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}]) {
        const ev = f.dispatch(f.anchor('/#section-b'), mods);
        assert.equal(ev.defaultPrevented, false, 'prevented default on ' + JSON.stringify(mods));
        assert.equal(f.watchers(), 0, 'watched for an arrival on ' + JSON.stringify(mods));
    }
});

test('a foreign or cross-path link gets no focus handling', () => {
    const f = fixture({elements: {'section-b': target()}});
    for (const href of [
        'http://other.host/#section-b',
        'https://www.test.local/#section-b',
        '/other-page#section-b',
        'http://www.test.local:8080/#section-b'
    ]) {
        assert.equal(f.dispatch(f.anchor(href)).defaultPrevented, false, 'prevented default on ' + href);
        assert.equal(f.watchers(), 0, 'watched for an arrival on ' + href);
    }
});

test('a missing fragment, a bare hash and a non-link click get no focus handling', () => {
    const f = fixture({elements: {'section-b': target()}});
    assert.doesNotThrow(() => f.click(f.anchor('/#nowhere')), 'a missing target threw inside the click path');
    f.click(f.anchor('/#'));
    f.dispatch({nodeName: 'DIV', parentNode: null});
    assert.equal(f.watchers(), 0);
    assert.equal(f.timers.length, 0);
});

test('the module exposes no imperative scroll surface', () => {
    const f = fixture();
    assert.deepEqual(Object.keys(f.ns), []);
});

test('a click on a nested element still resolves its anchor', () => {
    const f = fixture({elements: {'section-b': target()}});
    const a = f.anchor('/#section-b');
    f.dispatch({nodeName: 'SPAN', parentNode: a});
    f.navigate('#section-b');
    assert.equal(f.byId['section-b'].focused, true, 'a click inside the anchor was not followed to its target');
});

test('a non-current browsing context, a base target and a download get no focus handling', () => {
    for (const t of ['_blank', '_BLANK', 'frame-name']) {
        const f = fixture({elements: {'section-b': target()}});
        f.dispatch(f.anchor('/#section-b', {target: t}));
        assert.equal(f.watchers(), 0, 'watched for an arrival on target=' + t);
    }
    for (const t of ['_parent', '_top']) {
        const f = fixture({elements: {'section-b': target()}, framed: true});
        f.dispatch(f.anchor('/#section-b', {target: t}));
        assert.equal(f.watchers(), 0, 'a framed document watched for an arrival on target=' + t);
    }
    const renamed = fixture({elements: {'section-b': target()}, windowName: 'main'});
    renamed.dispatch(renamed.anchor('/#section-b', {target: 'MAIN'}));
    assert.equal(renamed.watchers(), 0, 'a browsing-context name matched without regard to case');
    const based = fixture({elements: {'section-b': target()}, baseTarget: '_blank'});
    based.dispatch(based.anchor('/#section-b'));
    assert.equal(based.watchers(), 0, 'an authored base target was watched');
    const download = fixture({elements: {'section-b': target()}});
    download.dispatch(download.anchor('/#section-b', {attrs: {download: 'pose.png'}}));
    assert.equal(download.watchers(), 0, 'a download contract was watched');
});

// The rules for choosing a browsing context: _parent and _top name the
// current one in a top-level document, and so does the window's own
// name. A link's own target attribute, even an empty one, outranks the
// base target.
test('a target that names the current browsing context is handled like none', () => {
    for (const t of ['_self', '_SELF', '_parent', '_top', '_Top']) {
        const f = fixture({elements: {'section-b': target()}});
        f.dispatch(f.anchor('/#section-b', {target: t}));
        f.navigate('#section-b');
        assert.equal(f.byId['section-b'].focused, true, 'a top-level target=' + t + ' moved no focus');
    }
    const named = fixture({elements: {'section-b': target()}, windowName: 'main'});
    named.dispatch(named.anchor('/#section-b', {target: 'main'}));
    named.navigate('#section-b');
    assert.equal(named.byId['section-b'].focused, true, 'the window\'s own name moved no focus');
    const emptied = fixture({elements: {'section-b': target()}, baseTarget: '_blank'});
    emptied.dispatch(emptied.anchor('/#section-b', {target: ''}));
    emptied.navigate('#section-b');
    assert.equal(emptied.byId['section-b'].focused, true, 'an empty target attribute deferred to the base target');
});

// The browser's fragment lookup: an id first, then the first a element
// with that name; other named elements are not fragment targets.
test('a fragment naming an a element focuses it when no id matches', () => {
    const input = target({id: '', tagName: 'INPUT', attrs: {name: 'legacy'}});
    input.nodeName = 'INPUT';
    const named = target({id: '', tagName: 'A', attrs: {name: 'legacy'}});
    named.nodeName = 'A';
    const f = fixture({elements: {}, named: [input, named]});
    f.dispatch(f.anchor('/#legacy'));
    f.navigate('#legacy');
    assert.equal(input.focused, false, 'a named form control was taken as the fragment target');
    assert.equal(named.focused, true, 'the named a element was not focused');
    assert.equal(named.focusArgs && named.focusArgs.preventScroll, true);
    const byId = fixture({elements: {legacy: target({id: 'legacy'})}, named: [named]});
    named.focused = false;
    byId.dispatch(byId.anchor('/#legacy'));
    byId.navigate('#legacy');
    assert.equal(byId.byId.legacy.focused, true, 'an id did not outrank a name');
    assert.equal(named.focused, false, 'a name outranked an id');
});

// Quirks mode: some engines also match an a element's name regardless of
// case and navigate to it, others find nothing. The module looks the name
// up the same way and lets the browser's :target decide.
test('a quirks-mode name differing in case focuses only the element the browser targeted', () => {
    const anchor = (name, id) => {
        const named = target({id: id || '', tagName: 'A', attrs: {name}});
        named.nodeName = 'A';
        return named;
    };
    // An engine that folds case targets the anchor and the module focuses it.
    const sec = anchor('Sec');
    const quirks = fixture({elements: {}, named: [sec], quirks: true, browserTarget: () => sec});
    quirks.dispatch(quirks.anchor('/#sec'));
    quirks.navigate('#sec');
    assert.equal(sec.focused, true, 'the anchor the browser targeted was not focused');
    // An engine that does not fold targets nothing; no focus moves.
    const ignored = anchor('Sec');
    const other = fixture({elements: {}, named: [ignored], quirks: true});
    other.dispatch(other.anchor('/#sec'));
    other.navigate('#sec');
    assert.equal(ignored.focused, false, 'an anchor the browser did not target took focus');
    const standards = fixture({elements: {}, named: [anchor('Sec')]});
    standards.dispatch(standards.anchor('/#sec'));
    assert.equal(standards.watchers(), 0, 'a standards-mode name differing in case was taken as a target');
});

// Chromium folds quirks-mode names with Unicode simple case folding: the
// long s, the Kelvin sign, final sigma, the micro sign and letters outside
// the basic plane (Deseret, Adlam: one code point, two code units) match
// their letters; the dotless i, the sharp s against 'ss' and a lone
// surrogate do not.
test('quirks-mode names fold as the engine folds them', () => {
    const cases = [
        {name: 'qf-\u017Fong', hash: '#QF-SONG', folds: true},
        {name: 'qf-\u212Aelvin', hash: '#qf-kelvin', folds: true},
        {name: 'qf-\u03C2', hash: '#qf-%CE%A3', folds: true},
        {name: 'qf-\u00B5', hash: '#qf-%CE%BC', folds: true},
        {name: 'qf-\uD801\uDC28x', hash: '#qf-%F0%90%90%80x', folds: true},
        {name: 'qf-\uD83A\uDD22', hash: '#qf-%F0%9E%A4%80', folds: true},
        {name: 'qf-\uD801x', hash: '#QF-%ED%A0%81X', folds: false},
        {name: 'qf-\u0131', hash: '#qf-I', folds: false},
        {name: 'qf-\u00DF', hash: '#qf-ss', folds: false}
    ];
    for (const c of cases) {
        const named = target({id: 'a', tagName: 'A', attrs: {name: c.name}});
        named.nodeName = 'A';
        const f = fixture({elements: {}, named: [named], quirks: true, browserTarget: () => named});
        f.dispatch(f.anchor('/' + c.hash));
        assert.equal(f.watchers(), c.folds ? 1 : 0, c.name + ' against ' + c.hash + ': the lookup');
        f.navigate(c.hash);
        assert.equal(named.focused, c.folds, c.name + ' against ' + c.hash + ': focus');
    }
});

// A folding engine takes the first case-insensitive match, even ahead of
// an exact one; focus follows that :target, not the exact lookup.
test('in quirks mode focus follows the browser\'s first case-folded target ahead of an exact name', () => {
    const upper = target({id: 'upper', tagName: 'A', attrs: {name: 'SEC'}});
    upper.nodeName = 'A';
    const lower = target({id: 'lower', tagName: 'A', attrs: {name: 'sec'}});
    lower.nodeName = 'A';
    const folding = fixture({elements: {}, named: [upper, lower], quirks: true, browserTarget: () => upper});
    folding.dispatch(folding.anchor('/#sec'));
    folding.navigate('#sec');
    assert.equal(upper.focused, true, 'the browser\'s own target was not focused');
    assert.equal(lower.focused, false, 'the exact lookup took focus the browser gave elsewhere');
    // An engine matching exactly targets the lower anchor.
    lower.focused = false; upper.focused = false;
    const exact = fixture({elements: {}, named: [upper, lower], quirks: true, browserTarget: () => lower});
    exact.dispatch(exact.anchor('/#sec'));
    exact.navigate('#sec');
    assert.equal(lower.focused, true);
    assert.equal(upper.focused, false);
});

test('in quirks mode a stale or unrelated :target takes no focus, and no :target support keeps the lookup', () => {
    const lower = target({id: 'lower', tagName: 'A', attrs: {name: 'sec'}});
    lower.nodeName = 'A';
    const stale = target({id: 'elsewhere'});
    const f = fixture({elements: {}, named: [lower], quirks: true, browserTarget: () => stale});
    f.dispatch(f.anchor('/#sec'));
    f.navigate('#sec');
    assert.equal(stale.focused, false, 'a target left by another navigation took focus');
    assert.equal(lower.focused, false);
    const byId = target({id: 'caf\u00e9'});
    const encoded = fixture({elements: {'caf\u00e9': byId}, quirks: true, browserTarget: () => byId});
    encoded.dispatch(encoded.anchor('/#caf%C3%A9'));
    encoded.navigate('#caf%C3%A9');
    assert.equal(byId.focused, true, 'a decoded id target was not focused');
    const unsupported = fixture({elements: {}, named: [lower], quirks: true, targetUnsupported: true});
    unsupported.dispatch(unsupported.anchor('/#sec'));
    unsupported.navigate('#sec');
    assert.equal(lower.focused, true, 'without :target support the lookup did not stand');
});

// A click the browser never navigates (a link inside an editable
// region, a click answered without navigating) fires no hashchange. The
// wait is bounded: a grace counted from the task after the click.
test('a click that never navigates stops waiting, and a later navigation moves no focus', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.dispatch(f.anchor('/#section-b'));
    assert.equal(f.watchers(), 1);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, 0, 'the grace must start in the task after the click');
    f.flushTimers();
    assert.equal(f.watchers(), 1, 'the wait ended inside the task after the click');
    assert.equal(f.timers.length, 1);
    assert.ok(f.timers[0].delay > 0 && f.timers[0].delay <= 250, 'the grace must be short: ' + f.timers[0].delay);
    f.flushTimers();
    assert.equal(f.watchers(), 0, 'the hashchange watcher outlived a click that never navigated');
    f.navigate('#section-b'); // an unrelated script navigation, later
    assert.equal(f.byId['section-b'].focused, false, 'a later navigation took focus for an abandoned click');
});

test('a navigation an engine lands a task after the click still focuses', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.dispatch(f.anchor('/#section-b'));
    f.flushTimers(); // the task after the click: not landed yet
    f.navigate('#section-b');
    assert.equal(f.byId['section-b'].focused, true, 'a late landing within the grace moved no focus');
    assert.equal(f.watchers(), 0);
    f.flushTimers();
    assert.equal(f.byId['section-b'].focused, true);
});

test('an address that lands without hashchange focuses when the grace ends', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.dispatch(f.anchor('/#section-b'));
    f.state.hash = '#section-b'; // committed, its hashchange not delivered
    f.flushTimers();
    f.flushTimers();
    assert.equal(f.byId['section-b'].focused, true, 'a landed address was not focused at the end of the wait');
    assert.equal(f.watchers(), 0);
});

test('a click an earlier handler prevented gets no focus handling', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.dispatch(f.anchor('/#section-b'), {defaultPrevented: true});
    assert.equal(f.watchers(), 0, 'the handler piled onto a click another handler already claimed');
});

test('a click a later handler prevents moves no focus', () => {
    const f = fixture({elements: {'section-b': target()}});
    const el = f.byId['section-b'];
    const ev = f.dispatch(f.anchor('/#section-b'));
    ev.preventDefault(); // a listener further up the path cancels the navigation
    f.navigate('#section-b'); // the same address arriving some other way
    assert.equal(el.focused, false, 'focus followed a cancelled click');
    assert.equal(f.watchers(), 0, 'the watcher outlived the hashchange that answered it');
});

test('a navigation that lands on another fragment moves no focus', () => {
    const f = fixture({elements: {'section-b': target(), 'section-c': target({id: 'section-c'})}});
    f.dispatch(f.anchor('/#section-b'));
    f.navigate('#section-c');
    assert.equal(f.byId['section-b'].focused, false);
    assert.equal(f.byId['section-c'].focused, false);
    assert.equal(f.watchers(), 0);
});

test('a different query on the same path is navigation, not an arrival', () => {
    const f = fixture({elements: {'section-b': target()}, search: '?page=1'});
    f.dispatch(f.anchor('/?page=2#section-b'));
    assert.equal(f.watchers(), 0);
    f.dispatch(f.anchor('/?page=1#section-b'));
    assert.equal(f.watchers(), 1, 'a same-query fragment was not watched');
});

test('no declarations means no listeners anywhere', () => {
    const f = fixture({declarations: [], elements: {'section-b': target()}});
    assert.deepEqual(Object.keys(f.listeners), [],
        'the module installed listeners with nothing declared');
});

test('Back and Forward move no focus', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.navigate('#section-b'); // a traversal: no click preceded it
    assert.equal(f.byId['section-b'].focused, false);
    assert.equal(f.watchers(), 0, 'the module listens for hashchange with no click pending');
});

test('the fragment already current focuses after a task, with no history write', () => {
    const f = fixture({elements: {'section-b': target()}, hash: '#section-b'});
    const el = f.byId['section-b'];
    f.click(f.anchor('/#section-b'));
    assert.equal(f.watchers(), 0, 'waited for a hashchange the same fragment never fires');
    assert.equal(el.focused, false, 'focus moved inside the click task');
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, 0);
    f.flushTimers();
    assert.equal(el.focused, true, 'the fragment already current was not focused');
});

test('without a timer the fragment already current focuses at once', () => {
    const f = fixture({elements: {'section-b': target()}, hash: '#section-b', noTimers: true});
    f.click(f.anchor('/#section-b'));
    assert.equal(f.byId['section-b'].focused, true);
});

test('a later click supersedes a pending one', () => {
    const f = fixture({elements: {'section-b': target(), 'section-c': target({id: 'section-c'})}, hash: '#section-c'});
    // The current fragment queues its task; a new fragment then replaces it.
    f.dispatch(f.anchor('/#section-c'));
    f.dispatch(f.anchor('/#section-b'));
    assert.equal(f.watchers(), 1, 'two arrival watchers waited at once');
    f.flushTimers();
    assert.equal(f.byId['section-c'].focused, false, 'a superseded click still focused');
    f.navigate('#section-b');
    assert.equal(f.byId['section-b'].focused, true);
    f.dispatch(f.anchor('/#section-c'));
    f.dispatch(f.anchor('/#section-c'));
    assert.equal(f.watchers(), 1, 'repeated clicks stacked arrival watchers');
});

test('a borrowed tabindex lasts until the target blurs', () => {
    const f = fixture({elements: {'section-b': target()}});
    const el = f.byId['section-b'];
    f.click(f.anchor('/#section-b'));
    assert.equal(el.focused, true);
    // Removing the attribute at focus time would bounce focus straight
    // back to BODY — the borrow lives until the destination blurs.
    assert.equal(el.getAttribute('tabindex'), '-1',
        'the borrowed tabindex left while the destination held focus');
    el.fire('blur');
    assert.equal(el.getAttribute('tabindex'), null, 'the borrowed tabindex survived the blur');
    assert.equal(el.listenerCount('blur'), 0, 'the blur watcher survived its one delivery');
    assert.equal((f.listeners['doc:focusin'] || []).length, 0, 'the focus watcher survived the borrow');
});

test('a blur that leaves the destination focused keeps the borrow', () => {
    // A window or tab switch blurs the target while it stays the
    // document's activeElement: focus resumes there on return.
    const f = fixture({elements: {'section-b': target()}});
    const el = f.byId['section-b'];
    f.click(f.anchor('/#section-b'));
    el.fire('blur', {keepFocus: true});
    assert.equal(el.getAttribute('tabindex'), '-1',
        'a window blur took the borrowed tabindex from the focused destination');
    assert.equal(el.listenerCount('blur'), 1, 'a window blur ended the blur watcher');
    el.fire('blur');
    assert.equal(el.getAttribute('tabindex'), null, 'the borrowed tabindex survived focus moving on');
    assert.equal(el.listenerCount('blur'), 0, 'the blur watcher survived focus moving on');
    assert.equal((f.listeners['doc:focusin'] || []).length, 0, 'the focus watcher survived focus moving on');
});

test('focus arriving elsewhere ends a borrow whose blur never came', () => {
    // An engine that restores focus silently after a window switch also
    // moves it on without a blur on the destination.
    const f = fixture({elements: {'section-b': target()}});
    const el = f.byId['section-b'];
    f.click(f.anchor('/#section-b'));
    el.fire('blur', {keepFocus: true});
    f.listeners['doc:focusin'].slice().forEach(fn => fn({type: 'focusin'})); // the destination's own return
    assert.equal(el.getAttribute('tabindex'), '-1',
        'a focusin while the destination held focus ended the borrow');
    el.focused = false; // focus moved on with no blur delivered
    f.listeners['doc:focusin'].slice().forEach(fn => fn({type: 'focusin'}));
    assert.equal(el.getAttribute('tabindex'), null, 'the borrowed tabindex outlived focus arriving elsewhere');
    assert.equal(el.listenerCount('blur'), 0, 'the blur watcher outlived the borrow');
    assert.equal((f.listeners['doc:focusin'] || []).length, 0, 'the focus watcher outlived the borrow');
});

test('a focus handler\'s own tabindex is not reclaimed', () => {
    // The removal verifies ownership: a handler that installs a real
    // tab position during focus keeps it across the blur.
    const el = target();
    el.focus = () => {
        el.focused = true;
        el.setAttribute('tabindex', '0');
        el.fire('blur');
    };
    const f = fixture({elements: {'section-b': el}});
    f.click(f.anchor('/#section-b'));
    assert.equal(el.getAttribute('tabindex'), '0', 'the module reclaimed a tabindex it did not write');
});

test('naturally focusable targets keep their authored attributes', () => {
    const cases = [
        {tagName: 'BUTTON'}, {tagName: 'A', attrs: {href: '#section-b'}},
        {tagName: 'DIV', attrs: {contenteditable: ''}},
        {tagName: 'DIV', attrs: {contenteditable: 'true'}},
        {tagName: 'DIV', attrs: {tabindex: '2'}},
        {tagName: 'AUDIO', attrs: {controls: ''}},
        {tagName: 'VIDEO', attrs: {controls: ''}},
        {tagName: 'INPUT'}, {tagName: 'TEXTAREA'}, {tagName: 'SELECT'},
        {tagName: 'SUMMARY'}, {tagName: 'IFRAME'},
        {tagName: 'AREA', attrs: {href: '#destination'}}
    ];
    for (const options of cases) {
        const el = target(options);
        const before = JSON.stringify(options.attrs || {});
        const f = fixture({elements: {'section-b': el}});
        f.click(f.anchor('/#section-b'));
        assert.equal(el.focused, true, options.tagName + ' was not focused');
        assert.equal(el.focusArgs.preventScroll, true);
        assert.equal(el.listenerCount('blur'), 0, options.tagName + ' was given a lease it did not need');
        const after = {};
        for (const key of Object.keys(options.attrs || {})) after[key] = el.getAttribute(key);
        assert.equal(JSON.stringify(after), before, options.tagName + ' lost or changed an authored attribute');
        assert.equal(el.getAttribute('tabindex'), (options.attrs || {}).tabindex === undefined ? null : options.attrs.tabindex);
    }
    for (const options of [{tagName: 'DIV', attrs: {contenteditable: 'false'}}, {tagName: 'AUDIO'}, {tagName: 'VIDEO'},
        {tagName: 'BUTTON', disabled: true}]) {
        const el = target(options);
        const f = fixture({elements: {'section-b': el}});
        f.click(f.anchor('/#section-b'));
        assert.equal(el.getAttribute('tabindex'), '-1', 'an unfocusable target must borrow focusability');
        el.fire('blur');
        assert.equal(el.getAttribute('tabindex'), null);
    }
});

test('a target that refuses focus gives back its borrowed tabindex and watchers', () => {
    const el = target();
    el.focus = () => undefined; // inert, or still hidden: focus never arrives
    const f = fixture({elements: {'section-b': el}});
    f.click(f.anchor('/#section-b'));
    assert.equal(el.getAttribute('tabindex'), null, 'the borrowed tabindex stayed on a target that never took focus');
    assert.equal(el.listenerCount('blur'), 0, 'the blur watcher stayed on a target that never took focus');
    assert.equal((f.listeners['doc:focusin'] || []).length, 0, 'the focus watcher stayed on a target that never took focus');
});

test('a throwing focus releases the borrow and its watchers before surfacing the error', () => {
    const el = target();
    el.focus = () => { throw new Error('focus denied'); };
    const f = fixture({elements: {'section-b': el}});
    f.dispatch(f.anchor('/#section-b'));
    assert.throws(() => f.navigate('#section-b'), /focus denied/);
    assert.equal(el.getAttribute('tabindex'), null);
    assert.equal(el.listenerCount('blur'), 0);
    assert.equal((f.listeners['doc:focusin'] || []).length, 0);
    assert.equal(f.watchers(), 0, 'the arrival watcher outlived a throwing focus');
});

test('a target without focus support is left alone', () => {
    const el = target();
    el.focus = undefined;
    const f = fixture({elements: {'section-b': el}});
    assert.doesNotThrow(() => f.click(f.anchor('/#section-b')));
    assert.equal(el.getAttribute('tabindex'), null);
});

test('repeated navigation does not duplicate the focus lease', () => {
    const el = target();
    const f = fixture({elements: {'section-b': el}});
    for (let index = 0; index < 3; index += 1) {
        f.click(f.anchor('/#section-b'));
        f.flushTimers();
    }
    assert.equal(el.focused, true);
    assert.equal(el.listenerCount('blur'), 1, 'repeated navigation duplicated the focus lease');
});

test('an encoded fragment focuses the decoded id', () => {
    const el = target({id: 'café'});
    const f = fixture({elements: {'café': el}});
    f.click(f.anchor('/#caf%C3%A9'));
    assert.equal(el.focused, true, 'an encoded fragment to a real id was not followed');
});

test('a malformed percent escape stays on the raw fragment', () => {
    const f = fixture({elements: {'section-b': target()}});
    f.click(f.anchor('/#100%off'));
    f.click(f.anchor('/#%broken'));
    assert.equal(f.watchers(), 0, 'a malformed escape resolved to a target anyway');
});

test('the raw fragment is tried as an id before its decoded form', () => {
    const raw = target({id: 'caf%C3%A9'});
    const decoded = target({id: 'café'});
    const f = fixture({elements: {'caf%C3%A9': raw, 'café': decoded}});
    f.click(f.anchor('/#caf%C3%A9'));
    assert.equal(raw.focused, true, 'the element whose id is the raw fragment was passed over');
    assert.equal(decoded.focused, false, 'the decoded id won over the raw one');
});

test('no smoothscroll event listener is bound', () => {
    // The window 'smoothscroll' event entry point is retired.
    const f = fixture({elements: {'section-b': target()}});
    assert.equal(f.listeners['win:smoothscroll'], undefined, 'a smoothscroll event listener was bound');
});

test('disclosure links get no focus handling', () => {
    const f = fixture({elements: {'section-b': target()}});
    const link = f.anchor('/#section-b');
    link.closest = sel => sel === '.paste-ui-section-nav-disclosure' ? {} : null;
    f.click(link);
    assert.equal(f.byId['section-b'].focused, false);
    assert.equal(f.watchers(), 0);
});

test('every declared container and section nav gets focus handling', () => {
    const make = () => ({listeners: [], addEventListener(type, handler) { this.listeners.push(handler); }, removeEventListener() {}});
    const containers = [make(), make()];
    const navs = [make(), make()];
    const f = fixture({elements: {'section-b': target()}, declarations: containers, navDeclarations: navs});
    for (const container of [...containers, ...navs]) {
        assert.equal(container.listeners.length, 1);
        const el = f.byId['section-b'];
        el.focused = false;
        f.state.hash = '';
        const ev = {target: f.anchor('/#section-b'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
        container.listeners[0](ev);
        assert.equal(ev.defaultPrevented, false);
        f.navigate('#section-b');
        assert.equal(el.focused, true);
    }
});
