/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * @compilation_level ADVANCED_OPTIMIZATIONS
 *
 * Same-document anchor navigation stays the browser's own, activated
 * by data-paste-smoothscroll on a link container or
 * .paste-ui-section-nav. The module never prevents a click and never
 * writes history: the browser updates the address, :target, history
 * and hashchange, reveals a target where it supports that (a closed
 * details element or hidden="until-found" content), and scrolls with
 * the page's CSS. Ordinary links behave the same without this module.
 *
 * CSS owns motion and positioning: scroll-behavior on the scrolling
 * element, scroll-margin on targets or scroll-padding on the scroller,
 * and a prefers-reduced-motion rule in the page stylesheet. The
 * paste.ui.sectionnav stylesheet supplies a zero-specificity
 * scroll-margin for targets that clears a fixed or sticky nav. The
 * browser adds a target's scroll-margin to the scroller's
 * scroll-padding, so a page that clears its chrome with
 * scroll-padding-top instead sets --paste-ui-section-nav-clearance to
 * 0px (or builds the mixin with $target-clearance: null); a page's own
 * scroll-margin rule for its targets replaces the default. There is no
 * animation loop, touch policy, measured nav offset or JavaScript
 * motion preference. Back and Forward restore each entry's own scroll
 * position, and a page loaded with a fragment lands on it, both
 * natively.
 *
 * Focus: what the platform does not do is move keyboard focus to the
 * target. After a primary click on a same-document fragment link that
 * resolves to an element, the module waits for the navigation to land
 * (the hashchange for a new fragment, the next task for the fragment
 * already current), then focuses the target with preventScroll. A
 * click a later handler prevents, or a navigation that lands on
 * another fragment, moves no focus. The wait for a hashchange is
 * bounded: it ends a short grace after the task that follows the
 * click. A click the browser never navigates (a link inside an
 * editable region, a navigation a script cancels) moves no focus then,
 * nor does a later navigation to that fragment; an address that took
 * the fragment without a hashchange (a navigation a script intercepts)
 * focuses the target when the wait ends. An unfocusable target
 * borrows tabindex=-1 until focus moves elsewhere; authored tabindex
 * values are preserved. Modified clicks, downloads, other browsing
 * contexts, missing targets and links inside
 * .paste-ui-section-nav-disclosure get no focus handling. A link
 * targeting _self, the current window's own name, or _parent or _top
 * from a top-level document navigates this document and is handled
 * like an untargeted one. Back and Forward move no focus.
 *
 * Focus styling is the page's: a section that takes focus is drawn
 * with the user agent's focus ring wherever the engine shows one
 * (keyboard use everywhere, mouse clicks in some engines). A page that
 * wants no ring on borrowed focus can write, for example,
 * :where(:target[tabindex="-1"]:focus) { outline: none; }.
 *
 * Fragment resolution follows the browser's own fragment lookup: an
 * element with the fragment as its id, else the first a element with
 * it as its name, tried for the raw fragment before its
 * percent-decoded form. In a quirks-mode document, where some engines
 * also match a name without regard to case (the first such anchor,
 * even ahead of an exact match; Chromium for most letters, WebKit for
 * ASCII letters only) and others do not, a name that matches once each
 * code point is folded to the lowercase of its uppercase form is looked
 * up too, and focus there follows the element the browser made its
 * :target, provided its id or folded name answers the fragment.
 * Chromium also matches a few pairs that fold differently (some
 * ligatures, Greek letters with diacritics); those take no focus. No
 * public JavaScript control API or application events are exposed.
 *
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/smoothscroll
 */
paste['define'](
    'paste.ui.smoothscroll',
    ['paste.dom', 'paste.event'],
    function (smoothscroll, dom, event) {
        'use strict';

        var $w = window,
            $d = document,
            $setTimeout = $w['setTimeout'],
            $decodeURIComponent = decodeURIComponent,
            // How long after the task that follows the click a new
            // fragment may still land before the wait for it ends.
            ARRIVAL_GRACE = 100,
            Subscription = event['Event']['Subscription'],
            // The accepted click whose native navigation focus waits
            // on, its fragment as the link serializes it, its target,
            // and the one-shot hashchange watcher waiting with it.
            pendingClick = null,
            pendingHash = null,
            pendingTarget = null,
            arrivalSub = null,
            naturallyFocusable,
            indicatedElement,
            caseFold,
            foldedAnchor,
            resolveTarget,
            quirksTarget,
            currentContext,
            focusTarget,
            arrive,
            settleArrival,
            awaitArrival,
            clickHandler,
            // Click listeners live as long as the declared page.
            clickSubscriptions = [],
            init;

        // Whether the platform already lets this element take focus:
        // a declared tabindex, a link with its href, a control, an
        // editable region. What is already focusable keeps its
        // authored attribute state untouched — anything else borrows
        // one temporary tabindex for the programmatic focus alone.
        naturallyFocusable = function (element) {
            var tagName = (element['tagName'] || element['nodeName'] || '').toUpperCase(),
                editable;
            if (element['hasAttribute'] && element['hasAttribute']('tabindex')) {
                return true;
            }
            if (element['hasAttribute'] && element['hasAttribute']('contenteditable')) {
                editable = element['getAttribute']('contenteditable');
                if (editable !== 'false') {
                    return true;
                }
            }
            if (tagName === 'A' || tagName === 'AREA') {
                return !!(element['hasAttribute'] && element['hasAttribute']('href'));
            }
            if (tagName === 'BUTTON' || tagName === 'INPUT' || tagName === 'SELECT' ||
                    tagName === 'TEXTAREA' || tagName === 'SUMMARY' || tagName === 'IFRAME') {
                return !element['disabled'];
            }
            if (tagName === 'AUDIO' || tagName === 'VIDEO') {
                return !!(element['hasAttribute'] && element['hasAttribute']('controls'));
            }
            return false;
        };

        // The element a fragment indicates: the one with that id, else
        // the first a element named by it, as the browser looks it up.
        indicatedElement = function (fragment) {
            var element = $d.getElementById(fragment),
                named,
                remaining,
                index = 0;
            if (element) {
                return element;
            }
            named = $d['getElementsByName'] ? $d['getElementsByName'](fragment) : [];
            remaining = named.length;
            while (remaining--) {
                if (named[index].nodeName === 'A') {
                    return named[index];
                }
                index += 1;
            }
            return null;
        };

        // Case folding by code point, as an engine that matches names
        // without regard to case in quirks mode compares them: each
        // code point becomes the lowercase of its uppercase form, so
        // the long s, the Kelvin sign, final sigma, the micro sign and
        // letters outside the basic plane fold with their letters. A
        // code point whose case forms change its length, and the
        // dotless i, which has no folding, stay as they are. Chromium
        // also matches a few equal-length pairs that need full folding
        // (some ligatures, Greek letters with diacritics); those are
        // not looked up.
        caseFold = function (text) {
            var folded = '',
                remaining = text.length,
                index = 0,
                code,
                unit,
                upper,
                lower;
            while (remaining--) {
                unit = text.charAt(index);
                code = text.charCodeAt(index);
                index += 1;
                // A surrogate pair is one code point.
                if (code >= 0xD800 && code <= 0xDBFF && remaining > 0) {
                    code = text.charCodeAt(index);
                    if (code >= 0xDC00 && code <= 0xDFFF) {
                        unit += text.charAt(index);
                        index += 1;
                        remaining -= 1;
                    }
                }
                upper = unit.toUpperCase();
                lower = upper.length === unit.length ? upper.toLowerCase() : unit.toLowerCase();
                folded += unit === '\u0131' || lower.length !== unit.length ? unit : lower;
            }
            return folded;
        };

        // In a quirks-mode document some engines also take the first a
        // element whose name matches without regard to case; others
        // find nothing. The browser's :target settles which one it was.
        // This finds a candidate, so the click is waited on at all.
        foldedAnchor = function (fragment) {
            var anchors = $d.getElementsByTagName('a'),
                folded = caseFold(fragment),
                remaining = anchors.length,
                index = 0;
            while (remaining--) {
                if (caseFold(anchors[index].getAttribute('name') || '') === folded) {
                    return anchors[index];
                }
                index += 1;
            }
            return null;
        };

        // The raw fragment first, then its percent-decoded form — the
        // order the browser's own fragment navigation uses. A malformed
        // escape stays raw.
        resolveTarget = function (fragment) {
            var decoded,
                target;
            if (!fragment) {
                return null;
            }
            try {
                decoded = $decodeURIComponent(fragment);
            } catch (decodeError) {
                decoded = fragment;
            }
            target = indicatedElement(fragment) ||
                (decoded !== fragment ? indicatedElement(decoded) : null);
            if (!target && $d['compatMode'] === 'BackCompat') {
                target = foldedAnchor(fragment) || foldedAnchor(decoded);
            }
            return target;
        };

        // In a quirks-mode document focus follows the element the
        // browser made its target: an engine that matches names without
        // regard to case takes the first such anchor, even ahead of an
        // exact match, and another takes only the exact one or none. It
        // counts when it is the lookup's own element, or when its id or
        // its name regardless of case is the fragment, so a target an
        // earlier navigation left never does. Where :target cannot be
        // queried, the lookup stands.
        quirksTarget = function (lookup, fragment) {
            var element,
                decoded,
                name;
            try {
                element = $d['querySelector'](':target');
            } catch (unsupported) {
                return lookup;
            }
            if (!element || element === lookup) {
                return element;
            }
            try {
                decoded = $decodeURIComponent(fragment);
            } catch (decodeError) {
                decoded = fragment;
            }
            if (element.id === fragment || element.id === decoded) {
                return element;
            }
            name = element.nodeName === 'A' ? caseFold(element.getAttribute('name') || '') : null;
            return name !== null && (name === caseFold(fragment) || name === caseFold(decoded)) ?
                    element : null;
        };

        // Whether a link target names this document's own browsing
        // context: none, _self, _parent or _top where there is no
        // parent, or this window's own name. Keywords match without
        // regard to case; names match exactly.
        currentContext = function (name) {
            var keyword = name.toLowerCase();
            if (!name || keyword === '_self') {
                return true;
            }
            if (keyword === '_parent') {
                return $w['parent'] === $w;
            }
            if (keyword === '_top') {
                return $w['top'] === $w;
            }
            return keyword !== '_blank' && name === $w['name'];
        };

        focusTarget = function (target) {
            var blurSub = null,
                focusSub = null,
                releaseBorrow;
            if (!target['focus']) {
                return;
            }
            if (naturallyFocusable(target)) {
                target['focus']({'preventScroll': true});
                return;
            }
            // A blur that leaves the target focused — the window or tab
            // losing focus — is not the end of the lease: the target is
            // still where keyboard focus resumes. An engine that restores
            // that focus silently also leaves it without a second blur,
            // so focus arriving anywhere else in the document ends the
            // lease too.
            releaseBorrow = function () {
                if ($d['activeElement'] === target) {
                    return;
                }
                if (blurSub) {
                    blurSub['dispose']();
                    blurSub = null;
                }
                if (focusSub) {
                    focusSub['dispose']();
                    focusSub = null;
                }
                if (target['getAttribute']('tabindex') === '-1') {
                    target['removeAttribute']('tabindex');
                }
            };
            target['setAttribute']('tabindex', '-1');
            try {
                blurSub = new Subscription('blur', target, releaseBorrow);
                focusSub = new Subscription('focusin', $d, releaseBorrow);
                target['focus']({'preventScroll': true});
            } catch (focusSetupError) {
                // No watcher and no focus means no blur will ever
                // arrive — take the owned value back now rather than
                // strand the element focusable.
                releaseBorrow();
                throw focusSetupError;
            }
            // A target that refused focus (inert, hidden, a handler
            // that moved focus on) never blurs: the watcher and the
            // borrowed value go now.
            if ($d['activeElement'] !== target) {
                releaseBorrow();
            }
        };

        // The navigation has had its chance to land. Focus follows only
        // when the click went unprevented and the address now carries
        // the link's own fragment — a later handler's cancellation, or
        // a navigation elsewhere in the meantime, keeps the visitor's
        // focus where it is.
        arrive = function () {
            var click = pendingClick,
                hash = pendingHash,
                target = pendingTarget;
            if (arrivalSub) {
                arrivalSub['dispose']();
                arrivalSub = null;
            }
            pendingClick = null;
            pendingHash = null;
            pendingTarget = null;
            if (!click || click['defaultPrevented'] || $w.location.hash !== hash) {
                return;
            }
            // Engines resolve names differently in quirks mode: there,
            // focus follows the element the browser made its target.
            if ($d['compatMode'] === 'BackCompat') {
                target = quirksTarget(target, hash.slice(1));
                if (!target) {
                    return;
                }
            }
            focusTarget(target);
        };

        // The wait for a click ends here when the arrival never came:
        // arrive focuses only if the address carries the link's
        // fragment by now, and either way the watcher goes.
        settleArrival = function (e) {
            if (pendingClick === e) {
                arrive();
            }
        };

        // The browser navigates after the click's listeners return —
        // at once in some engines, a task later in others. A new
        // fragment announces its landing with hashchange, after
        // :target has revealed the target; the fragment already
        // current fires none, so a task stands in for it. A click the
        // browser never navigates fires no hashchange either, so the
        // watcher is bounded: the grace starts in the task after the
        // click, behind a navigation the engine queued for it however
        // long the click's own listeners ran.
        awaitArrival = function (e, hash, target) {
            if (arrivalSub) {
                arrivalSub['dispose']();
                arrivalSub = null;
            }
            pendingClick = e;
            pendingHash = hash;
            pendingTarget = target;
            if ($w.location.hash !== hash) {
                arrivalSub = new Subscription('hashchange', $w, arrive);
                if (typeof $setTimeout === 'function') {
                    $setTimeout(function () {
                        if (pendingClick === e) {
                            $setTimeout(function () {
                                settleArrival(e);
                            }, ARRIVAL_GRACE);
                        }
                    }, 0);
                }
            } else if (typeof $setTimeout === 'function') {
                $setTimeout(function () {
                    settleArrival(e);
                }, 0);
            } else {
                arrive();
            }
        };

        clickHandler = function (e) {
            var anchor = e.target,
                fragment,
                baseTarget,
                location,
                target;

            // An earlier handler already took this click — the browser's
            // default is already prevented and nothing will navigate.
            if (e['defaultPrevented']) { return; }

            // A modified or non-primary click requests a new context —
            // there is no arrival in this document to focus.
            if (e['ctrlKey'] || e['altKey'] || e['shiftKey'] || e['metaKey'] ||
                    (e['button'] && e['button'] > 0)) {
                return;
            }

            while (anchor && anchor.nodeName !== 'A') {
                anchor = anchor.parentNode;
            }

            if (!anchor || anchor.nodeName !== 'A') { return; }
            if (anchor.closest && anchor.closest('.paste-ui-section-nav-disclosure')) { return; }

            // A download contract is content delivery, not navigation;
            // a non-current browsing context opens elsewhere. Both are
            // the browser's outright.
            if (anchor['hasAttribute'] && anchor['hasAttribute']('download')) { return; }
            // The link's own target attribute, even an empty one,
            // outranks the document's base target.
            if (anchor['hasAttribute'] && anchor['hasAttribute']('target')) {
                target = anchor['target'] || '';
            } else {
                baseTarget = $d['querySelector']('base[target]');
                target = (baseTarget && baseTarget['target']) || '';
            }
            if (!currentContext(target)) { return; }

            fragment = (anchor.hash && anchor.hash.length > 1) ? anchor.hash.slice(1) : null;
            if (!fragment) { return; }

            // Same-document only: a hash on a foreign or cross-path URL
            // — including a same-path URL whose query differs — loads
            // another document.
            location = $w.location;
            if (anchor.protocol !== location.protocol ||
                    anchor.hostname !== location.hostname ||
                    anchor.port !== location.port ||
                    anchor.pathname !== location.pathname ||
                    anchor.search !== location.search) {
                return;
            }

            // A fragment that resolves to nothing has nothing to focus.
            target = resolveTarget(fragment);
            if (!target) { return; }

            awaitArrival(e, anchor.hash, target);
        };

        init = function () {
            var declared,
                remaining,
                index;
            // The declared containers and the section navs each take one
            // click listener.
            declared = dom['querySelectorAll']('[data-paste-smoothscroll]');
            remaining = declared.length;
            index = 0;
            while (remaining--) {
                clickSubscriptions.push(new Subscription('click', declared[index], clickHandler));
                index += 1;
            }
            declared = dom['querySelectorAll']('.paste-ui-section-nav');
            remaining = declared.length;
            index = 0;
            while (remaining--) {
                clickSubscriptions.push(new Subscription('click', declared[index], clickHandler));
                index += 1;
            }
        };

        init();
        return smoothscroll;
    }
);
