const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// The throttle contract (see the module JSDoc): at most one call per
// window; trailing mode runs once at the window's end with the latest
// call; leading mode runs at once and, if more calls arrived, once more
// at the window's end with the latest of them. Id-less wrappers own a
// private window; a truthy id names a shared one.

function load() {
    const timers = [];
    // refusals > 0 makes the next setTimeout calls throw; mode 'sync'
    // runs the callback before setTimeout returns.
    const host = {refusals: 0, mode: 'queue'};
    const context = {
        window: {},
        setTimeout: (fn, delay) => {
            if (host.refusals > 0) {
                host.refusals -= 1;
                throw new Error('timer refused');
            }
            if (host.mode === 'sync') {
                fn();
                return 0;
            }
            timers.push({fn, delay});
            return timers.length;
        },
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.utilities.throttle');
            assert.equal(deps.length, 0);
            context.throttle = factory({});
        }}
    };
    vm.runInNewContext(readModuleSource('paste/ui/utilities/throttle.js'), context);
    return {
        throttle: context.throttle,
        context,
        timers,
        host,
        // End every window currently open (one timer task each).
        flush: () => timers.splice(0).forEach(t => t.fn())
    };
}

function recorder() {
    const calls = [];
    function fn(...args) {
        calls.push({self: this, args});
    }
    fn.calls = calls;
    return fn;
}

const argsOf = fn => fn.calls.map(c => c.args[0]);

test('trailing mode: one call at the window end, with the latest call\'s this and args', () => {
    const f = load();
    const fn = recorder();
    const wrapped = f.throttle(fn, 50);
    const c = {name: 'c'};
    wrapped.call({name: 'a'}, 1);
    wrapped.call({}, 2);
    wrapped.call(c, 3);
    assert.equal(fn.calls.length, 0, 'the trailing call ran early');
    assert.equal(f.timers.length, 1, 'more than one timer for one window');
    assert.equal(f.timers[0].delay, 50);
    f.flush();
    assert.equal(fn.calls.length, 1);
    assert.equal(fn.calls[0].self, c);
    assert.deepEqual(fn.calls[0].args, [3]);
    assert.equal(f.timers.length, 0, 'trailing mode reopened the window');
    // A lone call in a fresh window runs with its own this and args.
    const self = {name: 'only'};
    wrapped.call(self, 4, 'x');
    f.flush();
    assert.equal(fn.calls[1].self, self, 'a lone trailing call lost its context');
    assert.deepEqual(fn.calls[1].args, [4, 'x'], 'the window did not close');
});

test('leading mode: runs at once, and alone when nothing else arrives', () => {
    const f = load();
    const fn = recorder();
    const wrapped = f.throttle(fn, 50, null, true);
    const self = {};
    wrapped.call(self, 1);
    assert.equal(fn.calls.length, 1);
    assert.equal(fn.calls[0].self, self);
    f.flush();
    assert.equal(fn.calls.length, 1, 'a trailing call ran with nothing suppressed');
    assert.equal(f.timers.length, 0);
    wrapped(2);
    assert.equal(fn.calls.length, 2, 'the window did not close');
});

test('leading mode: suppressed calls produce one trailing call with the latest args, in a fresh full window', () => {
    const f = load();
    const fn = recorder();
    const wrapped = f.throttle(fn, 70, null, true);
    wrapped(1);
    wrapped(2);
    wrapped(3);
    assert.deepEqual(argsOf(fn), [1]);
    f.flush();
    assert.deepEqual(argsOf(fn), [1, 3]);
    // The trailing call opened a fresh window: an immediate call waits.
    assert.equal(f.timers.length, 1, 'the trailing call did not re-arm');
    assert.equal(f.timers[0].delay, 70, 're-armed window is not one period long');
    wrapped(4);
    assert.deepEqual(argsOf(fn), [1, 3]);
    f.flush();
    assert.deepEqual(argsOf(fn), [1, 3, 4]);
    f.flush();
    assert.equal(f.timers.length, 0, 'the window never closed');
});

test('reentry during the leading call is coalesced into the window', () => {
    const f = load();
    let depth = 0;
    const seen = [];
    const wrapped = f.throttle(n => {
        seen.push(n);
        depth += 1;
        if (depth < 50) {
            wrapped(n + 1);
        }
    }, 50, null, true);
    wrapped(0);
    assert.deepEqual(seen, [0], 'reentry ran through the open window');
    assert.equal(f.timers.length, 1, 'reentry opened a second window');
    f.flush();
    assert.deepEqual(seen, [0, 1]);
});

test('trailing mode: a call made while the trailing fn runs opens a fresh window', () => {
    const f = load();
    const seen = [];
    const wrapped = f.throttle(n => {
        seen.push(n);
        if (n < 3) {
            wrapped(n + 1);
        }
    }, 50);
    wrapped(0);
    f.flush();
    assert.deepEqual(seen, [0], 'the reentrant call ran through the window');
    assert.equal(f.timers.length, 1, 'the reentrant call did not open a fresh window');
    f.flush();
    assert.deepEqual(seen, [0, 1]);
});

test('leading mode: a call made while the trailing fn runs is coalesced into the re-armed window', () => {
    const f = load();
    const seen = [];
    const wrapped = f.throttle(n => {
        seen.push(n);
        if (n === 1) {
            wrapped(10);
        }
    }, 50, null, true);
    wrapped(0);
    wrapped(1);
    f.flush();
    assert.deepEqual(seen, [0, 1]);
    assert.equal(f.timers.length, 1, 'the reentrant call armed a second timer');
    f.flush();
    assert.deepEqual(seen, [0, 1, 10]);
});

test('a throwing leading call propagates and leaves a normal window behind', () => {
    const f = load();
    let ran = 0;
    const wrapped = f.throttle(() => {
        ran += 1;
        if (ran === 1) {
            throw new Error('boom');
        }
    }, 50, null, true);
    assert.throws(() => wrapped(), /boom/);
    wrapped();
    assert.equal(ran, 1);
    f.flush();
    assert.equal(ran, 2);
});

test('id-less wrappers never share a window, even around one function', () => {
    const f = load();
    let ran = 0;
    const fn = () => { ran += 1; };
    const a = f.throttle(fn, 50);
    const b = f.throttle(fn, 50);
    a();
    b();
    f.flush();
    assert.equal(ran, 2);
});

test('a fresh id-less wrapper per call is never throttled', () => {
    const f = load();
    let ran = 0;
    for (let i = 0; i < 10; i += 1) {
        f.throttle(() => { ran += 1; }, 50)();
    }
    f.flush();
    assert.equal(ran, 10);
});

test('wrappers sharing an id share one window; the latest call wins', () => {
    const f = load();
    const first = recorder();
    const second = recorder();
    const a = f.throttle(first, 50, 'resize');
    const b = f.throttle(second, 50, 'resize');
    a(1);
    b(2);
    assert.equal(f.timers.length, 1, 'one shared window armed two timers');
    f.flush();
    assert.equal(first.calls.length, 0);
    assert.deepEqual(argsOf(second), [2]);
    // Closed: the id is free for a new window.
    a(3);
    f.flush();
    assert.deepEqual(argsOf(first), [3]);
});

test('string ids name windows by text, other ids by identity', () => {
    const f = load();
    let ran = 0;
    const fn = () => { ran += 1; };
    const one = {};
    const two = {};
    f.throttle(fn, 50, one)();
    f.throttle(fn, 50, two)();
    f.throttle(fn, 50, 1)();
    f.throttle(fn, 50, '1')();
    f.throttle(fn, 50, 'toString')();
    f.throttle(fn, 50, 'constructor')();
    assert.equal(f.timers.length, 6, 'distinct ids collapsed into one window');
    f.throttle(fn, 50, one)();
    f.throttle(fn, 50, 'to' + 'String')();
    assert.equal(f.timers.length, 6, 'the same id did not rejoin its window');
    f.flush();
    assert.equal(ran, 6);
    f.throttle(fn, 50, one)();
    assert.equal(f.timers.length, 1, 'a closed identity window was not freed');
});

test('setTimeout is captured once at define time', () => {
    const f = load();
    let ran = 0;
    f.context.setTimeout = () => { throw new Error('re-read setTimeout'); };
    const wrapped = f.throttle(() => { ran += 1; }, 50);
    wrapped();
    f.flush();
    assert.equal(ran, 1);
});

test('a thrown timer refusal opens no window: the error reaches the caller and the next call retries', () => {
    ['leading', 'trailing'].forEach(mode => {
        const f = load();
        const fn = recorder();
        const leading = mode === 'leading';
        const wrapped = f.throttle(fn, 50, leading ? 'shared' : null, leading);
        f.host.refusals = 1;
        assert.throws(() => wrapped(1), /timer refused/);
        assert.equal(fn.calls.length, 0, mode + ': fn ran without a window behind it');
        wrapped(2);
        assert.equal(f.timers.length, 1, mode + ': the retry did not open a window');
        wrapped(3);
        f.flush();
        assert.deepEqual(argsOf(fn), leading ? [2, 3] : [3], mode);
        f.flush();
        // The window closed: a fresh wrapper on the same id opens a new one.
        f.throttle(fn, 50, leading ? 'shared' : null, leading)(4);
        f.flush();
        assert.deepEqual(argsOf(fn), leading ? [2, 3, 4] : [3, 4], mode);
    });
});

test('a timer that runs its callback inside setTimeout is a refusal: no window stays open', () => {
    ['leading', 'trailing'].forEach(mode => {
        const f = load();
        const fn = recorder();
        const wrapped = f.throttle(fn, 100, mode === 'leading' ? 'shared-' + mode : null, mode === 'leading');
        f.host.mode = 'sync';
        assert.doesNotThrow(() => wrapped(1));
        assert.doesNotThrow(() => wrapped(2));
        assert.equal(fn.calls.length, 0, mode + ': fn ran without a window behind it');
        f.host.mode = 'queue';
        wrapped(3);
        assert.equal(f.timers.length, 1, mode + ': the window stayed wedged after a synchronous timer');
        f.flush();
        assert.deepEqual(argsOf(fn), [3], mode);
    });
});

test('leading mode: a refused fresh window stays closed, so the next call runs at once', () => {
    // Synchronous refusal: the trailing call still runs.
    const f = load();
    const fn = recorder();
    const wrapped = f.throttle(fn, 50, null, true);
    wrapped(1);
    wrapped(2);
    f.host.mode = 'sync';
    assert.doesNotThrow(() => f.flush());
    assert.deepEqual(argsOf(fn), [1, 2]);
    f.host.mode = 'queue';
    wrapped(3);
    assert.deepEqual(argsOf(fn), [1, 2, 3], 'the window stayed open');
    // Thrown refusal: the error leaves the timer task in place of the
    // trailing call.
    const g = load();
    const gn = recorder();
    const other = g.throttle(gn, 50, 'scroll', true);
    other(1);
    other(2);
    g.host.refusals = 1;
    const expire = g.timers.splice(0)[0].fn;
    assert.throws(() => expire(), /timer refused/);
    other(3);
    assert.deepEqual(argsOf(gn), [1, 3], 'the window stayed open after a refused re-arm');
    assert.equal(g.timers.length, 1);
});

// Observe retention through caller-owned identities, without inspecting
// the registry that implements shared windows.
const v8 = require('node:v8');
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
async function isRetained(reference) {
    await new Promise(resolve => setImmediate(resolve));
    collect();
    return reference.deref() !== undefined;
}

test('expired shared windows release object identities while other windows remain open', async () => {
    const f = load();
    const refs = [];
    function openWindow() {
        const identity = {};
        refs.push(new WeakRef(identity));
        f.throttle(() => {}, 50, identity)();
    }
    openWindow();
    openWindow();
    assert.equal(await isRetained(refs[0]), true, 'an open window must retain its shared identity');
    f.timers.splice(1, 1)[0].fn();
    assert.equal(await isRetained(refs[1]), false, 'the later shared identity remained registered');
    assert.equal(await isRetained(refs[0]), true, 'closing a sibling removed the active identity');
    f.flush();
    assert.equal(await isRetained(refs[0]), false, 'the first shared identity remained registered');
    assert.equal(typeof f.throttle, 'function');
});

test('a leading window releases the delivered call while its cooldown remains open', async () => {
    const f = load();
    const wrapped = f.throttle(() => {}, 50, null, true);
    const refs = [];
    wrapped();
    function suppressedCall() {
        const receiver = {}, argument = {};
        refs.push(new WeakRef(receiver), new WeakRef(argument));
        wrapped.call(receiver, argument);
    }
    suppressedCall();
    assert.equal(await isRetained(refs[0]), true);
    f.flush();
    assert.equal(f.timers.length, 1, 'the trailing delivery starts a new cooldown');
    for (const ref of refs) assert.equal(await isRetained(ref), false);
    f.flush();
});
