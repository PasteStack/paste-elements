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

// options.sync makes requestAnimationFrame call back before it returns,
// as a page's synchronous flush wrapper does; options.refusals > 0 makes
// the next calls throw, as a page wrapper that fails does;
// options.throwAfter registers the frame and then throws, and
// options.syncAndReal calls back at once and also registers the frame.
function load(options = {}) {
    const timers = [];
    const frames = [];
    const cancelled = [];
    const clock = {perf: 48};
    let hostId = 1000;
    const window = {
        requestAnimationFrame(cb) {
            assert.equal(this, window, 'requestAnimationFrame lost its receiver');
            if (options.refusals > 0) {
                options.refusals -= 1;
                throw new Error('frame refused');
            }
            hostId += 1;
            if (options.throwAfter) {
                frames.push({id: hostId, cb});
                throw new Error('wrapper failed after registering');
            }
            if (options.syncAndReal) {
                cb(clock.perf);
                frames.push({id: hostId, cb});
                return hostId;
            }
            if (options.sync) {
                cb(clock.perf);
                return hostId;
            }
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

test('batch times strictly increase, even when the host repeats or rewinds a frame time', () => {
    const f = load();
    const seen = [];
    [100, 100, 90, 100.0001].forEach(time => {
        f.af.request(t => seen.push(t));
        f.runFrames(time);
    });
    assert.equal(seen[0], 100);
    for (let i = 1; i < seen.length; i += 1) {
        assert.ok(seen[i] > seen[i - 1], 'batch ' + i + ' did not move forward: ' + seen.join(', '));
        assert.ok(seen[i] - seen[i - 1] < 0.01, 'the forward step distorted the clock: ' + seen.join(', '));
    }
    // A large clock reading still steps forward.
    const g = load();
    const big = [];
    g.af.request(t => big.push(t));
    g.runFrames(1700000000000);
    g.af.request(t => big.push(t));
    g.runFrames(1700000000000);
    assert.ok(big[1] > big[0]);
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

// Page wrappers installed over requestAnimationFrame before the module
// loads.

test('a frame delivered without a usable time is stamped from performance.now', () => {
    const f = load();
    const seen = [];
    [[undefined, 300], [NaN, 316.5], ['332', 332], [Infinity, 348]].forEach(([hostTime, now]) => {
        f.clock.perf = now;
        f.af.request(t => seen.push(t));
        f.runFrames(hostTime);
    });
    assert.deepEqual(seen, [300, 316.5, 332, 348], 'the batch clock did not follow performance.now');
});

test('a requestAnimationFrame that calls back inside the call: nothing runs early, a timer carries the batch', () => {
    const f = load({sync: true});
    const ran = [];
    f.clock.perf = 100;
    const first = f.af.request(t => ran.push(['a', t]));
    f.af.requestPhased(t => ran.push(['read', t]), t => ran.push(['write', t]));
    assert.deepEqual(ran, [], 'a callback ran inside request()');
    assert.equal(f.timers.length, 1, 'the batch was not handed to one timer');
    assert.equal(f.timers[0].delay, 20);
    f.af.cancel(first);
    assert.deepEqual(f.cancelled, [], 'a timer batch reached cancelAnimationFrame');
    f.clock.perf = 120;
    f.runTimer();
    assert.deepEqual(ran, [['read', 120], ['write', 120]]);
    // The scheduler keeps going: a request from a batch and one after it.
    f.af.request(t => {
        ran.push(['b', t]);
        f.af.request(u => ran.push(['nested', u]));
    });
    assert.equal(f.timers.length, 1, 'the scheduler stopped arming after the first batch');
    f.clock.perf = 140;
    f.runTimer();
    assert.deepEqual(ran.slice(2), [['b', 140]]);
    f.clock.perf = 160;
    f.runTimer();
    assert.deepEqual(ran.slice(3), [['nested', 160]]);
    assert.equal(f.timers.length, 0);
});

test('a requestAnimationFrame that throws: request returns, a timer carries the batch, later batches ask again', () => {
    const f = load({refusals: 1});
    const ran = [];
    let id;
    assert.doesNotThrow(() => { id = f.af.request(t => ran.push(['a', t])); });
    assert.ok(typeof id === 'number' && id < 0);
    f.af.requestPhased(t => ran.push(['read', t]), t => ran.push(['write', t]));
    assert.equal(f.timers.length, 1, 'the refused batch was not handed to one timer');
    assert.equal(f.frames.length, 0);
    f.clock.perf = 90;
    f.runTimer();
    assert.deepEqual(ran, [['read', 90], ['a', 90], ['write', 90]]);
    // The next request asks requestAnimationFrame again and is delivered
    // by its frame, not left waiting behind a stuck arming state.
    f.af.request(t => ran.push(['b', t]));
    assert.equal(f.frames.length, 1, 'the next batch did not ask requestAnimationFrame again');
    assert.equal(f.timers.length, 0);
    f.runFrames(200);
    assert.deepEqual(ran.slice(3), [['b', 200]]);
    const later = f.af.request(() => ran.push('cancelled'));
    f.af.cancel(later);
    assert.equal(f.frames.length, 0, 'a later host frame could not be given back');
});

// A wrapper that refuses yet also registers the real frame leaves two
// carriers for one batch. The first to arrive delivers it; the other is
// stale, so a per-batch loop runs one batch per carrier pair and never
// multiplies.
test('a refusing wrapper that also registers the frame: one batch per arm, whichever carrier arrives first', () => {
    ['throwAfter', 'syncAndReal'].forEach(mode => {
        const f = load({[mode]: true});
        let batches = 0;
        const loop = () => {
            batches += 1;
            if (batches < 40) {
                f.af.request(loop);
            }
        };
        assert.doesNotThrow(() => f.af.request(loop), mode);
        assert.equal(batches, 0, mode + ': a batch ran inside request()');
        for (let round = 0; round < 40; round += 1) {
            assert.equal(f.frames.length, 1, mode + ': round ' + round + ' left ' + f.frames.length + ' frames');
            assert.equal(f.timers.length, 1, mode + ': round ' + round + ' left ' + f.timers.length + ' timers');
            const before = batches;
            if (round % 2 === 0) {
                // The real frame wins: the timer is cleared.
                f.runFrames(100 + round * 16);
                assert.equal(batches, before + 1, mode + ': the frame did not deliver the batch once');
            } else {
                // The timer wins; the real frame it could not cancel
                // arrives stale.
                const stale = f.frames.splice(0);
                f.runTimer();
                assert.equal(batches, before + 1, mode + ': the timer did not deliver the batch once');
                stale.forEach(frame => frame.cb(100 + round * 16));
                assert.equal(batches, before + 1, mode + ': a stale frame ran a batch');
            }
            if (batches >= 40) {
                break;
            }
            // Only the next batch's carriers remain.
            f.timers.splice(0, f.timers.length - 1).forEach(t => t.fn());
        }
        assert.equal(batches, 40, mode);
        f.frames.splice(0).forEach(frame => frame.cb(5000));
        f.timers.splice(0).forEach(t => t.fn());
        assert.equal(batches, 40, mode + ': a leftover carrier ran a batch');
    });
});

test('a refusing wrapper\'s batch is given back on cancel without trusting its handle', () => {
    ['syncAndReal', 'sync', 'throwAfter'].forEach(mode => {
        const f = load({[mode]: true});
        const id = f.af.request(() => assert.fail(mode + ': cancelled request ran'));
        assert.equal(f.timers.length, 1, mode);
        f.af.cancel(id);
        assert.deepEqual(f.cancelled, [], mode + ': a refusing wrapper\'s handle reached cancelAnimationFrame');
        assert.equal(f.timers.length, 0, mode + ': the fallback timer was not cleared');
        f.frames.splice(0).forEach(frame => frame.cb(16));
        let ran = 0;
        f.af.request(() => { ran += 1; });
        assert.equal(f.timers.length, 1, mode + ': the next batch did not arm again');
        f.frames.splice(0).forEach(frame => frame.cb(32));
        f.timers.splice(0).forEach(t => t.fn());
        assert.equal(ran, 1, mode);
    });
});
