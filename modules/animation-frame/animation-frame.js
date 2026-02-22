/* jslint white: true, plusplus: true, browser: true, nomen: false */
/*global paste */

/**
 * @requires paste
 * @module paste/utils/animation-frame
 *
 * Prevent "layout thrashing" by batching dom writes in the next animation
 * frame. The browser should attempt this roughly 60 times per second.
 *
 * If requestAnimationFrame is not supported (< IE 10) then a timer will be
 * used instead.
 *
 * Example Usage:
 *
 * // Schedule change
 * var requestId = animation_frame.request(function(time) {
 *     console.log('executed at', time);
 *     // Execute scripts that require re-paint
 * });
 *
 * // Abort change
 * animation_frame.cancel(requestId);
 */

paste['define'](
    'paste.utils.animation-frame',
    [],
    function (animation_frame) {
        'use strict';

        var raf = window.requestAnimationFrame ||
                  window.mozRequestAnimationFrame ||
                  window.webkitRequestAnimationFrame ||
                  window.msRequestAnimationFrame ||
                  null;

        var caf = window.cancelAnimationFrame ||
                  window.mozCancelAnimationFrame ||
                  null;

        var last = 0, rid = 0, queue = [], duration = 16;

        if (!raf) {
            raf = function(callback) {
                if (queue.length === 0) {
                    var now = Date.now(),
                        next = Math.max(0, duration - (now - last));
                    last = next + now;

                    setTimeout(function() {
                        var copy = queue.slice(0),
                            len = copy.length,
                            i;
                        queue.length = 0;
                        for (i = 0; i < len; i++) {
                            if (copy[i].cancelled === false) {
                                copy[i].callback(last);
                            }
                        }
                    }, next);
                }
                queue.push({
                    requestId: ++rid,
                    callback: callback,
                    cancelled: false
                });
                return rid;
            };
        }
        if (!caf) {
            caf = function(requestId) {
                var len = queue.length, i;
                for (i = 0; i < len; i++) {
                    if (queue[i].requestId === requestId) {
                        queue[i].cancelled = true;
                    }
                }
            };
        }

        animation_frame.request = function() {
            return raf.apply(window, arguments);
        };
        animation_frame.cancel = function() {
            return caf.apply(window, arguments);
        };
    }
);
