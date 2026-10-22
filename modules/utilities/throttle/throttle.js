/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * @module paste/ui/utilities/throttle
 *
 * throttle(fn, period, id, runFirst) returns a wrapper that calls fn at
 * most once per throttle window of `period` milliseconds.
 *
 * - Trailing mode (runFirst falsy): the first call opens a window; when
 *   it ends, the window closes and fn runs once with the context and
 *   arguments of the LATEST call made during the window. A call made
 *   while that trailing fn runs finds the window closed and opens a
 *   fresh one.
 * - Leading mode (runFirst truthy): the first call runs fn immediately
 *   and opens a window; a call made while that leading fn runs is
 *   coalesced into the window. If further calls arrive during the
 *   window, fn runs once more when it ends, with the latest call's
 *   context and arguments, and that trailing call runs inside a fresh
 *   window, so a steady stream of calls runs fn once per period and a
 *   call made while the trailing fn runs is coalesced too. Without
 *   further calls the window simply closes.
 *
 * Windows: a wrapper made without an id owns a private window, so
 * id-less wrappers never share a window - throttle() must be called once
 * and its wrapper reused; a fresh wrapper per event is never throttled.
 * A truthy id names a shared window: every wrapper carrying that id
 * joins it, and the latest call's fn is the one its trailing call runs.
 * A string id names a window by its text; any other truthy id (an
 * object, a number) names one by identity, so two distinct objects
 * never share a window and the number 1 is not the string '1'. The
 * opening call fixes the window's period and mode.
 *
 * Timers: a window is open only while its timer is outstanding. When
 * the host refuses the timer, by throwing or by running the callback
 * before setTimeout returns, the window stays closed and fn does not
 * run for that call: a thrown refusal reaches the caller, a synchronous
 * one throws nothing. Either way the next call tries again. When the
 * fresh window of a leading trailing call is refused, the window stays
 * closed: the trailing call still runs after a synchronous refusal,
 * and is dropped by a thrown one, which leaves its timer task.
 */

paste['define'](
    'paste.ui.utilities.throttle',
    [],
    function (throttle) {
        'use strict';

        var $setTimeout = setTimeout,
            // Open shared windows. Ids compare with ===, which is by
            // text for strings and by identity for anything else.
            shared = [],
            find = function (id) {
                var index = shared.length;
                while (index--) {
                    if (shared[index]['id'] === id) {
                        return shared[index];
                    }
                }
                return null;
            },
            makeWindow = function (id) {
                return {
                    id: id,
                    open: false,
                    leading: false,
                    period: 0,
                    fn: null,
                    context: null,
                    args: null
                };
            },
            expire,
            // Asks the host for the window's end and opens the window
            // once the timer is accepted; false when the host ran the
            // callback before returning. A thrown refusal propagates.
            open = function (record) {
                var returned = false,
                    early = false;
                $setTimeout(function () {
                    if (returned) {
                        expire(record);
                    } else {
                        early = true;
                    }
                }, record['period']);
                returned = true;
                if (early) {
                    return false;
                }
                record['open'] = true;
                if (record['id'] !== null) {
                    shared.push(record);
                }
                return true;
            };

        expire = function (record) {
            var fn = record['fn'],
                context = record['context'],
                args = record['args'],
                index = shared.length;
            record['open'] = false;
            record['fn'] = null;
            record['context'] = null;
            record['args'] = null;
            while (index--) {
                if (shared[index] === record) {
                    shared.splice(index, 1);
                    break;
                }
            }
            if (fn !== null) {
                if (record['leading']) {
                    open(record);
                }
                fn['apply'](context, args);
            }
        };

        throttle = function (fn, period, id, runFirst) {
            var own = id ? null : makeWindow(null);

            return function () {
                var record = own || find(id) || makeWindow(id);
                if (!record['open']) {
                    record['leading'] = !!runFirst;
                    record['period'] = period;
                    if (!open(record)) {
                        return;
                    }
                    if (runFirst) {
                        fn['apply'](this, arguments);
                        return;
                    }
                }
                record['fn'] = fn;
                record['context'] = this;
                record['args'] = arguments;
            };
        };

        return throttle;
    }
);
