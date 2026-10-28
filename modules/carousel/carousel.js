/*!
 * Copyright (c) 2017–present Tomshley LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     https://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Restored discrete-paging carousel: authored slides, discrete pages, generated
 * controls, indicators/counter, named instances, goTo/register/dispose and
 * carouselMove/carouselsBuilt events. See the fidelity ledger for local fixes.
 * @requires paste/util
 * @requires paste/event
 * @requires paste/guid
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/mediaquery
 * @module paste/ui/carousel
 */
paste['define']('paste.ui.carousel', ['paste.util', 'paste.event', 'paste.guid',
    'paste.ui.utilities.animation-frame', 'paste.ui.utilities.mediaquery'], function (carouselExport, util, event, guid, animationFrame, mediaquery) {
    'use strict';

    var $w = window,
        $doc = document,
        CLASS = 'paste-ui-carousel',
        Subscription = event['Event']['Subscription'],
        CarouselBuilder = function (el, name, thisGuid) {
            var self = this,
                wrapper = el['querySelector'](':scope > .' + CLASS + '-wrap') || el,
                slideItemContainer = wrapper['querySelector'](':scope > .' + CLASS + '-items'),
                slides = slideItemContainer['children'],
                totalSlides = slides.length,
                containerWidth = 0,
                slideWidth = 0,
                visibleSlideCount = 1,
                totalPanels = totalSlides,
                controlsParent = $doc['getElementById'](el['getAttribute']('data-paste-carousel-controlsparent')) || el,
                variableWidth = el['getAttribute']('data-paste-carousel-slide-width') === 'variable',
                useIndicators = el['hasAttribute']('data-paste-carousel-indicate'),
                useCounter = el['hasAttribute']('data-paste-carousel-count'),
                broadcastMoves = el['hasAttribute']('data-paste-carousel-broadcast-moves'),
                cycleValue = el['getAttribute']('data-paste-carousel-autocycle'),
                cyclePeriod = cycleValue === '' || cycleValue === 'true' ? 5000 : Number(cycleValue),
                autoCycle = cyclePeriod >= 1 && cyclePeriod <= 2147483647,
                motion = null,
                measurementsChanged = true,
                previousLeft = slideItemContainer['style']['left'],
                paused = false,
                hovering = false,
                focused = false,
                disposed = false,
                movedBySwipe = false,
                pointer = null,
                pointerX,
                pointerY,
                nextArrow,
                prevArrow,
                pauseButton,
                indicators,
                activeIndicator = null,
                counterEl,
                currentSlideEl,
                dividerEl,
                totalEl,
                positionFrame = null,
                measureFrame = null,
                transitionFrame = null,
                resizeObserver,
                subscriptions = [],
                generated = [],
                originalInert = [],
                remainingSlides = totalSlides,
                broadcastEvent = broadcastMoves ? new event['Event']($w, 'carouselMove') : null,
                listen = function (type, target, handler) {
                    subscriptions.push(new Subscription(type, target, handler, self));
                },
                createButton = function (suffix, label) {
                    var button = $doc['createElement']('button');
                    button['type'] = 'button';
                    button['className'] = CLASS + '-control ' + CLASS + '-' + suffix;
                    button['textContent'] = label;
                    controlsParent['appendChild'](button);
                    generated.push(button);
                    return button;
                },
                updateCycle = function () {
                    $w['clearInterval'](self.autoCycleInterval);
                    self.autoCycleInterval = null;
                    if (!disposed && autoCycle && !$doc['hidden'] &&
                            totalPanels > 1 && containerWidth > 0 && !paused && !hovering && !focused && !mediaquery['motionReduced'](motion)) {
                        self.autoCycleInterval = $w['setInterval'](function () {
                            self.goTo(self.current + 1 === totalPanels ? 0 : self.current + 1);
                        }, cyclePeriod);
                    }
                },
                watchCycle = function (target) {
                    listen('mouseenter', target, function () { hovering = true; updateCycle(); });
                    listen('mouseleave', target, function (e) {
                        hovering = el['contains'](e['relatedTarget']) || controlsParent['contains'](e['relatedTarget']);
                        updateCycle();
                    });
                    listen('focusin', target, function () { focused = true; updateCycle(); });
                    listen('focusout', target, function (e) {
                        focused = el['contains'](e['relatedTarget']) || controlsParent['contains'](e['relatedTarget']);
                        updateCycle();
                    });
                },
                updateCounter = function () {
                    var current,
                        total;
                    if (counterEl) {
                        current = String(self.current + 1);
                        total = String(totalPanels);
                        if (currentSlideEl['textContent'] !== current) {
                            currentSlideEl['textContent'] = current;
                        }
                        if (totalEl['textContent'] !== total) {
                            totalEl['textContent'] = total;
                        }
                    }
                },
                handleNavigation = function (position) {
                    var count = totalSlides,
                        button,
                        inert;
                    while (count--) {
                        inert = originalInert[count] || count * slideWidth >= position + containerWidth ||
                            (count + 1) * slideWidth <= position;
                        if (slides[count]['inert'] !== inert) {
                            slides[count]['inert'] = inert;
                        }
                    }
                    prevArrow['disabled'] = self.current === 0;
                    nextArrow['disabled'] = self.current === totalPanels - 1;
                    prevArrow['classList'].toggle(CLASS + '-controls-inactive', prevArrow['disabled']);
                    nextArrow['classList'].toggle(CLASS + '-controls-inactive', nextArrow['disabled']);
                    el['classList'].toggle(CLASS + '-at-last-slide', nextArrow['disabled']);
                    if (indicators) {
                        button = indicators['children'][self.current]['firstChild'];
                        if (button !== activeIndicator) {
                            if (activeIndicator) {
                                activeIndicator['setAttribute']('aria-current', 'false');
                                activeIndicator['parentElement']['classList'].remove(CLASS + '-indicator-item-active');
                            }
                            button['setAttribute']('aria-current', 'true');
                            button['parentElement']['classList'].add(CLASS + '-indicator-item-active');
                            activeIndicator = button;
                        }
                    }
                    updateCounter();
                    updateCycle();
                },
                buildIndicators = function () {
                    var index = 0,
                        item,
                        button;
                    if (!indicators) {
                        return;
                    }
                    indicators['textContent'] = '';
                    activeIndicator = null;
                    while (index < totalPanels) {
                        item = $doc['createElement']('li');
                        item['className'] = CLASS + '-indicator-item';
                        button = $doc['createElement']('button');
                        button['type'] = 'button';
                        button['className'] = CLASS + '-indicator-button';
                        button['textContent'] = String(index + 1);
                        button['setAttribute']('data-paste-carousel-page', index);
                        button['setAttribute']('aria-current', 'false');
                        item['appendChild'](button);
                        indicators['appendChild'](item);
                        index += 1;
                    }
                },
                takeMeasurements = function () {
                    var oldWidth = containerWidth,
                        oldSlideWidth = slideWidth;
                    containerWidth = wrapper['getBoundingClientRect']()['width'];
                    slideWidth = variableWidth ? slides[0]['getBoundingClientRect']()['width'] : containerWidth;
                    visibleSlideCount = slideWidth > 0 ? Math.max(1, Math.floor(containerWidth / slideWidth)) : 1;
                    totalPanels = Math.ceil(totalSlides / visibleSlideCount);
                    measurementsChanged = oldWidth !== containerWidth || oldSlideWidth !== slideWidth;
                },
                resizeHandler = function () {
                    if (disposed || measureFrame !== null) {
                        return;
                    }
                    measureFrame = animationFrame['requestPhased'](takeMeasurements, function () {
                        measureFrame = null;
                        if (indicators && indicators['children'].length !== totalPanels) {
                            buildIndicators();
                        }
                        if (measurementsChanged) {
                            self.goTo(self.current, true, true);
                        }
                    });
                },
                pointerDown = function (e) {
                    if (pointer !== null || e['button'] !== 0 || e['isPrimary'] === false) {
                        return;
                    }
                    pointer = e['pointerId'];
                    if (e['pointerType'] === 'touch') {
                        el['classList'].add(CLASS + '-touch');
                    }
                    pointerX = e['clientX'];
                    pointerY = e['clientY'];
                    movedBySwipe = false;
                },
                pointerMove = function (e) {
                    var distance = e['clientX'] - pointerX,
                        threshold = $w['innerWidth'] <= 600 ? 125 : 300;
                    if (e['pointerId'] === pointer && !movedBySwipe &&
                            Math.abs(distance) > threshold && Math.abs(distance) > Math.abs(e['clientY'] - pointerY)) {
                        self.goTo(self.current + (distance < 0 ? 1 : -1));
                        movedBySwipe = true;
                    }
                },
                pointerEnd = function (e) {
                    if (e['pointerId'] === pointer) {
                        pointer = null;
                        movedBySwipe = false;
                    }
                },
                dispose = function () {
                    var count;
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    updateCycle();
                    animationFrame['cancel'](positionFrame);
                    animationFrame['cancel'](measureFrame);
                    animationFrame['cancel'](transitionFrame);
                    if (resizeObserver) {
                        resizeObserver['disconnect']();
                    }
                    if (motion) {
                        motion['dispose']();
                    }
                    count = subscriptions.length;
                    while (count--) {
                        subscriptions[count]['dispose']();
                    }
                    count = generated.length;
                    while (count--) {
                        if (generated[count]['parentNode']) {
                            generated[count]['parentNode']['removeChild'](generated[count]);
                        }
                    }
                    if (broadcastEvent) {
                        broadcastEvent['dispose']();
                    }
                    slideItemContainer['style']['left'] = previousLeft;
                    slideItemContainer['classList'].remove(CLASS + '-no-transition');
                    el['classList'].remove(CLASS + '-loaded', CLASS + '-at-last-slide', CLASS + '-animating',
                        CLASS + '-indicators', CLASS + '-touch');
                    count = totalSlides;
                    while (count--) {
                        slides[count]['inert'] = originalInert[count];
                    }
                    delete carouselExport[name || thisGuid];
                };

            this.el = el;
            this.wrapper = wrapper;
            this.guid = thisGuid;
            this.current = 0;
            this.type = 'carousel';
            this.total = totalSlides;
            this.slides = slides;
            this.carouselName = name || false;
            this.autoCycleInterval = null;
            this.goTo = function (index, force, skipAnimation) {
                var position;
                if (disposed || typeof index !== 'number' || !isFinite(index)) {
                    return false;
                }
                index = Math.max(0, Math.min(totalPanels - 1, Math.floor(index)));
                if (!force && index === self.current) {
                    return false;
                }
                position = variableWidth ? Math.min(slideWidth * visibleSlideCount * index,
                    Math.max(0, slideWidth * totalSlides - containerWidth)) : containerWidth * index;
                animationFrame['cancel'](positionFrame);
                animationFrame['cancel'](transitionFrame);
                slideItemContainer['classList'].toggle(CLASS + '-no-transition', !!skipAnimation);
                positionFrame = animationFrame['request'](function () {
                    positionFrame = null;
                    slideItemContainer['style']['left'] = -position + 'px';
                    if (skipAnimation) {
                        transitionFrame = animationFrame['request'](function () {
                            transitionFrame = null;
                            slideItemContainer['classList'].remove(CLASS + '-no-transition');
                        });
                    }
                });
                self.current = index;
                handleNavigation(position);
                if (broadcastEvent && !force) {
                    broadcastEvent['fire'](self);
                }
            };
            this.dispose = dispose;
            this.register = function (object) {
                util['mixin'](this, object);
            };

            prevArrow = createButton('controls-prev', el['getAttribute']('data-paste-carousel-previous-label') || 'Previous');
            nextArrow = createButton('controls-next', el['getAttribute']('data-paste-carousel-next-label') || 'Next');
            listen('click', prevArrow, function () { self.goTo(self.current - 1); });
            listen('click', nextArrow, function () { self.goTo(self.current + 1); });
            if (useIndicators) {
                el['classList'].add(CLASS + '-indicators');
                indicators = $doc['createElement']('ol');
                indicators['className'] = CLASS + '-indicator';
                el['appendChild'](indicators);
                generated.push(indicators);
                listen('click', indicators, function (e) {
                    var target = e['target'],
                        page = target['getAttribute']('data-paste-carousel-page');
                    if (page !== null) {
                        self.goTo(Number(page));
                    }
                });
            }
            if (useCounter) {
                counterEl = $doc['createElement']('div');
                counterEl['className'] = CLASS + '-counter';
                currentSlideEl = $doc['createElement']('span');
                currentSlideEl['className'] = CLASS + '-counter-current';
                dividerEl = $doc['createElement']('span');
                dividerEl['className'] = CLASS + '-counter-divider';
                dividerEl['textContent'] = ' / ';
                totalEl = $doc['createElement']('span');
                totalEl['className'] = CLASS + '-counter-total';
                counterEl['appendChild'](currentSlideEl);
                counterEl['appendChild'](dividerEl);
                counterEl['appendChild'](totalEl);
                el['appendChild'](counterEl);
                generated.push(counterEl);
            }
            if (autoCycle) {
                motion = mediaquery['observe']('(prefers-reduced-motion: reduce)', updateCycle);
                listen('visibilitychange', $doc, updateCycle);
                pauseButton = createButton('pause', el['getAttribute']('data-paste-carousel-pause-label') || 'Pause');
                pauseButton['setAttribute']('aria-pressed', 'false');
                listen('click', pauseButton, function () {
                    paused = !paused;
                    pauseButton['setAttribute']('aria-pressed', String(paused));
                    updateCycle();
                });
                watchCycle(el);
                if (controlsParent !== el && !el['contains'](controlsParent)) {
                    watchCycle(controlsParent);
                }
            }
            listen('pointerdown', wrapper, pointerDown);
            listen('pointermove', wrapper, pointerMove);
            listen('pointerup', $w, pointerEnd);
            listen('pointercancel', $w, pointerEnd);
            if (el['hasAttribute']('data-paste-carousel-animation-enabled')) {
                listen('transitionrun', slideItemContainer, function (e) {
                    if (e['target'] === slideItemContainer && e['propertyName'] === 'left') {
                        el['classList'].add(CLASS + '-animating');
                    }
                });
                listen('transitionend', slideItemContainer, function (e) {
                    if (e['target'] === slideItemContainer && e['propertyName'] === 'left') {
                        el['classList'].remove(CLASS + '-animating');
                    }
                });
                listen('transitioncancel', slideItemContainer, function (e) {
                    if (e['target'] === slideItemContainer && e['propertyName'] === 'left') {
                        el['classList'].remove(CLASS + '-animating');
                    }
                });
            }
            while (remainingSlides--) {
                originalInert[remainingSlides] = !!slides[remainingSlides]['inert'];
            }
            el['classList'].add(CLASS + '-loaded');
            takeMeasurements();
            buildIndicators();
            self.goTo(0, true, true);
            if ($w['ResizeObserver']) {
                resizeObserver = new $w['ResizeObserver'](resizeHandler);
                resizeObserver['observe'](wrapper);
                if (variableWidth) {
                    resizeObserver['observe'](slides[0]);
                }
            } else {
                listen('resize', $w, resizeHandler);
            }
        },
        build = function () {
            var carousels = $doc['querySelectorAll']('.' + CLASS),
                count = carousels.length,
                index = 0,
                el,
                wrapper,
                items,
                name,
                thisGuid,
                built;
            while (count--) {
                el = carousels[index];
                index += 1;
                wrapper = el['querySelector'](':scope > .' + CLASS + '-wrap') || el;
                items = wrapper['querySelector'](':scope > .' + CLASS + '-items');
                if (items && items['children'].length && !el['classList'].contains(CLASS + '-loaded')) {
                    name = el['getAttribute']('data-paste-carousel-name');
                    thisGuid = guid['Guid']['create']();
                    // Named instances are authored references; never overwrite another.
                    if (!name || !Object['getOwnPropertyDescriptor'](carouselExport, name)) {
                        Object['defineProperty'](carouselExport, name || thisGuid, {
                            value: new CarouselBuilder(el, name, thisGuid),
                            configurable: true,
                            enumerable: true
                        });
                    }
                }
            }
            built = new event['Event']($w, 'carouselsBuilt');
            built['fire']();
            built['dispose']();
        };

    // Preserve the original asset-loaded initialization and handle a late JAM.
    if ($doc['readyState'] === 'complete') {
        build();
    } else {
        event['DocumentEvent']['loaded'](build);
    }
});
