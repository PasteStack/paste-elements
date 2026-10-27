const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The multistate contract: every dimension's checked default is captured,
// a single input change carries the other dimensions' current selections
// instead of dropping them, the hash is authoritative, authored input
// names are preserved, and the original public object identity is retained.

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
            tagName: 'INPUT',
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
        let checkedState = !!checked, nativeName = name;
        Object.defineProperty(el, 'checked', {
            configurable: true,
            get() { return checkedState; },
            set(value) {
                checkedState = !!value;
                if (checkedState && el.name) {
                    state.elements.forEach(other => {
                        if (other !== el && other.isInput && other.name === el.name && other.form === el.form) other.checked = false;
                    });
                }
            }
        });
        Object.defineProperty(el, 'name', {
            configurable: true,
            get() { return nativeName; },
            set(value) { nativeName = value; if (checkedState) el.checked = true; }
        });
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

    const address = new URL('https://example.test/page' + state.hash);
    const location = {
        get hash() { return address.hash; },
        set hash(value) { address.hash = value; },
        get href() { return address.href; },
        set href(value) { address.href = value; }
    };
    const window = {
        location,
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
    // this constructor is also available; event.bind reaches the same subscription. Window listeners
    // land in windowListeners, element listeners on the element.
    event.Event.Subscription = function (type, el, fn) {
        this.dispose = event.bind(type, el, fn).dispose;
    };

    if (options.beforeDefine) options.beforeDefine(state);
    let guidCounter = 0;
    const exports = {};
    vm.runInNewContext(
        readModuleSource('paste/ui/multistate.js'),
        {
            window, console,
            document: {},
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.multistate');
                assert.equal(deps.join('|'), 'paste.util|paste.dom|paste.event|paste.guid');
                const ns = factory(exports, util, dom, event, {Guid: {create: () => 'test-guid-' + (++guidCounter)}});
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

test('generated names give one native name per unnamed dimension and stable missing ids', () => {
    const f = fixture({dimensions: [
        {key: 'view', checked: 'a', named: false},
        {key: 'period', checked: 'b', named: false}
    ]});
    const before = Object.values(f.dims).flatMap(d => d.radios.map(r => [r.name, r.id]));
    assert.equal(f.dims.view.radios[0].name, f.dims.view.radios[1].name);
    assert.notEqual(f.dims.view.radios[0].name, f.dims.period.radios[0].name);
    f.exports.initialize(true);
    assert.deepEqual(Object.values(f.dims).flatMap(d => d.radios.map(r => [r.name, r.id])), before);
});

test('the module publishes the same selected-state object returned by getCurrentState', () => {
    const f = fixture();
    const initial = f.exports.getCurrentState();
    assert.equal(initial, f.popped.at(-1));
    assert.equal(initial, f.exports.getCurrentState());
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.notEqual(initial, f.exports.getCurrentState());
    assert.equal(f.popped.at(-1), f.exports.getCurrentState());
});

test('the module writes the address before announcing the selected state', () => {
    const f = fixture();
    const received = [];
    f.exports.events.multistatepop.subscribe((e, state) => received.push([f.window.location.hash, state.area1]));
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(received.length, 1);
    assert.match(received[0][0], /area1:b/);
    assert.equal(received[0][1], 'b');
});

test('an explicit partial state clears the omitted dimension and its panel', () => {
    const f = fixture();
    f.window.location.hash = '#area1:b';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area2, undefined);
    assert.ok(f.dims.area2.radios.every(r => !r.checked));
    assert.deepEqual(selected(f.dims, 'area2'), []);
});

test('several panels can share a radio value without a mirrored control system', () => {
    const f = fixture({beforeDefine: state => {
        const panel = state.elements.find(e => e.isContent && e.key === 'area1' && e.value === 'b');
        const copy = {...panel, attrs: {...panel.attrs}, classSet: {add() {}, delete() {}}};
        copy.setAttribute = (k, v) => { copy.attrs[k] = v; };
        copy.removeAttribute = k => { delete copy.attrs[k]; };
        state.elements.push(copy);
    }});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.state.elements.filter(e => e.key === 'area1' && e.attrs['data-multistate-state'] === 'b').length, 2);
});

test('URI serialization round trips separators and preserves foreign state values', () => {
    const f = fixture({hash: '#foreign:a%3Ab%2Cc'});
    assert.deepEqual({...f.exports.deserializeState(f.exports.serializeState({'a:b': 'c,d e'}))}, {'a:b': 'c,d e'});
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    const decoded = f.exports.deserializeState(f.window.location.hash);
    assert.equal(decoded.foreign, 'a:b,c');
    assert.equal(decoded.area1, 'b');
    assert.equal(decoded.area2, 'b');
});

test('radio-only dimensions retain defaults, changes and URL restoration without panel markers', () => {
    // the original registered every trigger value even when there was no content node.
    // Native sibling CSS can supply the entire presentation independently.
    const f = fixture({beforeDefine: state => {
        state.elements = state.elements.filter(el => el.isInput);
    }});
    assert.equal(f.exports.getCurrentState().area1, 'a');
    assert.equal(f.exports.getCurrentState().area2, 'b');
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.exports.getCurrentState().area1, 'b');
    assert.ok(f.pushed[0].url.includes('area1:b'));
    f.window.location.hash = '#area1:a,area2:a';
    f.fireHashchange();
    assert.equal(f.exports.getCurrentState().area1, 'a');
    assert.equal(f.dims.area1.radios[0].checked, true);
    assert.equal(f.dims.area2.radios[0].checked, true);
});

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
    const f = fixture({beforeDefine: state => {
        state.elements.find(e => e.isInput).id = 'authored-radio';
    }});
    assert.equal(f.dims.area1.radios[0].id, 'authored-radio');
    assert.match(f.dims.area1.radios[1].id, /^test-guid-/);
    assert.equal(new Set(Object.values(f.dims).flatMap(d => d.radios.map(r => r.id))).size, 4);
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
            isInput: true,
            tagName: 'INPUT', type: 'radio', key: 'area3', value, checked, defaultChecked: checked, name: '', id: '',
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
    assert.match(r3a.name, /^area3\$test-guid-/, 'generated grouping was not supplied for unnamed radios');
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

test('prototype-named dimensions keep their selections in state and payloads', () => {
    const f = fixture({dimensions: [
        {key: '__proto__', checked: 'a'},
        {key: 'constructor', checked: 'x', values: ['x', 'y']},
        {key: 'toString', checked: 'on', values: ['on', 'off']}
    ]});
    const current = f.exports.getCurrentState();
    assert.ok(Object.prototype.hasOwnProperty.call(current, '__proto__'),
        'the __proto__ dimension vanished from the state object');
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
        'the published state object dropped the __proto__ dimension');
    assert.equal(payload['__proto__'], 'a');
    assert.equal(payload['area1'], 'b', 'the published selection did not update');
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
    assert.equal(current.area2, undefined, 'a state omitted from the explicit address was retained');
    assert.deepEqual(selected(f.dims, 'area2'), []);
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

test('authored names stay intact while missing names receive generated grouping', () => {
    const f = fixture({dimensions: [
        {key: 'area1', checked: 'a', named: ['mine', '']}
    ]});
    assert.equal(f.dims.area1.radios[0].name, 'mine');
    assert.match(f.dims.area1.radios[1].name, /^area1\$test-guid-/);
});

test('non-radio trigger names stay authored', () => {
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

function extraRadio(key, value, options = {}) {
    const radio = {
        isInput: true, tagName: 'INPUT', type: 'radio', key, value,
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

test('a radio value without a content panel is a declared selection in the pushed fragment', () => {
    // the module registers the radio's state independently of any marked content.
    const f = fixture();
    const orphan = extraRadio('area1', 'nowhere');
    f.state.elements.push(orphan);
    f.exports.initialize(true);
    orphan.checked = true;
    orphan.fireChange();
    assert.equal(f.pushed.length, 1);
    assert.ok(f.pushed[0].url.includes('area1:nowhere'));
    assert.equal(f.exports.getCurrentState().area1, 'nowhere');
    assert.deepEqual(f.exports.deserializeState(f.pushed[0].url), f.exports.getCurrentState(),
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

test('a forced scan clears a live choice when neither markup nor fragment selects it', () => {
    const f = fixture({dimensions: [{key: 'view', checked: null}]});
    f.dims.view.radios[1].checked = true;
    f.dims.view.radios[1].fireChange();
    assert.equal(f.exports.getCurrentState().view, 'b');
    f.window.location.hash = '#section';
    f.exports.initialize(true);
    assert.equal(f.exports.getCurrentState().view, undefined);
    assert.ok(f.dims.view.radios.every(radio => !radio.checked));
    assert.ok(f.dims.view.contents.every(panel => !panel.hasAttribute('data-multistate-state')));
});

test('deserializeState of an empty string is an empty state', () => {
    const f = fixture({hash: '#area1:b'});
    assert.deepEqual(Object.keys(f.exports.deserializeState('')), [],
        'an empty string decoded the current location.hash');
    assert.equal(f.exports.deserializeState().area1, 'b',
        'no argument did not read location.hash');
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

test('binding and rescanning radios never inspect their parent structure', () => {
    const f = fixture({beforeDefine: state => {
        state.elements.filter(e => e.isInput).forEach(radio => {
            Object.defineProperty(radio, 'parentNode', {
                get() { throw new Error('radio ancestry was inspected'); }
            });
        });
    }});
    assert.doesNotThrow(() => f.exports.initialize(true));
    assert.equal(f.dims.area1.radios[0].name, 'group-area1');
});

test('changing one dimension leaves other panels and radios untouched', () => {
    const f = fixture();
    const other = f.dims.area2;
    for (const radio of other.radios) {
        let checked = radio.checked;
        Object.defineProperty(radio, 'checked', {get: () => checked,
            set: () => assert.fail('an unchanged radio was assigned')});
    }
    for (const panel of other.contents) {
        panel.setAttribute = () => assert.fail('an unchanged panel was written');
        panel.removeAttribute = () => assert.fail('an unchanged panel was cleared');
    }
    f.dims.area1.radios[1].checked = true;
    f.dims.area1.radios[1].fireChange();
    assert.equal(f.exports.getCurrentState().area1, 'b');
});

for (const kind of ['isInput', 'isContent']) {
    test('a page declaring only ' + kind + ' still observes hash navigation', () => {
        const f = fixture({beforeDefine: state => { state.elements = state.elements.filter(element => element[kind]); }});
        assert.equal(f.windowListeners.hashchange.length, 1);
        assert.equal(f.windowListeners.popstate.length, 1);
    });
}


for (const type of ['text', 'checkbox', 'button', 'select-one']) {
    test('multistate leaves marked ' + type + ' controls inert', () => {
        const f = fixture({dimensions: [{key: 'mode', checked: 'a', type}]});
        const input = f.dims.mode.radios[1];
        assert.equal(input.listenerCount('change'), 0);
        input.fireChange();
        assert.equal(f.pushed.length, 0);
        assert.equal(f.exports.getCurrentState().mode, undefined);
    });
}


test('an undeclared initial fragment value falls back to the authored default', () => {
    const f = fixture({hash: '#area1:zzz'});
    assert.equal(f.exports.getCurrentState().area1, 'a');
});
