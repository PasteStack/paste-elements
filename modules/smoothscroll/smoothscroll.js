/**
 * Smooth scroll for anchor links
 * Ported from jawbone.ui.smoothscroll (srv)
 *
 * Supports two modes:
 * - Container mode: add data-paste-smoothscroll to a parent element
 * - Class mode: add paste-ui-smoothscroll class to a parent element
 *
 * Accounts for sticky nav height when calculating scroll destination.
 *
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/smoothscroll
 */

paste.define(
    'paste.ui.smoothscroll',
    [
        'paste.dom',
        'paste.event'
    ],
    function (module, dom, event) {
        'use strict';

        var CONTAINER_ATTR_SELECTOR = '[data-paste-smoothscroll]',
            CONTAINER_CLASS_SELECTOR = '.paste-ui-smoothscroll',
            STICKY_CLASS = 'paste-ui-sticky-active',
            SPEED = 30,
            MAX_STEP = 400,
            BRAKE_K = 2,

            timeout,
            destination,
            offset,
            hashId,
            updateHash,
            prevScrollTop,

            getScrollTop = function () {
                return window.pageYOffset || document.documentElement.scrollTop;
            },

            getScrollHeight = function () {
                return Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight
                );
            },

            getViewportHeight = function () {
                return window.innerHeight || document.documentElement.clientHeight;
            },

            getStickyNavHeight = function () {
                var nav = dom.querySelector('.' + STICKY_CLASS);
                if (!nav) {
                    nav = dom.querySelector('.paste-ui-section-nav');
                }
                return nav ? nav.offsetHeight : 0;
            },

            mousewheelHandler = function () {
                window.clearTimeout(timeout);
                timeout = null;
            },

            scrollTo = function () {
                var scrollTop = getScrollTop(),
                    hashDistance;

                if (destination > scrollTop) {
                    hashDistance = Math.round((getScrollHeight() - (scrollTop + getViewportHeight())) / BRAKE_K);
                    hashDistance = Math.min(Math.round((destination - scrollTop) / BRAKE_K), hashDistance);
                    offset = Math.max(2, Math.min(hashDistance, MAX_STEP));
                } else {
                    offset = -Math.min(Math.abs(Math.round((destination - scrollTop) / BRAKE_K)), MAX_STEP);
                }

                prevScrollTop = scrollTop;
                window.scrollTo(0, scrollTop + offset);

                window.setTimeout(function () {
                    scrollHandler();
                }, SPEED);
            },

            scrollHandler = function () {
                var scrollTop = getScrollTop();

                if (Math.abs(scrollTop - destination) <= 1 || scrollTop === prevScrollTop) {
                    window.scrollTo(0, destination);
                    window.clearTimeout(timeout);
                    timeout = null;

                    if (updateHash && window.history && history.pushState) {
                        history.pushState({}, document.title, '#' + hashId);
                    }

                    window.removeEventListener('mousewheel', mousewheelHandler);
                    window.removeEventListener('wheel', mousewheelHandler);
                } else {
                    window.clearTimeout(timeout);
                    timeout = setTimeout(scrollTo, SPEED);
                }
            },

            smoothScrollTo = function (targetId, verticalOffset) {
                var target = document.getElementById(targetId) ||
                    document.querySelector('#' + targetId);

                if (!target) {
                    return;
                }

                var navHeight = verticalOffset || getStickyNavHeight();

                destination = target.getBoundingClientRect().top + getScrollTop() - navHeight;
                hashId = targetId;
                updateHash = true;

                window.addEventListener('mousewheel', mousewheelHandler);
                window.addEventListener('wheel', mousewheelHandler);

                scrollTo();
            },

            clickHandler = function (e) {
                var anchor = e.target;

                while (anchor && anchor.nodeName !== 'A') {
                    anchor = anchor.parentNode;
                }

                if (anchor && anchor.nodeName === 'A' && anchor.hash && anchor.hash.length > 1) {
                    e.preventDefault();
                    smoothScrollTo(anchor.hash.slice(1));
                }
            },

            init = function () {
                var containers = [],
                    attrContainers = dom.get(CONTAINER_ATTR_SELECTOR, true),
                    classContainers = dom.get(CONTAINER_CLASS_SELECTOR, true),
                    sectionNavs = dom.get('.paste-ui-section-nav', true);

                if (attrContainers && attrContainers.length) {
                    containers = containers.concat(Array.prototype.slice.call(attrContainers));
                }
                if (classContainers && classContainers.length) {
                    classContainers.forEach(function (el) {
                        if (containers.indexOf(el) === -1) {
                            containers.push(el);
                        }
                    });
                }
                if (sectionNavs && sectionNavs.length) {
                    sectionNavs.forEach(function (el) {
                        if (containers.indexOf(el) === -1) {
                            containers.push(el);
                        }
                    });
                }

                containers.forEach(function (el) {
                    event['bind']('click', el, clickHandler);
                });
            };

        // Initialize on DOM ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }

        module.init = init;
        module.scrollTo = smoothScrollTo;
    }
);
