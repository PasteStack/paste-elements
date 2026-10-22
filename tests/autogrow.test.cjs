const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The autogrow contract: the field sizes itself on 'input' — the boundary
// that sees typing, delete, cut, paste and undo — never only on 'keyup'.
// The authored box is the floor: content taller than it grows the
// element, deleted content shrinks it back, and nothing shrinks below
// the declared size.

function fixture(options = {}) {
    // Every geometry read and height write lands here, tagged with its
    // field, so a test can assert the pass batch order: resets, then
    // measures, then writes.
    const opLog = [];
    const elements = (options.elements || []).map((cfg, cfgIndex) => {
        const elListeners = {};
        const attrs = cfg.attrs || {'data-paste-autogrow': ''};
        const el = {
            nodeName: 'TEXTAREA',
            attrs,
            geometryReads: 0,
            scrollHeightValue: cfg.scrollHeight,
            clientHeight: cfg.clientHeight,
            computedStyle: cfg.computedStyle || {
                boxSizing: 'content-box',
                paddingTop: '0px',
                paddingBottom: '0px',
                borderTopWidth: '0px',
                borderBottomWidth: '0px'
            },
            style: {height: ''},
            listeners: elListeners,
            addEventListener: (t, fn) => { (elListeners[t] = elListeners[t] || []).push(fn); },
            removeEventListener() {},
            hasAttribute: name => attrs.hasOwnProperty(name),
            fire: t => (elListeners[t] || []).slice().forEach(fn => fn({target: undefined})),
            parentNode: cfg.parentNode || null
        };
        // A geometry read is counted — a burst of input must not turn
        // into a forced layout per event.
        Object.defineProperty(el, 'scrollHeight', {
            get() {
                el.geometryReads += 1;
                opLog.push({el: cfgIndex, op: 'measure'});
                return el.scrollHeightValue;
            },
            set(v) { el.scrollHeightValue = v; }
        });
        // Height writes go through a setter so reset ('0px') and final
        // (px) writes are distinguishable in the log.
        let heightValue = '';
        el.style = {};
        // Inline declarations other than height, with their priority, as
        // the CSSOM's property methods see them.
        el.inline = {};
        el.style.getPropertyValue = name => (el.inline[name] || {value: ''}).value;
        el.style.getPropertyPriority = name => (el.inline[name] || {priority: ''}).priority;
        el.style.setProperty = (name, value, priority) => {
            el.inline[name] = {value, priority: priority || ''};
            opLog.push({el: cfgIndex, op: 'set ' + name});
        };
        el.style.removeProperty = name => {
            delete el.inline[name];
            opLog.push({el: cfgIndex, op: 'remove ' + name});
        };
        Object.defineProperty(el.style, 'height', {
            get() { return heightValue; },
            set(v) {
                // A CSSOM that serializes to 6 significant digits, as
                // Chromium does, when the fixture asks for it.
                heightValue = cfg.roundCssom && /px$/.test(v)
                    ? Number(parseFloat(v).toPrecision(6)) + 'px'
                    : v;
                opLog.push({el: cfgIndex, op: v === '0px' ? 'reset' : 'write'});
                if (cfg.onHeight) { cfg.onHeight(v, el); }
            }
        });
        return el;
    });

    const dom = {
        // Selector-honest discovery: only elements carrying the declared
        // marker answer, and only for the module's canonical selector —
        // a fake that ignores its selector greens against nonsense.
        get: (sel, scoped) => {
            if (sel === 'textarea[data-paste-autogrow]') {
                const matches = elements.filter(el =>
                    el.nodeName === 'TEXTAREA' && el.hasAttribute('data-paste-autogrow'));
                // Core treats the unscoped argument as an element id.
                return scoped ? matches : elements.find(el => el.attrs.id === sel) || null;
            }
            return [];
        }
    };
    const event = {
        getEventTarget: e => e.target,
        Event: {Subscription: function (type, el, fn) {
            el.addEventListener(type, fn);
            this.dispose = () => {};
        }}
    };
    const frames = [];
    const requests = [];
    const requestedWrites = [];
    const deliver = cb => {
        if (options.scheduler && options.scheduler.sync) {
            // A scheduler that delivers before request returns.
            cb(16);
            return requests.length;
        }
        frames.push(cb);
        return frames.length;
    };
    const animation_frame = {
        request: cb => {
            requests.push(cb);
            return deliver(cb);
        },
        // The phased pair is one frame: the read half, then the write
        // half, on one delivery. requests records the read half,
        // requestedWrites the write half.
        requestPhased: (read, write) => {
            requests.push(read);
            requestedWrites.push(write);
            return deliver(time => {
                read(time);
                // Another module's write landing between the phases.
                if (options.betweenPhases) { options.betweenPhases(); }
                write(time);
            });
        },
        cancel: () => {}
    };
    const scrolls = [];
    const window = Object.assign({
        getComputedStyle: el => { el.geometryReads += 1; return el.computedStyle; }
    }, options.window || {});
    if (options.page) {
        // A page whose offset the engine clamps while a field is
        // collapsed: the reset shortens the document, the read after
        // measurement sees the clamped offset.
        window.pageXOffset = 0;
        window.pageYOffset = options.page.scrollY;
        window.scrollTo = (x, y) => { scrolls.push([x, y]); window.pageYOffset = y; };
    }
    const document = {};
    if (options.scrollOptions) {
        // An engine with scroll options: the scroll-behavior property
        // exists, and scrollTo takes an options object. 'auto' follows the
        // root's smooth scroll-behavior and moves nothing within the task;
        // 'instant' lands at once. rejectInstant models an engine that
        // knows only 'auto' and 'smooth'.
        document.documentElement = {style: {scrollBehavior: ''}};
        window.pageXOffset = 0;
        window.scrollTo = (a, b) => {
            if (a && typeof a === 'object') {
                if (a.behavior === 'instant' && options.scrollOptions.rejectInstant) {
                    throw new TypeError("'instant' is not a valid ScrollBehavior");
                }
                // Copied out of the module's realm for deepEqual.
                scrolls.push({...a});
                if (a.behavior === 'instant') { window.pageYOffset = a.top; }
            } else {
                scrolls.push([a, b]);
            }
        };
    }

    vm.runInNewContext(
        readModuleSource('paste/ui/autogrow.js'),
        {
            window,
            console,
            document,
            paste: {define(name, deps, factory) {
                assert.equal(name, 'paste.ui.autogrow');
                assert.equal(deps.join('|'),
                    'paste.dom|paste.event|paste.ui.utilities.animation-frame');
                factory({}, dom, event, animation_frame);
            }}
        }
    );

    return {
        elements,
        opLog,
        window,
        scrolls,
        requests,
        requestedWrites,
        framesPending: () => frames.length,
        pump: () => frames.splice(0).forEach(fn => fn(16))
    };
}

test('the declared textarea binds through its data attribute', () => {
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40}]});
    assert.ok(f.elements[0].listeners.input,
        'a declared textarea never received its input listener');
    assert.equal(f.elements[0].style.height, '40px',
        'a declared textarea was never sized at bind');
});

test('an undeclared textarea is never touched', () => {
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40, attrs: {}}]});
    assert.deepEqual(Object.keys(f.elements[0].listeners), [],
        'an undeclared element received listeners');
    assert.equal(f.elements[0].style.height, '',
        'an undeclared element was resized');
});

test('the legacy .autogrow class alone declares nothing', () => {
    const f = fixture({elements: [
        {scrollHeight: 40, clientHeight: 40, attrs: {class: 'autogrow'}}
    ]});
    assert.deepEqual(Object.keys(f.elements[0].listeners), [],
        'a class-only element was bound as if it carried the declaration');
});

test('the element listens on input, never keyup', () => {
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40}]});
    const el = f.elements[0];
    assert.ok(el.listeners.input, 'no input listener was bound');
    assert.equal(el.listeners.keyup, undefined,
        'a keyup listener was bound — cut/paste/delete would not reach it');
});

test('initial sizing honors the authored height as the floor', () => {
    const f = fixture({elements: [{scrollHeight: 20, clientHeight: 80}]});
    assert.equal(f.elements[0].style.height, '80px',
        'init shrank the box below its authored height');
});

test('taller content grows the box on input', () => {
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40}]});
    const el = f.elements[0];
    el.scrollHeight = 140;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '140px', 'the box did not grow');
});

test('deleted content shrinks the box back', () => {
    const f = fixture({elements: [{scrollHeight: 140, clientHeight: 40}]});
    const el = f.elements[0];
    assert.equal(el.style.height, '140px', 'precondition: grown at init');

    el.scrollHeight = 60;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '60px',
        'deleted content left the box pinned at its tallest');

    el.scrollHeight = 10;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '40px',
        'the box shrank below its authored height');
});

test('a burst of input events costs one sizing pass, not one layout each', () => {
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40}]});
    const el = f.elements[0];
    el.scrollHeight = 140;
    const readsBefore = el.geometryReads;
    for (let i = 0; i < 20; i += 1) {
        el.fire('input');
    }
    assert.equal(el.geometryReads, readsBefore,
        'an input handler read geometry synchronously');
    f.pump();
    assert.equal(el.geometryReads - readsBefore <= 2, true,
        'one frame performed more than the sizing pass\'s own reads');
    assert.equal(el.style.height, '140px', 'the coalesced pass sized the box');
    // The next burst is a fresh pass — shrink still works after growth.
    el.scrollHeight = 60;
    for (let i = 0; i < 5; i += 1) {
        el.fire('input');
    }
    f.pump();
    assert.equal(el.style.height, '60px', 'a later burst never re-armed');
});

test('content-box sizing subtracts padding from the content extent', () => {
    const pad = {
        boxSizing: 'content-box',
        paddingTop: '10px',
        paddingBottom: '10px',
        borderTopWidth: '0px',
        borderBottomWidth: '0px'
    };
    const f = fixture({elements: [
        {scrollHeight: 40, clientHeight: 100, computedStyle: pad}
    ]});
    const el = f.elements[0];
    // The authored floor is the declared content height — clientHeight
    // counts padding the CSS height does not.
    assert.equal(el.style.height, '80px',
        'the floor was measured in padding-inclusive units');
    el.scrollHeight = 140;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '120px',
        'content demand counted padding twice');
});

test('border-box sizing adds borders to the content extent', () => {
    const borders = {
        boxSizing: 'border-box',
        paddingTop: '0px',
        paddingBottom: '0px',
        borderTopWidth: '2px',
        borderBottomWidth: '2px'
    };
    const f = fixture({elements: [
        {scrollHeight: 96, clientHeight: 96, computedStyle: borders}
    ]});
    const el = f.elements[0];
    // A 100px authored border box must not shrink to a 96px client area.
    assert.equal(el.style.height, '100px',
        'border-box assignment dropped the borders');
    el.scrollHeight = 420;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '424px',
        'content demand left the borders clipping content');
});

test('a burst across fields arms one frame batching resets, measures, then writes', () => {
    const f = fixture({elements: [
        {scrollHeight: 40, clientHeight: 40},
        {scrollHeight: 50, clientHeight: 50}
    ]});
    const [a, b] = f.elements;
    f.opLog.length = 0;
    a.scrollHeight = 140;
    b.scrollHeight = 180;
    a.fire('input');
    b.fire('input');
    a.fire('input');
    assert.equal(f.framesPending(), 1, 'the burst armed more than one frame');
    const readsBefore = a.geometryReads + b.geometryReads;
    f.pump();
    assert.equal(a.geometryReads + b.geometryReads - readsBefore, 4,
        'each dirty field owed exactly one computed style and one scrollHeight read');
    assert.deepEqual(f.opLog, [
        {el: 0, op: 'reset'},
        {el: 1, op: 'reset'},
        {el: 0, op: 'measure'},
        {el: 1, op: 'measure'},
        {el: 0, op: 'write'},
        {el: 1, op: 'write'}
    ], 'the pass interleaved writes and geometry reads');
    assert.equal(a.style.height, '140px');
    assert.equal(b.style.height, '180px');
});

test('binding measures every field before writing any height', () => {
    // The bind path runs the same batching rule as input bursts: a page
    // of declared boxes pays one measure phase and one write phase,
    // not a forced layout per field.
    const f = fixture({elements: [
        {scrollHeight: 40, clientHeight: 40},
        {scrollHeight: 50, clientHeight: 50},
        {scrollHeight: 60, clientHeight: 60}
    ]});
    assert.deepEqual(f.opLog, [
        {el: 0, op: 'measure'},
        {el: 1, op: 'measure'},
        {el: 2, op: 'measure'},
        {el: 0, op: 'write'},
        {el: 1, op: 'write'},
        {el: 2, op: 'write'}
    ], 'init interleaved geometry reads and height writes');
});

test('a height the user dragged to becomes the floor, not a size to undo', () => {
    // The native resize handle writes the dragged size inline. The next
    // keystroke must not snap the box back to its content height.
    const f = fixture({elements: [{scrollHeight: 40, clientHeight: 40}]});
    const el = f.elements[0];
    assert.equal(el.style.height, '40px', 'precondition: sized at bind');
    el.style.height = '300px';
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '300px', 'a keystroke discarded the user\'s resize');
    el.scrollHeight = 420;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '420px', 'content taller than the user height did not grow');
    el.scrollHeight = 50;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '300px', 'deleting content collapsed below the user height');
});

test('an unrendered field at bind gets no height and no zero floor', () => {
    const f = fixture({elements: [{scrollHeight: 0, clientHeight: 0}]});
    const el = f.elements[0];
    assert.equal(el.style.height, '', 'an unrendered field was written at bind');
    // Shown later: the floor is captured from its first rendered box.
    el.clientHeight = 80;
    el.scrollHeight = 20;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '80px',
        'the lazily captured floor was not the rendered authored height');
});

test('a field unrendered at pass time keeps its inline height', () => {
    const f = fixture({elements: [{scrollHeight: 60, clientHeight: 60}]});
    const el = f.elements[0];
    assert.equal(el.style.height, '60px');
    el.scrollHeight = 0;
    el.clientHeight = 0;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '60px', 'a hidden field was written a zero or collapsed height');
});

test('padding never drives a written height to zero or below', () => {
    const pad = {
        boxSizing: 'content-box',
        paddingTop: '10px',
        paddingBottom: '10px',
        borderTopWidth: '0px',
        borderBottomWidth: '0px'
    };
    const f = fixture({elements: [{scrollHeight: 0, clientHeight: 0, computedStyle: pad}]});
    assert.equal(f.elements[0].style.height, '', 'an unrendered padded field got a negative height');
});

test('a field styled shorter than its rows keeps its authored floor', () => {
    // height: 100px with rows="12": the authored box is 100px, while
    // 'auto' would fall back to the rows' intrinsic 198px. The collapse
    // measures the content alone, so one line stays at the floor and
    // more content grows past it.
    let content = 40;
    const f = fixture({elements: [{
        scrollHeight: 100, clientHeight: 100,
        onHeight: function (value, el) {
            el.scrollHeightValue = value === 'auto' ? 198 : value === '0px' ? content : el.scrollHeightValue;
        }
    }]});
    const el = f.elements[0];
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '100px', 'the collapse fell back to the rows height');
    content = 260;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '260px', 'the field did not grow with its content');
});

// An engine with a height transition: a collapse that is not held starts
// a transition, so the measure reads the old height; a final height still
// unapplied when the hold is released animates up from the collapse.
function timedField(f, transition) {
    const state = {content: 40, pendingFinal: false, animated: false};
    const held = el => ['transition-duration', 'transition-delay'].every(name =>
        el.inline[name] && el.inline[name].value === '0s' && el.inline[name].priority === 'important');
    const computed = {
        boxSizing: 'content-box', paddingTop: '0px', paddingBottom: '0px',
        borderTopWidth: '0px', borderBottomWidth: '0px',
        transitionDelay: transition.delay || '0s'
    };
    Object.defineProperty(computed, 'transitionDuration', {get() {
        // A style read applies whatever height was written last.
        if (state.pendingFinal) {
            state.pendingFinal = false;
            state.animated = !held(state.el);
            f.get().opLog.push({el: 0, op: 'style'});
        }
        return transition.duration || '0s';
    }});
    state.config = {
        scrollHeight: 300, clientHeight: 80, computedStyle: computed,
        onHeight: (value, el) => {
            state.el = el;
            if (value === '0px') {
                el.scrollHeightValue = held(el) ? state.content : 300;
            } else if (f.get()) {
                state.pendingFinal = true;
            }
        }
    };
    state.held = held;
    return state;
}

test('a field with a height transition is held while it collapses, so deleted content still shrinks it', () => {
    let f;
    const box = {get: () => f};
    const timed = timedField(box, {duration: '0.2s'});
    f = fixture({elements: [timed.config]});
    const el = f.elements[0];
    assert.equal(el.style.height, '300px', 'precondition: grown at bind');
    // The author's own inline duration, important, must come back.
    el.inline['transition-duration'] = {value: '1s', priority: 'important'};
    f.opLog.length = 0;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '80px', 'the collapse animated and the field never shrank');
    assert.equal(timed.animated, false, 'the final height was released before it applied');
    assert.deepEqual(f.opLog.map(entry => entry.op), [
        'set transition-duration', 'set transition-delay', 'reset', 'measure', 'write', 'style',
        'set transition-duration', 'remove transition-delay'
    ], 'the hold did not wrap the collapse, the measure and the applied final height');
    assert.deepEqual(el.inline, {'transition-duration': {value: '1s', priority: 'important'}},
        'the author\'s inline transition was not put back as written');
});

test('a delayed zero-duration transition is held as well', () => {
    let f;
    const timed = timedField({get: () => f}, {duration: '0s', delay: '0.3s'});
    f = fixture({elements: [timed.config]});
    const el = f.elements[0];
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '80px', 'a delayed transition held the old height through the measure');
    assert.deepEqual(el.inline, {}, 'the hold left an inline transition behind');
});

test('a field whose transitions are all zero is never held', () => {
    const f = fixture({elements: [{
        scrollHeight: 300, clientHeight: 80,
        computedStyle: {
            boxSizing: 'content-box', paddingTop: '0px', paddingBottom: '0px',
            borderTopWidth: '0px', borderBottomWidth: '0px',
            transitionDuration: '0s, 0s', transitionDelay: '0s, 0s'
        }
    }]});
    const el = f.elements[0];
    f.opLog.length = 0;
    const readsBefore = el.geometryReads;
    el.scrollHeight = 40;
    el.fire('input');
    f.pump();
    assert.deepEqual(f.opLog.map(entry => entry.op), ['reset', 'measure', 'write'],
        'an untimed field was held');
    assert.equal(el.geometryReads - readsBefore, 2, 'an untimed field paid a second style read');
    assert.equal(el.style.height, '80px');
});

// An inline transition shorthand holding var(): every longhand it set
// reads back empty, a longhand written over it leaves the shorthand
// reading empty, and only setting the shorthand again restores it.
function pendingShorthand(el, text, priority) {
    let shorthand = {value: text, priority};
    el.style.getPropertyValue = name => name === 'transition'
        ? (shorthand ? shorthand.value : '')
        : (el.inline[name] || {value: ''}).value;
    el.style.getPropertyPriority = name => name === 'transition'
        ? (shorthand ? shorthand.priority : '')
        : (el.inline[name] || {priority: ''}).priority;
    el.style.setProperty = (name, value, valuePriority) => {
        if (name === 'transition') {
            shorthand = {value, priority: valuePriority || ''};
            delete el.inline['transition-duration'];
            delete el.inline['transition-delay'];
            return;
        }
        shorthand = null;
        el.inline[name] = {value, priority: valuePriority || ''};
    };
    el.style.removeProperty = name => {
        shorthand = null;
        delete el.inline[name];
    };
}

test('an inline transition shorthand holding var() comes back whole after the hold', () => {
    [['var(--t)', ''], ['var(--t)', 'important'], ['height 0.3s, background-color 1s linear', '']].forEach(([text, priority]) => {
        let f;
        const timed = timedField({get: () => f}, {duration: '0.3s, 1s'});
        f = fixture({elements: [timed.config]});
        const el = f.elements[0];
        pendingShorthand(el, text, priority);
        el.fire('input');
        f.pump();
        assert.equal(el.style.height, '80px', text + ': the collapse was not held');
        assert.equal(timed.animated, false, text + ': the final height was released before it applied');
        assert.equal(el.style.getPropertyValue('transition'), text, 'the author\'s inline shorthand was lost');
        assert.equal(el.style.getPropertyPriority('transition'), priority, text + ': its priority changed');
        assert.deepEqual(el.inline, {}, text + ': the hold left a longhand behind');
    });
});

test('a style change an earlier write left pending lands before the hold', () => {
    let f;
    const timed = timedField({get: () => f}, {duration: '2s'});
    // Another module's write phase toggled a class on the field (or an
    // ancestor) before this module's: style the next flush applies, with
    // whatever transition durations hold at that moment.
    const pending = {armed: false, appliedHeld: null};
    const flush = el => {
        if (pending.armed) {
            pending.armed = false;
            pending.appliedHeld = timed.held(el);
        }
    };
    const computed = timed.config.computedStyle;
    // Any computed-style read flushes pending style first.
    timed.config.computedStyle = Object.create(computed, {transitionDuration: {get() {
        if (f) { flush(f.elements[0]); }
        return computed.transitionDuration;
    }}});
    const onHeight = timed.config.onHeight;
    timed.config.onHeight = (value, el) => {
        // The measure after this collapse flushes whatever is pending.
        if (value === '0px') { flush(el); }
        onHeight(value, el);
    };
    f = fixture({elements: [timed.config], betweenPhases: () => { pending.armed = true; }});
    const el = f.elements[0];
    el.fire('input');
    f.pump();
    assert.equal(pending.appliedHeld, false, 'the pending class change applied under the hold, with no transition');
    assert.equal(el.style.height, '80px', 'the collapse was not held');
    assert.deepEqual(el.inline, {}, 'the hold left an inline transition behind');
});

test('a collapse that clamped the page offset puts it back', () => {
    // At the bottom of the page the collapse to zero shortens the document
    // and the engine clamps the scroll offset — the pass restores it.
    const f = fixture({
        page: {scrollY: 900},
        elements: [{
            scrollHeight: 140, clientHeight: 140,
            onHeight: function (value) {
                if (value === '0px') { f.window.pageYOffset = 820; }
            }
        }]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(f.scrolls, [[0, 900]], 'the clamped offset was not restored');
});

// The pass is phased: its read half takes the floors, a user's resize
// and the offsets and writes nothing; every reset, collapsed measure and
// final height lands in its write half, after every module's reads.
test('the read phase writes nothing and the write phase sizes every dirty field', () => {
    const f = fixture({elements: [
        {scrollHeight: 40, clientHeight: 40},
        {scrollHeight: 50, clientHeight: 50}
    ]});
    const [a, b] = f.elements;
    a.scrollHeight = 140;
    b.scrollHeight = 180;
    a.fire('input');
    b.fire('input');
    assert.equal(f.requests.length, f.requestedWrites.length,
        'a pass was armed outside the phased read/write pair');
    assert.equal(f.requests.length, 1, 'the burst armed more than one pass');
    f.opLog.length = 0;
    f.requests[0](16);
    assert.deepEqual(f.opLog.filter(entry => entry.op !== 'measure'), [],
        'the read phase wrote a height');
    f.requestedWrites[0](16);
    assert.deepEqual(f.opLog.map(entry => entry.op), ['reset', 'reset', 'measure', 'measure', 'write', 'write']);
    assert.equal(a.style.height, '140px');
    assert.equal(b.style.height, '180px');
});

test('the input handler carries no try/catch around the scheduler', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/autogrow/autogrow.js'), 'utf8');
    const arm = source.slice(source.indexOf('armResize = function'), source.indexOf('bindField = function'));
    assert.ok(arm.includes('requestPhased('), 'the arming function was not found');
    assert.equal(/catch\s*\(/.test(arm), false,
        'a try/catch guards a scheduler whose contract says it never throws');
});

test('a fractional height rounded by the CSSOM is not mistaken for a user drag', () => {
    const borders = {
        boxSizing: 'border-box',
        paddingTop: '0px',
        paddingBottom: '0px',
        borderTopWidth: '0.666667px',
        borderBottomWidth: '0.666667px'
    };
    const f = fixture({elements: [
        {scrollHeight: 50, clientHeight: 80, computedStyle: borders, roundCssom: true}
    ]});
    const el = f.elements[0];
    el.scrollHeight = 200;
    el.fire('input');
    f.pump();
    el.clientHeight = 200;
    el.scrollHeight = 50;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '81.3333px',
        'a rounded readback of the module\'s own write ratcheted the floor');
});

test('border-box floor converts the authored client height with its borders', () => {
    const borders = {
        boxSizing: 'border-box',
        paddingTop: '0px',
        paddingBottom: '0px',
        borderTopWidth: '3px',
        borderBottomWidth: '3px'
    };
    const f = fixture({elements: [
        {scrollHeight: 20, clientHeight: 94, computedStyle: borders}
    ]});
    const el = f.elements[0];
    assert.equal(el.style.height, '100px', 'the border-box floor dropped its borders');
    el.scrollHeight = 10;
    el.fire('input');
    f.pump();
    assert.equal(el.style.height, '100px', 'shrinking went below the border-box floor');
});

function scroller(top, clampTo, watch) {
    const node = {nodeType: 1, parentNode: null, writes: [], reads: 0, value: top};
    Object.defineProperty(node, 'scrollTop', {
        get() {
            node.reads += 1;
            if (watch && watch.written) { watch.late += 1; }
            return node.value;
        },
        set(v) { node.writes.push(v); node.value = v; }
    });
    node.clamp = () => { if (clampTo !== undefined) { node.value = clampTo; } };
    return node;
}

test('a collapse that clamped a scrolled ancestor puts its scrollTop back', () => {
    const outer = scroller(0);
    const box = scroller(300, 120);
    box.parentNode = outer;
    const f = fixture({
        page: {scrollY: 0},
        elements: [{
            scrollHeight: 140, clientHeight: 140, parentNode: box,
            onHeight: value => { if (value === '0px') { box.clamp(); } }
        }]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(box.writes, [300], 'the clamped ancestor was not restored');
    assert.deepEqual(outer.writes, [], 'an unscrolled ancestor was written');
    assert.deepEqual(f.scrolls, [], 'an unmoved page was scrolled');
});

test('an ancestor that did not move is never written', () => {
    const box = scroller(300);
    const f = fixture({
        page: {scrollY: 500},
        elements: [{scrollHeight: 140, clientHeight: 140, parentNode: box}]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(box.writes, []);
    assert.deepEqual(f.scrolls, []);
});

test('no offset is read after the final height writes', () => {
    const watch = {written: false, late: 0};
    const box = scroller(300, 100, watch);
    const f = fixture({
        page: {scrollY: 900},
        elements: [{
            scrollHeight: 140, clientHeight: 140, parentNode: box,
            onHeight: value => {
                if (value === '0px') { box.clamp(); y = 820; }
                else { watch.written = true; }
            }
        }]
    });
    let y = 900;
    Object.defineProperty(f.window, 'pageYOffset', {
        get() { if (watch.written) { watch.late += 1; } return y; },
        set(v) { y = v; }
    });
    watch.written = false;
    f.elements[0].fire('input');
    f.pump();
    assert.equal(watch.late, 0, 'an offset was read after the final writes — a second layout');
    assert.deepEqual(f.scrolls, [[0, 900]]);
    assert.deepEqual(box.writes, [300]);
});

test('the source captures builtins instead of re-walking them per call', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/autogrow/autogrow.js'), 'utf8');
    assert.ok(!(/Object\.prototype\.hasOwnProperty\.call/).test(source),
        'a builtin is re-walked per call instead of captured once');
});

test('an unscrolled wrapper inside a scrolled box does not hide the box from the restore', () => {
    const box = scroller(300, 120);
    const wrapper = scroller(0);
    wrapper.parentNode = box;
    const f = fixture({
        page: {scrollY: 0},
        elements: [{
            scrollHeight: 140, clientHeight: 140, parentNode: wrapper,
            onHeight: value => { if (value === '0px') { box.clamp(); } }
        }]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(box.writes, [300], 'the scrolled box past an unscrolled wrapper was not restored');
    assert.deepEqual(wrapper.writes, [], 'the unscrolled wrapper was written');
});

test('a clamped page offset is back in place before paint under a smooth scroll-behavior', () => {
    const f = fixture({
        page: {scrollY: 900},
        scrollOptions: {},
        elements: [{
            scrollHeight: 140, clientHeight: 140,
            onHeight: value => { if (value === '0px') { f.window.pageYOffset = 820; } }
        }]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(f.scrolls, [{left: 0, top: 900, behavior: 'instant'}],
        'the restore was not an instant scroll');
    assert.equal(f.window.pageYOffset, 900, 'the frame ends at the clamped offset');
});

test('a clamped ancestor is restored instantly through its own scrollTo', () => {
    const box = scroller(300, 120);
    const calls = [];
    box.scrollTo = function (options) {
        calls.push({...options});
        box.value = options.top;
    };
    const f = fixture({
        page: {scrollY: 0},
        scrollOptions: {},
        elements: [{
            scrollHeight: 140, clientHeight: 140, parentNode: box,
            onHeight: value => { if (value === '0px') { box.clamp(); } }
        }]
    });
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(calls, [{top: 300, behavior: 'instant'}], 'the ancestor restore could animate');
    assert.deepEqual(box.writes, [], 'scrollTop was written beside the instant scroll');
});

test('an engine that rejects the instant behavior gets the numeric restore', () => {
    const box = scroller(300, 120);
    box.scrollTo = function () {
        throw new TypeError("'instant' is not a valid ScrollBehavior");
    };
    const f = fixture({
        page: {scrollY: 900},
        scrollOptions: {rejectInstant: true},
        elements: [{
            scrollHeight: 140, clientHeight: 140, parentNode: box,
            onHeight: value => {
                if (value === '0px') { box.clamp(); f.window.pageYOffset = 820; }
            }
        }]
    });
    f.elements[0].fire('input');
    assert.doesNotThrow(() => f.pump(), 'a rejected scroll option escaped the pass');
    assert.deepEqual(box.writes, [300], 'the ancestor was not restored numerically');
    assert.deepEqual(f.scrolls, [[0, 900]], 'the page was not restored numerically');
});

test('restoring a clamped viewport preserves its horizontal offset', () => {
    let f;
    f = fixture({page: {scrollY: 900}, elements: [{
        scrollHeight: 140, clientHeight: 140,
        onHeight: value => { if (value === '0px') f.window.pageYOffset = 820; }
    }]});
    f.window.pageXOffset = 125;
    f.elements[0].fire('input');
    f.pump();
    assert.deepEqual(f.scrolls, [[125, 900]], 'restoring vertical scroll must preserve horizontal position');
});

test('fields sharing a scroller restore its offset once after all fields grow', () => {
    const box = scroller(300, 120);
    const f = fixture({page: {scrollY: 0}, elements: [140, 180].map(height => ({
        scrollHeight: height, clientHeight: 100, parentNode: box,
        onHeight: value => { if (value === '0px') box.clamp(); }
    }))});
    f.elements.forEach(el => el.fire('input'));
    f.pump();
    assert.equal(box.value, 300);
    assert.deepEqual(box.writes, [300]);
    assert.deepEqual(f.elements.map(el => el.style.height), ['140px', '180px']);
});

test('a field hidden after an external height change preserves that latest height', () => {
    const f = fixture({elements: [{clientHeight: 40, scrollHeight: 80}]});
    f.pump();
    const field = f.elements[0];
    assert.equal(field.style.height, '80px');
    field.style.height = '200px';
    field.clientHeight = 0;
    field.scrollHeightValue = 0;
    field.fire('input');
    f.pump();
    assert.equal(field.style.height, '200px');
});

test('fields first revealed together retain their distinct authored floors', () => {
    const f = fixture({elements: [{clientHeight: 0, scrollHeight: 0}, {clientHeight: 0, scrollHeight: 0}]});
    f.pump();
    for (const [index, height] of [120, 240].entries()) {
        f.elements[index].clientHeight = height;
        f.elements[index].scrollHeightValue = 20;
        f.elements[index].fire('input');
    }
    f.pump();
    assert.deepEqual(f.elements.map(field => field.style.height), ['120px', '240px']);
});

test('a field is measured only once in each later input pass', () => {
    const f = fixture({elements: [{clientHeight: 40, scrollHeight: 80}]});
    f.pump();
    for (let round = 0; round < 3; round += 1) {
        f.opLog.length = 0;
        f.elements[0].fire('input');
        f.pump();
        assert.equal(f.opLog.filter(op => op.op === 'measure').length, 1);
    }
});

test('a grown field hidden before the next input retains its last visible height', () => {
    const f = fixture({elements: [{clientHeight: 40, scrollHeight: 80}]});
    f.pump();
    const field = f.elements[0];
    assert.equal(field.style.height, '80px');
    field.clientHeight = 0;
    field.scrollHeightValue = 0;
    field.fire('input');
    f.pump();
    assert.equal(field.style.height, '80px', 'a hidden field shrank to its authored floor');
});

test('a scrolled parent ends the ancestor search before outer scroll reads', () => {
    let outerReads = 0;
    const outer = {nodeType: 1, get scrollTop() { outerReads += 1; return 300; }};
    const inner = {nodeType: 1, scrollTop: 100, parentNode: outer};
    const f = fixture({elements: [{clientHeight: 40, scrollHeight: 80, parentNode: inner}]});
    f.pump();
    f.elements[0].fire('input');
    f.pump();
    assert.equal(outerReads, 0);
    assert.equal(f.elements[0].style.height, '80px');
});
