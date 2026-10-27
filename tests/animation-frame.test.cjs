const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// Retention is observed the way a page would see it: a callback the
// module no longer holds is collectable.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
async function collectedAll(refs) {
    // A WeakRef target stays alive until the current job ends.
    await new Promise(resolve => setImmediate(resolve));
    gc();
    return refs.every(ref => ref.deref() === undefined);
}
async function retainedAll(refs) {
    await new Promise(resolve => setImmediate(resolve));
    gc();
    return refs.every(ref => ref.deref() !== undefined);
}

// The animation-frame contract, as a browser defines it: request() returns
// an opaque id that only cancel() cancels, and the callback receives the
// host frame's timestamp. One host requestAnimationFrame carries each
// batch; a callback's error is rethrown on its own timer task.

// The host queues callbacks with native asynchronous semantics.
function load(options = {}) {
    const timers = [];
    const frames = [];
    const cancelled = [];
    const clock = {perf: 48};
    let hostId = 1000;
    const window = {
        requestAnimationFrame(cb) {
            assert.equal(this, window, 'requestAnimationFrame lost its receiver');
            hostId += 1;
            frames.push({id: hostId, cb});
            return hostId;
        },
        cancelAnimationFrame(id) {
            assert.equal(this, window, 'cancelAnimationFrame lost its receiver');
            cancelled.push(id);
            for (let i = frames.length - 1; i >= 0; i -= 1) {
                if (frames[i].id === id) {
                    frames.splice(i, 1);
                }
            }
        },
        clearTimeout(id) {
            const index = timers.findIndex(t => t.id === id);
            if (index >= 0) {
                timers.splice(index, 1);
            }
        },
        performance: {
            now() {
                assert.equal(this, window.performance, 'performance.now lost its receiver');
                return clock.perf;
            }
        }
    };

    if (options.prefix) {
        window[options.prefix+'RequestAnimationFrame']=window.requestAnimationFrame;
        window[options.prefix+'CancelAnimationFrame']=window.cancelAnimationFrame;
        delete window.requestAnimationFrame;delete window.cancelAnimationFrame;
    }
    for (const name of options.missing || []) delete window[name];
    const exports = {};
    const context = {
        window,
        setTimeout: (fn, delay) => {
            hostId += 1;
            timers.push({id: hostId, fn, delay});
            return hostId;
        },

        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.utilities.animation-frame');
            assert.equal(deps.length, 0);
            factory(exports);
        }}
    };
    vm.runInNewContext(readModuleSource('paste/ui/utilities/animation-frame.js'), context);

    return {
        af: exports,
        context,
        window,
        clock,
        frames,
        cancelled,
        timers,
        // Native frames the host delivers, each with the given time.
        runFrames: time => frames.splice(0).forEach(f => f.cb(time)),
        // One timer task.
        runTimer: () => timers.shift().fn()
    };
}

test('one host frame per batch, delivered once in request order with the host time', () => {
    const f = load();
    const seen = [];
    const id = f.af.request(time => seen.push(['a', time]));
    const other = f.af.request(time => seen.push(['b', time]));
    f.af.request(time => seen.push(['c', time]));
    assert.equal(f.frames.length, 1, 'requests armed more than one host frame');
    assert.equal(typeof id, 'number');
    assert.notEqual(id, other, 'ids are not distinct');
    assert.ok(id < 0 && other < 0, 'an id could collide with a host handle');
    assert.equal(f.timers.length, 0, 'a request armed a timer');
    f.runFrames(123.5);
    assert.deepEqual(seen, [['a', 123.5], ['b', 123.5], ['c', 123.5]]);
    f.runFrames(200);
    assert.equal(seen.length, 3, 'delivered more than once');
});

test('batch timestamps remain the browser clock, including a coarsened repeat', () => {
    const f = load(), seen = [];
    for (const time of [0, 100, 100, 100.25]) {
        f.af.request(t => seen.push(t));
        f.runFrames(time);
    }
    assert.deepEqual(seen, [0, 100, 100, 100.25]);
});

test('cancel before delivery suppresses only its own request; unknown ids are ignored', () => {
    const f = load();
    const ran = [];
    const a = f.af.request(() => ran.push('a'));
    const b = f.af.request(() => ran.push('b'));
    f.af.cancel(b);
    f.af.cancel(-9999);
    f.af.cancel(9999);
    assert.deepEqual(f.cancelled, [], 'a batch with a live request gave its host frame back');
    f.runFrames(16);
    assert.deepEqual(ran, ['a']);
    assert.notEqual(a, b);
});

test('a batch whose every request is cancelled gives its host frame back', () => {
    const f = load();
    let ran = 0;
    const a = f.af.request(() => ran++);
    const b = f.af.requestPhased(() => ran++, () => ran++);
    const hostHandle = f.frames[0].id;
    f.af.cancel(a);
    f.af.cancel(b);
    assert.deepEqual(f.cancelled, [hostHandle]);
    assert.equal(f.frames.length, 0);
    f.af.request(() => ran++);
    assert.equal(f.frames.length, 1, 'the next request did not arm a fresh host frame');
    f.runFrames(16);
    assert.equal(ran, 1);
});

test('a callback can cancel a later request in its own batch', () => {
    const f = load();
    const ran = [];
    let b;
    f.af.request(() => { ran.push('a'); f.af.cancel(b); });
    b = f.af.request(() => ran.push('b'));
    f.runFrames(16);
    assert.deepEqual(ran, ['a']);
});

test('requests made during a batch land in the next batch', () => {
    const f = load();
    const ran = [];
    f.af.request(() => {
        ran.push('first');
        f.af.request(() => ran.push('nested'));
    });
    f.af.request(() => ran.push('second'));
    f.runFrames(16);
    assert.deepEqual(ran, ['first', 'second']);
    assert.equal(f.frames.length, 1, 'the nested request did not arm the next batch');
    f.runFrames(32);
    assert.deepEqual(ran, ['first', 'second', 'nested']);
});

test('a throwing callback does not starve its batch and is rethrown later', () => {
    const f = load();
    const ran = [];
    const boom = new Error('boom');
    f.af.request(() => ran.push('a'));
    f.af.request(() => { throw boom; });
    f.af.request(() => ran.push('c'));
    assert.doesNotThrow(() => f.runFrames(16));
    assert.deepEqual(ran, ['a', 'c']);
    assert.equal(f.timers.length, 1, 'the error was not rethrown on its own task');
    assert.throws(() => f.runTimer(), err => err === boom);
    // The scheduler keeps working after the error.
    f.af.request(() => ran.push('d'));
    f.runFrames(32);
    assert.deepEqual(ran, ['a', 'c', 'd']);
});

test('a request carrying no callback schedules nothing and returns 0', () => {
    const f = load();
    assert.equal(f.af.request(undefined), 0);
    assert.equal(f.af.requestPhased(undefined, undefined), 0);
    assert.equal(f.frames.length, 0, 'an empty request armed a host frame');
    assert.doesNotThrow(() => f.af.cancel(0));
});

test('globals are captured once at define time', () => {
    const f = load();
    let ran = 0;
    f.window.requestAnimationFrame = () => { throw new Error('re-read requestAnimationFrame'); };
    f.window.cancelAnimationFrame = () => { throw new Error('re-read cancelAnimationFrame'); };
    f.context.setTimeout = () => { throw new Error('re-read setTimeout'); };
    f.af.cancel(f.af.request(() => ran++));
    f.af.request(() => { ran++; throw new Error('reported'); });
    f.runFrames(16);
    assert.equal(ran, 1);
    assert.equal(f.timers.length, 1);
});

test('the module JSDoc names no dependency its define does not declare', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../modules/utilities/animation-frame/animation-frame.js'), 'utf8');
    assert.equal(/@requires\b/.test(source), false,
        'an @requires tag disagrees with the empty dependency array');
});

test('delivered requests are released, not retained', async () => {
    const f = load();
    const refs = [];
    const track = fn => { refs.push(new WeakRef(fn)); return fn; };
    f.af.request(track(() => {}));
    f.af.request(track(() => {}));
    assert.ok(await retainedAll(refs), 'precondition: the requests are pending');
    f.runFrames(16);
    assert.ok(await collectedAll(refs), 'a delivered callback stayed pinned in the pending batch');
});

// The phases: every phased read, then every plain request, then every
// phased write — each in request order, all on one host frame.
test('phases: reads, then plain requests, then writes, across several requesters', () => {
    const f = load();
    const order = [];
    f.af.requestPhased(t => order.push(['read-a', t]), t => order.push(['write-a', t]));
    f.af.request(t => order.push(['plain-1', t]));
    f.af.requestPhased(t => order.push(['read-b', t]), t => order.push(['write-b', t]));
    f.af.request(t => order.push(['plain-2', t]));
    f.af.requestPhased(t => order.push(['read-c', t]), t => order.push(['write-c', t]));
    assert.equal(f.frames.length, 1, 'phased requests armed more than one host frame');
    f.runFrames(40);
    assert.deepEqual(order.map(e => e[0]), [
        'read-a', 'read-b', 'read-c', 'plain-1', 'plain-2', 'write-a', 'write-b', 'write-c'
    ]);
    assert.ok(order.every(e => e[1] === 40), 'one batch delivered more than one time');
});

test('phases: a request made during any phase lands in the next batch', () => {
    const f = load();
    const order = [];
    f.af.requestPhased(() => {
        order.push('read');
        f.af.requestPhased(() => order.push('nested-read'), () => order.push('nested-write'));
    }, () => {
        order.push('write');
        f.af.request(() => order.push('nested-plain'));
    });
    f.af.request(() => {
        order.push('plain');
        f.af.requestPhased(() => order.push('late-read'), () => order.push('late-write'));
    });
    f.runFrames(16);
    assert.deepEqual(order, ['read', 'plain', 'write']);
    assert.equal(f.frames.length, 1, 'nested requests did not share one next host frame');
    f.runFrames(32);
    assert.deepEqual(order.slice(3), [
        'nested-read', 'late-read', 'nested-plain', 'nested-write', 'late-write'
    ]);
});

test('phases: cancel of a phased id suppresses both halves, or the write after the read ran', () => {
    const f = load();
    const order = [];
    const whole = f.af.requestPhased(() => order.push('read-a'), () => order.push('write-a'));
    let half;
    f.af.requestPhased(() => {
        order.push('read-b');
        f.af.cancel(half);
    }, () => order.push('write-b'));
    half = f.af.requestPhased(() => order.push('read-c'), () => order.push('write-c'));
    f.af.cancel(whole);
    f.runFrames(16);
    // Reads run in request order, so read-b cancels its successor's pair
    // before read-c is reached.
    assert.deepEqual(order, ['read-b', 'write-b']);
    const g = load();
    const seen = [];
    let pair;
    pair = g.af.requestPhased(() => seen.push('read'), () => seen.push('write'));
    g.af.request(() => {
        seen.push('plain');
        g.af.cancel(pair);
    });
    g.runFrames(16);
    assert.deepEqual(seen, ['read', 'plain'], 'the write ran after its pair was cancelled');
});

test('phases: a throwing read or write is isolated and rethrown later', () => {
    const f = load();
    const ran = [];
    const boom = new Error('read boom');
    const bang = new Error('write bang');
    f.af.requestPhased(() => { throw boom; }, () => ran.push('write-a'));
    f.af.requestPhased(() => ran.push('read-b'), () => { throw bang; });
    f.af.request(() => ran.push('plain'));
    assert.doesNotThrow(() => f.runFrames(16));
    assert.deepEqual(ran, ['read-b', 'plain', 'write-a']);
    assert.equal(f.timers.length, 2, 'each error was not rethrown on its own task');
    assert.throws(() => f.runTimer(), err => err === boom);
    assert.throws(() => f.runTimer(), err => err === bang);
});

test('phases: delivered and cancelled phased requests are released', async () => {
    const f = load();
    const delivered = [];
    const cancelledRefs = [];
    const track = (refs, fn) => { refs.push(new WeakRef(fn)); return fn; };
    f.af.requestPhased(track(delivered, () => {}), track(delivered, () => {}));
    const cancelled = f.af.requestPhased(track(cancelledRefs, () => {}), track(cancelledRefs, () => {}));
    f.af.request(track(delivered, () => {}));
    assert.ok(await retainedAll(delivered.concat(cancelledRefs)), 'precondition: the requests are pending');
    f.af.cancel(cancelled);
    assert.ok(await collectedAll(cancelledRefs), 'a cancelled pair stayed pinned');
    assert.ok(await retainedAll(delivered), 'cancel released a live request');
    f.runFrames(16);
    assert.ok(await collectedAll(delivered), 'a delivered pair stayed pinned');
});

test('phases: a pair whose read threw still runs its write in the same batch', () => {
    const f = load();
    const ran = [];
    const boom = new Error('read boom');
    f.af.requestPhased(() => { throw boom; }, t => ran.push(['write', t]));
    f.runFrames(16);
    assert.deepEqual(ran, [['write', 16]]);
    assert.throws(() => f.runTimer(), err => err === boom);
});

test('cancel never reaches a batch through a stale id after the slots are reused', () => {
    const f = load();
    const ran = [];
    const old = f.af.request(() => ran.push('old'));
    f.runFrames(16);
    f.af.request(() => ran.push('new'));
    f.af.cancel(old);
    f.runFrames(32);
    assert.deepEqual(ran, ['old', 'new'], 'a delivered id cancelled a later request');
});

test('completed phases leave no host frame behind when a later batch is cancelled', () => {
    const f = load();
    const seen = [];
    for (let round = 0; round < 2; round += 1) {
        f.af.requestPhased(() => seen.push('read'), () => seen.push('write'));
        f.af.request(() => seen.push('plain'));
        f.runFrames(16 * (round + 1));
    }
    assert.deepEqual(seen, ['read', 'plain', 'write', 'read', 'plain', 'write']);
    const pending = f.af.request(() => assert.fail('cancelled callback ran'));
    assert.equal(f.frames.length, 1);
    f.af.cancel(pending);
    assert.equal(f.frames.length, 0, 'completed callbacks kept an empty host frame alive');
});

test('successive cancelled batches release each new host frame', () => {
    const f = load();
    for (let index = 0; index < 3; index += 1) {
        const id = f.af.request(() => assert.fail('cancelled request ran'));
        assert.equal(f.frames.length, 1);
        f.af.cancel(id);
        assert.equal(f.frames.length, 0, 'a later batch could not be cancelled');
    }
});

test('numeric strings cannot cancel an opaque numeric request id', () => {
    const f = load();
    let calls = 0;
    const id = f.af.request(() => { calls += 1; });
    f.af.cancel(String(id));
    f.runFrames(16);
    assert.equal(calls, 1);
});

for (const missing of [['requestAnimationFrame'], ['cancelAnimationFrame'], ['performance'],
        ['requestAnimationFrame', 'cancelAnimationFrame', 'performance']]) {
    test('frame scheduling survives absent ' + missing.join(', '), () => {
        const f = load({missing});
        const seen = [];
        const id = f.af.request(time => seen.push(time));
        f.af.cancel(id);
        f.runFrames(20);
        f.timers.splice(0).forEach(t => t.fn());
        assert.deepEqual(seen, []);
        f.af.request(time => seen.push(time));
        f.runFrames(32);
        f.timers.splice(0).forEach(t => t.fn());
        assert.equal(seen.length, 1);
        assert.ok(Number.isFinite(seen[0]));
    });
}

test('historical vendor frame APIs retain scheduling and cancellation',()=>{
 for(const prefix of ['moz','webkit','ms']){const f=load({prefix});let called=0;
 const id=f.af.request(()=>called++);assert.equal(f.frames.length,1);assert.equal(f.timers.length,0);
 f.af.cancel(id);assert.equal(f.cancelled.length,1);f.runFrames(10);assert.equal(called,0);
 f.af.request(()=>called++);f.runFrames(20);assert.equal(called,1);}
});
test('fallback retains the historical sixteen millisecond cadence',()=>{
 const f=load({missing:['requestAnimationFrame','cancelAnimationFrame']});
 f.af.request(()=>{});assert.equal(f.timers[0].delay,0);f.runTimer();
 f.af.request(()=>{});assert.equal(f.timers[0].delay,16);
});

test('cancelled fallback carriers do not accumulate future delay',()=>{
 const f=load({missing:['requestAnimationFrame','cancelAnimationFrame']});
 for(let i=0;i<20;i++){const id=f.af.request(()=>{});f.af.cancel(id);}
 f.af.request(()=>{});assert.equal(f.timers[0].delay,0);
});
