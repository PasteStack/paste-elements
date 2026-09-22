/*jslint white:false plusplus:false browser:true nomen:false sub:true*/
/*globals paste */

/**
 * @compilation_level ADVANCED_OPTIMIZATIONS
 *
 * Provides for smooth scrolling between specified anchors and its target.
 * Can be used by simply adding an attribute to a parent element or by firing custom events.
 * 
 * @example
 * 
 * Easy implementation:
 * Add 'data-paste-smoothscroll="true" to a parent element containing the anchor tags (they must be anchors).
 * The init function will scrape for parent elements and attach the necessary events to handle anchor clicks within it.
 * The anchor should have an href pointing to a valid ID. 
 * 
 * Advanced: 
 * Use this option if you need to set an offset or if capturing all anchors within a parent is not feasible.
 * 
 * - Grab all the anchors you want to control, add a click event to preventDefault. 
 * - Fire a custom 'smoothscroll' event on the window padding an object with the options below
 * {
 *      newURL: 'this would be the id of the target element, minus the hash sign',
 *      verticalOffset: 'an optional vertical offset. defaults to 0'
 * }
 *
 * @requires paste
 * @requires paste/util
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/smoothscroll
 */

paste['define'](
    'paste.ui.smoothscroll',
    [
        'paste.util',
        'paste.dom',
        'paste.event'
    ],
    function (smoothscroll, util, dom, event) {
        'use strict';

        var SPEED = 50, //set here the scroll speed: when this value increase, the speed decrease.
            MAX_STEP = 400, //set here the "uniform motion" step for long distances
            BRAKE_K = 3, //set here the coefficient of slowing down

            touchSupported = (function () {
                // this isn't the best touch detection, but it serves our purposes here
                return (('ontouchstart' in window) || (window['DocumentTouch'] && document instanceof DocumentTouch));
            }()),

            timeout,

            $round = Math.round,
            $min = Math.min,
            $max = Math.max,
            $abs = Math.abs,

            mousewheelHandler = function (e) {
                window.clearTimeout(timeout);
                timeout = null;
            },
            mousewheelSub = new event['Event']['Subscription']('mousewheel', window, mousewheelHandler),

            $scrollTop,
            $hash,

            $hashDistance,
            $offset,
            $verticalOffset = 0,
            $destination,
            scrollTo,
            scrollHandler,
            scrollEvent,
            scrollSub,

            $nav = dom['querySelector']('.paste-ui-section-nav'),

            $hashId,
            $updateHash,
            hashChangeHandler = function (_, data) {
                var updateHash = true;
                $hash = dom['get'](data ? '#' + data['newURL'] : window.location.hash, true)[0];
                $destination = dom['Bounds']['fromElement']($hash).top;

                if (data && data['verticalOffset']) {
                    $verticalOffset = data['verticalOffset'];
                    $destination -= $verticalOffset;
                }

                if ($hash) {
                    if (data && data.hasOwnProperty('updateHash')) {
                        updateHash = util['parseBoolean'](data['updateHash']);
                    }
                    mousewheelSub['attach']();

                    // these will be used throughout the async scroll process
                    $hashId = $hash['id'];
                    $updateHash = updateHash;

                    // scroll action
                    scrollTo();
                }
            },
            hashChangeEvent = new event['Event'](window, 'smoothscroll'),
            hashChangeSub = hashChangeEvent['subscribe'](hashChangeHandler),
            clickHandler,
            clickEvents = [],

            init;

        scrollTo = function () {
            $scrollTop = dom['getScrollTop']();
            if (touchSupported) {
                // don't animate if we're on a portable device
                window.scrollTo(0, $destination);
            } else if ($destination > $scrollTop) {
                $hashDistance = $round((dom['getScrollHeight']() - ($scrollTop + dom['getViewportHeight']())) / BRAKE_K);
                $hashDistance = $min($round(($destination - $scrollTop) / BRAKE_K), $hashDistance);
                $offset = $max(2, $min($hashDistance, MAX_STEP));
            } else {
                $offset = -$min($abs($round(($destination - $scrollTop) / BRAKE_K)), MAX_STEP);
            }

            if (scrollSub) {
                scrollSub['attach']();
            } else {
                scrollSub = scrollEvent['subscribe'](scrollHandler);
            }

            window.scrollTo(0, $scrollTop + $offset);

            // cleanup if needed
            window.setTimeout(function () {
                scrollEvent['fire']();
            }, 50);
        };

        scrollHandler = function (e) {
            scrollSub['detach']();
            if (Math.abs($scrollTop - $destination) <= 1 || dom['getScrollTop']() === $scrollTop) {
                window.scrollTo(0, $destination);

                window.clearTimeout(timeout);
                timeout = null;

                hashChangeSub['detach']();
                // setting window.location.hash will cause the page to jump to the element and ignore the verticalOffset
                // using push state will sacrifice support for <IE9, but it's the easiest fix for now
                if ($updateHash && window.history && history.pushState) {
                    history.pushState({}, document.title, "#" + $hashId);
                }
                hashChangeSub['attach']();
                mousewheelSub['detach']();

            } else {
                window.clearTimeout(timeout);
                timeout = setTimeout(scrollTo, SPEED);
            }
        };

        clickHandler = function (e) {
            var anchor = e.target;

            while (anchor && anchor.nodeName !== 'A') {
                anchor = anchor.parentNode;
            }

            if (anchor && anchor.closest && anchor.closest('.paste-ui-section-nav-disclosure')) { return; }

            if (anchor && anchor.nodeName === 'A' && anchor.hash && anchor.hash.length > 1) {
                e.preventDefault();

                hashChangeEvent['fire']({
                    'newURL': anchor.hash.slice(1),
                    'verticalOffset': $nav ? dom['Bounds']['fromElement']($nav).height : 0
                });
            }
        };

        scrollEvent = new event['Event'](window, 'scroll');

        init = (function () {
            mousewheelSub['detach']();

            // scrape the page for smoothscroll elements and fire off an event to take over the scrolling when clicked
            util['each'](dom['querySelectorAll']('[data-paste-smoothscroll]'), function (el) {
                clickEvents.push(new event['Event']['Subscription']('click', el, clickHandler));
            });

            // also attach to section navs
            util['each'](dom['querySelectorAll']('.paste-ui-section-nav'), function (el) {
                clickEvents.push(new event['Event']['Subscription']('click', el, clickHandler));
            });
        }());

        smoothscroll.scrollTo = function (targetId, verticalOffset) {
            hashChangeEvent['fire']({
                'newURL': targetId,
                'verticalOffset': verticalOffset || ($nav ? dom['Bounds']['fromElement']($nav).height : 0)
            });
        };
    }
);
