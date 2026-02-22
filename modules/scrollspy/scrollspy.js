/**
 * Appends a class to an item when its corresponding element passes a certain threshold. It was written for navs that
 * need to be "turned on" when their section has scrolled into view. It currently sets an offset for the sticky nav
 * element because it is fixed and will affect measurements if I don't account for it. This module will turn elements
 * "on" when the top of the target element has scrolled to the top of the page (adjusted for the offset). The "active"
 * class will be added to parent of the breakpoint.
 *
 * Ported from jawbone.ui.scrollspy (srv)
 *
 * @requires paste/dom
 * @requires paste/util
 * @requires paste/event
 * @module paste/ui/scrollspy
 */

paste['define'](
    'paste.ui.scrollspy',
    [
        'paste.dom',
        'paste.util',
        'paste.event'
    ],
    function (scrollspy, dom, util, event) {
        'use strict';

        var ACTIVE_CLASS = "active",

            $parent = dom['querySelector']('[data-paste-scrollspy]') || dom['querySelector']('.paste-ui-section-nav'),
            $nav = $parent,
            scrollBreakpoints = $parent ? dom['get']('a[href^="#"]', $parent) : null,
            navHeight = null,
            minWidth = $parent ? parseInt($parent.getAttribute('data-spy-min-width'), 10) : 0,
            scrollTop = dom['getScrollTop'](),
            prevScrollTop = scrollTop,
            windowWidth = dom['getViewportWidth'](),
            touchSupported = (('ontouchstart' in window) || (window['DocumentTouch'] && document instanceof DocumentTouch)),
            breakpoints = [],
            groups = [],
            activeGroup = null,
            totalGroups = 0,
            navOffset = null,
            scrollEvent = null,
            resizeEvent = null,

            calculateNavHeight = function () {
                navHeight = $nav ? dom['Bounds']['fromElement']($nav).height : 0;
            },

            calculateOffset = function (updateHeights) {
                if (!navHeight || updateHeights) {
                    calculateNavHeight();
                }

                navOffset = navHeight;
            },

            setActiveGroup = function (index) {
                var noActive = false;
                if (index === -1 && activeGroup !== null) {
                    // this captures the case for when the user scrolls above the first breakpoint
                    dom['removeCssClass'](groups[activeGroup], ACTIVE_CLASS);
                    activeGroup = null;
                    noActive = true;
                } else if (index === -1 || index === activeGroup) {
                    noActive = true;
                }

                if (noActive) {
                    return;
                }

                dom['addCssClass'](groups[index], ACTIVE_CLASS);

                if (activeGroup !== null) {
                    dom['removeCssClass'](groups[activeGroup], ACTIVE_CLASS);
                }

                activeGroup = index;
            },

            findGroup = function () {
                // Don't highlight anything if we're above the first breakpoint
                if (scrollTop < breakpoints[0].start - navOffset) {
                    return -1;
                }

                // Highlight the last element if we're beyond its breakpoint
                if (scrollTop > breakpoints[totalGroups].start) {
                    return totalGroups;
                }

                // Otherwise, go fishing
                var i = 0;
                for (i; i <= totalGroups; i += 1) {

                    //if scroll top is between its start and end, return the index
                    if (scrollTop >= breakpoints[i].start - navOffset && (scrollTop < breakpoints[i].end - navOffset || breakpoints[i].end === false)) {
                        return i;
                    }

                }

                return -1;
            },

            scrollHandler = function () {
                if (windowWidth <= minWidth || touchSupported) { return; }

                // Update the scroll
                scrollTop = dom['getScrollTop']();

                // Figure out where we are
                setActiveGroup(findGroup());

                // Set the current scrollTop to the prev
                prevScrollTop = scrollTop;
            },

            resizeHandler = function () {
                windowWidth = dom['getViewportWidth']();

                calculateOffset(true);

                scrollHandler();
            },

            calculateBreakpoints = function () {
                util['each'](scrollBreakpoints, function (el, index) {
                    var target = dom['querySelector'](el.hash),
                        targetBounds = dom['Bounds']['fromElement'](target),
                        nextTarget = (index === scrollBreakpoints.length - 1) ? false : dom['querySelector'](scrollBreakpoints[index + 1].hash);

                    if (groups.length !== scrollBreakpoints.length) {
                        groups.push(el.parentElement);
                    }

                    breakpoints[index] = {
                        start : Math.round(targetBounds.top),
                        end : nextTarget ? Math.round(dom['Bounds']['fromElement'](nextTarget).top) : false
                    };
                });
            },

            setUpBreakpoints = function () {
                calculateOffset();

                calculateBreakpoints();

                totalGroups = groups.length - 1;

                scrollEvent = new event['Event']['Subscription']('scroll', window, scrollHandler);

                resizeEvent = new event['Event']['Subscription']('resize', window, resizeHandler);
            },


            // Here -- at the end of all things -- we wait for the document to fully load because sometimes JS
            // adjusts the dimensions of some DOM elements, which throws off my beautiful calculations

            init = (function () {
                if (!$parent || !scrollBreakpoints || !scrollBreakpoints.length) {
                    return;
                }

                if (document.readyState === 'complete') {
                    setUpBreakpoints();
                    scrollHandler();
                } else {
                    window.addEventListener('load', function () {
                        setUpBreakpoints();
                        scrollHandler();
                    });
                }
            }());
    }
);
