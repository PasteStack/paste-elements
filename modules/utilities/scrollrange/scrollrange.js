/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * The scroll relationship a declared scrub describes, reduced to one
 * geometry pass. Internal to the elements: scrollscrub publishes its
 * result as a CSS custom property and imagesequence maps it to a frame —
 * neither re-derives anchors, roots or coordinate systems for itself.
 *
 * Element mode: a start and an end are each a pair of anchors — the
 * subject edge and the root's viewport edge whose coincidence marks the
 * endpoint. 'top bottom' means the subject's top reaches the viewport's
 * bottom; 'bottom top' means its bottom reaches the viewport's top.
 * Progress is clamp((scrollOffset - S) / (E - S), 0, 1) in the root's own
 * scroll coordinate system, so nested scrollers measure correctly.
 *
 * Container mode: the root's own scroll fraction,
 * scrollOffset / (scrollable height - viewport height), clamped to 0..1.
 *
 * The document scroller is one root however it is named: a
 * data-scrub-root selector resolving to the root element, to
 * document.scrollingElement, or to the body of a quirks-mode document
 * normalizes to the viewport root (resolved.root === null). Its scroll
 * offset is the window's, its viewport height and scrollable height are
 * read from the document's scrolling element — the root element in
 * standards mode, the body in quirks mode — so neither mode measures
 * the document's own height as if it were the viewport.
 *
 * read(scope) validates the scope's data-scrub-* attributes, resolves
 * its selectors once, and returns {options, resolved}: options carries
 * mode, root, subject, start, end and window; resolved carries the
 * resolved root and subject elements, or an 'error' for a selector
 * that did not resolve to exactly one element, or for an element-mode
 * subject that is not inside its element root — the root itself
 * included, since a root's own box never moves through its own scroll.
 * An attribute parse failure throws — the declaration is invalid, not
 * merely unresolved.
 *
 * resolved.content lists the boxes that grow with the root's scrollable
 * content, taken at read time: an element root's element children, or
 * for the viewport root the root element, the body and the body's
 * element children. Content growth changes a root's scrollable span —
 * and moves subjects below it — without resizing the root, the subject
 * or the window, so neither a scroll nor a resize reports it. An owner
 * that observes these boxes (ResizeObserver) re-measures when it
 * happens, including a nested root that could not scroll at bind and
 * becomes scrollable later. Children added after the read are not in
 * the list.
 * data-scrub-window accepts plain decimal fractions only: hexadecimal,
 * binary, exponent and signed spellings are invalid declarations.
 *
 * measure(range) reads the current geometry and returns {progress, near,
 * offset, start, end}. progress is the clamped 0..1 position through
 * the declared range with data-scrub-window applied — or null when the
 * range cannot currently produce a number (element anchors coincide and collapse to
 * a point; a container with no scrollable span; an element root that
 * cannot scroll at all — no overflow, or a computed overflow-y of
 * visible or clip, as a standards-mode body named as the root has; a
 * standards-mode body whose overflow the viewport takes over, as it
 * does from the body whenever the root element's overflow is visible;
 * a subject or root that is not rendered). near
 * reports whether the scene is within one viewport-height of being
 * seen, so a consumer can defer expensive work until it is approaching:
 * in element mode the subject must sit within one root-viewport of the
 * root's visible span; a nested (element) root must in addition have
 * its own box within one page-viewport of the page viewport, in both
 * modes — a scene inside a scroller far down the page is not near
 * however its own scroll stands. A consumer whose root is nested
 * therefore re-measures on window scroll as well as on the root's own.
 * offset is the root scroll offset this same read used, so a caller
 * never re-reads it. start and end are the root scroll offsets at which
 * the declared range (before data-scrub-window) is at 0 and at 1 — in
 * container mode 0 and the scrollable span — or null with a null
 * progress. Every call reads afresh. An optional second argument is a caller-owned
 * result object to refill; without it the call returns a new object.
 *
 * progressFrom(range, measured) is the progress at the root's current
 * scroll offset for the endpoints an earlier measure of the same range
 * located, reading the offset alone. The endpoints sit in the root's
 * scroll space, so scrolling the root moves only the offset: a caller
 * re-measures when layout can have moved them (a resize, a box or
 * content resize, a load, a return to a visible page) and follows its
 * root's own scroll with progressFrom. The page scrolling a nested
 * root moves the root and its subjects together — it changes near,
 * never the endpoints. A measured null progress stays null: scrolling
 * never makes a degenerate or unrendered range measurable. A subject
 * that is itself fixed or sticky moves within that space as the root
 * — or the page around a nested root — scrolls; its endpoints are
 * those of its box at the last measure.
 *
 * scrollOffset(root) is the scroll offset measure would read for a
 * resolved root (null for the viewport), read alone, for an owner that
 * needs the offset outside a measure. contentOf(root) is the
 * resolved.content list taken afresh for a resolved root, for an owner
 * whose root's child list changed since the read.
 *
 * Callers must treat null distinctly from 0: 0 means "at the declared
 * start" and is a real position; null means the declaration cannot
 * measure right now and the authored baseline should stand untouched.
 *
 * @example
 *     // internal use — entry modules own the only public surface
 *     var range = scrollrange['read'](scope);
 *     if (range.resolved.error) { return; }  // unresolved selector: baseline stands
 *     var measured = scrollrange['measure'](range);
 *     if (measured.progress === null) { return; }  // degenerate range: baseline stands
 *     if (measured.near) { prepare(sequence); }    // approaching: warm up
 *     paint(sequence, measured.progress);
 *
 * @module paste/ui/utilities/scrollrange
 */
paste['define'](
    'paste.ui.utilities.scrollrange',
    [],
    function (scrollrange) {
        'use strict';

        var $w = window,
            $d = document,
            $math = Math,
            $min = $math['min'],
            $max = $math['max'],
            $abs = $math['abs'],
            $isFinite = isFinite,
            $Number = Number,
            $getComputedStyle = typeof $w['getComputedStyle'] === 'function' ?
                    $w['getComputedStyle'] : null,
            // Anchors are a closed vocabulary: a prototype-free table
            // answers only the three own names, so 'constructor' or
            // '__proto__' are never anchors.
            ANCHORS = (function () {
                var table = Object['create'](null);
                table.top = true;
                table.center = true;
                table.bottom = true;
                return table;
            }()),
            DEFAULT_WINDOW = [0, 1],
            // Plain decimal fractions only — Number() would also accept
            // '0x1', '0b1', '1e0' and '-0'.
            DECIMAL = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/,
            WHITESPACE = /\s+/,
            // The one carrier every measure reads into: the result
            // object is built from it, so it is never handed out.
            geometry = null,

            attribute = function (element, name) {
                return element.getAttribute('data-' + name);
            },

            // 'top bottom' -> {subject: 'top', viewport: 'bottom'}
            parseEndpoint = function (text, name) {
                var tokens;
                if (text === null || text === '') {
                    return null;
                }
                tokens = text.trim().split(WHITESPACE);
                if (tokens.length !== 2 ||
                        ANCHORS[tokens[0]] !== true ||
                        ANCHORS[tokens[1]] !== true) {
                    throw new TypeError(name + ' must be two of top, center or bottom');
                }
                return {subject: tokens[0], viewport: tokens[1]};
            },

            // '0.12 0.50' -> [0.12, 0.5] — the fractional subrange of the
            // base range the visual change occupies. A numeric remapping,
            // not another animation system.
            parseWindow = function (text) {
                var tokens,
                    a,
                    b;
                if (text === null || text === '') {
                    return DEFAULT_WINDOW;
                }
                tokens = text.trim().split(WHITESPACE);
                if (tokens.length !== 2 || !DECIMAL.test(tokens[0]) || !DECIMAL.test(tokens[1])) {
                    throw new TypeError('scrub-window must be two decimal fractions');
                }
                a = $Number(tokens[0]);
                b = $Number(tokens[1]);
                if (b > 1 || a >= b) {
                    throw new TypeError('scrub-window requires 0 <= a < b <= 1');
                }
                return [a, b];
            },

            exactlyOne = function (selector, name) {
                var list;
                try {
                    list = $d.querySelectorAll(selector);
                } catch (error) {
                    throw new TypeError(name + ' must be a valid CSS selector');
                }
                if (!list || list.length !== 1) {
                    return {error: new TypeError(name + ' must resolve to exactly one element')};
                }
                return {element: list[0]};
            },

            quirksMode = function () {
                return $d.compatMode === 'BackCompat';
            },

            // The element whose box is the viewport's scrolling area:
            // scrollingElement where the engine reports one, otherwise
            // the body in quirks mode and the root element in standards
            // mode — the same rule scrollingElement itself encodes.
            documentScroller = function () {
                return $d.scrollingElement ||
                    (quirksMode() ? $d.body : $d.documentElement) || null;
            },

            // Every name for the document's own scroller is the viewport
            // root: the window carries its scroll offset and its scroll
            // event, never the element — an element root here would
            // count the offset twice and listen where nothing fires.
            viewportRootFor = function (element) {
                if (element === $d.documentElement ||
                        (element && element === $d.scrollingElement) ||
                        (element === $d.body && quirksMode())) {
                    return null;
                }
                return element;
            },

            // The declared scrub relationship: which root scrolls, which
            // subject is measured, and the anchor pair marking progress
            // 0 and 1. Everything after this point is pure measurement.
            parseOptions = function (scope) {
                var mode = attribute(scope, 'scrub-mode') || 'element',
                    root = attribute(scope, 'scrub-root') || 'viewport',
                    subject = attribute(scope, 'scrub-subject'),
                    windowBounds = parseWindow(attribute(scope, 'scrub-window')),
                    start,
                    end;
                if (mode !== 'element' && mode !== 'container') {
                    throw new TypeError('scrub-mode must be element or container');
                }
                if (mode === 'container') {
                    // The root's own scroll range is the whole contract:
                    // subject and endpoint declarations do not apply;
                    // the window does.
                    return {mode: mode, root: root === 'viewport' ? null : root, window: windowBounds};
                }
                start = parseEndpoint(attribute(scope, 'scrub-start'), 'scrub-start') || {subject: 'top', viewport: 'bottom'};
                end = parseEndpoint(attribute(scope, 'scrub-end'), 'scrub-end') || {subject: 'bottom', viewport: 'top'};
                return {
                    mode: mode,
                    root: root === 'viewport' ? null : root,
                    subject: subject || null,
                    start: start,
                    end: end,
                    window: windowBounds
                };
            },

            // The boxes whose size follows the root's scrollable
            // content — see resolved.content in the header.
            contentOf = function (root) {
                var parent = root,
                    content = [],
                    children,
                    remaining,
                    index = 0;
                if (root === null) {
                    content.push($d.documentElement);
                    parent = $d.body || null;
                    if (parent) {
                        content.push(parent);
                    }
                }
                children = parent ? parent.children : null;
                remaining = children ? children.length : 0;
                while (remaining--) {
                    content.push(children[index]);
                    index += 1;
                }
                return content;
            },

            // Selector resolution happens once, at bind: an unresolved or
            // ambiguous declaration is a configuration error the caller
            // reports, not a reason to keep probing the document.
            resolve = function (scope, options) {
                var resolvedRoot = null,
                    resolvedSubject = scope,
                    found;
                if (options.root) {
                    found = exactlyOne(options.root, 'scrub-root');
                    if (found.error) {
                        return {error: found.error};
                    }
                    resolvedRoot = viewportRootFor(found.element);
                }
                // Container mode measures the root's own scroll range —
                // the scope merely declares it, so a subject declaration
                // neither resolves nor must live inside the scroller.
                if (options.mode === 'container') {
                    return {root: resolvedRoot, subject: resolvedSubject, content: contentOf(resolvedRoot)};
                }
                if (options.subject) {
                    found = exactlyOne(options.subject, 'scrub-subject');
                    if (found.error) {
                        return {error: found.error};
                    }
                    resolvedSubject = found.element;
                }
                // A root's own box moves with the page, never through its
                // own scroll: a subject that is the root measures nothing.
                if (resolvedRoot && resolvedSubject === resolvedRoot) {
                    return {error: new TypeError('scrub-subject must be inside scrub-root, not the root itself')};
                }
                if (resolvedRoot && !resolvedRoot.contains(resolvedSubject)) {
                    return {error: new TypeError('scrub-subject must be inside scrub-root')};
                }
                return {root: resolvedRoot, subject: resolvedSubject, content: contentOf(resolvedRoot)};
            },

            viewportHeightFor = function (root) {
                var scroller;
                if (root === null) {
                    scroller = documentScroller();
                    return (scroller && scroller.clientHeight) || $w.innerHeight || 0;
                }
                return root.clientHeight || 0;
            },

            scrollOffsetFor = function (root) {
                var scroller;
                if (root === null) {
                    scroller = documentScroller();
                    return $w.pageYOffset || (scroller ? scroller.scrollTop : 0) || 0;
                }
                return root.scrollTop || 0;
            },

            // Whether an element root is a scroll container at all: a
            // computed overflow-y of visible or clip never scrolls —
            // its scrollTop stays 0 however tall its content — so the
            // range is inactive however its scrollHeight reads. That
            // covers a standards-mode body named as the root, which
            // the viewport scrolls instead. A body with a scrolling
            // overflow is no scroll container either while the root
            // element's overflow is visible in both axes: the viewport
            // takes the body's overflow over, and the body's own is
            // then visible whatever its computed value says.
            scrollContainer = function (root) {
                var html = $d.documentElement,
                    overflow,
                    style;
                if ($getComputedStyle === null) {
                    return true;
                }
                overflow = $getComputedStyle(root).getPropertyValue('overflow-y');
                if (overflow === 'visible' || overflow === 'clip') {
                    return false;
                }
                if (root !== $d.body || root.parentNode !== html) {
                    return true;
                }
                style = $getComputedStyle(html);
                return style.getPropertyValue('overflow-x') !== 'visible' ||
                    style.getPropertyValue('overflow-y') !== 'visible';
            },

            scrollableHeightFor = function (root) {
                var scroller;
                if (root === null) {
                    scroller = documentScroller();
                    return scroller ? scroller.scrollHeight || 0 : 0;
                }
                return root.scrollHeight || 0;
            },

            // An anchor's position along a span: top, bottom, or the
            // midpoint — plain numbers, no per-call rectangle.
            anchorAt = function (anchor, top, bottom) {
                if (anchor === 'top') {
                    return top;
                }
                if (anchor === 'bottom') {
                    return bottom;
                }
                return (top + bottom) / 2;
            },

            applyWindow = function (progress, windowBounds) {
                var low = windowBounds[0];
                return $min(1, $max(0, (progress - low) / (windowBounds[1] - low)));
            },

            // The module's whole read contract: validate the declared
            // scope, resolve its selectors once, and return the plain
            // range description measure consumes. A parse problem
            // throws; an unresolvable selector reports through
            // resolved.error — both are the caller's "leave the
            // baseline" signal.
            read = function (scope) {
                var options = parseOptions(scope),
                    resolved = resolve(scope, options);
                return {options: options, resolved: resolved};
            },

            carrier = function () {
                return {
                    offset: 0,
                    viewport: 0,
                    span: 0,
                    scrolls: true,
                    top: 0,
                    bottom: 0,
                    rendered: false,
                    rootTop: 0,
                    rootScale: 1,
                    rootNear: true
                };
            },

            // Whether a nested root's own box lies within one
            // page-viewport of the page viewport — the same lead the
            // in-root band grants a subject. Also records the root's
            // scroll-space origin: its content box top, border box top
            // plus the border itself (clientTop) — a bordered scroller
            // shifts every measured edge by that offset, and the
            // padding box is what scrolls. A transformed ancestor
            // scales the rectangles but not scrollTop or clientHeight:
            // rootScale is the root's rendered height over its layout
            // height, and measured edges are divided by it before they
            // meet the scroll offset. offsetHeight and offsetWidth are
            // the layout size rounded to whole pixels, so a box drawn
            // within a pixel of both is the same untransformed box —
            // dividing by the rounded height would itself skew every
            // edge of a fractional-height root — and only a larger
            // difference on either side is a scale. The viewport root
            // is always near, its origin is 0 and its scale is 1.
            sampleRoot = function (entry, root) {
                var page,
                    rect,
                    layout,
                    scale;
                entry.rootTop = 0;
                entry.rootScale = 1;
                entry.rootNear = true;
                if (root === null) {
                    return;
                }
                page = viewportHeightFor(null);
                rect = root.getBoundingClientRect();
                layout = root.offsetHeight;
                scale = 1;
                if (layout > 0 && $isFinite(layout) &&
                        ($abs(rect.height - layout) >= 1 || $abs(rect.width - root.offsetWidth) >= 1)) {
                    scale = rect.height / layout;
                }
                if (!(scale > 0) || !$isFinite(scale)) {
                    scale = 1;
                }
                entry.rootScale = scale;
                entry.rootTop = rect.top + (root.clientTop || 0) * scale;
                entry.rootNear = rect.bottom >= -page && rect.top <= page * 2;
            },

            // One read of the current geometry into the carrier: a
            // later read is skipped whenever an earlier one already
            // settles the answer. subject is null for a container
            // range, which reads the root's scrollable height instead
            // of a subject box.
            sample = function (root, subject) {
                var entry = geometry,
                    viewport = viewportHeightFor(root),
                    rect;
                if (entry === null) {
                    entry = carrier();
                    geometry = entry;
                }
                entry.offset = scrollOffsetFor(root);
                entry.viewport = viewport;
                entry.span = 0;
                entry.scrolls = true;
                entry.top = NaN;
                entry.bottom = NaN;
                entry.rendered = false;
                entry.rootTop = 0;
                entry.rootScale = 1;
                entry.rootNear = false;
                if (!(viewport > 0)) {
                    return entry;
                }
                if (subject === null) {
                    entry.span = root === null || scrollContainer(root) ?
                            scrollableHeightFor(root) - viewport : 0;
                    sampleRoot(entry, root);
                    return entry;
                }
                if (root !== null && (!(root.scrollHeight - viewport > 0) || !scrollContainer(root))) {
                    entry.scrolls = false;
                    return entry;
                }
                rect = subject.getBoundingClientRect();
                entry.top = rect.top;
                entry.bottom = rect.bottom;
                if (!$isFinite(rect.top) || !$isFinite(rect.bottom)) {
                    return entry;
                }
                // A subject contributing no client rectangles is not
                // rendered at all — display:none, detached — which is
                // different from a rendered zero-height point anchor:
                // the point still reports its (empty) box and still
                // measures. Only an all-zero rectangle can be either,
                // so only then is the rectangle list read (and
                // allocated); engines without getClientRects cannot
                // tell the two apart, so the rect read stands.
                if (!rect.width && !rect.height && subject.getClientRects &&
                        !subject.getClientRects().length) {
                    return entry;
                }
                entry.rendered = true;
                sampleRoot(entry, root);
                return entry;
            },

            // The measured range from one geometry read. The subject's
            // edges are translated into the root's scroll space —
            // current rect plus current offset — so the measured
            // endpoints stay fixed under scrolling and only the offset
            // moves. An unmeasurable range is inactive, not an error:
            // progress comes back null. 'near' comes out of this same
            // read, not a second probe. The result object is the only
            // allocation per call unless the caller supplies a reusable
            // result. All fields are reset before taking the new sample.
            measure = function (range, into) {
                var result = into || {},
                    resolved = range.resolved,
                    options = range.options,
                    container = options.mode === 'container',
                    taken = sample(resolved.root, container ? null : resolved.subject),
                    offset = taken.offset,
                    viewport = taken.viewport,
                    rootNear = taken.rootNear,
                    windowBounds = options.window,
                    span,
                    subjectTop,
                    subjectBottom,
                    start,
                    end;
                result.progress = null;
                result.near = false;
                result.offset = offset;
                result.start = null;
                result.end = null;
                // A root with no rendered viewport carries no visible
                // span — endpoints anchored to its edges coincide at a
                // point, and 'near' has no meaning against it.
                if (!(viewport > 0)) {
                    return result;
                }
                if (container) {
                    span = taken.span;
                    // A container range has no approaching subject: the
                    // root's own scroll is the measurement, so near is
                    // the root's own nearness to the page viewport.
                    if (!(span > 0)) {
                        result.near = rootNear;
                        return result;
                    }
                    result.progress = applyWindow(offset / span, windowBounds);
                    result.near = rootNear;
                    result.start = 0;
                    result.end = span;
                    return result;
                }
                // An element root that cannot scroll — no overflow, or
                // not a scroll container at all — never moves its
                // offset: every read would answer the same constant
                // progress however the page moves, so the range is
                // inactive rather than frozen at a number. Content
                // growing inside it later is what makes it scrollable —
                // an owner watching resolved.content hears that.
                if (!taken.scrolls || !taken.rendered) {
                    return result;
                }
                subjectTop = (taken.top - taken.rootTop) / taken.rootScale + offset;
                subjectBottom = (taken.bottom - taken.rootTop) / taken.rootScale + offset;
                start = anchorAt(options.start.subject, subjectTop, subjectBottom) -
                    anchorAt(options.start.viewport, 0, viewport);
                end = anchorAt(options.end.subject, subjectTop, subjectBottom) -
                    anchorAt(options.end.viewport, 0, viewport);
                if (!(end > start)) {
                    result.near = rootNear;
                    return result;
                }
                result.progress = applyWindow((offset - start) / (end - start), windowBounds);
                // The same sample supplies proximity and progress.
                result.near = rootNear && subjectBottom >= offset - viewport &&
                    subjectTop <= offset + viewport * 2;
                result.start = start;
                result.end = end;
                return result;
            },

            // The progress at the current offset for located endpoints:
            // one offset read, no layout.
            progressFrom = function (range, measured) {
                var start = measured.start,
                    end = measured.end;
                if (measured.progress === null || start === null || end === null) {
                    return null;
                }
                return applyWindow((scrollOffsetFor(range.resolved.root) - start) / (end - start),
                    range.options.window);
            };

        scrollrange['read'] = read;
        scrollrange['measure'] = measure;
        scrollrange['progressFrom'] = progressFrom;
        scrollrange['scrollOffset'] = scrollOffsetFor;
        scrollrange['contentOf'] = contentOf;
        return scrollrange;
    }
);
