/*jslint browser:true continue:true plusplus:true sub:true */
/*globals paste */

/**
 * Progressive resolution for a single declared image host: replace the
 * usable initial image with a sharper representation only when the
 * painted size, the device pixel ratio, and the CSS resolution policy
 * say one is worth fetching.
 *
 * 1. 'data-paste-progressiveresolution' on the host opts it
 *    in; 'data-image-sources' names a script[type="application/json"]
 *    descriptor carrying the base representation and its upgrades.
 *    Hosts owned by imagesequence are not standalone candidates — the
 *    sequence is the only writer of its own source.
 * 2. The need is the painted box times the device pixel ratio, honest
 *    about the fit the display applies — object-fit on an img,
 *    background-size on a background, including explicit lengths. A
 *    background whose size paints the image at its own intrinsic size
 *    ('auto') never asks for an upgrade: a larger source would paint
 *    larger, not sharper. An img upgrade keeps the base's intrinsic
 *    size (see below), so object-fit 'none' — and a 'scale-down' that
 *    does not shrink — paints the base box at more pixels: its need is
 *    the base width times the device pixel ratio. The painted box is the
 *    box the image is sized against: an img's content box, inside its
 *    padding and border; a background's positioning area, by its
 *    background-attachment. For 'scroll' that is the box its
 *    background-origin names (the padding box by default); for 'local'
 *    on a box whose overflow scrolls and that reports a client box and
 *    a scrollable size, the same box measured over the whole scrollable
 *    content (a box overflow does not apply to, such as an inline one,
 *    keeps its origin box; Firefox paints 'local' on a scrolling table
 *    cell by the cell's own box, so there the module fetches more than
 *    the painted box needs); for 'fixed', the viewport (the window's
 *    inner size in quirks mode, which on a zoomed-out mobile visual
 *    viewport can exceed the layout viewport, again more than needed)
 *    or the origin box, whichever is larger in each dimension. An engine
 *    paints a fixed background against the origin box instead — a
 *    transform on the host or an ancestor, or a browser that ignores
 *    'fixed', such as iOS Safari — and the module cannot tell which it
 *    did: sized for the larger, it fetches more than the painted box
 *    needs, never less. The cap is
 *    '--paste-resolution-max-width' read from the host's computed
 *    style — CSS owns the breakpoint, this module only reads what it
 *    computed.
 * 3. The smallest representation that supplies the need inside the cap
 *    wins; the cap narrows optional upgrades only and never disqualifies
 *    the base. A candidate commits only when it is still sharper than
 *    what is displayed — a lowered cap or shrunken box never replaces
 *    the current image with a worse one, and a late completion never
 *    undoes a better commit.
 * 4. The policy's inputs change without scrolling: viewport resize, the
 *    device pixel ratio moving (a window dragged to another monitor,
 *    browser zoom — watched through paste.ui.utilities.mediaquery),
 *    page visibility returning, the host's own box moving, and the
 *    containers a container query could hit (a computed container-type
 *    naming size or inline-size). Each dirties a refresh; one
 *    animation-frame pass re-reads and re-selects.
 * 5. An img authored loading="lazy" keeps the author's deferral: no
 *    upgrade is fetched until the img comes within about one viewport
 *    of the top-level viewport. Where the platform has an
 *    IntersectionObserver, that observer — one viewport of margin around
 *    the top-level viewport, clipped by every scrolling or clipping
 *    ancestor and by the frames above it — alone decides nearness, and
 *    nothing is admitted before its first report: a slide a carousel
 *    clips, or an img in a frame far down the page, stays deferred.
 *    An img in a frame gets less than that margin: in a cross-origin
 *    frame the platform applies no margin, so the upgrade waits until
 *    the img is actually visible, and an engine that pauses animation
 *    frames in an off-screen frame runs the upgrading pass only once
 *    the frame is on screen. Without an observer, the img's box against
 *    its own window's viewport, on both axes, is re-checked as the page
 *    or an ancestor scrolls. Once near it upgrades like any other host.
 * 6. A prepared rung must be the image its descriptor declares: a
 *    decoded image whose natural width differs from the declared width,
 *    or whose aspect ratio leaves the descriptor's, is a failed rung —
 *    committing it would change the layout box. An image reporting no
 *    natural size cannot contradict the descriptor, and neither can a
 *    vector source, whose reported size is the engine's own default,
 *    not pixels. A decoded image does not report its media type, so a
 *    vector source is recognised by its URL alone: a path ending '.svg'
 *    or '.svgz' (before any query or fragment), or an image/svg+xml
 *    data URL. An SVG served at any other URL is held to the declared
 *    size and, where the engine reports a default box for it, fails;
 *    a raster served at such a path is not size-checked.
 *    A decode the platform refuses while the document is hidden is
 *    withheld until the document is visible again; the pass visibility
 *    brings retries it once if it still selects that URL, and a refusal
 *    of that retry is final. A withheld URL that pass does not select is
 *    released, and a later selection is a fresh attempt. A refusal while
 *    visible, or a load error, is final for that URL.
 *
 * Authoring
 *
 * Load 'paste.ui.progressiveresolution' through the ordinary
 * Paste include — activation follows Paste's footer convention and
 * authors wire nothing. The opt-in suits one image whose source is
 * worth sharpening beyond what the baseline already supplies.
 *
 * When native selection already covers the requirement — an img whose
 * srcset/sizes or a wrapping picture chooses the source, or a CSS
 * background whose art direction intentionally changes content or
 * crop across breakpoints — use that instead and omit the flag; the
 * module passes over an img whose srcset already governs. The
 * upgrades in this contract are the same content at more pixels, not
 * different crops.
 *
 * @example
 *     <img class="product-still"
 *          src="/images/product-still-640.webp"
 *          width="640" height="640"
 *          alt="Product shown with its housing closed"
 *          data-paste-progressiveresolution
 *          data-image-sources="#product-still">
 *
 *     <script type="application/json" id="product-still">
 *     {
 *       "src": "/images/product-still-640.webp",
 *       "width": 640,
 *       "height": 640,
 *       "upgrades": [
 *         {"src": "/images/product-still-1280.webp",
 *          "width": 1280, "height": 1280},
 *         {"src": "https://images-b.example.com/product-still-1920.webp",
 *          "width": 1920, "height": 1920}
 *       ]
 *     }
 *     </script>
 *
 *     <style>
 *     .product-still {
 *       --paste-resolution-max-width: 960;
 *     }
 *     @media (min-width: 64rem) {
 *       .product-still {
 *         --paste-resolution-max-width: 1920;
 *       }
 *     }
 *     </style>
 *
 * The cap is an ordinary inherited custom property carrying a unitless
 * intrinsic pixel width; 'auto' — the default — means no cap. The
 * media query that assigns it is the page's breakpoint: CSS decides
 * which classes of host may spend more pixels, the module only reads
 * the computed value.
 *
 * The base descriptor must describe the authored initial image —
 * upgrades are declared in ascending order, grow in both width and
 * height, and share its aspect ratio, because a resolution step is the
 * same content, never a different crop.
 *
 * Attributes on the host:
 *
 *   data-paste-progressiveresolution — required opt-in.
 *   data-image-sources   — required here: a '#id' reference to one
 *       script[type="application/json"] descriptor. Omit it on a
 *       sequence host — frame descriptors come from the catalog and
 *       the sequence owns the flag itself.
 *   data-image-property  — 'src' (img only) or 'background-image';
 *       default is by tag name.
 *   crossorigin, referrerpolicy — on an img host only, carried to the
 *       upgrade's preparation fetch so it matches the request the img
 *       itself will make; a background host's preparation adds none.
 *
 * JavaScript owns the one declared image property and nothing else:
 * the painted box, the breakpoint that picks the cap, background-size
 * fitting, and all layout remain CSS decisions the module reads rather
 * than duplicates. An img host's upgrade is always written as a srcset
 * width descriptor with a module-owned 'sizes' equal to the base's
 * intrinsic width, leaving the authored src in place — same intrinsic
 * size, more pixels, at every device pixel ratio, whatever CSS (width:
 * auto included) decides about the box. An img that already carries
 * srcset or sizes — sizes alone included — or sits in a picture, is
 * natively governed and is passed over: the module never overwrites an
 * authored sizes. The src the module leaves in place is the attribute
 * text captured at bind, so a later change of document base is not a
 * foreign write. When the module stands down — another script wrote
 * the src, srcset or sizes, noticed when the write happens where the
 * platform reports attribute mutations, otherwise on the next pass —
 * it removes the srcset and sizes it wrote, each only while it still
 * holds the module's own value, so the other writer's choice displays.
 * A background host's upgrade is an inline background-image keeping
 * the priority the baseline declaration had. Its claim stands while the
 * computed background-image is that single url(); a computed value
 * that still includes the module's URL among others — a cross-fade
 * while a background-image transition runs — keeps the claim and is
 * verified again on the next pass; anything else is another writer.
 * A pending claim requests its own verification passes for at most
 * five seconds of frame time from its first pending read — far longer
 * than a background-image transition runs. Past that bound no frame is
 * requested for it; the next pass an input brings reads it once more,
 * and a value still pending then counts as owned mid-transition and is
 * never reverted. A fresh claim starts a fresh bound.
 * Under a background-image transition — the host's computed
 * transition-property naming 'all', 'background' or 'background-image'
 * with a positive combined duration and delay at that position — the
 * computed value can still be the source the paint replaced before the
 * transition reports the change: a value whose url() tokens name that
 * predecessor is pending too, but only inside the bound, and at or past
 * it is another writer. Without such a transition the predecessor
 * still showing is another writer. Where the platform lists the host's
 * animations (getAnimations), that list replaces the predecessor rule:
 * a background-image transition still in flight — inside its delay or
 * running — is pending whatever older source the computed value still
 * names, so paints chained faster than the transition keep the claim;
 * with none in flight, a value that is not the module's is another
 * writer.
 *
 * Optional upgrades start as soon as a pass asks for them (a lazy img
 * once it is near); nothing waits for the document's load event. Without the module — or when a
 * descriptor is invalid or every upgrade fails — the authored src or
 * background-image is the presentation. Reduced motion does not
 * disable this enhancement: it trades no animation, only more pixels.
 *
 * Failure behavior: a malformed declaration — an invalid
 * data-image-property, a data-image-sources that is not a '#id' of a
 * script[type="application/json"] holding a valid descriptor, a
 * descriptor URL the platform cannot resolve, or a descriptor base that
 * does not match (or cannot be verified against) the authored image —
 * keeps the host at its baseline and is reported once per host, at
 * bind, as a descriptive TypeError rethrown asynchronously from a timer
 * captured when the module defines. Nothing is written to the console
 * and no other host is affected. Page or platform code that throws while
 * a host binds leaves that host as authored without a report.
 *
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/imageresolution
 * @requires paste/ui/utilities/mediaquery
 * @module paste/ui/progressiveresolution
 */
paste['define'](
    'paste.ui.progressiveresolution',
    [
        'paste.event',
        'paste.ui.utilities.animation-frame',
        'paste.ui.utilities.imageresolution',
        'paste.ui.utilities.mediaquery'
    ],
    function (progressiveresolution, event, animation_frame, imageresolution, mediaquery) {
        'use strict';

        // Every module-started fetch and decode settles through a native
        // promise — there is no callback-only expression of that contract.
        // Platform constructors and functions are captured once: a page
        // script replacing a global later cannot strand an operation
        // half-way or change which facility the module uses. Absent
        // Promise the enhancement itself cannot exist, so every scan,
        // subscription and write stays behind the one gate: declared
        // hosts keep their authored baselines untouched.
        var $w = window,
            $doc = document,
            NativePromise = typeof Promise === 'function' ? Promise : null,
            NativeResizeObserver = $w['ResizeObserver'],
            NativeMutationObserver = $w['MutationObserver'],
            NativeIntersectionObserver = $w['IntersectionObserver'],
            NativeWeakMap = $w['WeakMap'],
            $create = Object['create'],
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            capFrom = imageresolution['capFrom'],
            needFor = imageresolution['needFor'],
            paintedBox = imageresolution['paintedBox'],
            selectCandidate = imageresolution['selectCandidate'],
            cssUrl = imageresolution['cssUrl'],
            cssUrlSource = imageresolution['cssUrlSource'],
            computedStyle = imageresolution['computedStyle'],
            report = imageresolution['report'],
            readFragment = imageresolution['readFragment'],
            resolveSource = imageresolution['resolveSource'],
            property = imageresolution['property'],
            nativelySelected = imageresolution['nativelySelected'],
            policyWatchTargets = imageresolution['policyWatchTargets'],
            claimState = imageresolution['claimState'],
            prepare = imageresolution['prepare'],
            marker = 'data-paste-progressiveresolution',
            sequenceMarker = 'data-paste-imagesequence',
            capProperty = '--paste-resolution-max-width',
            // How long, in frame time, a pending background claim
            // requests its own verification passes.
            pendingVerifyMs = 5000,
            // The running pass's batch time.
            passAt = 0,
            // A srcset candidate URL ends at the first whitespace.
            whitespace = /\s/,
            hosts = [],
            byElement = null,
            hostFor = function (element) {
                var index = hosts.length;
                if (byElement) {
                    return byElement.get(element);
                }
                while (index--) {
                    if (hosts[index].element === element) {
                        return hosts[index];
                    }
                }
                return null;
            },
            // The img hosts authored loading="lazy" that have not yet
            // come near the top-level viewport. Without a proximity
            // observer the page's and their ancestors' scroll re-check
            // them, and those listeners exist once one such host does.
            deferred = [],
            // One IntersectionObserver, one viewport of margin around
            // the top-level viewport, for the deferred hosts. Its
            // reports alone decide nearness for a host it watches: they
            // account for clipping ancestors and enclosing frames, and
            // arrive for scrolls and for layout that moves a host with
            // no scroll at all. Absent or refused, the scroll inputs and
            // the box against the window's own viewport carry the
            // deferral.
            proximity = null,
            proximityFailed = false,
            // Listeners live as long as the page: the handles are kept
            // here and never torn down.
            listeners = [],
            lazyScrollTargets = [],
            // One MutationObserver for every img host's src, srcset and
            // sizes: a foreign write marks its host for the next pass,
            // which stands down. Absent or refused, the pass-time check
            // alone notices it.
            mutations = null,
            mutationsFailed = false,
            // One ResizeObserver for the whole module: observed maps a
            // watched target to the hosts whose policy it can move —
            // a private target index, so a delivery never scans every
            // record for every entry. A hostile or absent facility
            // leaves observerFailed set and the remaining inputs —
            // resize, resolution, visibility — carry the refresh alone.
            observed = null,
            observer = null,
            observerFailed = false,
            // Whether the one pass is requested and has not yet run, and
            // whether this batch's read phase ran it and its write phase
            // has not yet: should a request that threw (see schedule)
            // still have queued its pair, it can land beside the next
            // one, and only one of them runs.
            frameRequested = false,
            passRead = false,
            readPass,
            writePass,

            // One native asynchronous frame carries each pending pass.
            schedule = function () {
                if (!frameRequested) {
                    frameRequested = true;
                    requestPhased(readPass, writePass);
                }
            },

            dirty = function (host) {
                host.dirty = true;
                schedule();
            },

            dirtyEveryHost = function () {
                var index = hosts.length;
                while (index--) {
                    hosts[index].dirty = true;
                }
                schedule();
            },

            // The page or an ancestor scrolled: every still-deferred
            // lazy host is probed — its box alone — in the next pass.
            probeDeferred = function () {
                var index = deferred.length;
                if (!index) {
                    return;
                }
                while (index--) {
                    deferred[index].probe = true;
                }
                schedule();
            },

            // Element scroll does not bubble to window. Subscribe once
            // per ancestor shared by lazy hosts, including ancestors that
            // become scrollable after binding, without reading geometry.
            watchLazyScroll = function (element) {
                var node = element.parentNode;
                while (node && node.nodeType === 1) {
                    if (lazyScrollTargets.indexOf(node) < 0) {
                        lazyScrollTargets.push(node);
                        listeners.push(new Subscription('scroll', node, probeDeferred));
                    }
                    node = node.parentNode;
                }
            },

            // The proximity observer reported: each deferred host it
            // names keeps the latest verdict, and one now near is probed
            // like a scrolled one. Entries arrive in time order, so the
            // walk runs forward and the last one for a host stands. An
            // entry naming no deferred host, or carrying no boolean
            // verdict, is skipped on its own.
            proximityDelivery = function (entries) {
                var count = entries.length,
                    entryIndex = 0,
                    entry,
                    target,
                    verdict,
                    host,
                    marked = false;
                while (count--) {
                    entry = entries[entryIndex];
                    entryIndex += 1;
                    target = entry.target;
                    verdict = entry.isIntersecting;
                    host = target && typeof verdict === 'boolean' ? hostFor(target) : null;
                    if (host && host.lazy) {
                        host.near = verdict;
                        if (verdict) {
                            host.probe = true;
                            marked = true;
                        }
                    }
                }
                if (marked) {
                    schedule();
                }
            },

            // Answers whether the proximity observer now watches the
            // host's element.
            watchProximity = function (element) {
                if (proximityFailed) {
                    return false;
                }
                try {
                    if (proximity === null) {
                        if (typeof NativeIntersectionObserver !== 'function') {
                            proximityFailed = true;
                            return false;
                        }
                        proximity = new NativeIntersectionObserver(proximityDelivery, {rootMargin: '100%'});
                    }
                    proximity.observe(element);
                } catch (refused) {
                    // This host's nearness follows the scroll inputs
                    // alone.
                    return false;
                }
                return true;
            },

            // A decode refused while the document was hidden is
            // withheld, not failed: a visible document makes it due, and
            // the pass that follows retries it once if it still selects
            // it. The retry budget is spent only by that preparation.
            retryWithheld = function () {
                var index = hosts.length,
                    host,
                    withheld,
                    src;
                while (index--) {
                    host = hosts[index];
                    withheld = host.withheld;
                    for (src in withheld) {
                        if (withheld[src] === true) {
                            withheld[src] = 'due';
                            host.retryDue = true;
                        }
                    }
                }
            },

            // The descriptor must describe the image actually authored
            // on this host — an upgrade is more pixels of the same
            // picture, never a different one. Read the authored base
            // for the enhanced property before any enhancement writes:
            // an img's resolved src (currentSrc only when the platform
            // already reports a nonempty selection), or a background's
            // single unambiguous url(...) from the computed baseline.
            // Anything unreadable — no authored image, a gradient, or
            // a layered declaration — verifies nothing.
            backgroundSource = function (style) {
                return style && typeof style.getPropertyValue === 'function' ?
                        cssUrlSource(style.getPropertyValue('background-image') || '') :
                        null;
            },

            authoredSrc = function (element, declaredProperty) {
                if (declaredProperty === 'src') {
                    return element.src || element.currentSrc || null;
                }
                return backgroundSource(computedStyle(element));
            },

            // A srcset candidate URL is the run of characters up to
            // whitespace, with trailing commas stripped — a URL that
            // would split or lose characters there cannot be written
            // as a candidate.
            srcsetSafe = function (src) {
                return src.length > 0 && !whitespace.test(src) &&
                    src.charAt(0) !== ',' && src.charAt(src.length - 1) !== ',';
            },

            // A lazy host comes near — or stands down: it leaves the
            // deferred list, and neither scroll nor proximity probes it
            // again.
            undefer = function (host) {
                var index = deferred.length;
                host.lazy = false;
                if (proximity !== null) {
                    try {
                        proximity.unobserve(host.element);
                    } catch (ignore) {
                        // A stray delivery finds no deferred host.
                    }
                }
                while (index--) {
                    if (deferred[index] === host) {
                        deferred.splice(index, 1);
                    }
                }
            },

            // The module stops owning the display for good. On an img
            // host, the srcset and sizes the module wrote leave with it
            // — each only while it still holds the module's own value:
            // a srcset left behind would outrank another writer's src,
            // and a module sizes would mis-size another writer's
            // srcset. Somebody else's value is never touched. A deferred
            // lazy host leaves the deferred list with its claim, so no
            // scroll arms a pass for it again.
            standDown = function (host) {
                var element = host.element;
                host.owned = false;
                if (host.lazy) {
                    undefer(host);
                }
                if (host.property !== 'src') {
                    return;
                }
                try {
                    if (host.ownedSrcset !== null &&
                            element.getAttribute('srcset') === host.ownedSrcset) {
                        element.removeAttribute('srcset');
                    }
                    if (host.ownedSizes !== null &&
                            element.getAttribute('sizes') === host.ownedSizes) {
                        element.removeAttribute('sizes');
                    }
                } catch (ignore) {
                    // A surface that refuses the cleanup keeps what it
                    // has; the module writes nothing more either way.
                }
            },

            // The written source: on an img, a srcset width descriptor
            // with the module's own sizes, the authored src kept as the
            // fallback; an inline background otherwise. Answers whether
            // the paint was written; a surface that refuses the write
            // withdraws the host's claim instead of failing the pass
            // for every host.
            paint = function (host, candidate) {
                var element = host.element,
                    src = candidate['src'],
                    srcset;
                if (host.property === 'src') {
                    // A plain src replacement would let any img whose
                    // box CSS leaves to the image (width: auto, or no
                    // authored dimensions) change its layout along with
                    // its pixels. A width descriptor with sizes equal to
                    // the base's own intrinsic width says "same
                    // intrinsic size, more pixels": the descriptor is
                    // the only candidate (a src is never added beside
                    // width descriptors), so every device pixel ratio
                    // selects it, and its density is the rung over the
                    // base — whatever transform or container now scales
                    // the rendered box.
                    srcset = src + ' ' + candidate['width'] + 'w';
                    try {
                        element.setAttribute('sizes', host.sizes);
                        host.ownedSizes = host.sizes;
                        element.setAttribute('srcset', srcset);
                    } catch (srcsetError) {
                        standDown(host);
                        return false;
                    }
                    host.ownedSrcset = srcset;
                    return true;
                }
                try {
                    // The written declaration keeps the priority the
                    // module captured with its baseline — an authored
                    // !important survives an upgrade instead of being
                    // silently demoted by a two-argument write.
                    element.style.setProperty('background-image', cssUrl(src),
                        host.ownedPriority);
                } catch (writeError) {
                    host.owned = false;
                    return false;
                }
                return true;
            },

            // Whether an img's src, srcset and sizes attributes are
            // exactly the module's: the src attribute text captured at
            // bind (never the reflected URL, which re-resolves against
            // a moved document base), and the srcset and sizes the
            // module wrote — nothing, before its first paint.
            attributesOwned = function (host) {
                var element = host.element;
                return element.getAttribute('src') === host.ownedValue &&
                    element.getAttribute('srcset') === host.ownedSrcset &&
                    element.getAttribute('sizes') === host.ownedSizes;
            },

            // Whether the display surface still belongs to the module:
            // on an img, its attributes are the module's; on a
            // background, the declaration layer carries the same value
            // and priority the module last wrote, and the computed
            // source below it — as the pass's read phase saw it — is
            // the module's own. A computed value only pending — the
            // module's URL inside a transition's cross-fade, or any
            // value while the host lists a background-image transition
            // in flight — keeps the claim and, inside the pending
            // bound counted from the claim's first pending read, marks
            // one more verification; past the bound it marks none, and
            // the claim stands as owned mid-transition. A predecessor
            // still computed under a background-image transition, where
            // the platform lists no animations, is pending inside the
            // same bound only; at or past it, it is foreign. Anything else — a
            // foreign src, srcset or sizes write, a stylesheet that
            // outranks the inline layer — withdraws ownership
            // permanently; pending physical accounting still settles.
            // An unread computed source is no evidence, and the claim
            // stands: the next pass that reads the host asks again.
            displayOwned = function (host) {
                var style;
                if (host.property === 'src') {
                    if (!attributesOwned(host)) {
                        standDown(host);
                        return false;
                    }
                    return true;
                }
                style = host.element.style;
                if (host.passState === 'predecessor' && host.pendingSince !== null &&
                        (host.pendingLapsed || passAt - host.pendingSince >= pendingVerifyMs)) {
                    host.passState = 'foreign';
                }
                if (style.getPropertyValue('background-image') !== host.ownedValue ||
                        style.getPropertyPriority('background-image') !== host.ownedPriority ||
                        host.passState === 'foreign') {
                    standDown(host);
                    return false;
                }
                if ((host.passState === 'pending' || host.passState === 'predecessor') &&
                        !host.pendingLapsed) {
                    if (host.pendingSince === null) {
                        host.pendingSince = passAt;
                    }
                    if (passAt - host.pendingSince < pendingVerifyMs) {
                        host.verify = true;
                    } else {
                        host.pendingLapsed = true;
                    }
                }
                return true;
            },

            // A settlement parks on the host for the pass to reconcile.
            park = function (host, candidate, ok, withheld) {
                host.settled[host.settledCount] = {candidate: candidate, ok: ok, withheld: withheld};
                host.settledCount += 1;
                dirty(host);
            },

            // "Sharper than what is displayed" is the whole commit
            // contract: policy moves during the fetch, other work
            // commits first — the answer is still just this comparison.
            // The cap arrives with the pass's snapshot — a commit is a
            // paint and reads no style or layout itself.
            commit = function (host, candidate, cap) {
                var width = candidate['width'];
                if (width <= host.currentWidth) {
                    return false;
                }
                // Policy moved while the fetch flew: a cap that fell
                // below this candidate makes it ineligible — the image
                // already displayed keeps standing.
                if (cap !== 'auto' && width > cap) {
                    return false;
                }
                // Ownership moved while the fetch flew, the other way:
                // a srcset or sizes another script wrote, a replacement
                // src or background — inline or through the cascade —
                // is content this module does not own. The candidate
                // keeps its physical accounting — it fetched and
                // decoded — but the presentation claim withdraws rather
                // than clobbering somebody else's paint.
                if (!displayOwned(host) || !paint(host, candidate)) {
                    return false;
                }
                if (host.property === 'background-image') {
                    // The value reads back as the declaration layer
                    // serialized it; the priority is the one written.
                    host.ownedValue = host.element.style.getPropertyValue('background-image');
                    // Whether the declaration actually displays is a
                    // computed-style question, and asking it now would
                    // force a style recalculation right after the
                    // write. The claim stands for the rest of this
                    // pass; the next pass reads the computed source —
                    // and only that, no box or policy — to verify it:
                    // an !important rule above the inline layer then
                    // shows the computed source unchanged, and the host
                    // stands down there; a transition still cross-fading
                    // toward it verifies again on the pass after.
                    host.ownedPredecessor = host.ownedComputed;
                    host.ownedComputed = candidate['src'];
                    host.passState = 'owned';
                    host.verify = true;
                    host.pendingSince = null;
                    host.pendingLapsed = false;
                }
                host.currentWidth = width;
                host.currentSrc = candidate['src'];
                return true;
            },

            evaluate = function (host, cap, need) {
                var representations = host.representations,
                    failed = host.failed,
                    chosen,
                    withheld = host.withheld,
                    failedWidth,
                    pending,
                    index,
                    rep;
                // The display no longer carries module-owned content —
                // admissions stop with it; nothing fetches toward a
                // paint that commit would refuse anyway. The ownership
                // proof runs here too, not only at commit: a display
                // already claimed by somebody else deserves no fetch.
                if (host.owned === false || !displayOwned(host)) {
                    return;
                }
                // An author's lazy deferral stands until the img is near.
                if (host.lazy) {
                    return;
                }
                if (host.op) {
                    // One admitted operation at a time — a preferred
                    // size that moved mid-flight does not invalidate
                    // the in-flight result: it may still be a valid
                    // improvement. Its reconcile happens on settle
                    // against the pass's fresh snapshot, where commit
                    // re-checks width and cap — then this evaluation
                    // looks at the demand as it stands then.
                    return;
                }
                // Selection is useful only when this host can admit.
                chosen = selectCandidate(representations, need, cap);
                // A source that already failed is not retried on later
                // reevaluations — the URL is the same miss however the
                // geometry that asked for it moved. The memory is per
                // source, never against the ladder: a dead preferred
                // rung leaves the best surviving rung at or below it,
                // still a candidate only if it improves on what is
                // standing.
                if (failed[chosen['src']] === true || withheld[chosen['src']] === true) {
                    // The ladder ascends in width, so the first
                    // surviving rung met walking down is the widest
                    // candidate at or below the dead one — no filtered
                    // list is needed to find it.
                    failedWidth = chosen['width'];
                    chosen = null;
                    index = representations.length;
                    while (index--) {
                        rep = representations[index];
                        if (rep['width'] <= failedWidth && failed[rep['src']] !== true &&
                                withheld[rep['src']] !== true) {
                            chosen = rep;
                            break;
                        }
                    }
                }
                if (!chosen || chosen['width'] <= host.currentWidth ||
                        chosen['src'] === host.currentSrc) {
                    return;
                }
                // Optional work admits as soon as the pass wants it:
                // the authored base is already the presentation, and
                // nothing waits on the document's load event — a
                // stalled resource elsewhere never holds an upgrade. A
                // due URL's preparation is its one retry.
                if (withheld[chosen['src']] === 'due') {
                    delete withheld[chosen['src']];
                    host.retried[chosen['src']] = true;
                }
                pending = prepare(host.element, host.property === 'src', chosen);
                host.op = pending;
                // A settle is bookkeeping: the outcome parks on the
                // host and the pass reconciles — nothing reads layout
                // or paints inside the settle turn. Whether a refused
                // decode is withheld depends on the document being
                // hidden when it settles; a rung whose decoded size
                // contradicts its descriptor settles refused, never
                // withheld.
                pending.then(function () {
                    if (host.op === pending) {
                        host.op = null;
                    }
                    park(host, chosen, true, false);
                }, function (failure) {
                    var hidden = failure !== null && typeof failure === 'object' &&
                            failure.decode === true && $doc.hidden === true &&
                            host.retried[chosen['src']] !== true;
                    if (host.op === pending) {
                        host.op = null;
                    }
                    // A hidden document runs no frame, so the withheld
                    // record is made here, where the visible document's
                    // retry will find it.
                    if (hidden) {
                        host.withheld[chosen['src']] = true;
                    }
                    park(host, chosen, false, hidden);
                });
            },

            // A ResizeObserver delivery: every host a reported target
            // can move is dirtied. Stale reports for unwatched boxes
            // schedule no work.
            observerDelivery = function (entries) {
                var entryIndex = entries.length,
                    memberIndex,
                    entry,
                    record,
                    members,
                    changed = false;
                while (entryIndex--) {
                    entry = entries[entryIndex];
                    record = observed.get(entry.target);
                    if (record) {
                        changed = true;
                        members = record.hosts;
                        memberIndex = members.length;
                        while (memberIndex--) {
                            members[memberIndex].dirty = true;
                        }
                    }
                }
                if (changed) {
                    schedule();
                }
            },

            // Attribute mutations on img hosts: a record whose host's
            // attributes are no longer exactly the module's marks that
            // host for the next pass, where the ownership check stands
            // down. The module's own writes leave the attributes equal
            // to what it owns and mark nothing.
            mutationDelivery = function (records) {
                var recordIndex = records.length,
                    host,
                    marked = false;
                while (recordIndex--) {
                    host = hostFor(records[recordIndex].target);
                    if (host && host.owned && !host.dirty && !attributesOwned(host)) {
                        host.dirty = true;
                        marked = true;
                    }
                }
                if (marked) {
                    schedule();
                }
            },

            watchAttributes = function (element) {
                if (mutationsFailed) {
                    return;
                }
                try {
                    if (mutations === null) {
                        if (typeof NativeMutationObserver !== 'function') {
                            mutationsFailed = true;
                            return;
                        }
                        mutations = new NativeMutationObserver(mutationDelivery);
                    }
                    mutations.observe(element, {
                        attributes: true,
                        attributeFilter: ['src', 'srcset', 'sizes']
                    });
                } catch (refused) {
                    // This host's foreign writes are noticed by the
                    // pass-time check alone.
                    return;
                }
            },

            // A watched box is shared state, not per-host ownership:
            // one record per target carries every host whose policy the
            // target can move — the host itself and any container-type
            // ancestor several hosts could share.
            observeTarget = function (host, target) {
                var index,
                    record,
                    members;
                if (observerFailed) {
                    return;
                }
                if (!observer) {
                    if (typeof NativeResizeObserver !== 'function' || typeof NativeWeakMap !== 'function') {
                        observerFailed = true;
                        return;
                    }
                    // The private index and the observer stand or fall
                    // together.
                    try {
                        observed = new NativeWeakMap();
                        observer = new NativeResizeObserver(observerDelivery);
                    } catch (observerError) {
                        observed = null;
                        observer = null;
                        observerFailed = true;
                        return;
                    }
                }
                record = observed.get(target);
                if (!record) {
                    // A host that refuses one target loses only its own
                    // observation — the refresh still arrives through
                    // resize, resolution and visibility.
                    try {
                        observer.observe(target);
                    } catch (observeError) {
                        return;
                    }
                    record = {hosts: []};
                    observed.set(target, record);
                }
                members = record.hosts;
                index = members.length;
                while (index--) {
                    if (members[index] === host) {
                        return;
                    }
                }
                members.push(host);
            },

            // The declaration, validated and resolved: the parsed
            // descriptor with absolute URLs, or a TypeError naming what
            // is malformed.
            readDeclaration = function (element, declaredProperty) {
                var parsed = imageresolution['descriptor'](
                        readFragment(element.getAttribute('data-image-sources'), 'data-image-sources', null)
                    ),
                    upgrades = parsed['upgrades'],
                    index = upgrades.length,
                    authoredBase;
                parsed['src'] = resolveSource(parsed['src']);
                if (parsed['src'] === null) {
                    throw new TypeError('data-image-sources src cannot be resolved');
                }
                while (index--) {
                    upgrades[index]['src'] = resolveSource(upgrades[index]['src']);
                    if (upgrades[index]['src'] === null) {
                        throw new TypeError('data-image-sources upgrades[' + index + '] src cannot be resolved');
                    }
                }
                // A descriptor naming a different base than the host
                // actually displays would replace the author's image
                // with unrelated content — that is substitution, not
                // sharpening. A base that cannot be established, or
                // does not equal the descriptor's resolved base, leaves
                // this host exactly as authored.
                authoredBase = authoredSrc(element, declaredProperty);
                if (authoredBase === null || resolveSource(authoredBase) !== parsed['src']) {
                    throw new TypeError('data-image-sources src does not match the authored ' +
                            declaredProperty);
                }
                return parsed;
            },

            bind = function (element) {
                var declaredProperty,
                    parsed,
                    upgrades,
                    host,
                    watchTargets,
                    index;
                // The sequence owns its host's source for the whole
                // feature's life; standalone discovery honors that
                // boundary by declaration, not by load order.
                if (element.hasAttribute(sequenceMarker) || nativelySelected(element, false)) {
                    return;
                }
                try {
                    declaredProperty = property(element);
                    parsed = readDeclaration(element, declaredProperty);
                } catch (invalid) {
                    // No valid declaration, no work — the authored
                    // image is already the complete experience. The
                    // declaration grammar refuses with a TypeError;
                    // anything else comes from page or platform code
                    // and goes unreported.
                    if (invalid && invalid['name'] === 'TypeError') {
                        report('paste.ui.progressiveresolution', element, invalid['message']);
                    }
                    return;
                }
                // A base-only declaration has no work to observe.
                if (!parsed['upgrades'].length) {
                    return;
                }
                host = {
                    element: element,
                    property: declaredProperty,
                    base: parsed,
                    representations: imageresolution['representationsFor'](parsed),
                    currentWidth: parsed['width'],
                    currentSrc: parsed['src'],
                    // What the module claims to own on the display
                    // surface right now: an img's src attribute text as
                    // authored (the module never writes it), or the
                    // inline background declaration — value and
                    // priority — as last read or painted. Anything else
                    // there is somebody else's work and commits must not
                    // touch it.
                    ownedValue: declaredProperty === 'src' ? element.getAttribute('src') :
                            element.style.getPropertyValue('background-image'),
                    ownedPriority: declaredProperty === 'src' ? '' :
                            element.style.getPropertyPriority('background-image'),
                    // The computed source the baseline verified — what
                    // the cascade actually displays. A background
                    // claim only stands while this still matches.
                    ownedComputed: declaredProperty === 'src' ? null : parsed['src'],
                    // The computed source the latest background paint
                    // replaced — null before the first.
                    ownedPredecessor: null,
                    // The srcset and sizes the module wrote on an img —
                    // null until it writes them.
                    ownedSrcset: null,
                    ownedSizes: null,
                    // The sizes every img paint writes: the base's own
                    // intrinsic width.
                    sizes: parsed['width'] + 'px',
                    owned: true,
                    failed: $create(null),
                    // URLs whose decode was refused while the document
                    // was hidden — true while hidden, 'due' once the
                    // document is visible until the next pass decides —
                    // whether any is due, and those already retried
                    // once.
                    withheld: $create(null),
                    retryDue: false,
                    retried: $create(null),
                    op: null,
                    // Parked settlements: settledCount of them, in
                    // arrival order.
                    settled: [],
                    settledCount: 0,
                    dirty: true,
                    // A lazy img not yet near the top-level viewport,
                    // whether it is due a nearness check, whether the
                    // proximity observer watches it, and that
                    // observer's latest verdict — null before its first.
                    lazy: declaredProperty === 'src' &&
                            (element.getAttribute('loading') || '').toLowerCase() === 'lazy',
                    probe: false,
                    watched: false,
                    near: null,
                    // A background paint awaiting its computed-source
                    // check on the next pass.
                    verify: false,
                    // The batch time of the current claim's first
                    // pending read, and whether its pending bound ran
                    // out.
                    pendingSince: null,
                    pendingLapsed: false,
                    passCap: null,
                    passNeed: 0,
                    passState: 'owned'
                };
                // A rung whose URL cannot be written as a srcset
                // candidate can never be painted on an img: it is
                // remembered as failed, never fetched.
                if (declaredProperty === 'src') {
                    upgrades = parsed['upgrades'];
                    index = upgrades.length;
                    while (index--) {
                        if (!srcsetSafe(upgrades[index]['src'])) {
                            host.failed[upgrades[index]['src']] = true;
                        }
                    }
                }
                watchTargets = policyWatchTargets(element);
                index = watchTargets.length;
                while (index--) {
                    observeTarget(host, watchTargets[index]);
                }
                if (declaredProperty === 'src') {
                    watchAttributes(element);
                }
                // A host the proximity observer watches needs no scroll
                // input: the observer reports every crossing.
                if (host.lazy) {
                    host.watched = watchProximity(element);
                    if (!host.watched) {
                        if (!lazyScrollTargets.length) {
                            lazyScrollTargets.push($w);
                            listeners.push(new Subscription('scroll', $w, probeDeferred));
                        }
                        watchLazyScroll(element);
                    }
                    deferred.push(host);
                }
                if (!hosts.length && typeof NativeWeakMap === 'function') {
                    try {
                        byElement = new NativeWeakMap();
                    } catch (indexRefused) {
                        // Keep the established scan fallback when indexing is unavailable.
                        byElement = null;
                    }
                }
                hosts.push(host);
                if (byElement) {
                    byElement.set(element, host);
                }
                dirty(host);
            },

            // Within about one viewport of the page viewport, on both
            // axes — a carousel slide off to the side is not near. A
            // box with no size at all is not rendered, and not near.
            nearPage = function (rect) {
                var page = $w.innerHeight || 0,
                    pageWidth = $w.innerWidth || 0;
                return !(rect.width === 0 && rect.height === 0) &&
                    rect.bottom >= -page && rect.top <= page * 2 &&
                    rect.right >= -pageWidth && rect.left <= pageWidth * 2;
            },

            // Whether a deferred host is near now: for a host the
            // proximity observer watches, its latest verdict — not near
            // before its first report; otherwise the box against the
            // window's own viewport.
            nearNow = function (host, rect) {
                if (host.watched) {
                    return host.near === true;
                }
                return rect !== null && nearPage(rect);
            },

            // Declaration order is the bind order. One host's failure —
            // page or platform code that throws anywhere in its bind —
            // leaves that host as authored and never costs a later
            // declaration its enhancement.
            bindAll = function () {
                var declared = $doc.querySelectorAll('[' + marker + ']'),
                    remaining = declared.length,
                    index = 0;
                while (remaining--) {
                    try {
                        bind(declared[index]);
                    } catch (ignore) {
                        // This host keeps its authored image.
                    }
                    index += 1;
                }
            };

        // The pass, armed as one phased request. Its read phase runs
        // before any module writes in the batch, for every host that
        // needs one — a dirty host reads computed policy, fit, insets
        // and source in one style read, then its box; a host only verifying
        // a background paint reads its computed source and nothing
        // else — so no paint or preparation anywhere in the frame
        // disturbs a later read. The snapshot parks on the host.
        readPass = function (at) {
            var ratio = $w.devicePixelRatio,
                index,
                host,
                element,
                base,
                style,
                read,
                rect,
                box;
            if (passRead) {
                return;
            }
            passRead = true;
            frameRequested = false;
            passAt = at;
            index = hosts.length;
            while (index--) {
                host = hosts[index];
                element = host.element;
                rect = null;
                // A deferred lazy host the proximity observer reported
                // near, or one a scroll moved, is probed — by that
                // verdict, or by its box alone where no observer watches
                // it; once near it is read in full.
                if (host.owned && host.lazy && (host.probe || host.dirty)) {
                    host.probe = false;
                    if (!host.watched) {
                        rect = element.getBoundingClientRect ?
                                element.getBoundingClientRect() : null;
                    }
                    if (!nearNow(host, rect)) {
                        host.dirty = false;
                        // The write phase still checks image ownership;
                        // a deferred host needs no style or size policy.
                        host.passCap = 'auto';
                        host.passNeed = 0;
                        continue;
                    }
                    undefer(host);
                    host.dirty = true;
                }
                if (host.owned && (host.dirty || host.verify)) {
                    style = computedStyle(element);
                    read = style && typeof style.getPropertyValue === 'function';
                    // The computed source is the only view of the
                    // display the cascade reports.
                    host.passState = host.property === 'background-image' ?
                            claimState(element, style, host.ownedComputed, host.ownedPredecessor) : 'owned';
                    if (host.dirty) {
                        host.dirty = false;
                        host.probe = false;
                        host.verify = false;
                        base = host.base;
                        host.passCap = capFrom(read ? style.getPropertyValue(capProperty) : null);
                        // The pass's layout read happens once, last.
                        if (rect === null) {
                            rect = element.getBoundingClientRect ?
                                    element.getBoundingClientRect() : null;
                        }
                        box = rect && read ? paintedBox(host, rect, style) : rect;
                        host.passNeed = box ? needFor(
                            box.width,
                            box.height,
                            base['width'],
                            base['height'],
                            read ? (style.getPropertyValue(host.property === 'background-image' ?
                                    'background-size' : 'object-fit') || '').trim() : '',
                            ratio,
                            host.property === 'src'
                        ) : 0;
                    }
                }
            }
        };

        // The write phase, after every module's reads: each dirty host
        // reconciles parked completions, paints what still qualifies
        // against its snapshot, and admits what the snapshot wants; a
        // verifying host checks its claim.
        writePass = function () {
            var remaining,
                index,
                host,
                cap,
                settled,
                settledIndex,
                settledRemaining,
                entry,
                withheld,
                src;
            if (!passRead) {
                return;
            }
            passRead = false;
            // Evaluation order is declaration order: a shared one-shot
            // failure (a construction that throws once) is charged to
            // the earlier host, matching what the page would report.
            remaining = hosts.length;
            index = 0;
            while (remaining--) {
                host = hosts[index];
                index += 1;
                cap = host.passCap;
                if (cap !== null) {
                    host.passCap = null;
                    // Settlements arrive in promise reactions, never
                    // inside a pass, so the drain takes every parked
                    // one. Arrival order is the contract: a later
                    // settlement supersedes an earlier one for the
                    // same host. A decode refused while the document
                    // was hidden was withheld when it settled, never
                    // failed.
                    settled = host.settled;
                    settledRemaining = host.settledCount;
                    host.settledCount = 0;
                    settledIndex = 0;
                    while (settledRemaining--) {
                        entry = settled[settledIndex];
                        settled[settledIndex] = null;
                        src = entry.candidate['src'];
                        if (entry.ok) {
                            commit(host, entry.candidate, cap);
                        } else if (!entry.withheld) {
                            host.failed[src] = true;
                        }
                        settledIndex += 1;
                    }
                    evaluate(host, cap, host.passNeed);
                    host.passNeed = 0;
                    host.passState = 'owned';
                    // The retry visibility granted belonged to this pass:
                    // a due URL it did not select is released, and a
                    // later selection is a fresh attempt.
                    if (host.retryDue) {
                        host.retryDue = false;
                        withheld = host.withheld;
                        for (src in withheld) {
                            if (withheld[src] === 'due') {
                                delete withheld[src];
                            }
                        }
                    }
                } else if (host.verify && host.owned) {
                    host.verify = false;
                    displayOwned(host);
                    host.passState = 'owned';
                }
            }
            // A commit that needs its display verified, or a claim
            // still pending behind a transition inside its bound,
            // marked its host inside the pass; that verification is
            // the next pass.
            index = hosts.length;
            while (index--) {
                host = hosts[index];
                if (host.owned && (host.dirty || host.verify)) {
                    schedule();
                    break;
                }
            }
        };

        if (NativePromise !== null) {
            bindAll();

            // No declared host, no shared input listeners at all.
            if (hosts.length) {
                listeners.push(new Subscription('resize', $w, dirtyEveryHost));
                // A visible document re-reads every host, and a decode
                // it refused while hidden gets its one retry.
                listeners.push(new Subscription('visibilitychange', $doc, function () {
                    if (!$doc.hidden) {
                        retryWithheld();
                        dirtyEveryHost();
                    }
                }));
                // The device pixel ratio has no event of its own; the
                // shared media-query utility watches the current ratio
                // and re-arms on each change. A platform that cannot
                // observe it gets no watch; resize still re-reads the
                // ratio. The watch lives as long as the page.
                mediaquery['watchResolution'](dirtyEveryHost);
            }
        }

        return progressiveresolution;
    }
);
