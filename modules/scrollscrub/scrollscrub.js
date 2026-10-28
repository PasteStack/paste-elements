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
 * Scrub a declared scroll relationship into a CSS progress value.
 *
 * 1. One sweep at define time: every element carrying
 *    'data-paste-scrollscrub' declares a scope — its own
 *    'data-scrub-*' attributes say which root scrolls, which subject is
 *    measured, and which anchor pair marks progress 0 and 1.
 * 2. A measure locates each scope's endpoints in its root's scroll
 *    space; the root's own scroll moves only the offset against them.
 *    Each distinct root owns one scroll subscription, and its signal
 *    re-reads only that root's offset for its scopes — no layout. What
 *    can move the endpoints themselves re-measures: window resize is one
 *    shared subscription for every scope — a viewport change moves
 *    subjects inside nested roots without changing any element's box —
 *    and a shared visibilitychange re-measures on return since a hidden
 *    page's layout can move unreported. The page's own scroll moves a
 *    nested root and its subjects together, so it re-measures nothing.
 *    Subjects and element roots are
 *    ResizeObserver-watched so geometry changes that never scroll
 *    still re-measure. Each root also watches the boxes that grow with
 *    its scrollable content (scrollrange's resolved.content): an element
 *    root's element children, or for the viewport root the root
 *    element, the body and the body's element children. Content growing
 *    there — which moves a subject, changes a scrollable span, or makes
 *    a nested root that could not scroll at bind scrollable — resizes
 *    none of the subject, the root or the window, yet one of those
 *    boxes reports it, even under html { height: 100% }. A child added
 *    to or removed from the root — the body, for the viewport root —
 *    invalidates the root's ranges and refreshes its watched content
 *    boxes. In element mode each subject also watches its own path
 *    below that level: the element children of every ancestor between
 *    the subject and the root (the body), and those ancestors' child
 *    lists. A box on that path whose size is fixed — a wrapper under
 *    #app { height: 100% } — reports nothing when content inside it
 *    grows, yet the subject after that content moves: the path's
 *    children resize, or its child lists change, and the scope
 *    re-measures. A change off a subject's path moves the subject only
 *    by resizing a box that is watched, so text and markup churn
 *    elsewhere on the page costs no re-measure. A container range has
 *    no subject path: content changing inside a fixed-size box below
 *    its root's children, which only overflow carries into the
 *    scrollable span, re-measures at the next resize or return to the
 *    page, or at the document's load while that is still to come.
 *    Ordinary scrolling still reads only the offset.
 * 3. A single phased animation-frame pass reads every marked scope in
 *    the frame's read phase — a full measure where the endpoints may
 *    have moved, the root offset alone where only the root scrolled —
 *    and writes '--paste-scrub-progress' on the scope element in its
 *    write phase, only when the value actually moved. What the progress
 *    means is the page's own CSS.
 * 4. A degenerate or unmeasurable range restores the authored inline
 *    value and priority while it still owns the declaration; a newer
 *    writer is preserved. With no authored value, our declaration is
 *    removed.
 *    Bind schedules the first pass without waiting for the first scroll.
 *
 * A subject is measured by its box: one that is itself fixed or sticky
 * keeps the endpoints of its box at the last measure while its root —
 * or, for a nested root, the page — scrolls.
 *
 * Authoring
 *
 * Load 'paste.ui.scrollscrub' through the ordinary Paste
 * include — Paste loads at the end of the page, so the markup is
 * already there and discovery runs at define time. There is no
 * controller to construct, no readiness to await, and no JavaScript a
 * page author writes at all.
 *
 * @example
 *     <!-- element mode: the section's own traverse through the page
 *          viewport drives a descendant's authored effect. The page
 *          around it must actually scroll: authored content above and
 *          below carries the section's top from the viewport's bottom
 *          to its bottom from the viewport's top -->
 *     <div class="filler-top">…enough authored content to scroll…</div>
 *     <section id="gallery"
 *              data-paste-scrollscrub
 *              data-scrub-start="top bottom"
 *              data-scrub-end="bottom top">
 *       <h2>How the product opens</h2>
 *       <div class="gallery-detail">
 *         This authored element moves as the section passes through
 *         the viewport.
 *       </div>
 *     </section>
 *     <div class="filler-bottom">…and content below it…</div>
 *
 *     <style>
 *     .filler-top, .filler-bottom { height: 120vh; }
 *     .gallery-detail {
 *       transform: translateX(calc(var(--paste-scrub-progress, 0) * 3rem));
 *     }
 *     @media (prefers-reduced-motion: reduce) {
 *       .gallery-detail { transform: none; }
 *     }
 *     </style>
 *
 * The fallback argument is the authored rest state: before the module
 * writes the property, and again if a degenerate range removes it, the
 * declaration above reads var(..., 0) and holds still.
 *
 * @example
 *     <!-- element mode inside a nested scroller; the fractional window
 *          narrows the change to the middle half of the traverse -->
 *     <div id="panel-scroller" class="scroller">
 *       <section data-paste-scrollscrub
 *                data-scrub-root="#panel-scroller"
 *                data-scrub-window="0.25 0.75">
 *         <div class="panel-flag"></div>
 *         <p>Authored content that fills the scroller so the section's
 *            traverse through it is a real scroll range.</p>
 *       </section>
 *       <p class="scroller-filler">…more authored panels…</p>
 *     </div>
 *
 *     <style>
 *     .scroller { height: 18rem; overflow-y: auto; }
 *     .scroller-filler { height: 30rem; }
 *     .panel-flag { opacity: var(--paste-scrub-progress, 0); }
 *     </style>
 *
 * Container mode measures the root's own scroll fraction instead — no
 * subject is resolved at all, and subject/start/end declarations do
 * not apply.
 *
 * @example
 *     <!-- container mode: the root's own 0..1 scroll fraction, no
 *          subject measured — the window still applies -->
 *     <div id="preview-scroller" class="scroller">
 *       <div data-paste-scrollscrub
 *            data-scrub-mode="container"
 *            data-scrub-root="#preview-scroller">
 *         <div class="meter"></div>
 *       </div>
 *       <div class="scroller-filler">…previews tall enough to scroll…</div>
 *     </div>
 *
 *     <style>
 *     .scroller { height: 18rem; overflow-y: auto; }
 *     .scroller-filler { height: 30rem; }
 *     .meter {
 *       transform: scaleX(var(--paste-scrub-progress, 0));
 *       transform-origin: left center;
 *     }
 *     </style>
 *
 * Attributes, all on the scope element:
 *
 *   data-paste-scrollscrub — required; presence opts in.
 *   data-scrub-mode    — 'element' (default) measures a subject
 *                        through a root's viewport; 'container' measures
 *                        the root's own scrollable span and ignores
 *                        subject/start/end.
 *   data-scrub-root    — 'viewport' (default) or a selector resolving
 *                        to exactly one scrolling element. A selector
 *                        naming the document's own scroller ('html',
 *                        document.scrollingElement, or a quirks-mode
 *                        body) is the viewport root.
 *   data-scrub-subject — element mode only: a selector for one stable
 *                        element inside the root; the scope itself by
 *                        default.
 *   data-scrub-start   — 'top bottom' default. The subject anchor and
 *   data-scrub-end       the root-viewport anchor whose coincidence is
 *                        progress 0 and 1; 'bottom top' by default.
 *                        Each anchor is top, center, or bottom.
 *   data-scrub-window  — '0 1' default. Two plain decimal fractions,
 *                        0 <= a < b <= 1 (no hexadecimal, exponent or
 *                        signed spellings),
 *                        selecting the portion of the range the change
 *                        occupies; before a it holds its start, after b
 *                        its end.
 *
 * JavaScript owns exactly one write: the number between 0 and 1 on the
 * scope's '--paste-scrub-progress'. When the range cannot measure, the
 * authored inline value and priority return while our write is still
 * present; a newer writer is preserved. Everything the value does
 * remains the page's CSS — which descendants read it, the effect they run, the fallback
 * while the property is absent, and the reduced-motion override.
 * Scrolling itself stays native; the module moves no scroll position
 * and changes no layout.
 *
 * Before JavaScript — or when a declaration is invalid or its selectors
 * unresolved — the authored document is the whole experience: effects
 * written against the var() fallback simply hold their authored rest
 * state.
 *
 * Failure behavior: a malformed scope — an invalid data-scrub-*
 * attribute, or a selector that does not resolve to exactly one element
 * — keeps its authored baseline and is reported once, at bind, as a
 * descriptive TypeError rethrown asynchronously from a timer captured
 * when the module defines. The page's error reporting sees it; nothing
 * is written to the console, and no other scope is affected. Page or
 * platform code that throws while a scope binds leaves that scope as
 * authored without a report.
 *
 * Composition: imagesequence measures this same declaration through
 * 'paste.ui.utilities.scrollrange' directly, so a sequence
 * never needs this module loaded. Load scrollscrub only when CSS-owned
 * descendants also want the progress value — it is a styling output,
 * not a channel other JavaScript should poll.
 *
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/scrollrange
 * @module paste/ui/scrollscrub
 */
paste['define'](
    'paste.ui.scrollscrub',
    ['paste.event', 'paste.ui.utilities.animation-frame', 'paste.ui.utilities.scrollrange'],
    function (scrollscrub, event, animation_frame, scrollrange) {
        'use strict';

        // Platform constructors and the report timer are captured once:
        // a page script replacing a global later cannot change which
        // facility the module uses.
        var $w = window,
            $d = document,
            NativeResizeObserver = $w['ResizeObserver'],
            NativeMutationObserver = $w['MutationObserver'],
            NativeWeakMap = $w['WeakMap'],
            $setTimeout = $w['setTimeout'],
            $String = String,
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            measureRange = scrollrange['measure'],
            progressFrom = scrollrange['progressFrom'],
            readRange = scrollrange['read'],
            contentOf = scrollrange['contentOf'],
            marker = 'data-paste-scrollscrub',
            CHILD_LIST = {childList: true},
            property = '--paste-scrub-progress',
            scopes = [],
            roots = [],
            // Listeners live as long as the page: the handles are kept
            // here and never torn down.
            listeners = [],
            // One ResizeObserver for the whole module: observed carries
            // each watched target's record — the scopes whose subject it
            // is and the roots whose box or content it is — keyed
            // privately so one observer entry finds its record in one
            // probe and dirties exactly the declarations whose geometry
            // moved. A hostile or absent facility leaves observerFailed
            // set and the scroll/resize inputs carrying the feature
            // alone.
            observed = null,
            observer = null,
            observerFailed = false,
            framePending = false,

            // A malformed declaration is reported once, off the bind
            // path: the error surfaces through the page's own error
            // reporting and the define sweep continues.
            report = function (element, problem) {
                var error = new TypeError('paste.ui.scrollscrub ' +
                        (element.id ? '#' + element.id : $String(element.tagName).toLowerCase()) +
                        ': ' + (problem && problem['message'] ? problem['message'] : $String(problem)));
                if (typeof $setTimeout !== 'function') {
                    return;
                }
                try {
                    $setTimeout(function () {
                        throw error;
                    }, 0);
                } catch (ignore) {
                    // A refused timer loses the report, never the sweep.
                }
            },

            // The one frame pass, armed as one phased request. Its read
            // phase runs before any module writes in the batch: a scope
            // whose endpoints may have moved is measured afresh, one
            // whose root merely scrolled reads that offset against the
            // endpoints it holds, and the progress parks on the scope
            // itself rather than a per-pass readings list.
            readFrame = function () {
                var index,
                    scope;
                framePending = false;
                index = scopes.length;
                while (index--) {
                    scope = scopes[index];
                    if (scope.stale) {
                        scope.stale = false;
                        scope.moved = false;
                        scope.located = measureRange(scope.range, scope.located);
                        scope.progress = scope.located.progress;
                        scope.pending = true;
                    } else if (scope.moved) {
                        scope.moved = false;
                        scope.progress = progressFrom(scope.range, scope.located);
                        scope.pending = true;
                    }
                }
            },

            // The write phase runs after every module's reads: a
            // property write can restyle the geometry a later read
            // relies on, so no read follows it in the same frame.
            writeFrame = function () {
                var index,
                    scope,
                    progress,
                    style;
                index = scopes.length;
                while (index--) {
                    scope = scopes[index];
                    if (scope.pending) {
                        scope.pending = false;
                        progress = scope.progress;
                        style = scope.element.style;
                        if (progress === null) {
                            if (scope.written) {
                                if (style.getPropertyValue(property) === $String(scope.last) &&
                                        style.getPropertyPriority(property) === '') {
                                    if (scope.authoredValue === '') {
                                        style.removeProperty(property);
                                    } else {
                                        style.setProperty(property, scope.authoredValue, scope.authoredPriority);
                                    }
                                }
                                scope.written = false;
                            }
                            // Withdrawing the property forgets the
                            // value too — an identical recovered
                            // progress is still a new write, never
                            // "unchanged".
                            scope.last = null;
                        } else if (progress !== scope.last) {
                            if (!scope.written) {
                                scope.authoredValue = style.getPropertyValue(property);
                                scope.authoredPriority = style.getPropertyPriority(property);
                            }
                            scope.last = progress;
                            scope.written = true;
                            // Clear an important custom property before
                            // writing: WebKit otherwise retains it.
                            if (style.getPropertyPriority(property)) {
                                style.removeProperty(property);
                            }
                            style.setProperty(property, $String(progress), '');
                        }
                    }
                }
            },

            // Inputs share one native asynchronous frame.
            schedule = function () {
                if (!framePending) {
                    framePending = true;
                    requestPhased(readFrame, writeFrame);
                }
            },

            // The root scrolled: only the offset moved.
            followScroll = function (members) {
                var index = members.length;
                while (index--) {
                    members[index].moved = true;
                }
                schedule();
            },

            // Layout may have moved the endpoints: measure afresh.
            invalidate = function (members) {
                var index = members.length;
                while (index--) {
                    members[index].stale = true;
                }
            },

            invalidateAll = function () {
                invalidate(scopes);
                schedule();
            },

            // Native ResizeObserver entries identify the affected
            // declarations. A stale entry for an unobserved box is inert.
            observerDelivered = function (entries) {
                var entryIndex = entries.length,
                    entryRecord,
                    entryRoots,
                    rootIndex,
                    dirty = false;
                while (entryIndex--) {
                    entryRecord = observed.get(entries[entryIndex].target);
                    if (entryRecord) {
                        dirty = true;
                        invalidate(entryRecord.scopes);
                        entryRoots = entryRecord.roots;
                        rootIndex = entryRoots.length;
                        while (rootIndex--) {
                            invalidate(entryRoots[rootIndex].scopes);
                        }
                    }
                }
                if (dirty) {
                    schedule();
                }
            },

            // A watched box is shared state, not per-scope ownership:
            // one record per target carries every scope whose subject or
            // subject path it is and every root whose box or content it
            // is. member is a scope or a root record; list says which.
            observeTarget = function (target, member, list) {
                var index,
                    record,
                    members;
                if (!target || observerFailed) {
                    return;
                }
                if (!observer) {
                    if (typeof NativeResizeObserver !== 'function' || typeof NativeWeakMap !== 'function') {
                        observerFailed = true;
                        return;
                    }
                    // The private index and the observer stand or fall
                    // together: a hostile constructor for either leaves
                    // the scroll and resize inputs in charge.
                    try {
                        observed = new NativeWeakMap();
                        observer = new NativeResizeObserver(observerDelivered);
                    } catch (error) {
                        observed = null;
                        observer = null;
                        observerFailed = true;
                        return;
                    }
                }
                record = observed.get(target);
                if (!record) {
                    // A host that refuses one particular target does not
                    // retire coverage for every other declaration — this
                    // scope falls back to its scroll and window inputs.
                    try {
                        observer.observe(target);
                    } catch (refused) {
                        return;
                    }
                    record = {scopes: [], roots: []};
                    observed.set(target, record);
                }
                members = record[list];
                index = members.length;
                while (index--) {
                    if (members[index] === member) {
                        return;
                    }
                }
                members.push(member);
            },

            // A box one member no longer covers leaves that member's
            // record, and stays observed while any other root or scope
            // still needs it.
            releaseTarget = function (target, member, list) {
                var entry = observed ? observed.get(target) : null,
                    members,
                    owner;
                if (!entry) {
                    return;
                }
                members = entry[list];
                owner = members.indexOf(member);
                if (owner >= 0) {
                    members.splice(owner, 1);
                }
                if (!entry.roots.length && !entry.scopes.length) {
                    observer.unobserve(target);
                    observed.delete(target);
                }
            },

            // Refresh content coverage after a DOM change. Removed boxes
            // lose this root's ownership, but remain observed if another
            // root or a bound subject still needs them.
            refreshContent = function (record) {
                var content = contentOf(record.root),
                    index = record.content.length,
                    target;
                while (index--) {
                    target = record.content[index];
                    if (content.indexOf(target) < 0) {
                        releaseTarget(target, record, 'roots');
                    }
                }
                record.content = content;
                index = content.length;
                while (index--) {
                    observeTarget(content[index], record, 'roots');
                }
            },

            // The ancestors strictly between an element-mode subject and
            // the level its root's content list already covers — the
            // root itself, or the body for the viewport root. Empty for
            // a subject that is a direct child there.
            pathOf = function (subject, root) {
                var stop = root || $d.body,
                    path = [],
                    parent;
                if (!stop || !subject || subject === stop || !stop.contains(subject)) {
                    return path;
                }
                parent = subject.parentNode;
                while (parent && parent !== stop && parent.nodeType === 1) {
                    path.push(parent);
                    parent = parent.parentNode;
                }
                return path;
            },

            // Path coverage after bind or a child-list change on the
            // path: every element child of every path ancestor is
            // watched for this scope; a child that left releases this
            // scope's claim. The subject keeps its own claim.
            refreshPath = function (scope) {
                var path = scope.path,
                    subject = scope.range.resolved.subject,
                    previous = scope.pathContent,
                    content = [],
                    index = path.length,
                    children,
                    childIndex,
                    target;
                while (index--) {
                    children = path[index].children;
                    childIndex = children ? children.length : 0;
                    while (childIndex--) {
                        content.push(children[childIndex]);
                    }
                }
                index = previous.length;
                while (index--) {
                    target = previous[index];
                    if (target !== subject && content.indexOf(target) < 0) {
                        releaseTarget(target, scope, 'scopes');
                    }
                }
                scope.pathContent = content;
                index = content.length;
                while (index--) {
                    observeTarget(content[index], scope, 'scopes');
                }
            },

            // One child-list observer per scope over its path ancestors:
            // a child added or removed there re-measures the scope, and
            // the coverage follows the new children.
            watchPath = function (scope) {
                var path = scope.path,
                    index = path.length;
                if (!index) {
                    return;
                }
                refreshPath(scope);
                if (typeof NativeMutationObserver !== 'function') {
                    return;
                }
                try {
                    scope.mutations = new NativeMutationObserver(function () {
                        scope.stale = true;
                        schedule();
                        // The re-measure is armed first, as for a root.
                        try {
                            refreshPath(scope);
                        } catch (ignore) {
                            // The resize and visibility inputs remain.
                        }
                    });
                    while (index--) {
                        scope.mutations.observe(path[index], CHILD_LIST);
                    }
                } catch (ignore) {
                    // Path insertions go unheard; path resizes still
                    // re-measure.
                }
            },

            // One record per distinct resolved root: window (null) or an
            // element scroller. The record keeps its own scope list, so
            // a root's scroll signal — and a resize of its box or its
            // content — marks only the scopes it actually carries
            // rather than searching every declared scope. Its watched
            // child-list observer — direct children only, the list
            // resolved.content was taken from — invalidates geometry
            // without adding a layout read to ordinary scroll frames.
            // Attribute writes, the progress property among them,
            // cannot feed it back.
            rootRecord = function (resolved) {
                var root = resolved.root,
                    index = roots.length,
                    content,
                    record;
                while (index--) {
                    if (roots[index].root === root) {
                        return roots[index];
                    }
                }
                record = {root: root, scopes: [], content: resolved.content, mutations: null};
                listeners.push(new Subscription('scroll', root || $w, function () {
                    followScroll(record.scopes);
                }));
                roots.push(record);
                observeTarget(root, record, 'roots');
                content = resolved.content;
                index = content.length;
                while (index--) {
                    observeTarget(content[index], record, 'roots');
                }
                if (typeof NativeMutationObserver === 'function') {
                    try {
                        record.mutations = new NativeMutationObserver(function () {
                            invalidate(record.scopes);
                            schedule();
                            // The re-measure is armed first: a host that
                            // refuses a watch change costs only the
                            // coverage of the new boxes.
                            try {
                                refreshContent(record);
                            } catch (ignore) {
                                // The scroll, resize and visibility
                                // inputs still re-measure this root.
                            }
                        });
                        record.mutations.observe(root || $d.body || $d.documentElement,
                            CHILD_LIST);
                    } catch (unavailable) {
                        record.mutations = null;
                    }
                }
                return record;
            },

            bind = function (element) {
                var range,
                    resolved,
                    scope;
                try {
                    range = readRange(element);
                } catch (invalid) {
                    // A malformed scope is inert markup: the authored
                    // var(--paste-scrub-progress, 0) default keeps the
                    // page exactly as designed without the module. The
                    // declaration grammar refuses with a TypeError;
                    // anything else comes from page or platform code,
                    // not the author's markup, and goes unreported.
                    if (invalid && invalid['name'] === 'TypeError') {
                        report(element, invalid);
                    }
                    return;
                }
                resolved = range.resolved;
                if (resolved.error) {
                    report(element, resolved.error);
                    return;
                }
                scope = {
                    element: element,
                    range: range,
                    stale: true,
                    moved: false,
                    located: null,
                    progress: null,
                    pending: false,
                    written: false,
                    authoredValue: '',
                    authoredPriority: '',
                    last: null,
                    path: range.options.mode === 'container' ? [] : pathOf(resolved.subject, resolved.root),
                    pathContent: [],
                    mutations: null
                };
                rootRecord(resolved).scopes.push(scope);
                scopes.push(scope);
                observeTarget(resolved.subject, scope, 'scopes');
                watchPath(scope);
                schedule();
            },

            // Declaration order is the bind order. Page or platform code
            // that throws anywhere in one scope's bind leaves that scope as
            // authored and never costs a later declaration its binding.
            bindAll = function () {
                var declared = $d.querySelectorAll('[' + marker + ']'),
                    remaining = declared.length,
                    index = 0;
                while (remaining--) {
                    try {
                        bind(declared[index]);
                    } catch (ignore) {
                        // This scope keeps its authored rest state.
                    }
                    index += 1;
                }
            };

        // Declaration binding is this module's own: the markup that
        // exists at define time is the contract — paste loads at the end
        // of the page, so every declared scope is already there.
        bindAll();

        // Shared inputs live once for all scopes: window resize moves
        // subjects in every root — including element scrollers an
        // element listener would never see — and a hidden page's layout
        // can move unreported, so every scope re-measures on return.
        // ResizeObserver keeps the element-size cases; no declared
        // scope, no shared input listeners at all.
        if (scopes.length) {
            listeners.push(new Subscription('resize', $w, invalidateAll));
            listeners.push(new Subscription('visibilitychange', $d, function () {
                if (!$d.hidden) {
                    invalidateAll();
                }
            }));
            // ResizeObserver reports sizes, not positions: a resource
            // finishing after discovery inside a box whose own size is
            // fixed — an image or a web font above the subject in a
            // fixed-height or overflow-clipped ancestor — moves the
            // subject while no watched box changes size, and no resize
            // or scroll event carries the shift either. So the observer
            // working is no reason to skip this pass. When activation
            // ran before the document's own load, one more pass
            // re-measures every scope as it stands then; activation
            // after load needs none — the first scheduled pass already
            // measured final geometry. Load fires once; the
            // subscription retires with it.
            if ($d.readyState !== 'complete') {
                listeners.push(new Subscription('load', $w, invalidateAll, null, 1));
            }
        }

        return scrollscrub;
    }
);
