/**
 * Enhance one semantic list with optional CSS-driven continuous motion, without copies.
 * @requires paste/event
 * @module paste/ui/marquee
 */
paste.define('paste.ui.marquee', ['paste.event'], function (marquee, event) {
    'use strict';

    var instances = window.WeakMap ? new window.WeakMap() : null;
    var stateAttribute = 'data-paste-marquee-state';
    var interactiveSelector = 'a[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';
    var geometryProperties = ['--paste-marquee-distance', '--paste-marquee-item-size', '--paste-marquee-row-height', '--paste-marquee-duration'];
    var delayProperty = '--paste-marquee-delay';

    function saveProperty(element, name) {
        return {element: element, name: name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name)};
    }

    function restoreProperty(saved) {
        if (saved.value) {
            saved.element.style.setProperty(saved.name, saved.value, saved.priority);
        } else {
            saved.element.style.removeProperty(saved.name);
        }
    }

    function setProperty(element, name, value) {
        if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name)) {
            element.style.removeProperty(name);
            element.style.setProperty(name, value);
        }
    }

    /**
     * Initialize a data-paste-marquee root; repeated calls return its existing controller.
     * The original direct list items are never cloned, reordered, or removed.
     * Returns null for invalid markup or browsers without WeakMap. Other missing capabilities
     * leave the list static. CSS owns every animation frame; refresh only measures geometry.
     * @param {HTMLElement} root Root with one direct .paste-ui-marquee-items list and toggle button.
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
    marquee.init = function (root) {
        if (!instances || !root || !root.hasAttribute('data-paste-marquee')) {
            return null;
        }
        if (instances.has(root)) {
            return instances.get(root);
        }
        var list = root.querySelector('.paste-ui-marquee-items');
        var toggle = root.querySelector('.paste-ui-marquee-toggle');
        if (!list || !toggle || list.parentElement !== root || toggle.parentElement !== root) {
            return null;
        }

        var previousState = root.getAttribute(stateAttribute);
        var previousToggle = {hidden: toggle.hidden, disabled: toggle.disabled, text: toggle.textContent};
        var savedGeometry = geometryProperties.map(function (name) { return saveProperty(list, name); });
        var savedItems = [];
        var subscriptions = [];
        var paused = false;
        var disposed = false;
        var media = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        var supported = !!(media && media.addEventListener && window.ResizeObserver && window.CSS && window.CSS.supports('width', 'min(100%, 1px)'));
        var observer = supported ? new window.ResizeObserver(refresh) : null;

        function syncItems(items) {
            savedItems = savedItems.filter(function (saved) {
                if (items.indexOf(saved.element) !== -1) {
                    return true;
                }
                restoreProperty(saved);
                if (observer) { observer.unobserve(saved.element); }
                return false;
            });
            items.forEach(function (item) {
                if (!savedItems.some(function (saved) { return saved.element === item; })) {
                    savedItems.push(saveProperty(item, delayProperty));
                    if (observer) { observer.observe(item); }
                }
            });
        }

        function displayState(state, canAnimate) {
            if (root.getAttribute(stateAttribute) !== state) {
                root.setAttribute(stateAttribute, state);
            }
            toggle.hidden = toggle.disabled = !canAnimate;
            var label = paused ? root.getAttribute('data-paste-marquee-resume-label') : root.getAttribute('data-paste-marquee-pause-label');
            label = label || (paused ? 'Resume motion' : 'Pause motion');
            if (toggle.textContent !== label) { toggle.textContent = label; }
        }

        /** Refresh after changing list items or configuration; resize and reduced motion refresh automatically. */
        function refresh() {
            if (disposed) { return; }
            var items = Array.prototype.slice.call(list.children);
            syncItems(items);
            var durationText = root.getAttribute('data-paste-marquee-duration');
            var duration = durationText === null ? 45 : Number(durationText);
            var boxes = items.map(function (item) { return item.getBoundingClientRect(); });
            var width = boxes.length ? boxes[0].width : 0;
            var height = boxes.reduce(function (maximum, box) { return Math.max(maximum, box.height); }, 0);
            var gap = parseFloat(window.getComputedStyle(list).columnGap);
            var distance = items.length * (width + gap);
            var canAnimate = supported && !media.matches && isFinite(duration) && duration > 0 &&
                items.length > 1 && width > 0 && height > 0 && isFinite(gap) && gap >= 0 &&
                list.clientWidth > 0 && distance >= list.clientWidth + width &&
                !list.contains(document.activeElement) && items.every(function (item, index) {
                    return item.matches('.paste-ui-marquee-item') &&
                        Math.abs(boxes[index].width - width) < 0.01 &&
                        !item.matches(interactiveSelector) && !item.querySelector(interactiveSelector);
                });
            if (canAnimate) {
                setProperty(list, '--paste-marquee-distance', distance + 'px');
                setProperty(list, '--paste-marquee-item-size', width + 'px');
                setProperty(list, '--paste-marquee-row-height', height + 'px');
                setProperty(list, '--paste-marquee-duration', duration + 's');
                items.forEach(function (item, index) {
                    var delay = -duration * ((distance - width - index * (width + gap)) / distance);
                    setProperty(item, delayProperty, delay + 's');
                });
            }
            displayState(canAnimate ? (paused ? 'paused' : 'running') : 'static', canAnimate);
        }

        /** Pause motion and restore the wrapping list so every original remains available. */
        function pause() {
            if (!disposed) { paused = true; refresh(); }
        }

        /** Resume eligible motion from its initial phase; reduced motion and coverage still take precedence. */
        function resume() {
            if (!disposed) { paused = false; refresh(); }
        }

        /** Release observers/subscriptions and restore owned properties; never remove caller content. Idempotent. */
        function dispose() {
            if (disposed) { return; }
            disposed = true;
            if (observer) { observer.disconnect(); }
            if (supported) { media.removeEventListener('change', refresh); }
            subscriptions.forEach(function (subscription) { subscription.remove(); });
            savedGeometry.concat(savedItems).forEach(restoreProperty);
            if (previousState === null) { root.removeAttribute(stateAttribute); }
            else { root.setAttribute(stateAttribute, previousState); }
            toggle.hidden = previousToggle.hidden;
            toggle.disabled = previousToggle.disabled;
            toggle.textContent = previousToggle.text;
            savedItems = [];
            subscriptions = [];
            instances.delete(root);
        }

        var control = {refresh: refresh, pause: pause, resume: resume, dispose: dispose};
        instances.set(root, control);
        subscriptions.push(new event.Event.Subscription('click', toggle, function () {
            if (paused) { resume(); } else { pause(); }
        }));
        // Focus re-evaluates eligibility rather than pausing: refresh() already
        // refuses motion while the active element is inside the list, and a
        // focus visit must not leave the user's pause preference set once focus
        // moves away.
        subscriptions.push(new event.Event.Subscription('focusin', list, refresh));
        subscriptions.push(new event.Event.Subscription('focusout', list, refresh));
        if (supported) {
            observer.observe(list);
            media.addEventListener('change', refresh);
        }
        refresh();
        return control;
    };

    function initialize() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-paste-marquee]'), marquee.init);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function ready() {
            document.removeEventListener('DOMContentLoaded', ready, false);
            initialize();
        }, false);
    } else {
        initialize();
    }
});
