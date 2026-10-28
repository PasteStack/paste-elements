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
 * Appends a class to an item when its corresponding element passes a
 * certain threshold. It was written for navs that need to be "turned
 * on" when their section has scrolled into view, offset by the nav's own
 * height. The "active" class is added to the parent of the link.
 *
 * Markup: a [data-paste-scrollspy] element, else .paste-ui-section-nav,
 * containing same-document links (a[href^="#"], disclosure toggles
 * excluded). Each link's fragment resolves by exact id; a link naming
 * nothing contributes no breakpoint.
 *
 * Options, on the nav element:
 *   data-spy-min-width — original decimal parseInt semantics: leading
 *                        whitespace and numeric prefixes are accepted.
 *                        At or below it the marker clears. No numeric
 *                        prefix means no minimum.
 *   data-spy-touch     — opts the nav in on touch devices; without it a
 *                        touch device keeps the baseline and the module
 *                        binds no scroll or resize listener at all.
 *
 * Scheduling: one owned phased frame carries every measurement and
 * every class write. A scroll marks the selection stale; a resize and
 * the document's load mark geometry stale. Where ResizeObserver exists,
 * size changes in the body, nav or linked sections do the same. The read phase takes the
 * viewport width (on geometry passes only — a scroll cannot change
 * it), the geometry and the scroll position; the write phase moves the
 * marker. Only the define-time selection runs outside a frame.
 *
 * While ineligible below the minimum width no frame is armed for
 * scrolling and no breakpoint is re-measured; a resize still arms one
 * frame to notice the width coming back. At the bottom of the page the
 * last section is active even if its top never reaches the threshold:
 * the page has scrolled (offset above 0), cannot scroll any further —
 * judged against the live scroll height and the root's clientHeight
 * (the viewport without a horizontal scrollbar), read at selection so a
 * document that grew since the last measure is not mistaken for its old
 * bottom — and the last section's top is inside the viewport.
 *
 * Links sharing one parent element light that parent while either
 * section is current; moving between them never clears it.
 *
 * Note: This module is not well-suited for determining when an element
 * is visible on the page (for purposes of lazy-loading, for example).
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/has
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/scrollspy
 */
paste['define'](
    'paste.ui.scrollspy',
    [
        'paste.dom',
        'paste.event',
        'paste.has',
        'paste.ui.utilities.animation-frame'
    ],
    function (scrollspy, dom, event, featuredetection, animation_frame) {
        'use strict';

        var $w = window,
            $d = document,
            $round = Math.round,
            root = dom['getDocumentBody'](),
            getScrollTop = dom['getScrollTop'],
            getScrollHeight = dom['getScrollHeight'],
            getViewportWidth = dom['getViewportWidth'],
            addCssClass = dom['addCssClass'],
            removeCssClass = dom['removeCssClass'],
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            boundsFromElement = dom['Bounds']['fromElement'],
            ACTIVE_CLASS = 'active',

            $parent = dom['querySelector']('[data-paste-scrollspy]') || dom['querySelector']('.paste-ui-section-nav'),
            scrollBreakpoints = $parent ? dom['get']('a[href^="#"]:not(.paste-ui-section-nav-toggle)', $parent) : null,
            minWidth = 0,
            minWidthText = $parent ? $parent.getAttribute('data-spy-min-width') : null,
            scrollTop = 0,
            windowWidth = 0,
            // data-spy-touch opts an individual nav into scrollspy on
            // touch devices; without it the device keeps the baseline.
            touchIneligible = !!featuredetection['touch'] && !($parent && $parent.hasAttribute('data-spy-touch')),
            breakpoints = [],
            groups = [],
            spyTargets = [],
            activeGroup = null,
            lastGroup = 0,
            navOffset = 0,
            framePending = false,
            geometryDirty = false,
            selectionDirty = false,
            // The read phase's selection, carried to the same frame's
            // write phase: passWrite says whether there is one.
            passWrite = false,
            passGroup = -1,

            // The page-lifetime listeners: kept, never disposed.
            subscriptions = [],

            widthEligible = function () {
                return windowWidth > minWidth;
            },

            clearActiveGroup = function () {
                if (activeGroup !== null) {
                    removeCssClass(groups[activeGroup], ACTIVE_CLASS);
                    activeGroup = null;
                }
            },

            // The previous marker leaves before the next one lands, and a
            // parent shared by both links keeps its class untouched.
            setActiveGroup = function (index) {
                var next;
                if (index === activeGroup) {
                    return;
                }
                if (index === -1) {
                    // above the first breakpoint
                    clearActiveGroup();
                    return;
                }
                next = groups[index];
                if (activeGroup !== null && groups[activeGroup] !== next) {
                    removeCssClass(groups[activeGroup], ACTIVE_CLASS);
                    addCssClass(next, ACTIVE_CLASS);
                } else if (activeGroup === null) {
                    addCssClass(next, ACTIVE_CLASS);
                }
                activeGroup = index;
            },

            // A hash resolves by exact id, never by selector — an id
            // containing a dot or colon is still one id, and a
            // percent-encoded fragment resolves the way the browser's
            // own fragment navigation does. An unresolvable target is
            // dead markup: no breakpoint, no crash.
            resolveSpyTarget = function (hash) {
                var id, decoded;
                if (!hash || hash.length < 2) {
                    return null;
                }
                id = dom['stripIdHash'](hash);
                try {
                    decoded = decodeURIComponent(id);
                } catch (malformed) {
                    decoded = id;
                }
                return dom['get'](id) || (decoded !== id ? dom['get'](decoded) : null);
            },

            // The bottom rule reads the document's live extent: a page that
            // grew since the last measure has a new bottom.
            atBottom = function () {
                var viewport;
                if (!(scrollTop > 0)) {
                    return false;
                }
                viewport = root.clientHeight;
                return breakpoints[lastGroup].start < scrollTop + viewport &&
                    scrollTop >= getScrollHeight() - viewport - 1;
            },

            findGroup = function () {
                var remaining,
                    index,
                    breakpoint;
                // Don't highlight anything above the first breakpoint.
                if (scrollTop < breakpoints[0].start - navOffset) {
                    return -1;
                }
                // Highlight the last element beyond its breakpoint — a
                // stored comparison, answered before the bottom rule's
                // layout reads.
                if (scrollTop > breakpoints[lastGroup].start) {
                    return lastGroup;
                }
                // At the bottom of the page the last section is the one
                // being read, even when it is too short for its top to
                // ever reach the threshold.
                if (atBottom()) {
                    return lastGroup;
                }
                // First match wins, so the countdown walks forward.
                remaining = lastGroup + 1;
                index = 0;
                while (remaining--) {
                    breakpoint = breakpoints[index];
                    if (scrollTop >= breakpoint.start - navOffset &&
                            (breakpoint.end === false || scrollTop < breakpoint.end - navOffset)) {
                        return index;
                    }
                    index += 1;
                }
                return -1;
            },

            // The selection's reads: the position, then the group it
            // falls in.
            locate = function () {
                scrollTop = getScrollTop();
                return findGroup();
            },

            select = function () {
                setActiveGroup(locate());
            },

            // Each target pays one geometry read — a section's start is
            // its successor's predecessor, so one reverse walk measures
            // every top once and answers both ends. Breakpoint records
            // are reused across measures.
            calculateBreakpoints = function () {
                var index = spyTargets.length,
                    nextTop = false,
                    top,
                    breakpoint;
                while (index--) {
                    top = $round(boundsFromElement(spyTargets[index]).top);
                    breakpoint = breakpoints[index];
                    if (!breakpoint) {
                        breakpoint = breakpoints[index] = {start: 0, end: false};
                    }
                    breakpoint.start = top;
                    breakpoint.end = nextTop;
                    nextTop = top;
                }
            },

            measureGeometry = function () {
                navOffset = boundsFromElement($parent).height;
                // Section positions are document coordinates — a reflow
                // invalidates every stored breakpoint.
                calculateBreakpoints();
            },

            measure = function () {
                measureGeometry();
                select();
            },

            // Scroll, resize and load share one owned frame, armed as
            // one phased request: a burst of any of them coalesces into
            // one pass on the latest position. The width is read only
            // when geometry is stale; below the minimum width the pass
            // clears the marker and measures nothing, and the dirty
            // geometry waits for the width to come back.
            readPass = function () {
                framePending = false;
                if (geometryDirty) {
                    windowWidth = getViewportWidth();
                }
                if (!widthEligible()) {
                    selectionDirty = false;
                    passWrite = true;
                    passGroup = -1;
                    return;
                }
                if (geometryDirty) {
                    geometryDirty = false;
                    selectionDirty = false;
                    measureGeometry();
                    passWrite = true;
                    passGroup = locate();
                } else if (selectionDirty) {
                    selectionDirty = false;
                    passWrite = true;
                    passGroup = locate();
                }
            },
            writePass = function () {
                if (passWrite) {
                    passWrite = false;
                    setActiveGroup(passGroup);
                }
            },
            // The pending mark arms the frame once: every input until
            // the frame runs joins the pass already requested.
            schedulePass = function () {
                if (framePending) {
                    return;
                }
                framePending = true;
                requestPhased(readPass, writePass);
            },
            scrollHandler = function () {
                // Ineligible by width: nothing a scroll could change.
                if (!widthEligible()) {
                    return;
                }
                selectionDirty = true;
                schedulePass();
            },
            // Resize and load: the geometry and the width are stale.
            markGeometry = function () {
                geometryDirty = true;
                schedulePass();
            },

            init = function () {
                var index = 0,
                    remaining = scrollBreakpoints ? scrollBreakpoints.length : 0,
                    link,
                    target,
                    observer;
                if (!remaining || touchIneligible) {
                    return;
                }
                minWidth = parseInt(minWidthText, 10) || 0;

                // Resolve each link's target once — links naming nothing
                // contribute no breakpoint. The link list is released
                // after.
                while (remaining--) {
                    link = scrollBreakpoints[index];
                    target = resolveSpyTarget(link.hash);
                    if (target) {
                        spyTargets.push(target);
                        groups.push(link.parentElement);
                    }
                    index += 1;
                }
                scrollBreakpoints = null;
                if (!spyTargets.length) {
                    return;
                }
                lastGroup = groups.length - 1;
                windowWidth = getViewportWidth();

                subscriptions.push(new Subscription('scroll', $w, scrollHandler, null));
                subscriptions.push(new Subscription('resize', $w, markGeometry, null));

                // The first selection answers the position the page
                // opened at — immediate, not deferred to a frame.
                if (widthEligible()) {
                    measure();
                } else {
                    geometryDirty = true;
                }

                // Late resources — images without dimensions, web fonts —
                // move section tops without firing resize or scroll, and
                // the scroll path only selects against stored
                // breakpoints, so without one re-measure after load the
                // marker would follow stale geometry until the next
                // resize. Load fires once and the subscription retires
                // with it; a module defined after load measured settled
                // geometry already.
                if ($d.readyState !== 'complete') {
                    subscriptions.push(new Subscription('load', $w, markGeometry, null, 1));
                }
                // Content can resize after load without any window input.
                // Observe the declared geometry, and coalesce its reports
                // through the existing pass; scrolling still uses the cache.
                if ($w.ResizeObserver) {
                    try {
                        observer = new $w.ResizeObserver(markGeometry);
                        observer.observe($d.body);
                        observer.observe($parent);
                        index = spyTargets.length;
                        while (index--) {
                            observer.observe(spyTargets[index]);
                        }
                    } catch (ignore) {
                        // Window resize and load remain the fallback.
                    }
                }
            };

        init();
        return scrollspy;
    }
);
