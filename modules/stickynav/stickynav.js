/*jslint white:false plusplus:false browser:true nomen:false */
/*globals paste */

/**
 * Monitors viewport scrolls and resizes to determine when the user has scrolled beyond a certain element (adjusted for
 * offset). Appends a class to the #content div and fires an event to the window when a nav is stuck and unstuck.
 *
 * Presently, we are returning out if the user is on a touch device for two reasons: 1) fixed-position elements cause
 * some drama, particularly with iOS5 and anything less than Gingerbread. 2) most touch devices use a mini header, so a
 * sticky subnav won't generally work with the design.
 *
 * MinWidths are established to prevent browsers from running the handler if the viewport's width is too narrow to
 * require it. E.g. the nav may not be sticky < 1016px because the mini header comes into play. It's set as a data
 * attribute to be customizable.
 *
 * @requires paste
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/stickynav
 */

paste.define(
    'paste.ui.stickynav',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.utilities.animation-frame'
    ],
    function (stickynav, dom, event, animation_frame) {
        'use strict';

        var $stickyNav = dom['querySelector']('.sticky-nav-target'),
            $content,
            $body,
            nav,
            desktop_nav,
            navBounds,
            offset,
            topOffset,
            minWidth,
            windowTop,
            windowWidth,
            handler,
            resizeHandler,
            buildFixedNav,
            scrollSub,
            resizeSub,
            init,
            navStuckEvent,
            navUnstuckEvent,
            calculateTopOffset,
            calculateWindowWidth,
            FIXED_NAV_CLASS = "paste-fixed-subnav",
            touchSupported = (function () {
                // this isn't the best touch detection, but it serves our purposes here
                return (('ontouchstart' in window) || (window['DocumentTouch'] && document instanceof DocumentTouch));
            }());

        if (!$stickyNav || touchSupported) {
            return;
        }

        $body = dom['getDocumentBody']();
        $content = document.getElementById('content');
        nav = document.getElementById('_paste_ui_nav_wrap');
        desktop_nav = document.getElementById('paste-ui-nav');

        minWidth = parseInt($stickyNav.getAttribute('data-sticky-min-width'), 10) ||
            parseInt((dom['querySelector']('.paste-ui-section-nav') || {getAttribute:function(){return null;}}).getAttribute('data-sticky-min-width'), 10) || 0;
        windowTop = dom['getScrollTop']();

        calculateTopOffset = function () {
            if ($stickyNav.stuck === true) { return; }

            navBounds = dom['Bounds']['fromElement'](nav);

            offset = navBounds.height;

            topOffset = dom['Bounds']['fromElement']($stickyNav).top - offset;
        };

        calculateWindowWidth = function () {
            windowWidth = dom['getViewportWidth']();
        };

        handler = function () {
            if (windowWidth <= minWidth) { return; }
            windowTop = dom['getScrollTop']();

            if (windowTop >= topOffset) {
                if (!$stickyNav.stuck) {
                    // only hit the DOM if we need to
                    animation_frame.request(function () {
                        $body.classList.add(FIXED_NAV_CLASS);
                    });
                }
                $stickyNav.stuck = true;

                navStuckEvent = new event['Event'](window, 'navStuck');
                navStuckEvent['fire']($stickyNav);
                navStuckEvent['dispose']();
                navStuckEvent = null;

            } else if (windowTop < topOffset) {
                if ($stickyNav.stuck === true) {
                    // only hit the DOM if we need to
                    $body.classList.remove(FIXED_NAV_CLASS);
                }
                $stickyNav.stuck = false;

                navUnstuckEvent = new event['Event'](window, 'navUnstuck');
                navUnstuckEvent['fire']($stickyNav);
                navUnstuckEvent['dispose']();
                navUnstuckEvent = null;
            }
        };

        resizeHandler = function () {
            calculateWindowWidth();
            calculateTopOffset();
            handler();
        };

        buildFixedNav = function () {
            var $fixedNavContent = dom['querySelector']('.fixed-nav-content', $content),
                clone;

            if (!$fixedNavContent) { return; }

            clone = $fixedNavContent.cloneNode(true);
            desktop_nav.appendChild(clone);
        };

        // Call the handler on load just for fun
        init = (function () {
            // clearing this cache just in case it gets cached with the page
            $body.classList.remove(FIXED_NAV_CLASS);

            buildFixedNav();

            event['DocumentEvent']['loaded'](function () {
                scrollSub = new event['Event']['Subscription']('scroll', window, handler);
                resizeSub = new event['Event']['Subscription']('resize', window, resizeHandler);

                // This is sucky, but heroscroll forces the browser to scroll to the top after 20ms,
                // so I need to wait until that's done to take measurements
                resizeHandler();
            });
        }());
    }
);
