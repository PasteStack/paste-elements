/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * throttle(fn, period, id, runFirst) limits calls to one per window.
 * A delayed call uses the FIRST call's context and arguments. runFirst
 * runs that call immediately, with no trailing call. Intervening calls,
 * including synchronous reentry from fn, are discarded.
 *
 * Without an id, wrappers share by function source plus period. Truthy
 * explicit ids share by property-key coercion. The opening call supplies
 * its function, period and mode.
 * Native asynchronous timers close windows even when fn throws.
 *
 * @module paste/ui/utilities/throttle
 */
paste['define'](
    'paste.ui.utilities.throttle',
    [],
    function (throttle) {
        'use strict';

        var active = Object['create'](null),
            startTimer = setTimeout;

        throttle = function (fn, period, id, runFirst) {
            var derivedKey;
            return function () {
                var key = id || derivedKey,
                    keyBox,
                    context,
                    args;
                if (!key) {
                    key = fn['toString']() + period['toString']();
                    derivedKey = key;
                }
                if (typeof key === 'object' || typeof key === 'function') {
                    // Let the platform perform ToPropertyKey once, including
                    // an object that converts to a symbol. Keep that key for cleanup.
                    keyBox = Object['create'](null);
                    keyBox[key] = true;
                    key = Object['keys'](keyBox)[0];
                    if (key === undefined) {
                        key = Object['getOwnPropertySymbols'](keyBox)[0];
                    }
                }
                if (active[key]) {
                    return;
                }
                if (!runFirst) {
                    context = this;
                    args = arguments;
                }
                active[key] = true;
                try {
                    startTimer(function () {
                        try {
                            if (!runFirst) {
                                fn['apply'](context, args);
                            }
                        } finally {
                            delete active[key];
                        }
                    }, period);
                } catch (error) {
                    delete active[key];
                    throw error;
                }
                if (runFirst) {
                    fn['apply'](this, arguments);
                }
            };
        };
        return throttle;
    }
);
