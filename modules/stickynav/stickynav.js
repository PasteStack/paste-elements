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
            firstScroll,
            sentinel,
            applyPending,
            applyClass,
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
            var anchorStyle;
            navBounds = dom['Bounds']['fromElement'](nav);

            offset = navBounds.height;

            // While stuck the target's own rect can be a fixed-position
            // viewport coordinate, so the normal-flow marker holds the
            // threshold's anchor in every state. It sits at the slot's
            // margin edge — the target's own top margin still applies
            // between them, so it is added back here.
            if (sentinel) {
                anchorStyle = window.getComputedStyle ? window.getComputedStyle($stickyNav) : null;
                topOffset = dom['Bounds']['fromElement'](sentinel).top +
                    (anchorStyle ? parseFloat(anchorStyle.marginTop) || 0 : 0) - offset;
                return;
            }
            topOffset = dom['Bounds']['fromElement']($stickyNav).top - offset;
        };

        calculateWindowWidth = function () {
            windowWidth = dom['getViewportWidth']();
        };

        // The class write is one coalesced apply: whatever the latest
        // transition decided is what the frame performs, so a callback
        // queued before a correction can never add the class back over
        // a nav that has since unstuck.
        applyPending = false;
        applyClass = function () {
            if (applyPending) { return; }
            applyPending = true;
            animation_frame.request(function () {
                applyPending = false;
                if ($stickyNav.stuck === true) {
                    $body.classList.add(FIXED_NAV_CLASS);
                } else {
                    $body.classList.remove(FIXED_NAV_CLASS);
                }
            });
        };

        handler = function () {
            windowTop = dom['getScrollTop']();

            if (windowWidth <= minWidth) {
                // Below the declared minimum the enhancement is
                // ineligible — and ineligibility is a state, not an
                // absence of input: a nav that was stuck comes back
                // through the same coalesced write as any transition.
                if ($stickyNav.stuck === true) {
                    $stickyNav.stuck = false;
                    applyClass();
                }
                return;
            }

            if (windowTop >= topOffset) {
                if (!$stickyNav.stuck) {
                    // only hit the DOM if we need to
                    $stickyNav.stuck = true;
                    applyClass();
                }

                navStuckEvent = new event['Event'](window, 'navStuck');
                navStuckEvent['fire']($stickyNav);
                navStuckEvent['dispose']();
                navStuckEvent = null;

            } else if (windowTop < topOffset) {
                if ($stickyNav.stuck === true) {
                    // only hit the DOM if we need to
                    $stickyNav.stuck = false;
                    applyClass();
                }

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

        // The markup this enhances already exists when the module
        // defines — the subscriptions go live now rather than after
        // window load, so unrelated image or resource fetching can
        // never postpone the nav becoming sticky-aware. topOffset is
        // measured once here and re-derived by resizeHandler on every
        // resize; scrolls re-evaluate against the cached threshold and
        // recalibrate it once on the first real scroll — a rect read
        // per scroll event would be a layout pass on the hot path.
        init = (function () {
            // clearing this cache just in case it gets cached with the page
            $body.classList.remove(FIXED_NAV_CLASS);

            buildFixedNav();

            // The recalibration passes (first scroll, load, resize) all
            // need a measurement that stays honest while the nav is
            // stuck — a stuck target's own position can be fixed to the
            // viewport, telling it nothing about where it left normal
            // flow. The zero-height marker inserted just before the
            // target keeps the slot's document position readable in
            // every state and costs one read only when a recalibration
            // actually runs.
            sentinel = document.createElement('div');
            sentinel.setAttribute('aria-hidden', 'true');
            sentinel.style.cssText = 'height:0;width:0;margin:0;padding:0;visibility:hidden;overflow:hidden;line-height:0;';
            if ($stickyNav.parentNode) {
                $stickyNav.parentNode.insertBefore(sentinel, $stickyNav);
            } else {
                sentinel = null;
            }

            firstScroll = true;
            scrollSub = new event['Event']['Subscription']('scroll', window, function () {
                // The define-time measure can predate late resources —
                // recalibrate once on the first real scroll so a layout
                // that shifted the nav never sticks at a stale threshold.
                if (firstScroll) {
                    firstScroll = false;
                    calculateTopOffset();
                }
                handler();
            });
            resizeSub = new event['Event']['Subscription']('resize', window, resizeHandler);

            resizeHandler();

            // One more recalibration after resources settle: late CSS,
            // fonts or images can shift the nav's position without
            // firing resize. This corrects the threshold only — the
            // enhancement itself never waits on load.
            event['DocumentEvent']['loaded'](resizeHandler);
        }());
    }
);
