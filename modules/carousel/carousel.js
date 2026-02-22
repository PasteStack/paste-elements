/**
 * Carousel / slider component
 * Ported from jawbone.ui.carousel (srv)
 *
 * Usage:
 * - Add class paste-ui-carousel to a container element
 * - Child slides use class paste-ui-carousel-item inside a paste-ui-carousel-items wrapper
 * - Optional: data-paste-carousel-name for identification
 * - Optional: data-paste-carousel-autocycle for auto-cycling (value in ms)
 * - Optional: data-paste-carousel-indicate for dot indicators
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/throttle
 * @module paste/ui/carousel
 */

paste.define(
    'paste.ui.carousel',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.throttle'
    ],
    function (module, dom, event, throttle) {
        'use strict';

        var CAROUSEL_CLASS = 'paste-ui-carousel',
            ITEMS_CLASS = CAROUSEL_CLASS + '-items',
            ITEM_CLASS = CAROUSEL_CLASS + '-item',
            NAV_CLASS = CAROUSEL_CLASS + '-control',
            NAV_NEXT_CLASS = CAROUSEL_CLASS + '-controls-next',
            NAV_PREV_CLASS = CAROUSEL_CLASS + '-controls-prev',
            NAV_INACTIVE_CLASS = CAROUSEL_CLASS + '-controls-inactive',
            INDICATOR_CLASS = CAROUSEL_CLASS + '-indicator',
            INDICATOR_ITEM_CLASS = CAROUSEL_CLASS + '-indicator-item',
            INDICATOR_ACTIVE_CLASS = CAROUSEL_CLASS + '-indicator-item-active',
            LOADED_CLASS = CAROUSEL_CLASS + '-loaded',
            TOUCH_CLASS = CAROUSEL_CLASS + '-touch',
            NO_TRANSITION_CLASS = CAROUSEL_CLASS + '-no-transition',

            carousels = {},

            touchSupported = ('ontouchstart' in window) ||
                (window.DocumentTouch && document instanceof DocumentTouch),

            CarouselBuilder = function (el) {
                if (!el) { return; }

                var self = this,
                    slideContainer = el.querySelector('.' + ITEMS_CLASS),
                    slides = el.querySelectorAll('.' + ITEM_CLASS),
                    totalSlides = slides.length,
                    nextArrow,
                    prevArrow,
                    indicators,
                    activeIndicator,
                    containerWidth,
                    autoCycleInterval,
                    autoCycleMs = parseInt(el.getAttribute('data-paste-carousel-autocycle'), 10) || 0,
                    useIndicators = el.hasAttribute('data-paste-carousel-indicate'),
                    startX,
                    startY,
                    isDragging = false;

                this.el = el;
                this.current = 0;
                this.totalSlides = totalSlides;
                this.name = el.getAttribute('data-paste-carousel-name') || '';

                function getContainerWidth() {
                    containerWidth = el.offsetWidth;
                }

                function buildNavigator() {
                    var frag = document.createDocumentFragment();

                    nextArrow = document.createElement('button');
                    prevArrow = document.createElement('button');

                    nextArrow.className = NAV_CLASS + ' ' + NAV_NEXT_CLASS;
                    nextArrow.setAttribute('aria-label', 'Next');
                    prevArrow.className = NAV_CLASS + ' ' + NAV_PREV_CLASS;
                    prevArrow.setAttribute('aria-label', 'Previous');

                    frag.appendChild(prevArrow);
                    frag.appendChild(nextArrow);
                    el.appendChild(frag);
                }

                function buildIndicators() {
                    if (!useIndicators) { return; }

                    var ul = document.createElement('ul'),
                        i, li;

                    ul.className = INDICATOR_CLASS;

                    for (i = 0; i < totalSlides; i++) {
                        li = document.createElement('li');
                        li.className = INDICATOR_ITEM_CLASS;
                        li.setAttribute('data-slide-index', i);
                        ul.appendChild(li);
                    }

                    el.appendChild(ul);
                    indicators = ul;
                }

                function updateNavigation(index) {
                    if (prevArrow) {
                        if (index === 0) {
                            prevArrow.classList.add(NAV_INACTIVE_CLASS);
                        } else {
                            prevArrow.classList.remove(NAV_INACTIVE_CLASS);
                        }
                    }

                    if (nextArrow) {
                        if (index === totalSlides - 1) {
                            nextArrow.classList.add(NAV_INACTIVE_CLASS);
                        } else {
                            nextArrow.classList.remove(NAV_INACTIVE_CLASS);
                        }
                    }

                    if (indicators && activeIndicator) {
                        activeIndicator.classList.remove(INDICATOR_ACTIVE_CLASS);
                    }

                    if (indicators) {
                        activeIndicator = indicators.children[index];
                        if (activeIndicator) {
                            activeIndicator.classList.add(INDICATOR_ACTIVE_CLASS);
                        }
                    }
                }

                this.goTo = function (index, skipAnimation) {
                    if (index < 0) { index = 0; }
                    if (index >= totalSlides) { index = totalSlides - 1; }
                    if (index === self.current && !skipAnimation) { return; }

                    if (skipAnimation) {
                        slideContainer.classList.add(NO_TRANSITION_CLASS);
                    }

                    getContainerWidth();
                    slideContainer.style.transform = 'translateX(' + -(containerWidth * index) + 'px)';

                    if (skipAnimation) {
                        window.setTimeout(function () {
                            slideContainer.classList.remove(NO_TRANSITION_CLASS);
                        }, 0);
                    }

                    self.current = index;
                    updateNavigation(index);

                    if (autoCycleMs) {
                        window.clearInterval(autoCycleInterval);
                        autoCycleInterval = window.setInterval(function () {
                            var next = self.current + 1;
                            if (next >= totalSlides) { next = 0; }
                            self.goTo(next);
                        }, autoCycleMs);
                    }
                };

                // Build UI
                buildNavigator();
                buildIndicators();
                getContainerWidth();

                // Touch support
                if (touchSupported) {
                    el.classList.add(TOUCH_CLASS);
                }

                // Event handlers
                event['bind']('click', nextArrow, function () {
                    self.goTo(self.current + 1);
                });

                event['bind']('click', prevArrow, function () {
                    self.goTo(self.current - 1);
                });

                if (indicators) {
                    event['bind']('click', indicators, function (e) {
                        var target = e.target,
                            index = target.getAttribute('data-slide-index');
                        if (index !== null) {
                            self.goTo(parseInt(index, 10));
                        }
                    });
                }

                // Touch/swipe handling
                el.addEventListener('touchstart', function (e) {
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                    isDragging = true;
                }, { passive: true });

                el.addEventListener('touchend', function (e) {
                    if (!isDragging) { return; }
                    isDragging = false;

                    var endX = e.changedTouches[0].clientX,
                        endY = e.changedTouches[0].clientY,
                        diffX = startX - endX,
                        diffY = startY - endY;

                    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
                        if (diffX > 0) {
                            self.goTo(self.current + 1);
                        } else {
                            self.goTo(self.current - 1);
                        }
                    }
                }, { passive: true });

                // Resize handler
                event['bind']('resize', window, throttle(function () {
                    self.goTo(self.current, true);
                }, 100, 'carousel-resize-' + this.name));

                // Auto-cycle
                if (autoCycleMs) {
                    autoCycleInterval = window.setInterval(function () {
                        var next = self.current + 1;
                        if (next >= totalSlides) { next = 0; }
                        self.goTo(next);
                    }, autoCycleMs);
                }

                // Init
                updateNavigation(0);
                el.classList.add(LOADED_CLASS);
            },

            init = function () {
                var els = document.querySelectorAll('.' + CAROUSEL_CLASS);

                if (els && els.length) {
                    Array.prototype.forEach.call(els, function (el) {
                        var name = el.getAttribute('data-paste-carousel-name') || el.id || '';
                        carousels[name] = new CarouselBuilder(el);
                    });
                }
            };

        // Initialize on document loaded (images matter for carousel sizing)
        if (document.readyState === 'complete') {
            init();
        } else {
            window.addEventListener('load', init);
        }

        module.init = init;
        module.carousels = carousels;
    }
);
