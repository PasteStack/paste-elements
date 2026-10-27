/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Batches declared DOM reads before writes on the next browser frame.
 * request(callback) schedules plain work; requestPhased(read, write)
 * schedules a pair. Both return an opaque negative id for cancel(id).
 * An empty request returns 0 and schedules nothing.
 *
 * Each batch runs reads, plain callbacks, then writes, preserving
 * request order within each phase. Work requested during delivery waits
 * for the next batch. Cancel suppresses any part not yet delivered; a
 * fully cancelled batch gives its host frame back. Completed callbacks
 * are released, and the two batch buffers are reused.
 *
 * Callbacks receive the browser timestamp unchanged. A missing frame API
 * uses the original 16 ms timer cadence and performance.now (Date.now when unavailable).
 * Native frames and timers are asynchronous. Synchronous replacements
 * are outside this contract; this utility does not repair them or invent
 * a clock. A thrown callback is reported on a later task so the rest of
 * the batch can run; a write still runs if its paired read threw.
 *
 * @module paste/ui/utilities/animation-frame
 */

paste['define'](
    'paste.ui.utilities.animation-frame',
    [],
    function (animation_frame) {
        'use strict';

        var $w = window,
            $setTimeout = setTimeout,
            $clearTimeout = $w['clearTimeout'],
            $raf = $w['requestAnimationFrame'] || $w['mozRequestAnimationFrame'] ||
                    $w['webkitRequestAnimationFrame'] || $w['msRequestAnimationFrame'],
            $caf = $w['cancelAnimationFrame'] || $w['mozCancelAnimationFrame'] ||
                    $w['webkitCancelAnimationFrame'] || $w['msCancelAnimationFrame'],
            $perf = $w['performance'],
            $now = $perf && $perf['now'] ? $perf['now']['bind']($perf) : Date['now'],
            lastTimer = null,
            armed = false,
            handle = null,
            timer = null,
            // Suppresses a stale carrier when cancellation is unavailable.
            generation = 0,
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
                handle = null;
                timer = null;
            },

            deliver = function (time) {
                var batch = queue;
                disarm();
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

            // One carrier per batch. A cancelled carrier is inert even
            // on a platform without cancelAnimationFrame.
            arm = function () {
                var current = generation + 1,
                    callback = function (time) {
                        if (current === generation) {
                            deliver(time);
                        }
                    };
                generation = current;
                armed = true;
                if ($raf) {
                    handle = $raf.call($w, callback);
                } else {
                    timer = $setTimeout(function () {
                        lastTimer = $now();
                        callback(lastTimer);
                    }, lastTimer === null ? 0 : Math.max(0, 16 - ($now() - lastTimer)));
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
                if (handle !== null && $caf) {
                    $caf.call($w, handle);
                }
                if (timer !== null) {
                    $clearTimeout(timer);
                }
                disarm();
                queue.base = rid;
                queue.count = 0;
            }
        };
    }
);
