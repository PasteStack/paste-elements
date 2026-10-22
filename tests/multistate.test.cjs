const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The multistate contract: every dimension's checked default is captured,
// a single input change carries the other dimensions' current selections
// instead of dropping them, the hash is authoritative, authored input
// names are never rewritten, and the reported state is a snapshot — not
// the module's working dictionary.

function fixture(options = {}) {
    const listeners = {};
    const windowListeners = {};
    const pushed = [];

    const state = {
        hash: options.hash || '',
        elements: []
    };

    function contentEl(key, value) {
        const classes = {
            _set: new Set(),
            // classList rejects whitespace-bearing tokens with
            // InvalidCharacterError — the fake must do the same or a raw
            // value reaching addCssClass greens against a browser failure.
            add(c) {
                if (/\s/.test(c)) {
                    const err = new Error('InvalidCharacterError');
                    err.name = 'InvalidCharacterError';
                    throw err;
                }
                this._set.add(c);
            },
            delete(c) { this._set.delete(c); },
            has(c) { return this._set.has(c); }
        };
        const el = {
            isContent: true,
            key, value,
            attrs: {'data-multistate-key': key, 'data-multistate-value': value},
            classSet: classes,
            hasAttribute: k => el.attrs.hasOwnProperty(k),
            getAttribute: k => el.attrs[k] === undefined ? null : el.attrs[k],
            setAttribute: (k, v) => { el.attrs[k] = v; },
            removeAttribute: k => { delete el.attrs[k]; },
            addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
            removeEventListener() {}
        };
        return el;
    }

    function inputEl(key, value, checked, name, type) {
        const elListeners = {};
        const el = {
            isInput: true,
            type: type || 'radio',
            key, value,
            checked: !!checked,
            // The authored checked attribute: the module's own writes to
            // checked never reach it, as in the DOM.
            defaultChecked: !!checked,
            name,
            id: '',
            attrs: {'data-multistate-key': key},
            hasAttribute: k => el.attrs.hasOwnProperty(k),
            getAttribute: k => el.attrs[k] === undefined ? null : el.attrs[k],
            setAttribute: (k, v) => { el.attrs[k] = v; },
            addEventListener: (t, fn) => { (elListeners[t] = elListeners[t] || []).push(fn); },
            removeEventListener: (t, fn) => {
                const list = elListeners[t] || [];
                const at = list.indexOf(fn);
                if (at >= 0) { list.splice(at, 1); }
            },
            fireChange() { (elListeners.change || []).slice().forEach(fn => fn({target: el})); },
            listenerCount(t) { return (elListeners[t] || []).length; }
        };
        return el;
    }

    // dim1: v1/v2 radios + one content per value; dim2: same shape.
    function dimension(key, checkedValue, values, named, type) {
        const vals = values || ['a', 'b'];
        const isChecked = v => Array.isArray(checkedValue) ? checkedValue.includes(v) : v === checkedValue;
        const radios = vals.map((v, i) =>
            inputEl(key, v, isChecked(v),
                named === false ? '' : Array.isArray(named) ? named[i] : 'group-' + key, type));
        const contents = vals.map(v => contentEl(key, v));
        return {radios, contents};
    }

    const dims = {};
    (options.dimensions || [
        {key: 'area1', checked: 'a'},
        {key: 'area2', checked: 'b'}
    ]).forEach(d => {
        dims[d.key] = dimension(d.key, d.checked, d.values, d.named, d.type);
        state.elements.push(...dims[d.key].radios, ...dims[d.key].contents);
    });

    // Malformed declarations a hand-author can produce: the marker
    // attribute is present so querySelectorAll returns them, but the
    // key or value they name is empty.
    const malformedEls = [];
    (options.malformed || []).forEach(kind => {
        const el =
            kind === 'empty-key-content' ? contentEl('', 'b') :
            kind === 'empty-value-content' ? contentEl('area1', '') :
            kind === 'empty-key-trigger' ? inputEl('', 'a') :
            kind === 'empty-value-trigger' ? inputEl('area1', '') :
            null;
        if (el) {
            malformedEls.push(el);
            state.elements.push(el);
        }
    });

    const window = {
        location: {hash: state.hash},
        history: {
            // A foreign script's data can legitimately sit on
            // history.state — the module must neither read it as a
            // selection nor drop it when it pushes its own entries.
            state: options.historyState === undefined ? null : options.historyState,
            pushState: (st, title, url) => {
                if (options.onPush) {
                    options.onPush(st, url);
                }
                if (options.pushThrows) {
                    const err = new Error('SecurityError');
                    err.name = 'SecurityError';
                    throw err;
                }
                pushed.push({state: st, url: url});
                window.history.state = st;
                window.location.hash = url;
            }
        },
        addEventListener: (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); },
        removeEventListener() {}
    };

    const dom = {
        querySelectorAll: sel => sel === '[data-multistate-key]' ? state.elements : [],
        addCssClass: (el, c) => el.classSet && el.classSet.add(c),
        removeCssClass: (el, c) => el.classSet && el.classSet.delete(c)
    };
    const util = {
        stringStartsWith: (s, p) => s.indexOf(p) === 0
    };
    const popped = [];
    const event = {
        Event: function (ctx, name) {
            // Core's Event exposes subscribe()/bind() for the module's own
            // consumers — recording fire() calls alone never verifies
            // that a subscriber through the published surface hears the
            // payload.
            const handlers = [];
            this.getEventName = () => name;
            this.subscribe = fn => {
                handlers.push(fn);
                return {dispose: () => {
                    const at = handlers.indexOf(fn);
                    if (at >= 0) { handlers.splice(at, 1); }
                }};
            };
            this.bind = this.subscribe;
            // dispatchEvent throws InvalidStateError when the one event
            // object core reuses is already being dispatched — the fake
            // keeps that rule so reentrant announcements are caught.
            let dispatching = false;
            this.fire = payload => {
                if (dispatching) {
                    const err = new Error('InvalidStateError');
                    err.name = 'InvalidStateError';
                    throw err;
                }
                dispatching = true;
                try {
                    popped.push(payload);
                    handlers.slice().forEach(fn => fn({type: name}, payload));
                } finally {
                    dispatching = false;
                }
            };
            this.dispose = () => { handlers.length = 0; };
        },
        getEventTarget: e => e.target,
        bind: (type, el, fn) => {
            if (el === window) {
                (windowListeners[type] = windowListeners[type] || []).push(fn);
                // Disposal is faithful: the subscription's dispose is the
                // listener's removal, not a bookkeeping no-op.
                return {dispose: () => {
                    const list = windowListeners[type] || [];
                    const at = list.indexOf(fn);
                    if (at >= 0) { list.splice(at, 1); }
                }};
            }
            el.addEventListener(type, fn);
            return {dispose: () => el.removeEventListener(type, fn)};
        }
    };
    event.Event.getEventTarget = event.getEventTarget;
    // Core's Subscription constructor, published on the Event namespace:
    // the module binds every listener through it — window listeners
    // land in windowListeners, element listeners on the element.
    event.Event.Subscription = function (type, el, fn) {
        this.dispose = event.bind(type, el, fn).dispose;
    };

    if (options.beforeDefine) options.beforeDefine(state);
    const exports = {};
    vm.runInNewContext(
        readModuleSource('paste/ui/multistate.js'),
        {
            window, console,
            document: {},
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.multistate');
                assert.equal(deps.join('|'), 'paste.util|paste.dom|paste.event');
                const ns = factory(exports, util, dom, event);
                Object.assign(exports, ns);
            }}
        }
    );

    return {
        exports, dims, state, window, pushed, popped, windowListeners, malformedEls,
        firePopstate: st => (windowListeners.popstate || []).slice().forEach(fn => fn({type: 'popstate', state: st})),
        fireHashchange: () => (windowListeners.hashchange || []).slice().forEach(fn => fn({type: 'hashchange'}))
    };
}

function selected(dims, key) {
    return dims[key].contents.filter(c => c.attrs['data-multistate-state'] !== undefined)
        .map(c => c.attrs['data-multistate-state']);
}

test('every dimension captures its checked default', () => {
    const f = fixture();
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'the first dimension lost its checked default');
    assert.equal(current.area2, 'b', 'the second dimension lost its checked default');
    assert.deepEqual(selected(f.dims, 'area1'), ['a']);
    assert.deepEqual(selected(f.dims, 'area2'), ['b']);
});

test('a direct input change keeps the other dimensions selected', () => {
    const f = fixture();
    // Change area1 a→b through the real change path.
    const radioB = f.dims.area1.radios[1];
    radioB.checked = true;
    radioB.fireChange();

    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'the changed dimension did not update');
    assert.equal(current.area2, 'b', 'the untouched dimension was unselected');
    assert.deepEqual(selected(f.dims, 'area2'), ['b'],
        'area2 content lost its selected marker');
    assert.deepEqual(selected(f.dims, 'area1'), ['b'],
        'area1 content did not move to the new value');
    assert.equal(f.dims.area1.radios[0].checked, false,
        'the previous trigger stayed checked');
    assert.equal(f.dims.area1.radios[1].checked, true,
        'the new trigger was not checked');
    assert.ok(f.pushed.length === 1, 'the change did not write history');
});

test('authored input names are never rewritten', () => {
    const f = fixture();
    ['area1', 'area2'].forEach(k => {
        f.dims[k].radios.forEach(r => {
            assert.equal(r.name, 'group-' + k,
                'the module rewrote an authored input name');
        });
    });
});

test('getCurrentState returns a snapshot, not the working dictionary', () => {
    const f = fixture();
    const snapshot = f.exports.getCurrentState();
    snapshot.area1 = 'forged';
    snapshot.injected = 'x';
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'a caller mutated the module state');
    assert.equal(current.injected, undefined, 'a caller injected a dimension');
});

test('popstate with a partial hash falls back to the authored default for unnamed keys', () => {
    const f = fixture();
    // The fragment names only area1: area2 is not unselected — it
    // returns to the trigger that was checked when the page bound.
    f.window.location.hash = '#area1:b,area2:a';
    f.firePopstate({});
    assert.equal(f.exports.getCurrentState().area2, 'a', 'precondition: area2 moved');
    f.window.location.hash = '#area1:b';
    f.firePopstate({area1: 'b'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b');
    assert.equal(current.area2, 'b',
        'an unnamed dimension did not fall back to its authored default');
    assert.deepEqual(selected(f.dims, 'area2'), ['b']);
    assert.equal(f.dims.area2.radios[1].checked, true,
        'the authored default trigger was not checked again');
    assert.equal(f.dims.area2.radios[0].checked, false);
});

test('Back to the entry with no fragment restores every authored default', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.exports.getCurrentState().area1, 'b', 'precondition: the change applied');
    f.window.location.hash = '';
    f.firePopstate(null);
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'Back to the bare entry unselected area1');
    assert.equal(current.area2, 'b', 'Back to the bare entry unselected area2');
    assert.equal(f.dims.area1.radios[0].checked, true, 'the authored default was left unchecked');
    assert.equal(f.dims.area1.radios[1].checked, false);
});

test('a plain anchor fragment keeps the current selection', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const published = f.popped.length;
    // An in-page link fires popstate and hashchange in current engines;
    // neither may reset a tab the user chose.
    f.window.location.hash = '#top';
    f.firePopstate(null);
    f.fireHashchange();
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'a plain anchor reset a chosen tab');
    assert.equal(current.area2, 'b');
    assert.equal(f.dims.area1.radios[1].checked, true);
    assert.equal(f.popped.length, published, 'a plain anchor announced a transition');
});

test('a fragment carrying only foreign tokens keeps the current selection', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    f.window.location.hash = '#widget:open,top';
    f.fireHashchange();
    f.firePopstate(null);
    assert.equal(f.exports.getCurrentState().area1, 'b');
});

test('a hashchange to an empty fragment keeps the selection; only popstate restores defaults', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    f.window.location.hash = '';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area1, 'b',
        'a hashchange to an empty fragment reset the selection');
    f.firePopstate(null);
    assert.equal(f.exports.getCurrentState().area1, 'a',
        'popstate to the bare entry kept a non-default selection');
});

test('a key with no authored default is unselected when the fragment omits it', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: 'a'},
        {key: 'area2', checked: undefined}
    ]});
    f.window.location.hash = '#area1:b,area2:a';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area2, 'a');
    f.window.location.hash = '#area1:b';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area2, undefined,
        'a dimension with no default kept a selection the fragment dropped');
    assert.equal(f.dims.area2.radios[0].checked, false);
});

test('an undeclared value in the fragment falls back to the default too', () => {
    const f = fixture();
    f.window.location.hash = '#area1:zzz';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area1, 'a');
});

test('a hash-derived initial state wins over authored defaults', () => {
    const f = fixture({hash: '#area1:b'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'the hash value did not win');
    assert.equal(current.area2, 'b',
        'the dimension absent from the hash lost its authored default');
    assert.deepEqual(selected(f.dims, 'area1'), ['b']);
});

test('undeclared and hostile hash keys cannot corrupt declared state', () => {
    const f = fixture({hash: '#junk:1,__proto__:x,hasOwnProperty:b,area1:b'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'the declared hash value did not apply');
    assert.equal(current.area2, 'b', 'the authored default was lost');
    assert.equal(current.junk, undefined, 'an undeclared key entered state');
    assert.ok(!Object.prototype.hasOwnProperty.call(current, '__proto__'),
        'a prototype key became an own state entry');
    assert.ok(!Object.prototype.hasOwnProperty.call(current, 'hasOwnProperty'),
        'an inherited key became an own state entry');
});

test('authored element ids are never rewritten', () => {
    const f = fixture();
    ['area1', 'area2'].forEach(k => {
        f.dims[k].radios.forEach(r => {
            assert.equal(r.id, '', 'the module manufactured an element id');
        });
    });
});

test('the original public surface is kept', () => {
    const f = fixture();
    assert.equal(typeof f.exports.initialize, 'function');
    assert.equal(typeof f.exports.getCurrentState, 'function');
    assert.equal(typeof f.exports.serializeState, 'function');
    assert.equal(typeof f.exports.deserializeState, 'function');
    assert.ok(f.exports.events.multistatepop);
});

test('initialize without force does nothing once bound', () => {
    const f = fixture();
    const radio = f.dims.area1.radios[0];
    const published = f.popped.length;
    f.exports.initialize();
    assert.equal(radio.listenerCount('change'), 1, 'a second change listener was bound');
    assert.equal(f.popped.length, published);
    assert.equal(f.windowListeners.popstate.length, 1);
});

test('initialize(true) re-scans: new triggers bind, old listeners and reflection leave', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const removed = f.dims.area2;
    // The page swaps area2 out and brings area3 in.
    f.state.elements = f.state.elements.filter(el => el.key !== 'area2');
    const added = [];
    const mk = (value, checked) => {
        const radio = {
            isInput: true, type: 'radio', key: 'area3', value, checked, defaultChecked: checked, name: '', id: '',
            attrs: {'data-multistate-key': 'area3'}, l: [],
            hasAttribute: k => radio.attrs.hasOwnProperty(k),
            getAttribute: k => radio.attrs[k] === undefined ? null : radio.attrs[k],
            addEventListener: (t, fn) => radio.l.push(fn),
            removeEventListener: (t, fn) => { radio.l = radio.l.filter(x => x !== fn); }
        };
        return radio;
    };
    const r3a = mk('x', false);
    const r3b = mk('y', true);
    const c3 = ['x', 'y'].map(v => {
        const el = {
            attrs: {'data-multistate-key': 'area3', 'data-multistate-value': v},
            classSet: {s: new Set(), add(c) { this.s.add(c); }, delete(c) { this.s.delete(c); }, has(c) { return this.s.has(c); }},
            hasAttribute: k => el.attrs.hasOwnProperty(k),
            getAttribute: k => el.attrs[k] === undefined ? null : el.attrs[k],
            setAttribute: (k, val) => { el.attrs[k] = val; },
            removeAttribute: k => { delete el.attrs[k]; }
        };
        return el;
    });
    added.push(r3a, r3b, ...c3);
    f.state.elements.push(...added);
    f.window.location.hash = '#area1:b';
    f.exports.initialize(true);
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'the fragment selection was not resolved again');
    assert.equal(current.area3, 'y', 'the new key was not bound');
    assert.equal(current.area2, undefined, 'a removed key stayed in state');
    assert.equal(removed.contents[1].attrs['data-multistate-state'], undefined,
        'the removed content kept its reflection');
    assert.equal(removed.radios[0].listenerCount('change'), 0,
        'a removed trigger kept its change listener');
    assert.equal(f.dims.area1.radios[0].listenerCount('change'), 1,
        'a kept trigger gained a duplicate listener');
    assert.equal(r3a.l.length, 1);
    assert.equal(c3[1].attrs['data-multistate-state'], 'y');
    assert.equal(r3a.name, 'paste-ui-multistate:area3', 'the new unnamed group was not named');
    assert.equal(f.windowListeners.popstate.length, 1, 'a re-scan bound history twice');
});

test('popstate does not disable later hashchange transitions', () => {
    const f = fixture();
    f.window.location.hash = '#area1:b,area2:a';
    f.firePopstate({area1: 'b', area2: 'a'});
    assert.equal(f.exports.getCurrentState().area1, 'b');
    f.window.location.hash = '#area1:a,area2:b';
    f.fireHashchange();
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'a later hashchange was dropped');
    assert.equal(current.area2, 'b', 'a later hashchange was dropped');
});

test('hashchange does not disable later popstate transitions', () => {
    const f = fixture();
    f.window.location.hash = '#area1:b,area2:a';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area1, 'b');
    f.window.location.hash = '#area1:a,area2:b';
    f.firePopstate({area1: 'a', area2: 'b'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'a later popstate was dropped');
    assert.equal(current.area2, 'b', 'a later popstate was dropped');
});

test('a paired popstate + hashchange is one transition, not two', () => {
    const f = fixture();
    const published = f.popped.length;
    // One navigation can deliver both events; they describe the same
    // state, so the module observes one change.
    f.window.location.hash = '#area1:b,area2:a';
    f.firePopstate({area1: 'b', area2: 'a'});
    f.fireHashchange();
    assert.equal(f.popped.length, published + 1,
        'a paired delivery published a duplicate transition');
    assert.equal(f.exports.getCurrentState().area1, 'b');
});

test('alternating history families keep applying', () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
        f.window.location.hash = '#area1:b,area2:a';
        f.firePopstate({area1: 'b', area2: 'a'});
        assert.equal(f.exports.getCurrentState().area1, 'b',
            'round ' + i + ' popstate was dropped');
        f.window.location.hash = '#area1:a,area2:b';
        f.fireHashchange();
        assert.equal(f.exports.getCurrentState().area1, 'a',
            'round ' + i + ' hashchange was dropped');
    }
});

test('zero declarations install zero history listeners', () => {
    const f = fixture({dimensions: []});
    assert.deepEqual(Object.keys(f.windowListeners), [],
        'history listeners were installed with nothing declared');
});

// Malformed declarations fail locally: each stays at baseline, binds
// nothing, and cannot disable or corrupt a valid sibling.

test('an empty-key content declaration stays inert beside valid siblings', () => {
    const f = fixture({malformed: ['empty-key-content']});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'a malformed sibling disabled area1');
    assert.equal(current.area2, 'b', 'a malformed sibling disabled area2');
    assert.deepEqual(selected(f.dims, 'area1'), ['a']);
    assert.equal(f.malformedEls[0].attrs['data-multistate-state'], undefined,
        'a malformed content element received module state');
});

test('an empty-value content declaration stays inert beside valid siblings', () => {
    const f = fixture({malformed: ['empty-value-content']});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'a malformed sibling disabled area1');
    assert.equal(current.area2, 'b', 'a malformed sibling disabled area2');
    assert.deepEqual(selected(f.dims, 'area1'), ['a']);
});

test('an empty-key trigger binds no listener and writes no history', () => {
    const f = fixture({malformed: ['empty-key-trigger']});
    const bad = f.malformedEls[0];
    assert.equal(bad.listenerCount('change'), 0,
        'a malformed trigger gained a change subscription');
    bad.checked = true;
    bad.fireChange();
    assert.equal(f.pushed.length, 0, 'a malformed trigger wrote history');
    assert.equal(f.exports.getCurrentState().area1, 'a',
        'a malformed trigger disturbed declared state');
});

test('an empty-value trigger binds no listener and writes no history', () => {
    const f = fixture({malformed: ['empty-value-trigger']});
    const bad = f.malformedEls[0];
    assert.equal(bad.listenerCount('change'), 0,
        'a malformed trigger gained a change subscription');
    bad.checked = true;
    bad.fireChange();
    assert.equal(f.pushed.length, 0, 'a malformed trigger wrote history');
});

test('all-malformed declarations install zero history listeners', () => {
    const f = fixture({
        dimensions: [],
        malformed: ['empty-key-content', 'empty-value-trigger', 'empty-key-trigger']
    });
    assert.deepEqual(Object.keys(f.windowListeners), [],
        'history listeners were installed for malformed declarations');
    assert.deepEqual(Object.keys(f.exports.getCurrentState()), [],
        'malformed declarations entered reported state');
});

test('a malformed declaration cannot appear in or disturb declared state', () => {
    const f = fixture({malformed: ['empty-key-content', 'empty-key-trigger']});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const url = f.pushed[0].url;
    assert.ok(url.indexOf('area1:b') >= 0, 'the valid change did not serialize');
    assert.equal(f.exports.getCurrentState()[''], undefined,
        'a malformed declaration produced an empty-key state entry');
    f.malformedEls.forEach(el => {
        assert.equal(el.attrs['data-multistate-state'], undefined,
            'a malformed element received module state');
    });
    assert.deepEqual(selected(f.dims, 'area1'), ['b'],
        'a malformed sibling disturbed valid content selection');
});

test('an initial hash leaves exactly one unnamed radio checked', () => {
    // Unnamed radios never uncheck one another — the module must
    // reconcile the authored default against the resolved selection.
    const f = fixture({
        hash: '#area1:b',
        dimensions: [
            {key: 'area1', checked: 'a', named: false},
            {key: 'area2', checked: 'b', named: false}
        ]
    });
    assert.equal(f.dims.area1.radios[0].checked, false,
        'the authored default stayed checked beside the hash selection');
    assert.equal(f.dims.area1.radios[1].checked, true,
        'the hash selection was not checked');
    assert.equal(f.dims.area2.radios[1].checked, true,
        'the unnamed dimension lost its authored default');
    assert.equal(f.exports.getCurrentState().area1, 'b');
});

test('a hash-named whitespace value selects without touching a raw class token', () => {
    const f = fixture({
        hash: '#area1:north%20america',
        dimensions: [
            {key: 'area1', checked: 'south', values: ['north america', 'south']}
        ]
    });
    const content = f.dims.area1.contents[0];
    assert.equal(content.attrs['data-multistate-state'], 'north america',
        'the data attribute lost the original value');
    assert.ok(content.classSet.has('multistate-state-area1-north%20america'),
        'the reflected class was not token-encoded');
    assert.equal(f.dims.area1.radios[0].checked, true,
        'the whitespace-valued trigger was not checked');
    assert.equal(f.dims.area1.radios[1].checked, false,
        'the authored default stayed checked beside the selection');
});

test('input changes to and from whitespace values keep the class token encoded', () => {
    const f = fixture({
        dimensions: [
            {key: 'area1', checked: 'south', values: ['north america', 'south']}
        ]
    });
    f.dims.area1.radios[0].checked = true;
    f.dims.area1.radios[0].fireChange();
    assert.ok(f.dims.area1.contents[0].classSet.has('multistate-state-area1-north%20america'),
        'the whitespace value reached the class unencoded');
    assert.equal(f.exports.getCurrentState().area1, 'north america',
        'the selection lost its original value');
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.ok(!f.dims.area1.contents[0].classSet.has('multistate-state-area1-north%20america'),
        'unselection removed a differently-encoded class');
    assert.ok(f.dims.area1.contents[1].classSet.has('multistate-state-area1-south'),
        'the new selection was not reflected');
});

test('a whitespace key encodes its class token the same way', () => {
    const f = fixture({
        dimensions: [
            {key: 'north coast', checked: 'b'}
        ]
    });
    f.dims['north coast'].radios[0].checked = true;
    f.dims['north coast'].radios[0].fireChange();
    assert.ok(f.dims['north coast'].contents[0].classSet.has('multistate-state-north%20coast-a'),
        'the whitespace key reached the class unencoded');
});

test('a change keeps foreign key:value tokens in the pushed fragment', () => {
    const f = fixture({hash: '#foreign:1,other%20key:x%20y'});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.pushed.length, 1, 'the change did not write history');
    const url = f.pushed[0].url;
    assert.ok(url.startsWith('#foreign:1,other%20key:x%20y,'),
        'foreign tokens were dropped, reordered or re-encoded: ' + url);
    assert.ok(url.includes('area1:b'), 'the changed dimension is absent from history');
    assert.ok(url.includes('area2:b'), 'a carried dimension is absent from history');
});

test('declared keys in the fragment are replaced, and plain anchors are not state', () => {
    const f = fixture({hash: '#top,area1:a,widget:open'});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const url = f.pushed[0].url;
    assert.ok(url.startsWith('#widget:open,'), 'the foreign token did not lead: ' + url);
    assert.ok(!url.includes('top'), 'a plain anchor was carried as state');
    assert.ok(!url.includes('area1:a'), 'the stale declared token survived');
    assert.ok(url.includes('area1:b'));
});

test('prototype-named dimensions keep their selections in snapshots and payloads', () => {
    const f = fixture({dimensions: [
        {key: '__proto__', checked: 'a'},
        {key: 'constructor', checked: 'x', values: ['x', 'y']},
        {key: 'toString', checked: 'on', values: ['on', 'off']}
    ]});
    const current = f.exports.getCurrentState();
    assert.ok(Object.prototype.hasOwnProperty.call(current, '__proto__'),
        'the __proto__ dimension vanished from the snapshot');
    assert.equal(current['__proto__'], 'a', 'the __proto__ dimension lost its selection');
    assert.ok(Object.prototype.hasOwnProperty.call(current, 'constructor'));
    assert.equal(current['constructor'], 'x');
    assert.ok(Object.prototype.hasOwnProperty.call(current, 'toString'));
    assert.equal(current['toString'], 'on');
});

test('the published payload keeps prototype-named dimensions and their values', () => {
    const f = fixture({dimensions: [
        {key: '__proto__', checked: 'a'},
        {key: 'area1', checked: 'a'}
    ]});
    // Subscribe through the module's published events surface — the
    // payload a consumer receives, not only what fire() recorded.
    const received = [];
    const sub = f.exports.events.multistatepop.subscribe((domEvent, payload) =>
        received.push(payload));
    const radios = f.dims['area1'].radios;
    const toB = radios.find(r => r.value === 'b');
    toB.checked = true;
    toB.fireChange();
    assert.equal(received.length, 1, 'the subscriber heard no payload');
    const payload = received[0];
    sub.dispose();
    assert.ok(Object.prototype.hasOwnProperty.call(payload, '__proto__'),
        'the published snapshot dropped the __proto__ dimension');
    assert.equal(payload['__proto__'], 'a');
    assert.equal(payload['area1'], 'b', 'the published selection did not update');
});

test('a listener mutating a snapshot does not touch the working state', () => {
    const f = fixture({dimensions: [
        {key: '__proto__', checked: 'a'},
        {key: 'area1', checked: 'a'}
    ]});
    const snapshot = f.exports.getCurrentState();
    snapshot['__proto__'] = 'hijacked';
    delete snapshot['area1'];
    const current = f.exports.getCurrentState();
    assert.equal(current['__proto__'], 'a', 'snapshot mutation reached the module state');
    assert.equal(current['area1'], 'a', 'snapshot deletion reached the module state');
});

test('a foreign history.state never masquerades as a selection', () => {
    const f = fixture({hash: '#area1:a,area2:b'});
    // The fragment still declares both selections: a popstate whose
    // state belongs to another script must not clear them.
    f.firePopstate({modal: 'open'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a', 'foreign state cleared area1');
    assert.equal(current.area2, 'b', 'foreign state cleared area2');
    assert.deepEqual(selected(f.dims, 'area1'), ['a']);
    assert.deepEqual(selected(f.dims, 'area2'), ['b']);
});

test('navigating to a foreign entry applies the fragment, not event.state', () => {
    const f = fixture();
    // The foreign entry still carries a hash naming selections — that
    // text is the record, not the state object another script wrote.
    f.window.location.hash = '#area1:b';
    f.firePopstate({unrelated: true});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'b', 'the fragment selection was ignored');
    assert.equal(current.area2, 'b', 'an unnamed key did not fall back to its default');
    assert.deepEqual(selected(f.dims, 'area1'), ['b']);
});

test('entries between identical fragments stay consistent across foreign state', () => {
    const f = fixture();
    f.window.location.hash = '#area1:a,area2:b';
    f.firePopstate({modal: 'open'});
    f.window.location.hash = '#area1:a,area2:b';
    f.firePopstate({modal: 'closed'});
    const current = f.exports.getCurrentState();
    assert.equal(current.area1, 'a');
    assert.equal(current.area2, 'b');
});

test('a change pushes a null state, never another script\'s record', () => {
    // The fragment is the module's whole record: a router's state object
    // must not be duplicated into an entry the router did not create.
    for (const foreign of [{area1: 'foreign', modal: 'open'}, [1, 2, 3], 'marker', 42]) {
        const f = fixture({historyState: foreign});
        f.dims.area1.radios[1].checked = true;
        f.dims.area1.radios[1].fireChange();
        assert.equal(f.pushed.length, 1, 'the change did not write history');
        assert.equal(f.pushed[0].state, null, 'the push copied a foreign history.state');
    }
});

test('the selection is applied before the history write', () => {
    let seen;
    const f = fixture({onPush: () => { seen = f.exports.getCurrentState().area1; }});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(seen, 'b', 'pushState ran before the selection applied');
});

test('a refused pushState never escapes and never desyncs the radio and panel', () => {
    const f = fixture({pushThrows: true});
    f.dims.area1.radios[1].checked = true;
    assert.doesNotThrow(() => f.dims.area1.radios[1].fireChange(),
        'a SecurityError escaped the change handler');
    assert.equal(f.exports.getCurrentState().area1, 'b');
    assert.deepEqual(selected(f.dims, 'area1'), ['b'], 'the panel did not follow the radio');
    assert.equal(f.dims.area1.radios[0].checked, false);
    assert.equal(f.window.location.hash, '', 'the address changed without a history entry');
});

test('a change made while multistatepop is announced is announced after it', () => {
    const f = fixture();
    const heard = [];
    f.exports.events.multistatepop.subscribe((e, payload) => {
        heard.push(payload.area1 + '/' + payload.area2);
        if (payload.area1 === 'b' && payload.area2 === 'b') {
            // A listener reacting to area1 also flips area2.
            f.dims.area2.radios[0].checked = true;
            f.dims.area2.radios[0].fireChange();
        }
    });
    f.dims.area1.radios[1].checked = true;
    assert.doesNotThrow(() => f.dims.area1.radios[1].fireChange(),
        'a nested announcement re-dispatched the event in flight');
    assert.deepEqual(heard, ['b/b', 'b/a'], 'the nested announcement was lost or reordered');
    assert.equal(f.exports.getCurrentState().area2, 'a');
});

test('an unnamed radio group gets one generated name per key', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: 'a', named: false},
        {key: 'area2', checked: 'b', named: false}
    ]});
    f.dims.area1.radios.forEach(r => assert.equal(r.name, 'paste-ui-multistate:area1'));
    f.dims.area2.radios.forEach(r => assert.equal(r.name, 'paste-ui-multistate:area2'));
});

test('a group with any authored name is left exactly as authored', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: 'a', named: ['mine', '']}
    ]});
    assert.equal(f.dims.area1.radios[0].name, 'mine');
    assert.equal(f.dims.area1.radios[1].name, '', 'a partly named group was renamed');
});

test('only radios are named', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: 'a', named: false, type: 'checkbox'}
    ]});
    f.dims.area1.radios.forEach(r => assert.equal(r.name, '', 'a non-radio trigger was named'));
});

test('several checked triggers of one key default to the last in document order', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: ['a', 'b'], named: false}
    ]});
    assert.equal(f.exports.getCurrentState().area1, 'b',
        'the default was not the last checked trigger in document order');
    assert.equal(f.dims.area1.radios[0].checked, false, 'a competing default stayed checked');
    f.window.location.hash = '';
    f.firePopstate(null);
    assert.equal(f.exports.getCurrentState().area1, 'b');
});

test('the JSDoc records the inherited surface, naming, encoding and anchor rules', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../modules/multistate/multistate.js'), 'utf8');
    const doc = source.slice(0, source.indexOf('paste[\'define\']'));
    ['initialize(force)', 'inherited', 'paste-ui-multistate:', 'encodeURIComponent',
        'north%20america', 'keeps the current', 'null'].forEach(term =>
        assert.ok(doc.includes(term), 'the JSDoc does not document: ' + term));
});

test('the source captures builtins instead of re-walking them per call', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/multistate/multistate.js'), 'utf8');
    assert.ok(!(/Object\.prototype\.hasOwnProperty\.call/).test(source),
        'a builtin is re-walked per call instead of captured once');
});

function extraRadio(key, value, options = {}) {
    const radio = {
        isInput: true, type: 'radio', key, value,
        checked: !!options.checked, defaultChecked: !!options.checked,
        name: options.name || '', id: '',
        attrs: {'data-multistate-key': key}, l: [],
        hasAttribute: k => radio.attrs.hasOwnProperty(k),
        getAttribute: k => radio.attrs[k] === undefined ? null : radio.attrs[k],
        addEventListener: (t, fn) => radio.l.push(fn),
        removeEventListener: (t, fn) => { radio.l = radio.l.filter(x => x !== fn); },
        fireChange() { radio.l.slice().forEach(fn => fn({target: radio})); }
    };
    return radio;
}

test('a change made by a multistatepop listener leaves one entry describing the final selection', () => {
    const f = fixture();
    f.exports.events.multistatepop.subscribe((e, payload) => {
        if (payload.area1 === 'b' && payload.area2 === 'b') {
            f.dims.area2.radios[0].checked = true;
            f.dims.area2.radios[0].fireChange();
        }
    });
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const final = f.exports.getCurrentState();
    assert.equal(final.area1, 'b');
    assert.equal(final.area2, 'a', 'the nested change did not apply');
    assert.equal(f.pushed.length, 1, 'one user change wrote ' + f.pushed.length + ' entries');
    const top = f.exports.deserializeState(f.window.location.hash);
    assert.equal(top.area1, 'b');
    assert.equal(top.area2, 'a', 'the top entry describes a superseded selection: ' + f.window.location.hash);
});

test('the pushed fragment carries what was applied, not what the input asked for', () => {
    // A trigger whose value has no content is never selected, so it is
    // never written to the address either.
    const f = fixture();
    const orphan = extraRadio('area1', 'nowhere');
    f.state.elements.push(orphan);
    f.exports.initialize(true);
    orphan.checked = true;
    orphan.fireChange();
    assert.equal(f.pushed.length, 1);
    assert.ok(!f.pushed[0].url.includes('nowhere'),
        'an unapplied value reached the address: ' + f.pushed[0].url);
    assert.equal(f.pushed[0].url, '#' + f.exports.serializeState(f.exports.getCurrentState()),
        'the address and the applied selection disagree');
});

test('an in-page link to an empty fragment keeps the chosen tab', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    // <a href="#">: the address ends in '#', location.hash reads ''.
    f.window.location.hash = '';
    f.window.location.href = 'https://example.test/page#';
    f.firePopstate(null);
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area1, 'b', 'a link to "#" reset a chosen tab');
    assert.equal(f.dims.area1.radios[1].checked, true);
    // Back to the bare entry still restores the defaults.
    f.window.location.href = 'https://example.test/page';
    f.firePopstate(null);
    assert.equal(f.exports.getCurrentState().area1, 'a');
});

test('initialize(true) keeps the authored defaults, not the selection at re-scan time', () => {
    const f = fixture();
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    f.exports.initialize(true);
    assert.equal(f.exports.getCurrentState().area1, 'b', 'the re-scan dropped the fragment selection');
    f.window.location.hash = '';
    f.firePopstate(null);
    assert.equal(f.exports.getCurrentState().area1, 'a',
        'Back to the bare entry restored the re-scan-time selection');
    assert.equal(f.dims.area1.radios[0].checked, true);
    assert.equal(f.dims.area1.radios[1].checked, false);
});

test('every radio declaring the same key and value is named, checked and unchecked', () => {
    const f = fixture({dimensions: [{key: 'area1', checked: 'a', named: false}]});
    const mirrorA = extraRadio('area1', 'a');
    const mirrorB = extraRadio('area1', 'b');
    f.state.elements.push(mirrorA, mirrorB);
    f.exports.initialize(true);
    // Each strip is its own native group: one shared name would let the
    // browser keep only one checked radio across both strips, so the
    // mirrored strip gets a name of its own.
    f.dims.area1.radios.forEach(r =>
        assert.equal(r.name, 'paste-ui-multistate:area1', 'a trigger of an unnamed key was left unnamed'));
    [mirrorA, mirrorB].forEach(r =>
        assert.equal(r.name, 'paste-ui-multistate:area1:1', 'the mirrored strip shares the first strip\'s group'));
    assert.equal(f.dims.area1.radios[0].checked, true, 'the first strip lost the default');
    assert.equal(mirrorA.checked, true, 'the mirrored default was not checked');
    mirrorB.checked = true;
    mirrorB.fireChange();
    assert.equal(f.exports.getCurrentState().area1, 'b');
    assert.equal(f.dims.area1.radios[1].checked, true, 'the first strip did not follow');
    assert.equal(f.dims.area1.radios[0].checked, false);
    assert.equal(mirrorA.checked, false, 'a mirrored radio of the old value stayed checked');
    f.window.location.hash = '#area1:a';
    f.fireHashchange();
    assert.equal(mirrorA.checked, true);
    assert.equal(f.dims.area1.radios[0].checked, true, 'the first strip did not show the selection');
    assert.equal(mirrorB.checked, false, 'a mirrored radio of the old value stayed checked');
    assert.equal(f.dims.area1.radios[1].checked, false);
});

test('a re-scan keeps each strip\'s generated name', () => {
    const f = fixture({dimensions: [{key: 'area1', checked: 'a', named: false}]});
    const mirrorA = extraRadio('area1', 'a');
    f.state.elements.push(mirrorA);
    f.exports.initialize(true);
    f.exports.initialize(true);
    assert.equal(f.dims.area1.radios[0].name, 'paste-ui-multistate:area1');
    assert.equal(mirrorA.name, 'paste-ui-multistate:area1:1',
        'the module took its own strip name for an authored one');
});

test('a radio added before initialize(true) joins the generated name of its key', () => {
    const f = fixture({dimensions: [{key: 'area1', checked: 'a', named: false}]});
    const added = extraRadio('area1', 'c');
    f.state.elements.push(added);
    f.exports.initialize(true);
    assert.equal(added.name, 'paste-ui-multistate:area1',
        'the module took its own generated name for an authored one');
});

test('the public members hand out plain objects', () => {
    const f = fixture({hash: '#area1:b'});
    const received = [];
    f.exports.events.multistatepop.subscribe((e, payload) => received.push(payload));
    f.dims.area2.radios[0].checked = true;
    f.dims.area2.radios[0].fireChange();
    const objects = [
        f.exports.getCurrentState(),
        f.exports.deserializeState('#area1:b,constructor:x'),
        received[0]
    ];
    objects.forEach(o => {
        assert.equal(Object.getPrototypeOf(o), Object.getPrototypeOf(f.exports.events),
            'a public object is not a plain object');
        assert.equal(o.hasOwnProperty('area1'), true);
        assert.equal(typeof String(o), 'string');
    });
    assert.equal(objects[1].constructor, 'x', 'a prototype-named key is not an own property');
});

test('deserializeState of an empty string is an empty state', () => {
    const f = fixture({hash: '#area1:b'});
    assert.deepEqual(Object.keys(f.exports.deserializeState('')), [],
        'an empty string decoded the current location.hash');
    assert.equal(f.exports.deserializeState().area1, 'b',
        'no argument did not read location.hash');
});

test('state snapshots are editable ordinary objects without changing the module', () => {
    const f = fixture();
    const state = f.exports.getCurrentState();
    state.area1 = 'local';
    assert.equal(state.area1, 'local');
    assert.equal(delete state.area2, true);
    assert.equal(Object.hasOwn(state, 'area2'), false);
    assert.equal(f.exports.getCurrentState().area1, 'a');
    assert.equal(f.exports.getCurrentState().area2, 'b');
});

test('changing one dimension never withdraws an unchanged dimension selection', () => {
    const f = fixture();
    const unchanged = f.dims.area2.contents[1];
    const removed = [];
    const removeAttribute = unchanged.removeAttribute;
    unchanged.removeAttribute = name => { removed.push(name); removeAttribute(name); };
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.exports.getCurrentState().area1, 'b');
    assert.equal(f.exports.getCurrentState().area2, 'b');
    assert.deepEqual(removed, [], 'an unchanged selection was withdrawn and reapplied');
});

test('an undecodable fragment key cannot select a dimension literally named undefined', () => {
    const f = fixture({dimensions: [{key: 'undefined', checked: 'a'}], hash: '#%ZZ:b'});
    assert.equal(f.exports.getCurrentState().undefined, 'a');
    f.window.location.hash = '#%ZZ:b';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().undefined, 'a');
});

test('a new mirrored strip is named after a prior mirrored strip was generated', () => {
    const f = fixture({dimensions: [{key: 'area1', checked: 'a', named: false}]});
    f.state.elements.push(extraRadio('area1', 'a'));
    f.exports.initialize(true);
    const third = extraRadio('area1', 'a');
    f.state.elements.push(third);
    f.exports.initialize(true);
    assert.equal(third.name, 'paste-ui-multistate:area1:2');
});

for (const kind of ['isInput', 'isContent']) {
    test('a page declaring only ' + kind + ' still observes hash navigation', () => {
        const f = fixture({beforeDefine: state => { state.elements = state.elements.filter(element => element[kind]); }});
        assert.equal(f.windowListeners.hashchange.length, 1);
        assert.equal(f.windowListeners.popstate.length, 1);
    });
}

test('a forced scan releases removed trigger elements', async () => {
    require('node:v8').setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const f = fixture();
    const reference = new WeakRef(f.dims.area1.radios[0]);
    delete f.dims.area1;
    f.state.elements = f.state.elements.filter(element => element.key !== 'area1');
    f.exports.initialize(true);
    await new Promise(resolve => setImmediate(resolve));
    gc();
    assert.equal(reference.deref(), undefined, 'the old change subscription retained a removed trigger');
    assert.equal(f.exports.getCurrentState().area2, 'b');
});

// A fake element tree: enough of parentNode, contains, localName and the
// role attribute for the module to read a strip's structure.
function treeNode(parent, options = {}) {
    const attrs = options.attrs || {};
    const node = {
        nodeType: 1, localName: options.localName || 'div', parentNode: parent || null,
        getAttribute: k => attrs[k] === undefined ? null : attrs[k],
        contains(other) {
            for (let at = other; at; at = at.parentNode) {
                if (at === node) return true;
            }
            return false;
        }
    };
    return node;
}

function placedRadio(parent, key, value, options = {}) {
    const radio = extraRadio(key, value, options);
    radio.nodeType = 1;
    radio.localName = 'input';
    radio.parentNode = parent;
    return radio;
}

function stripContent(key, value) {
    const el = {
        attrs: {'data-multistate-key': key, 'data-multistate-value': value},
        hasAttribute: k => el.attrs.hasOwnProperty(k),
        getAttribute: k => el.attrs[k] === undefined ? null : el.attrs[k],
        setAttribute: (k, v) => { el.attrs[k] = v; },
        removeAttribute: k => { delete el.attrs[k]; }
    };
    return el;
}

function stripPage(radios, contents) {
    const f = fixture({dimensions: []});
    f.state.elements.push(...radios, ...contents.map(([key, value]) => stripContent(key, value)));
    f.exports.initialize(true);
    return f;
}

const TAB_PANELS = [['tab', 'overview'], ['tab', 'specs'], ['tab', 'gallery']];

test('strips that differ in values each get a name of their own', () => {
    const root = treeNode(null);
    const stripA = treeNode(root);
    const stripB = treeNode(root);
    const a = [placedRadio(stripA, 'tab', 'overview', {checked: true}), placedRadio(stripA, 'tab', 'specs')];
    const b = [placedRadio(stripB, 'tab', 'overview'), placedRadio(stripB, 'tab', 'specs'),
        placedRadio(stripB, 'tab', 'gallery')];
    const f = stripPage([...a, ...b], TAB_PANELS);
    a.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab'));
    b.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab:1',
        'a value only the second strip offers took the first strip\'s group'));
    b[2].checked = true;
    b[2].fireChange();
    assert.equal(f.exports.getCurrentState().tab, 'gallery');
    assert.deepEqual([...a, ...b].map(r => r.checked), [false, false, false, false, true]);
    f.window.location.hash = '#tab:overview';
    f.fireHashchange();
    assert.deepEqual([...a, ...b].map(r => r.checked), [true, false, true, false, false]);
});

test('a stray radio before the strips keeps them apart', () => {
    const root = treeNode(null);
    const stray = placedRadio(root, 'tab', 'overview');
    const stripA = treeNode(root);
    const stripB = treeNode(root);
    const a = [placedRadio(stripA, 'tab', 'overview', {checked: true}), placedRadio(stripA, 'tab', 'specs')];
    const b = [placedRadio(stripB, 'tab', 'overview'), placedRadio(stripB, 'tab', 'specs')];
    stripPage([stray, ...a, ...b], TAB_PANELS);
    assert.equal(stray.name, 'paste-ui-multistate:tab');
    a.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab:1', 'a stray radio split a strip'));
    b.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab:2', 'a stray radio split a strip'));
});

test('flat strips under one parent split where a value repeats', () => {
    const parent = treeNode(treeNode(null));
    const radios = ['x', 'y', 'x', 'y', 'z'].map(v => placedRadio(parent, 'tab', v));
    stripPage(radios, [['tab', 'x'], ['tab', 'y'], ['tab', 'z']]);
    assert.deepEqual(radios.map(r => r.name), ['paste-ui-multistate:tab', 'paste-ui-multistate:tab',
        'paste-ui-multistate:tab:1', 'paste-ui-multistate:tab:1', 'paste-ui-multistate:tab:1']);
});

for (const boundary of [{localName: 'fieldset'}, {attrs: {role: 'radiogroup'}}, {attrs: {role: 'tablist'}}]) {
    test('a strip never reaches past a declared group: ' + JSON.stringify(boundary), () => {
        const root = treeNode(null);
        const group = treeNode(root, boundary);
        const inside = [placedRadio(group, 'tab', 'overview'), placedRadio(group, 'tab', 'specs')];
        const outside = placedRadio(root, 'tab', 'gallery');
        stripPage([...inside, outside], TAB_PANELS);
        inside.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab'));
        assert.equal(outside.name, 'paste-ui-multistate:tab:1', 'a radio outside the group joined it');
    });
}

test('a strip name never equals another key\'s name', () => {
    const parent = treeNode(treeNode(null));
    const a = ['x', 'y', 'x', 'y'].map(v => placedRadio(parent, 'a', v));
    const colon = ['p', 'q'].map(v => placedRadio(parent, 'a:1', v));
    const f = stripPage([...a, ...colon], [['a', 'x'], ['a', 'y'], ['a:1', 'p'], ['a:1', 'q']]);
    assert.deepEqual(a.map(r => r.name), ['paste-ui-multistate:a', 'paste-ui-multistate:a',
        'paste-ui-multistate:a:1', 'paste-ui-multistate:a:1']);
    colon.forEach(r => assert.equal(r.name, 'paste-ui-multistate:a%3A1'));
    // A re-scan reads both as generated, not authored.
    f.exports.initialize(true);
    assert.equal(a[2].name, 'paste-ui-multistate:a:1');
    colon.forEach(r => assert.equal(r.name, 'paste-ui-multistate:a%3A1', 'a generated name read as authored'));
});

test('one strip with every value distinct keeps the single generated name', () => {
    const root = treeNode(null);
    const strip = treeNode(root);
    const radios = ['overview', 'specs', 'gallery'].map(v => placedRadio(strip, 'tab', v));
    const elsewhere = placedRadio(treeNode(root), 'tab', 'overview');
    stripPage([...radios, elsewhere], TAB_PANELS);
    radios.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab'));
    assert.equal(elsewhere.name, 'paste-ui-multistate:tab:1');
});

// Interleaved strips: one radio of each strip per row (table rows with a
// strip per column, list items holding a radio of each strip, a grid
// filled row by row). Each strip keeps its own group.
const INTERLEAVED = [
    ['table columns', root => {
        const body = treeNode(treeNode(root, {localName: 'table'}), {localName: 'tbody'});
        return ['overview', 'specs', 'gallery'].map(v => {
            const row = treeNode(body, {localName: 'tr'});
            return [placedRadio(treeNode(row, {localName: 'td'}), 'tab', v),
                placedRadio(treeNode(row, {localName: 'td'}), 'tab', v)];
        });
    }],
    ['items holding one radio of each strip', root => {
        const list = treeNode(root);
        return ['overview', 'specs', 'gallery'].map(v => {
            const item = treeNode(list);
            return [placedRadio(item, 'tab', v), placedRadio(item, 'tab', v)];
        });
    }],
    ['grid cells filled row by row', root => {
        const grid = treeNode(root);
        return ['overview', 'specs', 'gallery'].map(v =>
            [placedRadio(treeNode(grid), 'tab', v), placedRadio(treeNode(grid), 'tab', v)]);
    }]
];
for (const [layout, build] of INTERLEAVED) {
    test('interleaved strips keep one group per strip: ' + layout, () => {
        const rows = build(treeNode(null));
        const f = stripPage(rows.flat(), TAB_PANELS);
        rows.forEach(([a, b]) => {
            assert.equal(a.name, 'paste-ui-multistate:tab', 'the first strip split: ' + rows.flat().map(r => r.name));
            assert.equal(b.name, 'paste-ui-multistate:tab:1', 'the second strip split: ' + rows.flat().map(r => r.name));
        });
        rows[2][1].checked = true;
        rows[2][1].fireChange();
        assert.deepEqual(rows.flat().map(r => r.checked), [false, false, false, false, true, true]);
        assert.equal(f.exports.getCurrentState().tab, 'gallery');
    });
}

test('flat strips: a value before any repeat stays with the strip it follows', () => {
    // overview specs gallery overview specs, side by side: nothing in
    // the markup says where the second strip starts before a value
    // repeats, so gallery stays with the first.
    const parent = treeNode(treeNode(null));
    const radios = ['overview', 'specs', 'gallery', 'overview', 'specs'].map(v => placedRadio(parent, 'tab', v));
    stripPage(radios, TAB_PANELS);
    assert.deepEqual(radios.map(r => r.name.replace('paste-ui-multistate:', '')),
        ['tab', 'tab', 'tab', 'tab:1', 'tab:1']);
});

test('a lone radio in another container never joins flat strips beside it', () => {
    const root = treeNode(null);
    const stray = placedRadio(root, 'tab', 'gallery');
    const flat = treeNode(root);
    const radios = ['overview', 'specs', 'overview', 'specs'].map(v => placedRadio(flat, 'tab', v));
    stripPage([stray, ...radios], TAB_PANELS);
    assert.equal(stray.name, 'paste-ui-multistate:tab');
    assert.deepEqual(radios.map(r => r.name.replace('paste-ui-multistate:', '')),
        ['tab:1', 'tab:1', 'tab:2', 'tab:2'], 'a stray radio joined a flat strip');
});

test('side-by-side radios never run across a declared group', () => {
    const root = treeNode(null);
    const groups = [treeNode(root, {localName: 'fieldset'}), treeNode(root, {attrs: {role: 'radiogroup'}})];
    // Each group holds a strip and a mirror of it, flat.
    const radios = groups.map(group =>
        ['overview', 'specs', 'overview'].map(v => placedRadio(group, 'tab', v)));
    stripPage(radios.flat(), TAB_PANELS);
    assert.deepEqual(radios.flat().map(r => r.name.replace('paste-ui-multistate:', '')),
        ['tab', 'tab', 'tab:1', 'tab:2', 'tab:2', 'tab:3'], 'a run crossed a declared group');
});

test('naming a key reads each radio\'s ancestors once, not once per other radio', () => {
    const root = treeNode(null);
    const list = treeNode(treeNode(root));
    let reads = 0;
    const radios = [];
    for (let at = 0; at < 2000; at += 1) {
        const radio = placedRadio(treeNode(list, {localName: 'li'}), 'tab', 'v' + at);
        radios.push(radio);
    }
    const tracked = new Set([root, list, list.parentNode, ...radios, ...radios.map(r => r.parentNode)]);
    tracked.forEach(node => {
        let parent = node.parentNode;
        Object.defineProperty(node, 'parentNode', {get() { reads += 1; return parent; }, set(v) { parent = v; }});
    });
    stripPage(radios, radios.map(r => ['tab', r.value]));
    radios.forEach(r => assert.equal(r.name, 'paste-ui-multistate:tab'));
    // Depth 5 per radio: a pass that compares every radio with every
    // other reads millions.
    assert.ok(reads < 2000 * 12, 'naming read ' + reads + ' parent links for 2000 radios');
});

test('a key keeps its own text in the generated name unless it holds a colon or a percent sign', () => {
    const parent = treeNode(treeNode(null));
    const spaced = ['x', 'y', 'x', 'y'].map(v => placedRadio(parent, 'north america', v));
    const percent = ['x', 'y'].map(v => placedRadio(parent, 'a%3A1', v));
    const colon = ['x', 'y'].map(v => placedRadio(parent, 'a:1', v));
    const raw = ['x', 'y'].map(v => placedRadio(parent, 'a', v));
    const f = stripPage([...spaced, ...percent, ...colon, ...raw],
        ['north america', 'a%3A1', 'a:1', 'a'].flatMap(k => [[k, 'x'], [k, 'y']]));
    assert.deepEqual(spaced.map(r => r.name), ['paste-ui-multistate:north america', 'paste-ui-multistate:north america',
        'paste-ui-multistate:north america:1', 'paste-ui-multistate:north america:1']);
    percent.forEach(r => assert.equal(r.name, 'paste-ui-multistate:a%253A1'));
    colon.forEach(r => assert.equal(r.name, 'paste-ui-multistate:a%3A1'));
    raw.forEach(r => assert.equal(r.name, 'paste-ui-multistate:a'));
    f.exports.initialize(true);
    assert.equal(spaced[2].name, 'paste-ui-multistate:north america:1', 'a raw generated name read as authored');
});

test('a key or value holding a lone surrogate is escaped, never thrown', () => {
    const key = 'k:\uD800';
    const radios = [extraRadio(key, 'u', {checked: true}), extraRadio(key, 'v\uDC00')];
    const f = stripPage(radios, [[key, 'u'], [key, 'v\uDC00']]);
    assert.equal(radios[0].name, 'paste-ui-multistate:k%3A%uD800');
    assert.equal(f.exports.getCurrentState()[key], 'u');
    radios[1].checked = true;
    radios[1].fireChange();
    assert.equal(f.exports.getCurrentState()[key], 'v\uDC00');
    assert.equal(f.pushed.length, 1, 'the change wrote no entry');
    assert.ok(f.pushed[0].url.includes('k%3A%uD800:v%uDC00'), 'the entry is not escaped: ' + f.pushed[0].url);
});
