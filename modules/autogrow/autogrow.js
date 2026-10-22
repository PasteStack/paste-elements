/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * A declared textarea grows with its content and shrinks back to its
 * floor as content is deleted.
 *
 * Markup: <textarea data-paste-autogrow>. The data attribute is the
 * whole declaration; the .autogrow class alone activates nothing —
 * markup carrying only the class must add data-paste-autogrow.
 * Minimum and maximum heights are CSS (the autogrow mixin's
 * min-height/max-height); no data-paste-autogrow-min/max attribute is
 * read.
 *
 * Sizing runs on 'input' — typing, delete, cut, paste, undo — coalesced
 * into one phased animation-frame pass for every dirty field. Its read
 * phase takes everything readable before any write: lazily captured
 * floors, a user's own resize, box metrics, and the scroll offsets a
 * collapse could disturb. Its write phase then lands all resets, then all
 * measurements, then all final heights. Measuring a collapsed field is
 * the one layout the module needs; it runs in the write phase because the
 * collapse it measures must never paint, and every module's read phase in
 * the same frame has already run on clean layout by then.
 *
 * The collapse is to a height of zero, not 'auto': 'auto' falls back to
 * the rows attribute's intrinsic height, so a field styled shorter than
 * its rows would grow on the first keystroke. Transitions: zero is a
 * height a transition can run to, which would leave the measure reading
 * the old height. A field whose computed transition duration or delay is
 * non-zero is held for the pass — transition-duration and
 * transition-delay are set to 0s inline and important — so the collapse
 * and the final height land at once; one computed-style read (style, not
 * layout) applies the final heights, then the author's own inline values
 * come back: an inline transition shorthand is put back whole, as its
 * text reads, since a shorthand holding var() reads back nothing through
 * its longhands. Another computed-style read before the hold applies
 * whatever style change an earlier write in the frame left pending — a
 * class on the field or an ancestor — so that change transitions with
 * the author's own durations. A height transition therefore never runs on
 * a sizing pass's writes, and one on another property is left running.
 * Binding does not collapse and holds nothing.
 *
 * The floor: the box's rendered height when the module first sees the
 * field rendered — at bind, or at the first pass after a field that
 * was hidden at bind (display:none, a closed details) is shown. A field
 * that is not rendered is skipped: its inline height is left as it was
 * and no height of zero or less is ever written.
 *
 * Native resize: the browser's resize handle keeps working, with or
 * without JavaScript. A height the user drags to becomes the new floor
 * — the next keystroke grows from it but never collapses below it — so
 * the enhancement never fights the user's own sizing.
 *
 * Scroll position: collapsing a field to measure it can shorten the
 * document, or the field's nearest scrolled ancestor, for an instant, and
 * the engine clamps the offset. The pass reads the page offset and that
 * ancestor's scrollTop in its read phase, reads them again in the
 * measure phase (whose layout the measurements already paid for), and
 * puts back only what moved once the final heights land — no offset is
 * read after the final writes. The nearest ancestor with a non-zero
 * scrollTop is the one restored; a scroller further out is not tracked.
 * The restore is instant ('instant' scroll behavior) even under
 * scroll-behavior: smooth, so the clamped offset never paints; an
 * engine without scroll options, or one that rejects 'instant', gets the
 * plain numeric write.
 *
 * Each written height is remembered as the inline value reads back,
 * so the CSSOM's own rounding of a fractional height is never mistaken
 * for a user's drag.
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/autogrow
 */
paste['define'](
    'paste.ui.autogrow',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.utilities.animation-frame'
    ],
    function (autogrow, dom, event, animation_frame) {
        'use strict';

        var $w = window,
            $doc = document,
            $max = Math['max'],
            $parseFloat = parseFloat,
            $Number = Number,
            $root = $doc['documentElement'],
            // Scroll options (and with them the behavior member) ship
            // together with the scroll-behavior property.
            scrollOptions = !!($root && $root['style'] && $root['style']['scrollBehavior'] !== undefined),
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            AUTOGROW_SELECTOR = 'textarea[data-paste-autogrow]',
            PIXELS = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)px$/,
            // Any non-zero digit in the computed duration and delay lists:
            // some property of the field can transition.
            TIMED = /[1-9]/,
            TRANSITION = 'transition',
            TRANSITION_DURATION = 'transition-duration',
            TRANSITION_DELAY = 'transition-delay',

            // The module's one pending sizing pass and the fields it owes
            // work. Input events only mark fields dirty.
            dirtyFields = [],
            framePending = false,

            // Per-pass scroll bookkeeping, reused across passes: each
            // distinct scrolled ancestor of a dirty field with the offset
            // it had before the pass wrote anything.
            scrollers = [],
            scrollerTops = [],
            scrollerMoved = [],
            // The page offset the read phase took, for the write phase.
            passScrollX = 0,
            passScrollY = 0,

            // A field is rendered when its box has a scroll extent —
            // display:none and detached fields report zero.
            rendered = function (element) {
                return element['clientHeight'] > 0 || element['scrollHeight'] > 0;
            },

            // The units the inline height is written in, from one
            // computed-style read taken before the collapse: scrollHeight
            // counts content plus padding while the CSS height counts
            // whatever box-sizing declares. The same read says whether the
            // field can transition, which the collapse must not let run.
            boxUnits = function (field) {
                var style = $w['getComputedStyle'](field.element);
                field.borderBox = style['boxSizing'] === 'border-box';
                field.verticalPadding = ($parseFloat(style['paddingTop']) || 0) +
                    ($parseFloat(style['paddingBottom']) || 0);
                field.verticalBorder = ($parseFloat(style['borderTopWidth']) || 0) +
                    ($parseFloat(style['borderBottomWidth']) || 0);
                field.timed = TIMED.test((style['transitionDuration'] || '') +
                    (style['transitionDelay'] || ''));
            },

            // A zero duration and delay, inline and important so no rule
            // outranks them, keep the collapse and the final height from
            // starting a transition; a transition already running on
            // another property keeps running. The author's own inline
            // values are kept for the release: the shorthand's text when
            // it reads back — a shorthand holding var() leaves its
            // longhands reading empty — and the two longhands otherwise.
            holdTransitions = function (field) {
                var style = field.element['style'];
                field.heldTransition = style['getPropertyValue'](TRANSITION);
                field.heldTransitionPriority = style['getPropertyPriority'](TRANSITION);
                field.heldDuration = style['getPropertyValue'](TRANSITION_DURATION);
                field.heldDurationPriority = style['getPropertyPriority'](TRANSITION_DURATION);
                field.heldDelay = style['getPropertyValue'](TRANSITION_DELAY);
                field.heldDelayPriority = style['getPropertyPriority'](TRANSITION_DELAY);
                style['setProperty'](TRANSITION_DURATION, '0s', 'important');
                style['setProperty'](TRANSITION_DELAY, '0s', 'important');
            },

            restoreProperty = function (style, name, value, priority) {
                if (value) {
                    style['setProperty'](name, value, priority);
                } else {
                    style['removeProperty'](name);
                }
            },

            // The shorthand, set again, puts back every longhand it set.
            releaseTransitions = function (field) {
                var style = field.element['style'];
                if (field.heldTransition) {
                    style['setProperty'](TRANSITION, field.heldTransition, field.heldTransitionPriority);
                    return;
                }
                restoreProperty(style, TRANSITION_DURATION, field.heldDuration, field.heldDurationPriority);
                restoreProperty(style, TRANSITION_DELAY, field.heldDelay, field.heldDelayPriority);
            },

            // clientHeight (padding box) converted to CSS height units.
            heightFromClient = function (field, clientHeight) {
                return field.borderBox
                    ? clientHeight + field.verticalBorder
                    : clientHeight - field.verticalPadding;
            },

            // The floor is the authored height, read once the field is
            // rendered — kept in padding-box units so it converts with
            // whatever box metrics apply at each pass. A field still
            // unrendered keeps no floor yet.
            captureFloor = function (field) {
                var element = field.element;
                if (field.floorClient !== null || !rendered(element)) {
                    return;
                }
                field.floorClient = element['clientHeight'];
            },

            // Measure one field against its floor. A field that turned
            // out unrendered gets no final height at all.
            sizeField = function (field) {
                var scrollHeight;
                if (field.floorClient === null && field.floor === null) {
                    field.finalHeight = 0;
                    return;
                }
                scrollHeight = field.element['scrollHeight'];
                if (!(scrollHeight > 0)) {
                    field.finalHeight = 0;
                    return;
                }
                field.finalHeight = $max(
                    field.borderBox
                        ? scrollHeight + field.verticalBorder
                        : scrollHeight - field.verticalPadding,
                    field.floor !== null ? field.floor : heightFromClient(field, field.floorClient)
                );
            },

            // A height the module did not write is the user's: the
            // native resize handle writes the dragged size inline. It
            // becomes the floor, so the next keystroke cannot snap the
            // box back below what the user chose — the enhancement and
            // the platform's own control agree instead of fighting.
            // field.written holds the serialized readback of the module's
            // own write, so CSSOM rounding never looks like a drag.
            adoptUserHeight = function (field) {
                var inline = field.element['style']['height'],
                    match;
                if (field.written === null || inline === field.written) {
                    return;
                }
                match = PIXELS.exec(inline);
                if (match && $Number(match[1]) > 0) {
                    field.floor = $Number(match[1]);
                }
            },

            // Writes the measured height and keeps what the inline style
            // reads back; false when the field had nothing to write.
            commitHeight = function (field) {
                var style;
                if (!(field.finalHeight > 0)) {
                    return false;
                }
                style = field.element['style'];
                style['height'] = field.finalHeight + 'px';
                field.written = style['height'];
                return true;
            },

            // The nearest ancestor below the document's own scroller
            // whose scrollTop is non-zero: the box a collapse can clamp.
            // The page offset covers the root and body.
            rememberScroller = function (element) {
                var node = element['parentNode'],
                    root = $doc['documentElement'],
                    body = $doc['body'],
                    top,
                    known;
                while (node && node['nodeType'] === 1 && node !== root && node !== body) {
                    top = node['scrollTop'];
                    if (top > 0) {
                        known = scrollers.length;
                        while (known--) {
                            if (scrollers[known] === node) {
                                return;
                            }
                        }
                        scrollers.push(node);
                        scrollerTops.push(top);
                        return;
                    }
                    node = node['parentNode'];
                }
            },

            // Puts an offset back without animating it: 'auto' would
            // follow a smooth scroll-behavior and paint the clamped
            // offset first. left is null for an element, whose
            // horizontal offset is left as it is.
            scrollInstantly = function (target, left, top) {
                var options;
                if (scrollOptions && typeof target['scrollTo'] === 'function') {
                    options = {top: top, behavior: 'instant'};
                    if (left !== null) {
                        options.left = left;
                    }
                    try {
                        target['scrollTo'](options);
                        return;
                    } catch (rejected) {
                        // An engine that predates 'instant' rejects it.
                        options = null;
                    }
                }
                if (left === null) {
                    target['scrollTop'] = top;
                } else if (typeof target['scrollTo'] === 'function') {
                    target['scrollTo'](left, top);
                }
            },

            // The read phase: every read the pass can take before any
            // module writes in the frame.
            readPass = function () {
                var index,
                    remaining,
                    dirty = dirtyFields,
                    field;
                framePending = false;
                scrollers.length = 0;
                scrollerTops.length = 0;
                // Lazily captured floors, the user's own resize, box
                // metrics and transitions, and the offsets a collapse
                // could disturb.
                remaining = dirty.length;
                index = 0;
                while (remaining--) {
                    field = dirty[index];
                    captureFloor(field);
                    adoptUserHeight(field);
                    boxUnits(field);
                    field.previous = field.element['style']['height'];
                    rememberScroller(field.element);
                    index += 1;
                }
                passScrollX = $w['pageXOffset'];
                passScrollY = $w['pageYOffset'];
            },

            // The write phase: resets, the collapsed measure, final
            // heights, and the offsets put back.
            writePass = function () {
                var index,
                    remaining,
                    dirty = dirtyFields,
                    field,
                    scrollX = passScrollX,
                    scrollY = passScrollY,
                    pageMoved,
                    held = false,
                    moved = scrollerMoved;
                // Collapsing each box to zero (min-height still holds)
                // lets scrollHeight report the content alone, so deleted
                // text shrinks the element; 'auto' would fall back to
                // the rows attribute's intrinsic height and grow a field
                // styled shorter than its rows. Zero can be interpolated,
                // so a field that can transition is held first: otherwise
                // the measure reads the old height mid-animation and the
                // field never shrinks. The floor comes back with the final
                // height. All resets land before any geometry read; field
                // order stays authored order inside each phase.
                // A write earlier in the frame — a class on a held field or
                // its ancestor — is still pending style; the hold would
                // apply it at the measure with no transition. A
                // computed-style read (style only) applies it first, with
                // the author's durations.
                remaining = dirty.length;
                index = 0;
                while (remaining--) {
                    field = dirty[index];
                    if (field.timed) {
                        field.applied = $w['getComputedStyle'](field.element)['transitionDuration'];
                    }
                    index += 1;
                }
                remaining = dirty.length;
                index = 0;
                while (remaining--) {
                    field = dirty[index];
                    if (field.timed) {
                        holdTransitions(field);
                        held = true;
                    }
                    field.element['style']['height'] = '0px';
                    index += 1;
                }
                remaining = dirty.length;
                index = 0;
                while (remaining--) {
                    sizeField(dirty[index]);
                    index += 1;
                }
                // Still the measure phase: the measurements above already
                // flushed the collapsed layout, so a clamped offset reads
                // here for free. Nothing is read after the final writes.
                pageMoved = typeof scrollY === 'number' && $w['pageYOffset'] !== scrollY;
                remaining = scrollers.length;
                moved.length = remaining;
                while (remaining--) {
                    moved[remaining] = scrollers[remaining]['scrollTop'] !== scrollerTops[remaining];
                }
                remaining = dirty.length;
                index = 0;
                while (remaining--) {
                    field = dirty[index];
                    field.queued = false;
                    if (!commitHeight(field)) {
                        // Unrendered: the inline height it had stays.
                        field.element['style']['height'] = field.previous;
                    }
                    index += 1;
                }
                if (held) {
                    // The final heights must apply while the hold is in
                    // place, or the released transition would animate
                    // them up from the collapse. A computed-style read
                    // applies them — style only, no layout — and every
                    // read lands before any release dirties style again.
                    remaining = dirty.length;
                    index = 0;
                    while (remaining--) {
                        field = dirty[index];
                        if (field.timed) {
                            field.applied = $w['getComputedStyle'](field.element)['transitionDuration'];
                        }
                        index += 1;
                    }
                    remaining = dirty.length;
                    index = 0;
                    while (remaining--) {
                        if (dirty[index].timed) {
                            releaseTransitions(dirty[index]);
                        }
                        index += 1;
                    }
                }
                dirty.length = 0;
                remaining = scrollers.length;
                while (remaining--) {
                    if (moved[remaining]) {
                        scrollInstantly(scrollers[remaining], null, scrollerTops[remaining]);
                    }
                    // Release the held ancestor.
                    scrollers[remaining] = null;
                }
                scrollers.length = 0;
                scrollerTops.length = 0;
                moved.length = 0;
                if (pageMoved) {
                    scrollInstantly($w, scrollX, scrollY);
                }
            },

            // The pending mark is set before the request so one pass is
            // armed per frame however many input events arrive; the read
            // phase clears it. The scheduler never throws.
            armResize = function (field) {
                if (!field.queued) {
                    field.queued = true;
                    dirtyFields.push(field);
                }
                if (framePending) {
                    return;
                }
                framePending = true;
                requestPhased(readPass, writePass);
            },

            bindField = function (element) {
                var field = {
                    element: element,
                    floorClient: null,
                    floor: null,
                    borderBox: false,
                    verticalPadding: 0,
                    verticalBorder: 0,
                    timed: false,
                    heldTransition: '',
                    heldTransitionPriority: '',
                    heldDuration: '',
                    heldDurationPriority: '',
                    heldDelay: '',
                    heldDelayPriority: '',
                    applied: '',
                    written: null,
                    previous: '',
                    queued: false,
                    finalHeight: 0,
                    subscription: null
                };
                // 'input' covers every content change — typing, delete,
                // cut, paste, undo — where 'keyup' only ever saw keys.
                // The listener lives as long as the field.
                field.subscription = new Subscription('input', element, function () {
                    armResize(field);
                });
                return field;
            },

            init = function () {
                var fields = dom['get'](AUTOGROW_SELECTOR, true) || [],
                    declared = [],
                    remaining = fields.length,
                    index = 0;
                while (remaining--) {
                    declared[index] = bindField(fields[index]);
                    index += 1;
                }
                // The same batch rule the input path runs: every measure
                // lands before any write. Unrendered fields are skipped
                // — no floor yet and nothing written.
                remaining = declared.length;
                index = 0;
                while (remaining--) {
                    captureFloor(declared[index]);
                    boxUnits(declared[index]);
                    sizeField(declared[index]);
                    index += 1;
                }
                remaining = declared.length;
                index = 0;
                while (remaining--) {
                    commitHeight(declared[index]);
                    index += 1;
                }
            };

        init();
        return autogrow;
    }
);
