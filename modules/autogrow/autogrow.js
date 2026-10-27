/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Grows .autogrow or textarea[data-paste-autogrow] when its content overflows.
 * The browser owns editing and manual resize; CSS owns min/max height
 * and transitions. Deleting content never shrinks the field.
 *
 * Shared input and legacy keyup handlers cover typing, paste, cut and undo. Hidden
 * fields wait for their next input after becoming visible. No collapse,
 * frame queue, transition override, scroll restoration or public API.
 *
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/autogrow
 */
paste['define'](
    'paste.ui.autogrow',
    [
        'paste.dom',
        'paste.event'
    ],
    function (autogrow, dom, event) {
        'use strict';

        var $w = window,
            $style = $w['getComputedStyle'],
            $parseFloat = parseFloat,
            $min = Math['min'],
            bind = event['bind'],
            getTarget = event['getEventTarget'],
            PIXELS = /px$/,
            heightFor = function (element) {
                var client = element['clientHeight'],
                    height,
                    computed,
                    style,
                    limit;
                if (!(client > 0)) {
                    return;
                }
                height = element['scrollHeight'];
                if (height <= client) {
                    return;
                }
                computed = $style(element);
                if (computed['boxSizing'] === 'border-box') {
                    height += ($parseFloat(computed['borderTopWidth']) || 0) +
                        ($parseFloat(computed['borderBottomWidth']) || 0);
                } else {
                    height -= ($parseFloat(computed['paddingTop']) || 0) +
                        ($parseFloat(computed['paddingBottom']) || 0);
                }
                // Resolved pixel caps avoid repeated writes at the limit.
                // Other units remain CSS-owned, without layout inference.
                limit = computed['maxHeight'];
                if (PIXELS.test(limit)) {
                    height = $min(height, $parseFloat(limit));
                }
                if (!(height > $parseFloat(computed['height']))) {
                    return;
                }
                style = element['style'];
                // A height transition may still be approaching a taller
                // inline target. Input must not shorten that target.
                limit = style['height'];
                if (PIXELS.test(limit) && height <= $parseFloat(limit)) {
                    return;
                }
                height += 'px';
                return style['height'] !== height ? height : undefined;
            },
            applyHeight = function (element, height) {
                var style;
                if (height !== undefined) {
                    style = element['style'];
                    style['setProperty']('height', height, style['getPropertyPriority']('height'));
                }
            },
            onInput = function (e) {
                var element = getTarget(e);
                applyHeight(element, heightFor(element));
            },
            elements,
            remaining,
            batchEnd,
            writeIndex,
            heights = [],
            element;

        if (!$style) {
            return autogrow;
        }
        elements = dom['get']('.autogrow, textarea[data-paste-autogrow]', true) || [];
        remaining = elements.length;
        batchEnd = remaining;
        while (remaining--) {
            element = elements[remaining];
            // Legacy .autogrow may wrap another declared field. Finish
            // that descendant's growth before measuring its ancestor.
            if (remaining + 1 < batchEnd && element.contains &&
                    element.contains(elements[remaining + 1])) {
                writeIndex = batchEnd;
                while (writeIndex > remaining + 1) {
                    writeIndex -= 1;
                    applyHeight(elements[writeIndex], heights[writeIndex]);
                }
                batchEnd = remaining + 1;
            }
            bind('input', element, onInput);
            bind('keyup', element, onInput);
            heights[remaining] = heightFor(element);
        }
        // Independent fields share one measurement batch.
        // Editing remains immediate and measures only the event target.
        remaining = batchEnd;
        while (remaining--) {
            applyHeight(elements[remaining], heights[remaining]);
        }
        elements = null;
        heights = null;
        element = null;
        return autogrow;
    }
);
