/**
 * Monitors viewport scrolls and resizes to determine when the user has scrolled beyond a certain element (adjusted for
 * offset). Appends a class to the nav and fires an event to the window when a nav is stuck and unstuck. A spacer
 * element is inserted to preserve document flow when the nav becomes fixed.
 *
 * MinWidths are established to prevent browsers from running the handler if the viewport's width is too narrow to
 * require it. E.g. the nav may not be sticky < 1016px because the mini header comes into play. It's set as a data
 * attribute to be customizable.
 *
 * Ported from jawbone.ui.stickynav (srv)
 *
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/stickynav
 */

paste['define'](
    'paste.ui.stickynav',
    [
        'paste.dom',
        'paste.event'
    ],
    function (stickynav, dom, event) {
        'use strict';

        var $stickyNavTarget = dom['querySelector']('.sticky-nav-target') || dom['querySelector']('[data-paste-sticky-target]'),
            $nav = dom['querySelector']('[data-paste-sticky-nav]') || dom['querySelector']('.paste-ui-section-nav'),
            $spacer,
            navBounds,
            spacerHeight,
            topOffset,
            minWidth,
            windowTop,
            windowWidth,
            handler,
            resizeHandler,
            scrollSub,
            resizeSub,
            navStuckEvent,
            navUnstuckEvent,
            calculateTopOffset,
            calculateWindowWidth,
            createSpacer,
            STICKY_CLASS = 'paste-ui-sticky',
            STICKY_ACTIVE_CLASS = 'paste-ui-sticky-active',
            touchSupported = (function () {
                // this isn't the best touch detection, but it serves our purposes here
                return (('ontouchstart' in window) || (window['DocumentTouch'] && document instanceof DocumentTouch));
            }());

        if (!$nav || touchSupported) {
            return;
        }

        minWidth = parseInt($nav.getAttribute('data-sticky-min-width'), 10) || 0;
        windowTop = dom['getScrollTop']();

        createSpacer = function () {
            var el = document.createElement('div');
            el.className = 'paste-ui-sticky-spacer';
            el.style.display = 'none';
            $nav.parentNode.insertBefore(el, $nav.nextSibling);
            return el;
        };

        calculateTopOffset = function () {
            if ($nav.stuck === true) { return; }

            navBounds = dom['Bounds']['fromElement']($nav);

            var computedMarginTop = parseInt(dom['getComputedStyle']($nav, 'margin-top'), 10) || 0;
            spacerHeight = Math.max(0, navBounds.height + computedMarginTop);

            topOffset = $stickyNavTarget ?
                dom['Bounds']['fromElement']($stickyNavTarget).top + dom['Bounds']['fromElement']($stickyNavTarget).height :
                navBounds.top;
        };

        calculateWindowWidth = function () {
            windowWidth = dom['getViewportWidth']();
        };

        handler = function () {
            if (windowWidth <= minWidth) {
                if ($nav.stuck === true) {
                    dom['removeCssClass']($nav, STICKY_ACTIVE_CLASS);
                    $spacer.style.display = 'none';
                    $nav.stuck = false;
                }
                return;
            }

            windowTop = dom['getScrollTop']();

            if (windowTop >= topOffset) {
                if (!$nav.stuck) {
                    // only hit the DOM if we need to
                    $spacer.style.height = spacerHeight + 'px';
                    $spacer.style.display = 'block';
                    dom['addCssClass']($nav, STICKY_ACTIVE_CLASS);
                }
                $nav.stuck = true;

                navStuckEvent = new event['Event'](window, 'navStuck');
                navStuckEvent['fire']($nav);
                navStuckEvent['dispose']();
                navStuckEvent = null;

            } else if (windowTop < topOffset) {
                if ($nav.stuck === true) {
                    // only hit the DOM if we need to
                    dom['removeCssClass']($nav, STICKY_ACTIVE_CLASS);
                    $spacer.style.display = 'none';
                }
                $nav.stuck = false;

                navUnstuckEvent = new event['Event'](window, 'navUnstuck');
                navUnstuckEvent['fire']($nav);
                navUnstuckEvent['dispose']();
                navUnstuckEvent = null;
            }
        };

        resizeHandler = function () {
            calculateWindowWidth();
            calculateTopOffset();
            handler();
        };

        // Call the handler on load just for fun
        (function () {
            dom['addCssClass']($nav, STICKY_CLASS);
            $spacer = createSpacer();

            if (document.readyState === 'complete') {
                scrollSub = new event['Event']['Subscription']('scroll', window, handler);
                resizeSub = new event['Event']['Subscription']('resize', window, resizeHandler);
                resizeHandler();
            } else {
                window.addEventListener('load', function () {
                    scrollSub = new event['Event']['Subscription']('scroll', window, handler);
                    resizeSub = new event['Event']['Subscription']('resize', window, resizeHandler);
                    resizeHandler();
                });
            }
        }());
    }
);
