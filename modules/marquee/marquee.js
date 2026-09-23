/*jslint white:false plusplus:false browser:true nomen:false sub:true */
/*globals paste */

/**
 * Enhance one semantic list with optional CSS-driven continuous motion, without copies.
 * @module paste/ui/marquee
 */
paste.define('paste.ui.marquee', [], function (marquee) {
    'use strict';

    var instances = window.WeakMap ? new window.WeakMap() : null,
        stateAttribute = 'data-paste-marquee-state',
        interactiveSelector = 'a[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])',
        geometryProperties = ['--paste-marquee-distance', '--paste-marquee-item-size', '--paste-marquee-row-height', '--paste-marquee-duration'],
        delayProperty = '--paste-marquee-delay',

        saveProperty = function ($element, name) {
            return {element: $element, name: name, value: $element.style.getPropertyValue(name), priority: $element.style.getPropertyPriority(name)};
        },

        restoreProperty = function (saved) {
            if (saved.value) {
                saved.element.style.setProperty(saved.name, saved.value, saved.priority);
            } else {
                saved.element.style.removeProperty(saved.name);
            }
        },

        setProperty = function ($element, name, value) {
            if ($element.style.getPropertyValue(name) !== value || $element.style.getPropertyPriority(name)) {
                $element.style.removeProperty(name);
                $element.style.setProperty(name, value);
            }
        };

    /**
     * Initialize a data-paste-marquee root; repeated calls return its existing controller.
     * The original direct list items are never cloned, reordered, or removed.
     * Returns null for invalid markup or browsers without WeakMap. Other missing capabilities
     * leave the list static. CSS owns every animation frame; refresh only measures geometry.
     * @param {HTMLElement} $root Root with one direct .paste-ui-marquee-items list and toggle button.
     * @returns {?Object} refresh(), pause(), resume(), dispose() controller.
     * @example
     * paste.require(['paste.ui.marquee'], function (module, marquee) {
     *     var control = marquee.init(document.querySelector('[data-paste-marquee]'));
     *     control.pause();
     *     control.resume();
     *     control.refresh();
     *     control.dispose();
     * });
     */
    marquee['init'] = function ($root) {
        var $list,
            $toggle,
            previousState,
            previousToggle,
            savedGeometry,
            savedItems,
            unbinds,
            paused,
            disposed,
            media,
            supported,
            observer,
            frame,
            control,
            syncItems = function ($items) {
                savedItems = savedItems.filter(function (saved) {
                    if ($items.indexOf(saved.element) !== -1) {
                        return true;
                    }
                    restoreProperty(saved);
                    if (observer) {
                        observer.unobserve(saved.element);
                    }
                    return false;
                });
                $items.forEach(function ($item) {
                    if (!savedItems.some(function (saved) {
                            return saved.element === $item;
                        })) {
                        savedItems.push(saveProperty($item, delayProperty));
                        if (observer) {
                            observer.observe($item);
                        }
                    }
                });
            },
            displayState = function (state, canAnimate) {
                var label;
                if ($root.getAttribute(stateAttribute) !== state) {
                    $root.setAttribute(stateAttribute, state);
                }
                $toggle.hidden = !canAnimate;
                $toggle.disabled = !canAnimate;
                label = paused ? $root.getAttribute('data-paste-marquee-resume-label') : $root.getAttribute('data-paste-marquee-pause-label');
                label = label || (paused ? 'Resume motion' : 'Pause motion');
                if ($toggle.textContent !== label) {
                    $toggle.textContent = label;
                }
            },
            refresh = function () {
                var $items,
                    durationText,
                    duration,
                    boxes,
                    width,
                    height,
                    gap,
                    distance,
                    canAnimate;
                if (disposed) {
                    return;
                }
                $items = Array.prototype.slice.call($list.children);
                syncItems($items);
                durationText = $root.getAttribute('data-paste-marquee-duration');
                duration = durationText === null ? 45 : Number(durationText);
                boxes = $items.map(function ($item) {
                    return $item.getBoundingClientRect();
                });
                width = boxes.length ? boxes[0].width : 0;
                height = boxes.reduce(function (maximum, box) {
                    return Math.max(maximum, box.height);
                }, 0);
                gap = parseFloat(window.getComputedStyle($list).columnGap);
                distance = $items.length * (width + gap);
                canAnimate = supported && !media.matches && Number.isFinite(duration) && duration > 0 &&
                    $items.length > 1 && width > 0 && height > 0 && Number.isFinite(gap) && gap >= 0 &&
                    $list.clientWidth > 0 && distance >= $list.clientWidth + width &&
                    !$list.contains(document.activeElement) && $items.every(function ($item, index) {
                        return $item.matches('.paste-ui-marquee-item') &&
                            Math.abs(boxes[index].width - width) < 0.01 &&
                            !$item.matches(interactiveSelector) && !$item.querySelector(interactiveSelector);
                    });
                if (canAnimate) {
                    setProperty($list, '--paste-marquee-distance', distance + 'px');
                    setProperty($list, '--paste-marquee-item-size', width + 'px');
                    setProperty($list, '--paste-marquee-row-height', height + 'px');
                    setProperty($list, '--paste-marquee-duration', duration + 's');
                    $items.forEach(function ($item, index) {
                        var delay = -duration * ((distance - width - index * (width + gap)) / distance);
                        setProperty($item, delayProperty, delay + 's');
                    });
                }
                displayState(canAnimate ? (paused ? 'paused' : 'running') : 'static', canAnimate);
            },
            scheduleRefresh = function () {
                if (frame === null && !disposed) {
                    frame = window.requestAnimationFrame(function () {
                        frame = null;
                        refresh();
                    });
                }
            },
            /** Pause motion and restore the wrapping list so every original remains available. */
            pause = function () {
                if (!disposed) {
                    paused = true;
                    refresh();
                }
            },
            /** Resume eligible motion from its initial phase; reduced motion and coverage still take precedence. */
            resume = function () {
                if (!disposed) {
                    paused = false;
                    refresh();
                }
            },
            /** Release observers/listeners and restore owned properties; never remove caller content. Idempotent. */
            dispose = function () {
                if (disposed) {
                    return;
                }
                disposed = true;
                if (frame !== null) {
                    window.cancelAnimationFrame(frame);
                    frame = null;
                }
                if (observer) {
                    observer.disconnect();
                }
                if (supported) {
                    media.removeEventListener('change', refresh);
                }
                unbinds.forEach(function (unbind) {
                    unbind();
                });
                savedGeometry.concat(savedItems).forEach(restoreProperty);
                if (previousState === null) {
                    $root.removeAttribute(stateAttribute);
                } else {
                    $root.setAttribute(stateAttribute, previousState);
                }
                $toggle.hidden = previousToggle.hidden;
                $toggle.disabled = previousToggle.disabled;
                $toggle.textContent = previousToggle.text;
                savedItems = [];
                unbinds = [];
                instances['delete']($root);
            },
            listen = function ($target, type, handler) {
                $target.addEventListener(type, handler, false);
                unbinds.push(function () {
                    $target.removeEventListener(type, handler, false);
                });
            };

        if (!instances || !$root || !$root.hasAttribute('data-paste-marquee')) {
            return null;
        }
        if (instances.has($root)) {
            return instances.get($root);
        }
        $list = $root.querySelector('.paste-ui-marquee-items');
        $toggle = $root.querySelector('.paste-ui-marquee-toggle');
        if (!$list || !$toggle || $list.parentElement !== $root || $toggle.parentElement !== $root) {
            return null;
        }

        previousState = $root.getAttribute(stateAttribute);
        previousToggle = {hidden: $toggle.hidden, disabled: $toggle.disabled, text: $toggle.textContent};
        savedGeometry = geometryProperties.map(function (name) {
            return saveProperty($list, name);
        });
        savedItems = [];
        unbinds = [];
        paused = false;
        disposed = false;
        frame = null;
        media = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        supported = Boolean(media && media.addEventListener && window.ResizeObserver && window.requestAnimationFrame && window.cancelAnimationFrame && window.CSS && window.CSS.supports('width', 'min(100%, 1px)'));
        // Resize notifications refresh on the next frame: refresh() can change
        // the observed boxes (state switch, row height), and doing that inside
        // the observer callback is a ResizeObserver loop.
        observer = supported ? new window.ResizeObserver(scheduleRefresh) : null;

        control = {'refresh': refresh, 'pause': pause, 'resume': resume, 'dispose': dispose};
        instances.set($root, control);
        listen($toggle, 'click', function () {
            if (paused) {
                resume();
            } else {
                pause();
            }
        });
        // Focus re-evaluates eligibility rather than pausing: refresh() already
        // refuses motion while the active element is inside the list, and a
        // focus visit must not leave the user's pause preference set once focus
        // moves away.
        listen($list, 'focusin', refresh);
        listen($list, 'focusout', refresh);
        if (supported) {
            observer.observe($list);
            media.addEventListener('change', refresh);
        }
        refresh();
        return control;
    };

    Array.prototype.forEach.call(
        document.querySelectorAll('[data-paste-marquee]'),
        function ($root) {
            marquee['init']($root);
        }
    );
});
