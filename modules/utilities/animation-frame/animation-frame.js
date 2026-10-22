/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * @module paste/ui/utilities/animation-frame
 *
 * Prevent "layout thrashing" by batching dom work in the next animation
 * frame. The browser should attempt this roughly 60 times per second.
 *
 * Contract:
 * - request(callback) schedules callback for the next frame and returns
 *   an id. Ids are opaque negative integers, so they never collide with
 *   a handle the host's requestAnimationFrame returns: only cancel()
 *   cancels them. A request carrying no callback schedules nothing and
 *   returns 0.
 * - requestPhased(read, write) schedules a measure-then-mutate pair for
 *   the next frame and returns one id for the pair. read runs in the
 *   batch's read phase, write in its write phase.
 * - request() and requestPhased() never run a callback before they
 *   return: every callback runs from a later host frame or task.
 * - Every callback receives one argument, the host frame's timestamp in
 *   milliseconds on the performance.now() clock; a frame delivered
 *   without a finite number, as a page's requestAnimationFrame wrapper
 *   can deliver it, is stamped from performance.now() instead. Every
 *   callback of one batch receives the same timestamp, and each batch's
 *   timestamp is strictly greater than the previous batch's: a frame
 *   time that repeats or rewinds, as a coarsened clock can report it,
 *   is stepped forward by a fraction of a millisecond.
 * - cancel(id) before delivery suppresses the callback; for a phased id
 *   it suppresses whichever of read and write has not run yet. After
 *   delivery, or with an unknown id, it does nothing.
 *
 * Batches and phases:
 * Every request armed for the same frame shares one batch, delivered
 * by one host frame callback. A batch runs in three phases:
 *   1. read   - every phased read, in request order;
 *   2. plain  - every request() callback, in request order;
 *   3. write  - every phased write, in request order.
 * A module that keeps its geometry and computed-style reads in read and
 * its style, class and attribute writes in write never reads after
 * another module has written within the same frame, so the browser
 * computes style and layout once per frame instead of once per module.
 * A write that needs a follow-up read asks for the next frame's read
 * phase rather than reading in place.
 *
 * A request made while a batch runs lands in the next batch. A throwing
 * callback does not stop the rest of its batch; its error is rethrown
 * on a later task. A pair whose read threw still runs its write in the
 * same batch: the write sees whatever state the read left, so a write
 * that depends on its read guards that state itself.
 *
 * Arming:
 * One host animation frame carries each batch; a batch whose every
 * request is cancelled gives its host frame back. While the document
 * is hidden the host delivers no frames, and the batch waits for the
 * first frame after it is shown again. A page that replaced
 * requestAnimationFrame with one that calls back before it returns (a
 * synchronous "flush" helper), or with one that throws, gets that batch
 * on a timer 20 ms later instead: the early callback is ignored and the
 * error is not passed on. Such a wrapper may also have registered a
 * real frame; whichever of that frame and the timer arrives first
 * delivers the batch, and the other then arrives stale and runs
 * nothing, so a batch is delivered once whatever the wrapper does. The
 * timer is a little longer than a frame, so a registered frame usually
 * wins and batches keep to one per frame. The next batch asks
 * requestAnimationFrame again.
 *
 * Example Usage:
 *
 * var requestId = animation_frame['request'](function (time) {
 *     // Execute scripts that require re-paint
 * });
 *
 * animation_frame['cancel'](requestId);
 *
 * var phasedId = animation_frame['requestPhased'](function (time) {
 *     // Read geometry and computed style; keep results in locals
 * }, function (time) {
 *     // Write styles, classes and attributes from those locals
 * });
 */

paste['define'](
    'paste.ui.utilities.animation-frame',
    [],
    function (animation_frame) {
        'use strict';

        var $w = window,
            $setTimeout = setTimeout,
            $clearTimeout = $w['clearTimeout'],
            $isFinite = isFinite,
            $raf = $w['requestAnimationFrame']['bind']($w),
            $caf = $w['cancelAnimationFrame']['bind']($w),
            $perf = $w['performance'],
            $now = $perf['now']['bind']($perf),
            // The smallest forward step between two batch timestamps:
            // a power of two, so it survives addition to a large
            // clock reading.
            STEP = 1 / 1024,
            // Whether the queued batch is armed, and its carriers: the
            // host frame handle (0 when unknown) and the fallback timer
            // (0 when none). Each arm has a generation; a carrier from
            // an earlier one is stale and runs nothing.
            armed = false,
            handle = 0,
            timer = 0,
            generation = 0,
            // True while requestAnimationFrame is being asked; early
            // says it called back inside the call.
            arming = false,
            early = false,
            // The last batch's timestamp.
            stamped = 0,
            rid = 0,
            // Two reusable batches: one fills while the other runs.
            // Request ids base + 1 .. base + count live in a batch, at
            // slots 0 .. count - 1 of its phase arrays; the counts say
            // how many callbacks each phase still owes.
            makeBatch = function () {
                return {
                    base: 0,
                    count: 0,
                    reads: [],
                    plains: [],
                    writes: [],
                    readCount: 0,
                    plainCount: 0,
                    writeCount: 0
                };
            },
            queue = makeBatch(),
            running = makeBatch(),

            invoke = function (callback, time) {
                try {
                    callback(time);
                } catch (error) {
                    // Reported on its own task, after the batch.
                    $setTimeout(function () {
                        throw error;
                    }, 0);
                }
            },

            // Runs one phase in request order and stops as soon as it
            // owes nothing more; a slot is cleared before its callback
            // runs, so a cancel from inside the batch only reaches
            // callbacks still owed. Only a callback can change what a
            // phase owes, so the count is read after each one.
            phase = function (batch, callbacks, owed, time) {
                var remaining = batch[owed] > 0 ? batch.count : 0,
                    index = 0,
                    callback;
                while (remaining--) {
                    callback = callbacks[index];
                    if (callback !== undefined) {
                        callbacks[index] = undefined;
                        batch[owed] -= 1;
                        invoke(callback, time);
                        if (batch[owed] === 0) {
                            remaining = 0;
                        }
                    }
                    index += 1;
                }
            },

            // Retires the armed batch's carriers.
            disarm = function () {
                generation += 1;
                armed = false;
                handle = 0;
                timer = 0;
            },

            deliver = function (time) {
                var batch = queue;
                disarm();
                if (typeof time !== 'number' || !$isFinite(time)) {
                    time = $now();
                }
                if (!(time > stamped)) {
                    time = stamped + STEP;
                }
                stamped = time;
                // Take the batch before any callback runs: a request made
                // from inside it belongs to the next batch.
                queue = running;
                running = batch;
                queue.base = rid;
                queue.count = 0;
                phase(batch, batch.reads, 'readCount', time);
                phase(batch, batch.plains, 'plainCount', time);
                phase(batch, batch.writes, 'writeCount', time);
                batch.count = 0;
            },

            // One carrier closure per arm: a frame or timer from an
            // earlier arm compares its generation and runs nothing.
            arm = function () {
                var current = generation + 1;
                generation = current;
                armed = true;
                arming = true;
                early = false;
                try {
                    handle = $raf(function (time) {
                        if (current !== generation) {
                            return;
                        }
                        if (arming) {
                            early = true;
                            return;
                        }
                        if (timer !== 0) {
                            $clearTimeout(timer);
                        }
                        deliver(time);
                    });
                } catch (refused) {
                    early = true;
                }
                arming = false;
                if (early) {
                    // A handle from a refusing wrapper is not trusted
                    // for cancel: it may name another caller's frame.
                    handle = 0;
                    timer = $setTimeout(function () {
                        if (current === generation) {
                            deliver();
                        }
                    }, 20);
                } else if (!(handle > 0)) {
                    handle = 0;
                }
            },

            enqueue = function (read, plain, write) {
                var batch = queue,
                    index = batch.count;
                if (read === undefined && plain === undefined && write === undefined) {
                    return 0;
                }
                rid += 1;
                batch.count = index + 1;
                batch.reads[index] = read;
                batch.plains[index] = plain;
                batch.writes[index] = write;
                if (read !== undefined) {
                    batch.readCount += 1;
                }
                if (plain !== undefined) {
                    batch.plainCount += 1;
                }
                if (write !== undefined) {
                    batch.writeCount += 1;
                }
                if (!armed) {
                    arm();
                }
                return -rid;
            },

            // Clears whatever the batch still owes request number n.
            withdraw = function (batch, n) {
                var index = n - batch.base - 1;
                if (!(index >= 0 && index < batch.count)) {
                    return;
                }
                if (batch.reads[index] !== undefined) {
                    batch.reads[index] = undefined;
                    batch.readCount -= 1;
                }
                if (batch.plains[index] !== undefined) {
                    batch.plains[index] = undefined;
                    batch.plainCount -= 1;
                }
                if (batch.writes[index] !== undefined) {
                    batch.writes[index] = undefined;
                    batch.writeCount -= 1;
                }
            };

        /**
         * Schedules callback for the next batch's plain phase and returns
         * an opaque id.
         */
        animation_frame['request'] = function (callback) {
            return enqueue(undefined, callback, undefined);
        };

        /**
         * Schedules read for the next batch's read phase and write for its
         * write phase, and returns one opaque id for the pair.
         */
        animation_frame['requestPhased'] = function (read, write) {
            return enqueue(read, undefined, write);
        };

        /**
         * Withdraws a request that has not run yet; unknown ids are
         * ignored. A batch left with nothing to deliver gives its host
         * frame back.
         */
        animation_frame['cancel'] = function (id) {
            if (typeof id !== 'number' || !(id < 0)) {
                return;
            }
            withdraw(queue, -id);
            withdraw(running, -id);
            if (armed && queue.readCount === 0 &&
                    queue.plainCount === 0 && queue.writeCount === 0) {
                if (handle !== 0) {
                    $caf(handle);
                }
                if (timer !== 0) {
                    $clearTimeout(timer);
                }
                disarm();
                queue.base = rid;
                queue.count = 0;
            }
        };
    }
);
