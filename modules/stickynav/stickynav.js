/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Sticks a sub-navigation once the page scrolls past it.
 *
 * Markup: a .sticky-nav-target element, and optionally the site
 * navigation wrapper #_paste_ui_nav_wrap — a header fixed or sticky at
 * the top of the viewport, whose height is the offset the nav sticks
 * at. Without the wrapper the offset is zero; without the target the
 * page keeps its baseline.
 *
 * Behaviour: when the scroll offset reaches the target's slot less the
 * navigation wrapper's height, the module adds the paste-fixed-subnav
 * class and announces navStuck; scrolling back above removes the class
 * and announces navUnstuck. Narrowing the viewport to or below the
 * minimum width while stuck is an unstick transition too.
 *
 * Where the class lands: the element paste.dom's getDocumentBody()
 * returns — the root element (<html>) in standards mode, <body> only in
 * quirks mode. Selectors keyed on the class should not assume <body>,
 * for example `.paste-fixed-subnav .fixed-nav-content`.
 *
 * navStuck / navUnstuck (a documented exception to the no-JS-API
 * rule): paste events created with window as their context, which core
 * dispatches on the document (event.js PasteEvent: a context without a
 * nodeType dispatches on document), so they reach document-bound paste
 * subscriptions, not window listeners.
 * The payload is the .sticky-nav-target element. Both fire only on the
 * transition — never once per scroll — and only after the class write
 * that makes the transition visible: a listener always observes the
 * class it is told about. A stick and an unstick that cancel out before
 * the class is written announce nothing.
 *
 * Authored content: the module never moves, clones or reparents it, so
 * form association, labels, delegated listeners and ids stay intact.
 * Showing .fixed-nav-content while stuck is the page's CSS, keyed on
 * the class — for example:
 *
 *     .fixed-nav-content { display: none; }
 *     .paste-fixed-subnav .fixed-nav-content {
 *         display: block;
 *         position: fixed;
 *         top: 0;
 *         left: 0;
 *         right: 0;
 *     }
 *
 * The events announce the transition and nothing else; presentation
 * keys on the class. #paste-ui-nav and #content are neither read nor
 * required.
 *
 * Options:
 *   data-sticky-min-width (on the target, else on .paste-ui-section-nav)
 *     — a whole number of CSS pixels, digits only and read untrimmed;
 *     at or below it the nav never sticks. "0" is honored as zero; any
 *     other spelling is ignored and the next source (or 0) applies.
 *
 * The threshold is measured without inserting anything into the page —
 * no marker node, so flex and grid layout, sibling selectors and child
 * counts around the target are untouched. The anchor is the bottom
 * edge of the nearest previous element sibling that has an in-flow box,
 * or, when none does, the parent's content top (inside its border and
 * padding); neither moves when the target leaves the flow or when the
 * page scrolls. A sibling with no box (a script, a [hidden] element, a
 * hidden input, display: contents) or one out of the flow (position
 * fixed, absolute or sticky) moves with the scroll or has no position
 * of its own, so the walk passes over it. A display: contents parent
 * draws no box either; the fallback passes up to the nearest ancestor
 * that does.
 *
 * The anchor edge is read from rects, which carry no rounding and move
 * with every ancestor's transform and zoom — as the slot does. A
 * sibling's own transform is taken back out: its computed matrix about
 * its transform origin, and its translate property, so a translateZ(0)
 * hint, a scroll-linked parallax or an entrance animation (on an
 * element or an inline svg) changes where the box is drawn, not where
 * the slot is. Not taken out: a sibling's rotate and scale properties,
 * and a sibling's own transform under a scaled ancestor, which scales
 * the move.
 *
 * While the target is in normal flow its own top is read, and what the
 * anchor and the margins between them (the sibling's bottom margin
 * collapsed with the target's top margin, or the target's top margin
 * below its parent's content top) do not explain is kept; while it is
 * stuck (and its own rect is a viewport coordinate) the anchor, the
 * margins and that remainder stand in for it. The anchor is found again
 * on every measure, so a sibling hidden at a breakpoint while the nav
 * is stuck hands over to the next anchor with the margins that apply
 * there. A target with no box of its own (display: none, for example at
 * a breakpoint) has no slot and does not stick until a measure finds
 * one. A display: contents target is measured through its first child
 * that draws a box. Limit: a first-child target whose top margin
 * collapses through its parent shifts the parent when it leaves the
 * flow; the stuck slot is then off by that margin until the target is
 * back in flow.
 *
 * Scheduling: one owned frame carries every measurement, the class
 * write and the announcement. Resize, the document's load and the first
 * scroll mark geometry dirty, and so does a box change of the target,
 * its parent or the root element where ResizeObserver exists: a target
 * revealed later (a class, [hidden], a tab panel shown) or content
 * growing above it re-measures with no resize. Content that moves the
 * slot without resizing any of those (inside a root fixed at the
 * viewport height, for one) waits for the next resize. A transition
 * marks the class dirty; the frame measures in its read phase, then
 * writes the class and announces in its write phase.
 *
 * Touch devices (paste.has) keep the baseline: fixed-position chrome
 * and the mini header make a sticky sub-navigation unsuitable there.
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/has
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/stickynav
 */
paste['define'](
    'paste.ui.stickynav',
    [
        'paste.dom',
        'paste.event',
        'paste.has',
        'paste.ui.utilities.animation-frame'
    ],
    function (stickynav, dom, event, has, animation_frame) {
        'use strict';

        var $w = window,
            $d = document,
            $max = Math.max,
            $min = Math.min,
            $parseFloat = parseFloat,
            $isNaN = isNaN,
            $String = String,
            $Infinity = Infinity,
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            boundsFromElement = dom['Bounds']['fromElement'],
            FIXED_NAV_CLASS = 'paste-fixed-subnav',
            WHOLE_NUMBER = /^[0-9]+$/,
            getScrollTop = dom['getScrollTop'],
            $stickyNav = dom['querySelector']('.sticky-nav-target'),
            $body,
            nav = null,
            // The page-lifetime listeners: kept, never disposed.
            subscriptions = [],
            Observer = $w['ResizeObserver'],
            observer = null,
            minWidth,
            windowWidth = 0,
            topOffset = 0,
            // What the anchor edge and the margin gap leave of the
            // target's in-flow top, measured rather than re-derived.
            slotRest = 0,
            // The target's top margin, as last read in normal flow.
            targetMargin = 0,
            // Whether the last in-flow measure found the target drawn:
            // one with no box has no slot to stick at.
            slotted = true,
            stuck = false,
            // Whether the class is on the page right now — the target's
            // own rect is a slot position only while it is not.
            classApplied = false,
            // The state the last announcement told listeners about.
            announced = false,
            firstScroll = true,
            framePending = false,
            geometryDirty = false,
            classDirty = false,
            // Assigned below: the frame, the transition and the
            // evaluation call one another.
            evaluate,

            // A whole number of pixels, or null for an absent or
            // malformed declaration — "0" is a value, not an absence.
            minWidthOf = function (element) {
                var text = element ? element.getAttribute('data-sticky-min-width') : null;
                return text !== null && WHOLE_NUMBER.test(text) ? Number(text) : null;
            },

            announce = function (name) {
                var announcement = new event['Event']($w, name);
                announcement['fire']($stickyNav);
                announcement['dispose']();
            },

            // Whether an element has a box in the normal flow: one with
            // no box, or one positioned out of the flow, has no document
            // position that stays put while the page scrolls.
            inFlow = function (element) {
                var style,
                    position;
                if (element.getClientRects().length === 0) {
                    return false;
                }
                style = $w.getComputedStyle(element);
                position = style['position'];
                return style['display'] !== 'contents' &&
                    position !== 'fixed' &&
                    position !== 'absolute' &&
                    position !== 'sticky';
            },

            // A computed length in pixels; absent or unparsable reads 0.
            pixels = function (text) {
                var value = $parseFloat(text);
                return $isNaN(value) ? 0 : value;
            },

            // How far an element's own transform moves the bottom of its
            // rect, in its own pixels: the computed matrix (projected
            // through its perspective terms) applied about the
            // transform origin to the border box's corners, plus the
            // translate property. Its ancestors' transforms move the
            // nav's slot as well, so they stay in the rect. Not undone:
            // the rotate and scale properties, and a transform under a
            // scaled ancestor, which scales the move.
            ownShift = function (element, style) {
                var matrix = style['transform'],
                    translate = style['translate'],
                    width = element.offsetWidth,
                    height = element.offsetHeight,
                    shift = 0,
                    values,
                    origin,
                    corner = 4,
                    x,
                    y,
                    w,
                    drawn,
                    lowest = -$Infinity;
                if (typeof height !== 'number') {
                    width = pixels(style['width']);
                    height = pixels(style['height']);
                }
                if (matrix && matrix !== 'none') {
                    values = matrix.slice(matrix.indexOf('(') + 1, -1).split(',');
                    origin = $String(style['transformOrigin'] || '').split(' ');
                    // matrix(a, b, c, d, e, f) or matrix3d's sixteen
                    // values, column by column.
                    values = values.length === 16 ?
                            [pixels(values[1]), pixels(values[5]), pixels(values[13]),
                                pixels(values[3]), pixels(values[7]), pixels(values[15])] :
                            [pixels(values[1]), pixels(values[3]), pixels(values[5]), 0, 0, 1];
                    while (corner--) {
                        x = (corner % 2 ? width : 0) - pixels(origin[0]);
                        y = (corner > 1 ? height : 0) - pixels(origin[1]);
                        w = values[3] * x + values[4] * y + values[5];
                        if (w <= 0) {
                            return 0;
                        }
                        drawn = (values[0] * x + values[1] * y + values[2]) / w + pixels(origin[1]);
                        if (drawn > lowest) {
                            lowest = drawn;
                        }
                    }
                    shift = lowest - height;
                }
                if (translate && translate !== 'none') {
                    translate = translate.split(' ')[1] || '';
                    shift += translate.charAt(translate.length - 1) === '%' ?
                            pixels(translate) * height / 100 : pixels(translate);
                }
                return shift;
            },

            // Whether a block's top margin collapses through it: a plain
            // block in the flow with no top border or padding that starts
            // no formatting context of its own.
            collapsesThrough = function (element, style) {
                var display = style['display'],
                    position = style['position'];
                return (display === 'block' || display === 'list-item') &&
                    element.clientTop === 0 && pixels(style['paddingTop']) === 0 &&
                    (style['overflowY'] || 'visible') === 'visible' &&
                    (style['float'] || 'none') === 'none' &&
                    position !== 'absolute' && position !== 'fixed';
            },

            // Two adjoining margins collapsed into one.
            collapsed = function (a, b) {
                return $max(a, b, 0) + $min(a, b, 0);
            },

            // The anchor edge and the margin gap between it and the
            // target, as [edge, gap]: the nearest in-flow previous
            // sibling's rect bottom less its own transform, else the
            // content top of the nearest ancestor that draws a box — a
            // display: contents parent has none. Rects carry no rounding
            // and follow the ancestors' transforms, which move the slot
            // too; neither the target's own flow state nor the scroll
            // offset moves the edge. The gap is what the margins put
            // between edge and target in normal flow: the sibling's
            // bottom margin collapsed with the target's top margin (both
            // whole in a flex or grid container), or the target's top
            // margin below a parent it does not collapse through. When
            // the anchor changes between measures (a sibling hidden at a
            // breakpoint while the nav is stuck), the gap changes with
            // it, so the slot stays where the flow puts the target.
            anchorEdge = function () {
                var previous = $stickyNav.previousElementSibling,
                    parent = $stickyNav.parentNode,
                    style,
                    display;
                while (previous) {
                    if (inFlow(previous)) {
                        style = $w.getComputedStyle(previous);
                        display = $w.getComputedStyle(parent)['display'] || '';
                        return [
                            previous.getBoundingClientRect().bottom + getScrollTop() - ownShift(previous, style),
                            display.indexOf('flex') >= 0 || display.indexOf('grid') >= 0 ?
                                    pixels(style['marginBottom']) + targetMargin :
                                    collapsed(pixels(style['marginBottom']), targetMargin)
                        ];
                    }
                    previous = previous.previousElementSibling;
                }
                while (parent !== $d.documentElement && parent.parentNode &&
                        $w.getComputedStyle(parent)['display'] === 'contents') {
                    parent = parent.parentNode;
                }
                style = $w.getComputedStyle(parent);
                return [
                    parent.getBoundingClientRect().top + getScrollTop() + (parent.clientTop || 0) +
                        pixels(style['paddingTop']),
                    collapsesThrough(parent, style) ? 0 : targetMargin
                ];
            },

            // The element that draws the target's slot: the target, or
            // for a display: contents target (which has no box) its first
            // child that has one; null when none is drawn.
            slotElement = function () {
                var child;
                if ($stickyNav.getClientRects().length !== 0) {
                    return $stickyNav;
                }
                if ($w.getComputedStyle($stickyNav)['display'] !== 'contents') {
                    return null;
                }
                child = $stickyNav.firstElementChild;
                while (child && child.getClientRects().length === 0) {
                    child = child.nextElementSibling;
                }
                return child;
            },

            // The in-flow target's own rect names the slot exactly; what
            // the anchor and the margin gap do not explain (inline
            // content, an engine's rounding) is kept and carried while
            // the target is stuck. The target's margin is read in flow
            // only: the stuck CSS may change it.
            calculateTopOffset = function () {
                var offset = nav ? boundsFromElement(nav)['height'] : 0,
                    slot = classApplied ? null : slotElement(),
                    anchor;
                if (!classApplied) {
                    slotted = !!slot;
                    if (slot) {
                        targetMargin = pixels($w.getComputedStyle(slot)['marginTop']);
                    }
                }
                anchor = anchorEdge();
                if (slot) {
                    slotRest = boundsFromElement(slot)['top'] - anchor[0] - anchor[1];
                }
                topOffset = anchor[0] + anchor[1] + slotRest - offset;
            },

            // One owned frame, armed as one phased request: geometry in
            // the read phase, so the class write that follows reflects
            // the newest threshold, and whatever the latest transition
            // decided is what the class becomes — a queued frame can
            // never add the class back over a nav that has since
            // unstuck. The pending mark holds through both phases, so a
            // transition decided inside the frame is written by it. The
            // announcement follows the write: listeners hear about the
            // class that is on the page, never about an intent.
            readFrame = function () {
                if (geometryDirty) {
                    geometryDirty = false;
                    windowWidth = dom['getViewportWidth']();
                    calculateTopOffset();
                    evaluate();
                }
            },
            writeFrame = function () {
                if (classDirty) {
                    classDirty = false;
                    if (stuck) {
                        $body.classList.add(FIXED_NAV_CLASS);
                    } else {
                        $body.classList.remove(FIXED_NAV_CLASS);
                    }
                    classApplied = stuck;
                }
                framePending = false;
                if (announced !== classApplied) {
                    announced = classApplied;
                    announce(announced ? 'navStuck' : 'navUnstuck');
                }
            },
            // The pending mark arms the frame once: every input until
            // the frame runs joins the pass already requested.
            requestPass = function () {
                if (framePending) {
                    return;
                }
                framePending = true;
                requestPhased(readFrame, writeFrame);
            },
            transition = function (nowStuck) {
                stuck = nowStuck;
                classDirty = true;
                requestPass();
            },

            // A resize burst pays for one recalibration: the input only
            // marks the need, and the armed frame measures and evaluates
            // once, on the latest inputs.
            markGeometry = function () {
                geometryDirty = true;
                requestPass();
            },

            scrollHandler = function () {
                // The define-time measure can predate late resources —
                // the first real scroll re-measures, inside the owned
                // frame rather than the scroll event, and evaluates
                // there on the corrected threshold.
                if (firstScroll) {
                    firstScroll = false;
                    markGeometry();
                    return;
                }
                evaluate();
            },

            init = function () {
                // clearing this cache just in case it gets cached with the page
                $body.classList.remove(FIXED_NAV_CLASS);

                subscriptions.push(new Subscription('scroll', $w, scrollHandler, null));
                subscriptions.push(new Subscription('resize', $w, markGeometry, null));

                // A target revealed later (a class, [hidden], a panel
                // shown) or content growing above it moves the slot with
                // no resize: a box change on the target, its parent or
                // the root element marks geometry dirty. A ResizeObserver
                // is no event target, so it is not a Subscription; like
                // the listeners it lives as long as the page.
                if (Observer) {
                    observer = new Observer(markGeometry);
                    observer['observe']($stickyNav);
                    if ($stickyNav.parentNode && $stickyNav.parentNode.nodeType === 1) {
                        observer['observe']($stickyNav.parentNode);
                    }
                    observer['observe']($d.documentElement);
                }

                // The define-time calibration is the measurement itself:
                // it runs now, so the threshold is honest before the
                // first scroll evaluates.
                windowWidth = dom['getViewportWidth']();
                calculateTopOffset();
                evaluate();

                // Late CSS, fonts or images can move the slot without a
                // resize, and the first-scroll recalibration has already
                // been spent once the user scrolled. One recalibration
                // after the document's own load corrects that; a module
                // defined after load already measured settled geometry.
                // Load fires once and the subscription retires with it.
                if ($d.readyState !== 'complete') {
                    subscriptions.push(new Subscription('load', $w, markGeometry, null, 1));
                }
            };

        evaluate = function () {
            var windowTop = getScrollTop();
            if (windowWidth <= minWidth || !slotted) {
                // At or below the minimum, or with no slot, the
                // enhancement is ineligible — and ineligibility is a
                // state: a nav that was stuck unsticks through the
                // same write and announcement.
                if (stuck) {
                    transition(false);
                }
                return;
            }
            if (windowTop >= topOffset && !stuck) {
                transition(true);
            } else if (windowTop < topOffset && stuck) {
                transition(false);
            }
        };

        if (!$stickyNav || has['touch']) {
            return stickynav;
        }

        $body = dom['getDocumentBody']();
        // The header the nav sticks beneath; without one it sticks at
        // the top of the viewport.
        nav = $d.getElementById('_paste_ui_nav_wrap');

        minWidth = minWidthOf($stickyNav);
        if (minWidth === null) {
            minWidth = minWidthOf(dom['querySelector']('.paste-ui-section-nav'));
        }
        if (minWidth === null) {
            minWidth = 0;
        }

        init();
        return stickynav;
    }
);
