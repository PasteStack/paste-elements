/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Enhance one semantic list with optional CSS-driven continuous motion,
 * without copies.
 *
 * Markup: a root carrying data-paste-marquee with exactly one direct
 * .paste-ui-marquee-items list of .paste-ui-marquee-item children and one
 * direct .paste-ui-marquee-toggle button. The original list items are
 * never cloned, reordered or removed; the authored toggle is the only
 * pause control, and there is no imperative API — the binding lives as
 * long as the page does.
 *
 * Options, read on every refresh so a changed attribute applies at the
 * next one:
 *   data-paste-marquee-duration     — seconds per cycle, a plain
 *                                     decimal number greater than zero
 *                                     (default 45): digits with an
 *                                     optional fraction ('4', '4.5',
 *                                     '.5', '4.'), read untrimmed.
 *                                     Hexadecimal, binary, exponent,
 *                                     signed, empty or space-padded
 *                                     values are invalid and keep the
 *                                     list static.
 *   data-paste-marquee-pause-label  — toggle text while running.
 *   data-paste-marquee-resume-label — toggle text while paused.
 *
 * CSS owns every animation frame. The module only measures geometry and
 * eligibility, and it does so after bind and again whenever an input
 * can change the answer: a ResizeObserver notification on the list or
 * an item, a child-list change, focus entering or leaving the list, the
 * toggle being pressed, and a reduced-motion preference change. The
 * bind-time and observer-driven refreshes — resize and child-list — run
 * on the next animation frame through
 * paste.ui.utilities.animation-frame: geometry is read in the frame's
 * read phase and the state and custom properties are written in its
 * write phase, so a burst of notifications is one measurement, the
 * measurement shares the frame's single layout with every other paste
 * element, and it never runs inside the observer delivery its own
 * writes would retrigger. Toggle, focus and preference refreshes answer
 * the user immediately.
 *
 * The module writes data-paste-marquee-state (running, paused or
 * static), the toggle's hidden, disabled and label, the list's
 * --paste-marquee-distance, --paste-marquee-item-size,
 * --paste-marquee-row-height and --paste-marquee-duration, and each
 * item's --paste-marquee-delay. Every custom property it writes is
 * owned: the inline value and priority it replaced are remembered, and
 * when ownership ends — an item leaving the list, or the binding
 * standing down — the authored value and priority come back, but only
 * while the declaration is still the one the module wrote; a newer
 * writer's value is left alone.
 *
 * Gap: the spacing between items is measured from item geometry —
 * while the list is in its in-flow layout (any state but running) and
 * its first two items share a row, the gap is the distance between
 * their boxes, whatever unit or expression the stylesheet used. When
 * the layout cannot show it (a list too narrow for two items on one
 * row), the computed column-gap stands in: a px value as is, a
 * percentage resolved against the list's content width, 'normal' as 0.
 * The running layout positions every item absolutely and hides the
 * gap, so a running refresh starts from the last gap measured in flow
 * and carries it forward by however much the computed column-gap has
 * moved since that measurement — a breakpoint or a viewport-relative
 * gap that changes while the list runs changes the running pitch with
 * it, and margins or distributed space the in-flow pitch included are
 * kept. A computed form that resolves to none of the above (a calc()
 * or max() expression) cannot say how far it moved: the running pitch
 * keeps the in-flow measurement until the list next leaves the running
 * state. With no in-flow measurement at all, the computed value stands
 * in, and an unresolvable one keeps the list static.
 *
 * Geometry is read in the list's own layout pixels, the unit every
 * custom property it writes is resolved in: an ancestor transform or
 * zoom scales the item rectangles, so they are divided by the list's
 * rendered width over its layout width. A rendered width within a
 * pixel of offsetWidth, which rounds the layout width, is unscaled. An
 * ancestor scale that later changes resizes no box and is not seen
 * until the next refresh input, but each measure is correct at the
 * scale it reads.
 *
 * Direction: the running layout anchors items at the list's inline
 * start and translates them toward it, so a right-to-left list moves
 * the mirror way. The stylesheet carries the sign as
 * --paste-marquee-inline-sign (1, or -1 under :dir(rtl), or under a
 * dir="rtl" ancestor where :dir() is unsupported).
 *
 * Reduced motion: the motion is offered only while the
 * prefers-reduced-motion preference is observable and not 'reduce', as
 * paste.ui.utilities.mediaquery reports it; an unobservable preference
 * keeps the list static, since a later change to it could never be
 * honored.
 *
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/mediaquery
 * @module paste/ui/marquee
 */
paste['define']('paste.ui.marquee', [
    'paste.event',
    'paste.ui.utilities.animation-frame',
    'paste.ui.utilities.mediaquery'
], function (marquee, event, animation_frame, mediaquery) {
    'use strict';

    var $w = window,
        $d = document,
        $abs = Math.abs,
        $parseFloat = parseFloat,
        $isFinite = isFinite,
        Subscription = event['Event']['Subscription'],
        requestPhased = animation_frame['requestPhased'],
        cancelFrame = animation_frame['cancel'],
        PIXELS = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)px$/,
        PERCENT = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)%$/,
        STATE_ATTRIBUTE = 'data-paste-marquee-state',
        DURATION_ATTRIBUTE = 'data-paste-marquee-duration',
        ITEM_SELECTOR = '.paste-ui-marquee-item',
        INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])',
        DELAY_PROPERTY = '--paste-marquee-delay',
        LIST_PROPERTIES = [
            '--paste-marquee-distance',
            '--paste-marquee-item-size',
            '--paste-marquee-row-height',
            '--paste-marquee-duration'
        ],
        DEFAULT_DURATION = 45,
        // Plain decimals only, on the untrimmed attribute text —
        // Number() would also accept '0x2', '0b1', '1e1', '-0' and
        // padding whitespace.
        DECIMAL = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/,
        CHILD_LIST = {childList: true},

        durationOf = function (root) {
            var text = root.getAttribute(DURATION_ATTRIBUTE);
            if (text === null) {
                return DEFAULT_DURATION;
            }
            return DECIMAL.test(text) ? Number(text) : NaN;
        },

        // An owned custom property: the first write remembers the
        // authored inline value and priority it replaces; every write
        // records the declaration as the style interface reports it —
        // the ownership proof a later surrender is judged against.
        writeOwned = function (element, record, name, value) {
            var style = element.style;
            if (!record.claimed) {
                record.claimed = true;
                record.authored = style.getPropertyValue(name);
                record.authoredPriority = style.getPropertyPriority(name);
            }
            if (style.getPropertyValue(name) !== value || style.getPropertyPriority(name)) {
                style.removeProperty(name);
                style.setProperty(name, value);
            }
            record.written = style.getPropertyValue(name);
            record.writtenPriority = style.getPropertyPriority(name);
        },

        // Ownership ends: the authored declaration — value and
        // priority — returns while the property is still the module's
        // own write; a newer writer's declaration stays untouched.
        surrenderOwned = function (element, record, name) {
            var style = element.style;
            if (!record.claimed) {
                return;
            }
            record.claimed = false;
            if (style.getPropertyValue(name) !== record.written ||
                    style.getPropertyPriority(name) !== record.writtenPriority) {
                return;
            }
            if (record.authored === '') {
                style.removeProperty(name);
            } else {
                style.setProperty(name, record.authored, record.authoredPriority);
            }
        },

        // The computed column gap, resolved: px as is, a percentage
        // of the list's content inline size, 'normal' as 0 — any other
        // form is unresolvable (NaN).
        computedGap = function (list) {
            var style = $w.getComputedStyle(list),
                text = String(style.columnGap || ''),
                content;
            if (text === 'normal') {
                return 0;
            }
            if (PIXELS.test(text)) {
                return $parseFloat(text);
            }
            if (PERCENT.test(text)) {
                content = list.clientWidth - ($parseFloat(style.paddingLeft) || 0) -
                    ($parseFloat(style.paddingRight) || 0);
                return content * $parseFloat(text) / 100;
            }
            return NaN;
        },

        // The real gap between the first two items, from their boxes:
        // only meaningful while both are in flow on one row.
        measuredGap = function (first, second) {
            if ($abs(first.top - second.top) >= 0.5) {
                return NaN;
            }
            return second.left >= first.left
                ? second.left - first.right
                : first.left - second.right;
        },

        ownedRecord = function () {
            return {
                claimed: false,
                authored: '',
                authoredPriority: '',
                written: '',
                writtenPriority: ''
            };
        },

        // Bind one data-paste-marquee root at module evaluation. Invalid
        // markup binds nothing; a missing capability leaves the list
        // static.
        bind = function (root) {
            var list,
                toggle,
                paused = false,
                motion = null,
                running = false,
                supported,
                refreshScheduled = false,
                refreshFrame = null,
                pendingPlan = null,
                // The gap the in-flow layout last showed — the running
                // layout cannot show one — and the computed gap that
                // stood beside it, so a running refresh can follow the
                // stylesheet's change from there.
                lastGap = NaN,
                lastComputedGap = NaN,
                observer = null,
                mutations = null,
                childRecords,
                listRecords = [],
                // active marks a binding whose work may still run —
                // queued callbacks re-read it rather than trust their
                // own arrival. released makes teardown single-shot.
                active = false,
                released = false,
                subscriptions = [],
                index,
                children,
                displayState,
                measure,
                apply,
                refresh,
                readScheduled,
                writeScheduled,
                scheduleRefresh,
                observeChild,
                releaseChild,
                deactivate,
                onMutations,
                togglePause;

            if (!root || !root.hasAttribute('data-paste-marquee')) {
                return;
            }
            list = root.querySelector('.paste-ui-marquee-items');
            toggle = root.querySelector('.paste-ui-marquee-toggle');
            if (!list || !toggle || list.parentElement !== root || toggle.parentElement !== root) {
                return;
            }

            displayState = function (state, canAnimate) {
                var label;
                if (root.getAttribute(STATE_ATTRIBUTE) !== state) {
                    root.setAttribute(STATE_ATTRIBUTE, state);
                }
                toggle.hidden = !canAnimate;
                toggle.disabled = !canAnimate;
                label = paused
                    ? root.getAttribute('data-paste-marquee-resume-label')
                    : root.getAttribute('data-paste-marquee-pause-label');
                label = label || (paused ? 'Resume motion' : 'Pause motion');
                if (toggle.textContent !== label) {
                    toggle.textContent = label;
                }
            };

            // Every capability probe is a browser boundary: a facility
            // that is absent, non-callable, or throws only means the
            // static fallback is the honest answer. Motion needs every
            // observation the eligibility proof relies on: the resize
            // surface, the child-list surface that keeps it truthful
            // when members change, and the record structure ownership
            // bookkeeping is kept in.
            supported = !!($w.ResizeObserver &&
                typeof $w.MutationObserver === 'function' &&
                typeof $w.WeakMap === 'function' &&
                $w.CSS && typeof $w.CSS.supports === 'function');
            if (supported) {
                try {
                    supported = !!$w.CSS.supports('width', 'min(100%, 1px)');
                } catch (supportsError) {
                    supported = false;
                }
            }
            // A permanently missing capability cannot appear later, so
            // an unsupported list keeps its authored static state with no
            // observers, subscriptions, or geometry work at all.
            if (!supported) {
                displayState('static', false);
                return;
            }
            // The preference must be observable — a query that cannot
            // take a change listener could never honor a later change.
            // The shared utility owns the MediaQueryList binding; its
            // listener re-measures, and refresh is inert until the
            // binding is active.
            motion = mediaquery['observe']('(prefers-reduced-motion: reduce)', function () {
                refresh();
            });
            if (!motion['observed']) {
                displayState('static', false);
                return;
            }

            childRecords = new $w.WeakMap();
            index = LIST_PROPERTIES.length;
            while (index--) {
                listRecords[index] = ownedRecord();
            }

            // Measure geometry and eligibility into a plan; reads only.
            // A call that survives teardown is inert — a queued delivery
            // must never revive a binding already returned to the static
            // baseline.
            measure = function () {
                var items = [],
                    itemsLength,
                    itemIndex,
                    item,
                    boxes = [],
                    box,
                    width = 0,
                    height = 0,
                    gap,
                    computed,
                    distance,
                    duration,
                    eligible,
                    listWidth,
                    layoutWidth,
                    listBox,
                    scale = 1;

                if (!active) {
                    return null;
                }
                // The live collection is copied first — a shifting
                // children list would lie about geometry mid-measure.
                children = list.children;
                itemIndex = children.length;
                while (itemIndex--) {
                    items[itemIndex] = children[itemIndex];
                }
                itemsLength = items.length;
                // Rectangles carry any ancestor transform or zoom; the
                // written geometry is in the list's layout pixels.
                layoutWidth = list.offsetWidth;
                if (itemsLength && layoutWidth > 0) {
                    listBox = list.getBoundingClientRect();
                    if ($abs(listBox.width - layoutWidth) >= 1 && listBox.width > 0) {
                        scale = listBox.width / layoutWidth;
                    }
                }

                itemIndex = itemsLength;
                while (itemIndex--) {
                    box = items[itemIndex].getBoundingClientRect();
                    if (scale !== 1) {
                        box = {
                            left: box.left / scale,
                            right: box.right / scale,
                            top: box.top / scale,
                            width: box.width / scale,
                            height: box.height / scale
                        };
                    }
                    boxes[itemIndex] = box;
                    if (itemIndex === 0) {
                        width = box.width;
                    }
                    if (box.height > height) {
                        height = box.height;
                    }
                }
                // The running layout hides the gap, so both states test
                // the fit against the pitch the in-flow layout last
                // showed — margins and distributed space included — and
                // fall back to the computed value only when the in-flow
                // layout showed none. Two sources that disagree would
                // flip the state every frame. A running refresh moves
                // that pitch by the computed gap's own change since it
                // was measured: unchanged CSS keeps it exactly.
                computed = computedGap(list);
                if (!running) {
                    lastGap = itemsLength > 1 ? measuredGap(boxes[0], boxes[1]) : NaN;
                    lastComputedGap = computed;
                }
                gap = lastGap;
                if (!$isFinite(gap)) {
                    gap = computed;
                } else if (running && $isFinite(computed) && $isFinite(lastComputedGap)) {
                    gap += computed - lastComputedGap;
                }
                distance = itemsLength * (width + gap);
                duration = durationOf(root);
                listWidth = list.clientWidth;
                eligible = itemsLength > 0;
                itemIndex = itemsLength;
                while (itemIndex-- && eligible) {
                    item = items[itemIndex];
                    eligible = item.matches(ITEM_SELECTOR) &&
                        $abs(boxes[itemIndex].width - width) < 0.01 &&
                        !item.matches(INTERACTIVE_SELECTOR) && !item.querySelector(INTERACTIVE_SELECTOR);
                }
                return {
                    items: items,
                    width: width,
                    height: height,
                    gap: gap,
                    distance: distance,
                    duration: duration,
                    canAnimate: !mediaquery['motionReduced'](motion) && $isFinite(duration) && duration > 0 &&
                        itemsLength > 1 && width > 0 && height > 0 && $isFinite(gap) && gap >= 0 &&
                        listWidth > 0 && distance >= listWidth + width &&
                        !list.contains($d.activeElement) && eligible
                };
            };

            // Write a measured plan: the owned custom properties, then
            // the state and toggle. Writes only.
            apply = function (plan) {
                var items,
                    itemIndex,
                    item,
                    record,
                    canAnimate;
                if (!active || !plan) {
                    return;
                }
                canAnimate = plan.canAnimate;
                if (canAnimate) {
                    writeOwned(list, listRecords[0], LIST_PROPERTIES[0], plan.distance + 'px');
                    writeOwned(list, listRecords[1], LIST_PROPERTIES[1], plan.width + 'px');
                    writeOwned(list, listRecords[2], LIST_PROPERTIES[2], plan.height + 'px');
                    writeOwned(list, listRecords[3], LIST_PROPERTIES[3], plan.duration + 's');
                    items = plan.items;
                    itemIndex = items.length;
                    while (itemIndex--) {
                        item = items[itemIndex];
                        record = childRecords.get(item);
                        if (record) {
                            writeOwned(item, record, DELAY_PROPERTY,
                                (-plan.duration * ((plan.distance - plan.width - itemIndex * (plan.width + plan.gap)) /
                                    plan.distance)) + 's');
                        }
                    }
                }
                running = canAnimate && !paused;
                displayState(running ? 'running' : (canAnimate ? 'paused' : 'static'), canAnimate);
            };

            // A user-driven refresh answers in the same turn.
            refresh = function () {
                apply(measure());
            };

            // Teardown is terminal: the binding dies before any claim is
            // released, so work already queued cannot revive it. Every
            // owned declaration — the list geometry and each item's
            // delay — returns to what was authored.
            deactivate = function () {
                var childIndex;
                if (released) {
                    return;
                }
                released = true;
                active = false;
                refreshScheduled = false;
                pendingPlan = null;
                if (refreshFrame !== null) {
                    cancelFrame(refreshFrame);
                    refreshFrame = null;
                }
                index = subscriptions.length;
                while (index--) {
                    subscriptions[index]['dispose']();
                }
                subscriptions.length = 0;
                motion['dispose']();
                if (mutations) {
                    mutations.disconnect();
                }
                if (observer) {
                    observer.disconnect();
                }
                children = list.children;
                childIndex = children ? children.length : 0;
                while (childIndex--) {
                    releaseChild(children[childIndex]);
                }
                index = LIST_PROPERTIES.length;
                while (index--) {
                    surrenderOwned(list, listRecords[index], LIST_PROPERTIES[index]);
                }
                running = false;
                displayState('static', false);
            };

            // The scheduled refresh is one phased pair: the read phase
            // measures, the write phase applies what it measured.
            readScheduled = function () {
                refreshFrame = null;
                refreshScheduled = false;
                pendingPlan = measure();
            };
            writeScheduled = function () {
                var plan = pendingPlan;
                pendingPlan = null;
                apply(plan);
            };

            // Bind-time and observer work waits for the next frame and
            // coalesces: a refresh that writes styles inside the
            // notification would resize the observed boxes
            // mid-delivery, and a burst of notifications is one
            // remeasure, not N. The mark is set before the frame is
            // requested so the pass is armed once per frame.
            scheduleRefresh = function () {
                if (!active || refreshScheduled) {
                    return;
                }
                refreshScheduled = true;
                refreshFrame = requestPhased(readScheduled, writeScheduled);
            };

            // An added child joins observation once. A refused
            // observation fails the whole coverage proof: motion over
            // children the observer cannot see would run on geometry
            // that can go stale.
            observeChild = function (item) {
                if (!item || item.nodeType !== 1 || childRecords.has(item)) {
                    return true;
                }
                try {
                    observer.observe(item);
                } catch (observeError) {
                    return false;
                }
                childRecords.set(item, ownedRecord());
                return true;
            };

            // Ownership follows membership: a child that leaves the
            // list is unobserved and surrenders the delay it carried.
            releaseChild = function (item) {
                var record = item ? childRecords.get(item) : null;
                if (!record) {
                    return;
                }
                observer.unobserve(item);
                surrenderOwned(item, record, DELAY_PROPERTY);
                childRecords['delete'](item);
            };

            // Records arrive in DOM-mutation order and a node can appear
            // in several — added, removed, added back. Its final
            // membership is what its parent says now, so each named node
            // is judged by that, never by the record it rode in on.
            onMutations = function (records) {
                var recordCount = records.length,
                    recordIndex = 0,
                    record,
                    nodes,
                    nodeCount,
                    nodeIndex,
                    node;
                while (recordCount--) {
                    record = records[recordIndex];
                    recordIndex += 1;
                    nodes = record.addedNodes;
                    nodeCount = nodes ? nodes.length : 0;
                    nodeIndex = 0;
                    while (nodeCount--) {
                        node = nodes[nodeIndex];
                        nodeIndex += 1;
                        if (node && node.parentNode === list) {
                            if (!observeChild(node)) {
                                deactivate();
                                return;
                            }
                        } else {
                            releaseChild(node);
                        }
                    }
                    nodes = record.removedNodes;
                    nodeCount = nodes ? nodes.length : 0;
                    nodeIndex = 0;
                    while (nodeCount--) {
                        node = nodes[nodeIndex];
                        nodeIndex += 1;
                        if (node && node.parentNode === list) {
                            if (!observeChild(node)) {
                                deactivate();
                                return;
                            }
                        } else {
                            releaseChild(node);
                        }
                    }
                }
                scheduleRefresh();
            };

            togglePause = function () {
                paused = !paused;
                refresh();
            };

            // Each registration is a fallible host boundary on its own:
            // a refusal hands back every claim already made and leaves
            // this root static while later roots still bind.
            try {
                observer = new $w.ResizeObserver(scheduleRefresh);
                mutations = new $w.MutationObserver(onMutations);
            } catch (constructError) {
                observer = null;
                mutations = null;
                motion['dispose']();
                displayState('static', false);
                return;
            }
            // active before the first claim, so a queued delivery from
            // any registration below meets a live binding.
            active = true;
            try {
                observer.observe(list);
            } catch (listObserveError) {
                deactivate();
                return;
            }
            subscriptions.push(new Subscription('click', toggle, togglePause));
            // Focus re-evaluates eligibility rather than pausing:
            // refresh() already refuses motion while the active element
            // is inside the list, and a focus visit must not leave the
            // user's pause preference set once focus moves away.
            subscriptions.push(new Subscription('focusin', list, refresh));
            subscriptions.push(new Subscription('focusout', list, refresh));
            // The watched surface is this list's own children — the
            // module never observes the document to learn its root's
            // lifecycle; bindings are page-lifetime.
            try {
                mutations.observe(list, CHILD_LIST);
            } catch (mutationObserveError) {
                deactivate();
                return;
            }
            children = list.children;
            index = children ? children.length : 0;
            while (index--) {
                if (!observeChild(children[index])) {
                    deactivate();
                    return;
                }
            }
            scheduleRefresh();
        },

        roots = $d.querySelectorAll('[data-paste-marquee]'),
        rootsLength = roots.length,
        rootIndex = 0;

    // Paste's footer-loading convention means the markup precedes this
    // define — there is no parse event to wait for. Every fallible call
    // inside bind is guarded where it is made, and a failure that still
    // escapes one root's bind is contained there: later roots still
    // bind.
    while (rootsLength--) {
        try {
            bind(roots[rootIndex]);
        } catch (ignore) {
            // This root keeps whatever state it reached; the sweep goes
            // on.
        }
        rootIndex += 1;
    }

    // The namespace carries nothing: markup is the whole contract.
    return marquee;
});
