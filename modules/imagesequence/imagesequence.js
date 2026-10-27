/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * An ordered set of images presented as successive frames inside an
 * existing host, driven by a declared scroll relationship and an
 * optional finite intro.
 *
 * 1. 'data-paste-imagesequence' on the host names a
 *    script[type="application/json"] frame catalog; the host's authored
 *    image is the baseline and stays until a real frame is ready.
 * 2. The scrub relationship belongs to a 'data-paste-scrollscrub'
 *    element — named by 'data-sequence-scrub' or the nearest ancestor
 *    scope — and this module measures that same declaration through
 *    shared geometry. 'data-sequence-from'/'data-sequence-to' declare
 *    which catalog indices the scroll range samples — inclusive, and
 *    reversible without dropping frames an intro may still need.
 * 3. Progress maps to an index; the desired frame is prepared through a
 *    native Image and committed only when it is still the desired frame
 *    — delayed and out-of-order loads never regress the paint. Every
 *    request carries the representation the pass's measured policy
 *    selects — a sharper candidate is chosen before the fetch, never
 *    fetched after it, and a failed URL falls back to the best
 *    surviving rung on either request path. A bounded window ahead of
 *    the travel direction — the scroll range's own direction or the
 *    intro clock's eased horizon — prepares behind the desire; at most
 *    six loads per sequence run in flight, admission reclaims
 *    lower-priority retained frames only when the reclaim actually
 *    makes the candidate fit, and retained decoded pixels stay under a
 *    bounded budget.
 * 4. 'data-sequence-intro-*' declares one finite introductory playback:
 *    an elapsed clock selects indices across its own catalog range with
 *    the same sampling rule. 'data-sequence-intro-buffer-ms' is the
 *    authored startup lead — the poster stands until every index the
 *    easing traverses inside that window is ready, and only then does
 *    the clock start; a set that cannot fund ends the intro once.
 *    Direct playback: completion, skip, scroll, document hiding or reduced
 *    motion ends the phase and hands ownership to the live scroll
 *    position — a late intro completion never regains the source.
 *    'data-sequence-scrub-buffer-frames' is the authored scroll gate —
 *    a presentation change holds the standing image until the desired
 *    frame and its following frames in the direction of travel are all
 *    ready; once open it stays open until a miss closes it again. The
 *    gate governs scroll-driven presentation and the handoff, never the
 *    active intro — a playing intro's eased forward horizon is its own
 *    demand, and the scroll range's stored direction may run backward
 *    from it.
 * 5. A failed load leaves the current image standing. A range that
 *    cannot measure — degenerate, unrendered, or a root that does not
 *    scroll — admits and paints nothing: before the first paint that is
 *    the authored baseline, afterwards the last painted frame. Reduced
 *    motion keeps the authored static presentation and permits
 *    refining only the declared initial frame. The baseline is
 *    content, not a placeholder.
 * 6. 'data-paste-progressiveresolution' on the host opts a
 *    displayed frame into sharper representations: the painted need
 *    and the CSS '--paste-resolution-max-width' cap — read with the one
 *    plain-decimal grammar every resolution owner shares, so the same
 *    CSS caps every image alike — pick the smallest sufficient upgrade,
 *    committed only when strictly better.
 *    The device pixel ratio moving — a window dragged to another
 *    monitor, browser zoom — is an input of its own.
 *
 * Queued playback: data-sequence-playback=queued preserves a running intro,
 * then plays the scroll range toward the newest destination. The optional
 * data-sequence-playback-fps is an integer 1..120 (default 30). Each ready
 * presentation advances at most one index, with bounded resource preparation;
 * completion consumes that travel and stops clock work. Skip, history return
 * and intro failure hand off directly. Native scrolling is never intercepted.
 *
 * Authoring
 *
 * Load 'paste.ui.imagesequence' through the ordinary Paste
 * include. The sequence reads the scrub declaration and resolution
 * policy through its own dependencies — neither scrollscrub's
 * CSS-output entry nor the standalone progressiveresolution entry is
 * required, and the standalone entry skips a sequence-declared host
 * anyway. Paste loads at the end of the page; binding is immediate and
 * there is no controller, event, or readiness surface for an author to
 * wire.
 *
 * The host is an element that already presents an image — an img's
 * authored src attribute or a CSS background-image that is a single
 * url() (or none); an img host whose src attribute is absent or blank,
 * or a background that is layered or generated — a gradient beside a
 * url(), several url()s — is a malformed declaration. That authored
 * image is the baseline: it stays painted until a representation of
 * the currently wanted frame is ready, and it is the whole experience
 * when the module is absent, a declaration is invalid, reduced motion
 * applies, or loads fail.
 *
 * @example
 *     <!-- A decorative host: no alt text on a background, and the
 *          content beside it stands on its own. The authored CSS owns
 *          the painted surface — sizing, crop, and the baseline image
 *          are all plain styles the page already had. -->
 *     <style>
 *       .product-visual {
 *         display: block;
 *         width: 100%;
 *         aspect-ratio: 1 / 1;
 *         background-size: cover;
 *         background-position: center;
 *         background-image: url('/images/product-0-640.webp');
 *       }
 *     </style>
 *     <section id="product"
 *              data-paste-scrollscrub
 *              data-scrub-start="top top"
 *              data-scrub-end="bottom top">
 *       <i class="product-visual"
 *          data-paste-imagesequence="#product-frames"
 *          data-sequence-intro-from="0"
 *          data-sequence-intro-to="2"
 *          data-sequence-intro-duration-ms="2400"
 *          data-sequence-intro-buffer-ms="1000"
 *          data-sequence-intro-easing="ease-in-out"
 *          data-sequence-intro-skip="#product-intro-skip"
 *          data-sequence-scrub-buffer-frames="3"
 *          data-sequence-from="2"
 *          data-sequence-to="0"
 *          data-paste-progressiveresolution
 *          aria-hidden="true"></i>
 *       <button id="product-intro-skip" type="button" hidden>
 *         Skip animation
 *       </button>
 *       <div class="product-copy">
 *         <h1>Product name</h1>
 *         <p>The description is available without animation.</p>
 *       </div>
 *     </section>
 *
 *     <script type="application/json" id="product-frames">
 *     {
 *       "frames": [
 *         {"src": "/images/product-0-640.webp", "width": 640, "height": 640,
 *          "upgrades": [
 *            {"src": "https://images-b.example.com/product-0-1280.webp",
 *             "width": 1280, "height": 1280}
 *          ]},
 *         {"src": "/images/product-1-640.webp", "width": 640, "height": 640,
 *          "upgrades": [
 *            {"src": "https://images-b.example.com/product-1-1280.webp",
 *             "width": 1280, "height": 1280}
 *          ]},
 *         {"src": "/images/product-2-640.webp", "width": 640, "height": 640,
 *          "upgrades": [
 *            {"src": "https://images-b.example.com/product-2-1280.webp",
 *             "width": 1280, "height": 1280}
 *          ]}
 *       ]
 *     }
 *     </script>
 *
 * The declaration above plays frames 0 to 2 once over 2.4 seconds when
 * the intro's authored startup set can paint — the 1000 ms buffer
 * threshold covers indices 0 and 1 under the declared ease-in-out, so
 * both prepare before the clock starts; a 400 ms threshold would have
 * covered only the opening frame. The authored skip control is
 * ordinary HTML, initially hidden, shown only while it can skip — then
 * the intro hands the sequence to scroll, which samples the reverse
 * range 2 to 0 across the section's traverse. Each frame descriptor
 * may carry 'upgrades', ascending intrinsic widths of the same
 * content; an absolute URL keeps its own origin, so a sharper frame
 * can come from a different image host than its base.
 *
 * @example
 *     <!-- An ordinary meaningful image: real alt text, intrinsic
 *          dimensions, the authored src as baseline, and an explicit
 *          scope reference instead of the nearest ancestor -->
 *     <section id="assembly"
 *              data-paste-scrollscrub
 *              data-scrub-start="top bottom"
 *              data-scrub-end="bottom top">
 *       <h2>Opening the assembly</h2>
 *       <img src="https://images-a.example.com/assembly/frame-0-640.webp"
 *            width="640" height="360"
 *            alt="The assembly and its opening mechanism"
 *            data-paste-imagesequence="#assembly-frames"
 *            data-sequence-scrub="#assembly">
 *     </section>
 *
 *     <script type="application/json" id="assembly-frames">
 *     {
 *       "frames": [
 *         {"src": "https://images-a.example.com/assembly/frame-0-640.webp",
 *          "width": 640, "height": 360},
 *         {"src": "https://images-a.example.com/assembly/frame-1-640.webp",
 *          "width": 640, "height": 360},
 *         {"src": "https://images-a.example.com/assembly/frame-2-640.webp",
 *          "width": 640, "height": 360}
 *       ]
 *     }
 *     </script>
 *
 * Attributes on the host. Every number is written in plain decimal
 * digits exactly as the attribute text — no sign, exponent,
 * hexadecimal prefix or surrounding whitespace; a decimal may also be
 * written '.5' or '3000.', a whole number may not carry a point — and
 * an attribute present but empty is malformed, never a default:
 *
 *   data-paste-imagesequence — required; a '#id' reference to
 *       one script[type="application/json"] catalog block, embedded and
 *       inert — data, not executable configuration.
 *   data-sequence-scrub    — selector for the declared scrollscrub
 *       scope; it must match exactly one element carrying
 *       'data-paste-scrollscrub'. Default is the nearest
 *       ancestor-or-self carrying that marker.
 *   data-sequence-playback — direct (default) or queued. Queued preserves
 *       a running intro, then traverses to the latest scroll destination.
 *   data-sequence-playback-fps — queued travel rate, integer 1..120,
 *       default 30; malformed unless playback is queued.
 *   data-sequence-from     — catalog index at scroll progress 0;
 *       default 0.
 *   data-sequence-to       — catalog index at progress 1; default the
 *       last index. May be lower than from for reverse playback —
 *       equal endpoints select that one frame.
 *   data-image-property    — which existing source property the module
 *       writes: 'src' (img only) or 'background-image'; default is by
 *       tag name. On an img a frame's own base paints as src, while a
 *       sharper representation is always written as a module-owned
 *       srcset width descriptor with a module-owned sizes equal to the
 *       base frame's intrinsic width, so the box never grows with the
 *       pixels whatever the CSS sizing — authored width and height
 *       attributes do not change this. The pair comes off before the
 *       next base paint and on reduced motion, each attribute only while
 *       it still holds the module's own value. An img carrying an
 *       authored srcset or sizes — sizes alone included — or inside a
 *       picture, is skipped silently: native selection already owns its
 *       source and the module never overwrites an authored sizes, as
 *       progressiveresolution also treats it.
 *   data-paste-progressiveresolution — presence permits
 *       sharper representations of the displayed frame under the CSS
 *       resolution policy.
 *   data-sequence-intro-duration-ms — a positive duration enables one
 *       finite intro; absent or zero means scroll ownership only.
 *   data-sequence-intro-from / -to — the intro's own catalog range;
 *       default the whole catalog. Its frames may sit outside the
 *       scroll range.
 *   data-sequence-intro-buffer-ms — the authored startup lead: the
 *       poster stands until every catalog index the declared easing
 *       traverses inside this horizon can paint at the selected
 *       resolution, then the intro clock starts. Absent or zero means
 *       only the opening frame must be ready. The wait is bounded —
 *       a member that cannot arrive, a set that cannot fit the decoded
 *       budget, or the deadline ending ends the intro once; it never
 *       pauses or restarts the clock afterwards.
 *   data-sequence-intro-trigger — 'ready' only: the clock starts once
 *       the intro's buffered frames can actually paint and the user is
 *       still at the authored start.
 *   data-sequence-intro-easing — 'ease-in-out' (default) or 'linear'.
 *   data-sequence-intro-skip — optional. Absent, the intro has no skip
 *       control and, in direct mode, any scroll, a hidden document, reduced motion,
 *       failure, or completion still ends it. Present, a selector for
 *       exactly one authored button whose effective type is 'button'
 *       (type="button" written out: a button's default type is submit)
 *       and which is authored with the hidden attribute. Click, direct-mode
 *       scroll, a hidden document, reduced motion, failure, or
 *       completion hands ownership to live scroll, and the intro does
 *       not replay on a history return. A skip declaration that
 *       resolves to anything else — an empty or unusable selector, no
 *       element, several, a submit button, a visible control, or a
 *       control another sequence also names — is malformed: the whole
 *       host stays at its authored baseline, with neither intro nor
 *       scrubbing, and the control is never touched. When the retiring
 *       control holds focus, focus moves to the scrollscrub scope
 *       (given tabindex="-1" for as long as it keeps that focus when it
 *       carries no tabindex of its own); the module reads back whether
 *       focus actually landed, and when it did not the borrowed
 *       tabindex comes off at once and the control is blurred. The
 *       borrowed tabindex is removed only while it is still the
 *       module's own "-1".
 *   data-sequence-scrub-buffer-frames — the authored scrub gate, a
 *       nonnegative integer F defaulting to 0: a frame change holds
 *       until F frames are ready — the desired index plus the F − 1
 *       that follow it in the direction of travel, clipped at the
 *       range endpoint (two frames left means those two, never an
 *       impossible wait). Absent or zero means each desired frame
 *       paints the moment it is ready. While the gate stands closed
 *       the standing image keeps standing and the desire still tracks
 *       the live scroll position; a set that can never fund is
 *       remembered rather than retried forever.
 *
 * JavaScript owns the one declared image property — for an img, also
 * the srcset/sizes pair it writes — and the skip control's visibility
 * while an intro runs. CSS owns sizing, crop,
 * background position, aspect, and every presentation choice — the
 * module reads painted geometry, never writes layout. Catalog sources
 * resolve once against the document base URL at bind: a relative or
 * root-relative source takes the document base's origin (a base
 * element can point it elsewhere than the page), an absolute URL keeps
 * its host, and module CDN delivery never rewrites image origins. A
 * catalog source the platform cannot parse is a malformed declaration;
 * an authored baseline it cannot parse is simply never adopted. A host
 * whose declared property is src carries its authored crossorigin and
 * referrerpolicy attributes to its preparation fetches; a
 * background-image property adds none, whatever the host's tag.
 *
 * A background-image paint is a claim, verified in the next pass. It
 * stands while the computed background-image is that single url(); a
 * computed value that still includes the module's URL among others — a
 * cross-fade while a background-image transition runs — keeps the claim
 * and is verified again on the next pass. Where the platform lists the
 * host's animations (getAnimations), that list is the only transition
 * evidence: a background-image transition still in flight — inside its
 * delay or running — keeps the claim pending whatever older source the
 * computed value still names, so paints chained faster than the
 * transition keep it; with none in flight, anything else is another
 * writer — a stylesheet !important rule outranking the inline frame
 * included, whatever transition the host declares — and the paint
 * reverts to what stood before it only while its inline value and priority
 * remain owned. A newer inline declaration is preserved; completion work
 * yields until a fresh page input permits another presentation decision.
 * A pending claim requests its own verification passes for at most
 * five seconds of frame time from its first pending read — far longer
 * than a background-image transition runs. Past that bound no frame is
 * requested for it; the next pass an input brings reads it once more,
 * and a value still pending then counts as owned mid-transition and is
 * never reverted. A fresh claim starts a fresh bound.
 * Where the platform cannot list animations, the declared transition
 * stands in. Under a background-image transition — the host's computed
 * transition-property naming 'all', 'background' or 'background-image'
 * with a positive combined duration and delay at that position — the
 * computed value can still be the source the paint replaced before the
 * transition reports the change: a value whose url() tokens name that
 * predecessor is pending too, but only inside the bound, and at or past
 * it is another writer. Without such a transition the predecessor
 * still showing is another writer, and so is anything else.
 * Sharpening waits while a claim is pending; the pass after a claim
 * settles as owned sharpens with whatever landed meanwhile.
 *
 * Malformed declarations. Every declaration this module rejects — a
 * bad attribute value (an empty one included), catalog, scope
 * reference or skip, an img host without an authored src, a layered
 * background baseline — leaves that whole host exactly as authored
 * while every other host binds normally, and is reported once per host
 * as a TypeError whose message starts 'paste.ui.imagesequence #id: '
 * (the tag name for a host without an id): the error is rethrown on a
 * later task through the timer captured at define, so it reaches the
 * platform's error reporting without a console call and without
 * interrupting the page; a timer that refuses loses the report, never
 * the sweep. A natively selected img host is skipped silently. Page or
 * platform code that throws — while a host binds or inside a frame pass —
 * is contained without a report: the host stays as authored, or that
 * host's intro ends and its pass state clears, and the other hosts
 * carry on.
 *
 * Failure and motion. A load that errors is remembered for the page's
 * life and never retried, and so is a decode refused while the
 * document is visible. So is a representation whose decoded pixels
 * contradict its catalog entry — a natural width other than the
 * declared width, or an aspect ratio more than 1% from the declared
 * one — whatever the document's visibility: mislabelled pixels would
 * change an img's box once written as a width descriptor. An image
 * reporting no natural size cannot contradict its entry, and neither
 * can a vector source, whose reported size is the engine's own
 * default, not pixels. A decoded image does not report its media type,
 * so a vector source is recognised by its URL alone: a path ending
 * '.svg' or '.svgz' (before any query or fragment), or an
 * image/svg+xml data URL. An SVG served at any other URL is held to
 * its catalog size and, where the engine reports a default box for
 * it, fails; a raster served at such a path is not size-checked.
 * A decode refused while the document is hidden
 * — not fully active, a cached page being restored — is withheld until
 * it is visible again and then retried once; a second refusal is
 * final. An Image constructor that refuses is no verdict on the URL:
 * the next input asks again. Optional work — lookahead and sharpening —
 * never waits for the document's own load event; a sequence bound
 * before that event re-measures once when it fires, as scrollscrub
 * does, because a late image or font can move a subject inside a box
 * whose size never changes. Reduced motion follows
 * the authored preference through the shared media-query record: a
 * preference the platform cannot report — no matchMedia, a query that
 * throws, or one no change listener can be attached to — counts as
 * reduced and keeps every host on its static baseline. Each pass reads
 * the preference once, in its read phase: a reported change only
 * schedules a pass, and a change the platform never reports is
 * honoured by the next pass anything else asks for; the pass applies it
 * after its read phase, and the authored baseline is re-adopted in the
 * next read phase. A background baseline restored through a
 * background-image transition is adopted only once that transition has
 * settled — until then the computed value is the transition's: the
 * pass its settling asks for, where the platform lists animations, or
 * else the next one an input brings, adopts it, and nothing polls in
 * between. Under reduced motion a scroll asks for no pass.
 *
 * Session record. A declared intro never replays on a history return: when
 * its clock starts, the module writes a sessionStorage entry keyed by
 * the page URL without its fragment, the catalog reference, the
 * declared scroll and intro ranges, and the host's id (or ordinal). A
 * back/forward return to a scene whose entry exists restores straight
 * into scroll ownership — the intro never replays on a history return,
 * as the contract requires. An ordinary load or reload plays it again,
 * and storage that is unavailable or refuses simply means no record.
 *
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/scrollrange
 * @requires paste/ui/utilities/imageresolution
 * @requires paste/ui/utilities/mediaquery
 * @module paste/ui/imagesequence
 */
paste['define'](
    'paste.ui.imagesequence',
    [
        'paste.event',
        'paste.ui.utilities.animation-frame',
        'paste.ui.utilities.scrollrange',
        'paste.ui.utilities.imageresolution',
        'paste.ui.utilities.mediaquery'
    ],
    function (imagesequence, event, animation_frame, scrollrange, imageresolution, mediaquery) {
        'use strict';

        // Every module-started fetch and decode settles through a native
        // promise, and every preparation is a native Image — there is
        // no other expression of that contract. Those constructors and
        // every other global the module touches are captured once, here:
        // a page script replacing a global later can neither strand an
        // operation half-way nor change which facility a later pass
        // uses. Absent either capability the enhancement itself cannot
        // exist, so every scan, subscription, probe and write stays
        // behind the one gate: declared hosts keep their authored
        // baselines untouched.
        var $w = window,
            $doc = document,
            NativeImage = typeof $w['Image'] === 'function' ? $w['Image'] : null,
            NativeResizeObserver = typeof $w['ResizeObserver'] === 'function' ? $w['ResizeObserver'] : null,
            NativeWeakMap = typeof $w['WeakMap'] === 'function' ? $w['WeakMap'] : null,
            $performance = $w['performance'],
            $location = $w['location'],
            // Storage access itself can throw where the page denies it.
            $sessionStorage = (function () {
                try {
                    return $w['sessionStorage'] || null;
                } catch (denied) {
                    return null;
                }
            }()),
            $math = Math,
            $floor = $math['floor'],
            $min = $math['min'],
            $max = $math['max'],
            $abs = $math['abs'],
            $pow = $math['pow'],
            $isFinite = isFinite,
            $Number = Number,
            $String = String,
            $create = Object['create'],
            $setTimeout = $w['setTimeout'],
            $clearTimeout = $w['clearTimeout'],
            NativePromise = typeof Promise === 'function' ? Promise : null,
            Subscription = event['Event']['Subscription'],
            cssUrl = imageresolution['cssUrl'],
            cssUrlSource = imageresolution['cssUrlSource'],
            cssUrlSources = imageresolution['cssUrlSources'],
            capFrom = imageresolution['capFrom'],
            tagName = imageresolution['tagName'],
            computedStyle = imageresolution['computedStyle'],
            report = imageresolution['report'],
            readFragment = imageresolution['readFragment'],
            resolveSource = imageresolution['resolveSource'],
            property = imageresolution['property'],
            nativelySelected = imageresolution['nativelySelected'],
            policyWatchTargets = imageresolution['policyWatchTargets'],
            listedTransition = imageresolution['listedTransition'],
            claimState = imageresolution['claimState'],
            prepare = imageresolution['prepare'],
            scrollOffset = scrollrange['scrollOffset'],
            measureRange = scrollrange['measure'],
            needFor = imageresolution['needFor'],
            paintedBox = imageresolution['paintedBox'],
            selectCandidate = imageresolution['selectCandidate'],
            requestPhased = animation_frame['requestPhased'],
            motionReduced = mediaquery['motionReduced'],
            marker = 'data-paste-imagesequence',
            scrubMarker = 'data-paste-scrollscrub',
            resolutionMarker = 'data-paste-progressiveresolution',
            decodedBudgetBytes = 33554432,
            // Six outstanding requests per sequence — each sequence
            // keeps its own books, so active scenes never share or
            // starve one another's slots. The bound is a candidate
            // limit: enough in flight to keep a playing lead fed
            // without turning the whole catalog into demanded work.
            maxInFlight = 6,
            // The lookahead is the direction of travel's own lead —
            // bounded so a long catalog never becomes one speculative
            // batch, and further bounded by the decoded budget at
            // admission. For the intro the horizon is time, not a
            // frame count: the index the declared easing reaches in
            // the next horizon-milliseconds.
            lookaheadMax = 8,
            introHorizonMs = 500,
            // A waiting intro's outer bound — internal, not an author
            // attribute: the authored startup buffer must be ready
            // inside this window or the intro is abandoned once, for
            // the host's lifetime.
            introWaitDeadlineMs = 15000,
            // How long, in frame time, a pending background claim
            // requests its own verification passes.
            pendingVerifyMs = 5000,
            // A required set's standing, as setStatus reports it.
            WAITING = 0,
            READY = 1,
            DEAD = 2,
            // Plain decimal digits, nothing else, matched against the
            // attribute text exactly as authored: Number() would also
            // accept '0x2', '0b1', '1e0', '-0' and surrounding
            // whitespace.
            integerText = /^[0-9]+$/,
            decimalText = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/,
            // A srcset candidate URL runs to the first whitespace and
            // loses trailing commas — a URL that would split or lose
            // characters there cannot be written as one.
            srcsetUnsafe = /\s|^,|,$/,
            sequences = [],
            rootGroups = [],
            // The page-life inputs shared by every sequence — resize and
            // visibility, and the document's one-shot load — held here;
            // nothing ever disposes them, and the load input retires
            // itself after its one delivery.
            pageInputs = [],
            // The declared hosts the define-time sweep found, and the
            // walk that arms the pixel-ratio watch.
            hosts,
            watchIndex,
            // Every control a declared skip resolves to, tallied before
            // any host binds — one control can never serve two owners,
            // and a contested declaration disables each claimant's
            // intro rather than letting document order pick a winner.
            declaredSkipClaims = [],
            // One ResizeObserver for the whole module: observed maps a
            // watched target to the sequences whose geometry or policy
            // it can move, keyed privately so an entry finds its record
            // in one probe rather than a scan. A hostile or absent
            // facility leaves observerFailed set and the
            // scroll/resize/visibility inputs carrying the refresh
            // alone.
            observed = null,
            observer = null,
            observerFailed = false,
            // Whether the one pass is requested and has not yet run.
            frameRequested = false,
            // Whether this batch's read phase ran the pass and its write
            // phase has not yet: should a request that threw (see
            // schedule) still have queued its pair, it can land beside
            // the next one, and only one of them runs.
            passRead = false,
            // Whether a demanded admission of the sequence the pass is
            // working on was refused for capacity: optional work —
            // speculation and sharpening — never admits behind it in
            // the same evaluation, or it would spend the room the
            // demand is waiting for.
            demandRefused = false,
            readPass,
            writePass,
            // The motion answer the read phase took, carried to the same
            // batch's write phase.
            passMotionNow = true,
            passMotionChanged = false,
            // The authored-motion answer is CSS's; the sequence only
            // honors it, through the shared media-query record — a
            // preference the module cannot observe counts as reduced.
            // Null until the first declared host is found.
            motionRecord = null,
            // The motion answer the module last acted on. A reported
            // change only schedules a pass; the pass compares the
            // record's answer against this one after its read phase
            // and applies the transition there, so the writes it
            // makes never precede a read in the same frame.
            motionSeen = true,

            // Whether a prepared image can prove its pixels
            // asynchronously — the same decode() the preparation op
            // completes on. Probed once on a fresh Image: where the
            // platform has no decode, the documented load evidence is
            // the only readiness proof there is.
            decodeSupported = false,

            easeLinear = function (p) {
                return p;
            },

            easeInOut = function (p) {
                return p < 0.5 ? 2 * p * p : 1 - $pow(-2 * p + 2, 2) / 2;
            },

            // The live motion answer, for the few reads made outside a
            // pass — bind, and a completion landing between passes. A
            // record whose answer throws counts as reduced, like one the
            // platform cannot report at all. Inside a pass the read
            // phase's own answer (passMotionNow) is the only one used.
            reducedMotion = function () {
                try {
                    return motionReduced(motionRecord) === true;
                } catch (unreadable) {
                    return true;
                }
            },

            // The one error a bind refusal throws for a declaration
            // problem. Anything else a bind throws comes from page or
            // platform code: contained, the host left as authored, and not reported.
            declarationError = null,

            malformed = function (problem) {
                declarationError = new TypeError(problem);
                return declarationError;
            },

            // The captured timers, refusals contained: a refused wake is
            // no wake, and a refused clear leaves a wake whose own
            // identity check already makes it inert.
            startTimer = function (callback, delay) {
                if (typeof $setTimeout !== 'function') {
                    return null;
                }
                try {
                    return $setTimeout(callback, delay);
                } catch (refused) {
                    return null;
                }
            },

            stopTimer = function (id) {
                if (id === null || typeof $clearTimeout !== 'function') {
                    return;
                }
                try {
                    $clearTimeout(id);
                } catch (ignore) {
                    // The wake checks its own identity when it fires.
                }
            },

            retirePlaybackWake = function (sequence) {
                stopTimer(sequence.playWakeId);
                sequence.playWakeId = null;
                sequence.playWakeAt = null;
            },

            pixelsFor = function (rep) {
                return rep.width * rep.height * 4;
            },

            attribute = function (element, name) {
                return element.getAttribute('data-' + name);
            },

            // A back/forward navigation may land on a fresh document or
            // on a cached one — the module assumes neither. Each declared
            // scene's intro is recorded in sessionStorage when its clock
            // starts: a history return to
            // a scene whose intro already ran restores straight into
            // scroll ownership rather than replaying the opening.
            backForwardNavigation = function () {
                var performance = $performance,
                    entry = performance && typeof performance['getEntriesByType'] === 'function' &&
                        performance['getEntriesByType']('navigation')[0];
                if (entry && entry['type']) {
                    return entry['type'] === 'back_forward';
                }
                return !!(performance && performance['navigation'] &&
                    performance['navigation']['type'] === 2);
            },

            // The consumption key is private to one declared scene on
            // one page: the document's own URL without its fragment —
            // location, not baseURI, which a base element can point
            // elsewhere — the sequence's own declaration, and a stable
            // host discriminator. Hosts without ids key by their
            // ordinal among the document's declared hosts.
            introSessionKey = function (element, declaration, ordinal) {
                var href = $location && $location['href'];
                if (!href) {
                    return null;
                }
                return 'paste-ui-imagesequence-intro|' +
                    $String(href).split('#')[0] + '|' + declaration + '|' +
                    (element.id ? 'id:' + element.id : 'host:' + ordinal);
            },

            introConsumedInSession = function (key) {
                try {
                    return !!(key && $sessionStorage &&
                        $sessionStorage['getItem'](key) === '1');
                } catch (unavailable) {
                    return false;
                }
            },

            recordIntroConsumed = function (sequence) {
                try {
                    if (sequence.introKey && $sessionStorage) {
                        $sessionStorage['setItem'](sequence.introKey, '1');
                    }
                } catch (ignore) {
                    // Denied storage means no record — the intro may
                    // play again, never a broken page.
                }
            },

            // The attribute text as authored, when it is plain decimal
            // digits — optionally with a fraction — or NaN.
            decimalValue = function (text, integer) {
                var value = $String(text);
                return (integer ? integerText : decimalText).test(value) ? $Number(value) : NaN;
            },

            // The resolution policy's whole read in one snapshot — the
            // CSS cap, the device pixel ratio, the painted box, and the
            // fit the display applies (background-size for a painted
            // background, object-fit for an image element). Gathering it
            // in the scheduled pass's read phase is what keeps every
            // later commit a pure write: nothing re-reads style or
            // layout after a paint. The snapshot is the sequence's own
            // carrier, refilled in place; its version moves only when
            // one of its inputs actually changed, so the selection memo
            // outlives passes that change nothing. The style is the
            // read phase's one computed-style read for this host. The
            // cap uses the one plain-decimal reading every resolution
            // owner shares, so the same CSS caps every image alike.
            policyRead = function (sequence, style) {
                var host = sequence.element,
                    policy = sequence.policy,
                    readable = !!style && typeof style.getPropertyValue === 'function',
                    cap,
                    fit,
                    ratio,
                    rect,
                    width,
                    height;
                cap = capFrom(readable ? style.getPropertyValue('--paste-resolution-max-width') : null);
                fit = readable ? (style.getPropertyValue(sequence.property === 'background-image' ?
                        'background-size' : 'object-fit') || '').trim() : '';
                ratio = $w.devicePixelRatio || 1;
                // The layout read happens once, last.
                rect = host.getBoundingClientRect ? host.getBoundingClientRect() : null;
                if (rect && readable) {
                    rect = paintedBox(sequence, rect, style);
                }
                width = rect ? rect.width : 0;
                height = rect ? rect.height : 0;
                if (cap !== policy.cap || fit !== policy.fit || ratio !== policy.devicePixelRatio ||
                        width !== policy.width || height !== policy.height) {
                    policy.cap = cap;
                    policy.fit = fit;
                    policy.devicePixelRatio = ratio;
                    policy.width = width;
                    policy.height = height;
                    policy.version += 1;
                }
                policy.read = true;
                return policy;
            },

            // The only evidence a background claim needs: the source the
            // cascade actually computed, read in the pass after the
            // paint — not a re-measure of the whole scene. Before a
            // displayed frame, or where the style cannot be read or the
            // value is blank, there is no evidence ('unread'); the
            // shared claim rule answers otherwise.
            claimEvidence = function (sequence, style) {
                var rep = sequence.displayedRep;
                return rep ? claimState(sequence.element, style, rep.src, sequence.claimPredecessor) : 'unread';
            },

            // The authored buffering thresholds — a nonnegative
            // millisecond count for the intro's startup lead, a
            // nonnegative integer frame count for scroll-driven
            // presentation. Omitted means zero, which adds no gate.
            // Anything else is a bad declaration and leaves the host
            // at its authored baseline through bind's catch.
            bufferValue = function (element, name, integer) {
                var text = attribute(element, name),
                    value;
                if (text === null) {
                    return 0;
                }
                if (text === '') {
                    throw malformed('data-' + name + ' must not be empty');
                }
                value = decimalValue(text, integer);
                if (!$isFinite(value)) {
                    throw malformed('data-' + name + ' must be a nonnegative' +
                        (integer ? ' integer' : '') + ' decimal number');
                }
                return value;
            },

            // An explicitly empty index is a malformed declaration, not
            // a zero — Number('') would silently activate the first
            // frame's entry.
            catalogIndex = function (text, name, count) {
                var value;
                if (text === null) {
                    return null;
                }
                if (text === '') {
                    throw malformed(name + ' must not be empty');
                }
                value = decimalValue(text, true);
                if (!$isFinite(value) || value >= count) {
                    throw malformed(name + ' must be an integer index within the catalog');
                }
                return value;
            },

            // Both the scroll range and the intro range sample a
            // catalog interval the same way: inclusive endpoints,
            // sign carrying direction, equal ends selecting one frame.
            indexOnRange = function (from, to, progress) {
                var count = $abs(to - from) + 1,
                    offset = $min(count - 1, $floor(progress * count));
                return from + (to >= from ? 1 : -1) * offset;
            },

            // Ownership accounting. Every decoded image the sequence
            // owns — a retained entry under any alias index, the
            // standing image, a landed result awaiting reconciliation,
            // a request physically in flight — holds its URL here. One
            // URL is one decoded image: the running total prices it
            // once however many holders share it, so nothing is ever
            // double-counted and no scan re-sums the books.
            hold = function (sequence, rep) {
                var holds = sequence.holds,
                    count = holds[rep.src];
                // Any ownership change can move what a reservation funds.
                sequence.reservationSet = null;
                if (count === undefined) {
                    holds[rep.src] = 1;
                    sequence.ownedBytes += pixelsFor(rep);
                } else {
                    holds[rep.src] = count + 1;
                }
            },

            release = function (sequence, rep) {
                var holds = sequence.holds,
                    count = holds[rep.src];
                sequence.reservationSet = null;
                if (count === 1) {
                    delete holds[rep.src];
                    sequence.ownedBytes -= pixelsFor(rep);
                } else if (count !== undefined) {
                    holds[rep.src] = count - 1;
                }
            },

            setPrepared = function (sequence, index, record) {
                var prepared = sequence.prepared,
                    existing = prepared[index];
                if (existing === record) {
                    return;
                }
                if (existing !== undefined) {
                    release(sequence, existing.rep);
                }
                prepared[index] = record;
                hold(sequence, record.rep);
            },

            deletePrepared = function (sequence, index) {
                var prepared = sequence.prepared,
                    existing = prepared[index];
                if (existing !== undefined) {
                    delete prepared[index];
                    release(sequence, existing.rep);
                }
            },

            setDisplayed = function (sequence, index, rep, ready) {
                sequence.reservationSet = null;
                if (sequence.displayedRep) {
                    release(sequence, sequence.displayedRep);
                }
                sequence.displayedIndex = index;
                sequence.displayedRep = rep;
                sequence.displayedReady = ready;
                if (rep) {
                    hold(sequence, rep);
                }
            },

            // Whether a URL can still be requested: a load error is the
            // resource's own failure and lasts the page's life, and so
            // is a decode refused while the document was visible. Only a
            // decode refused while the document was hidden — the one
            // state in which the platform may decline to decode a good
            // load — is withheld until the document is visible again,
            // and that retry happens at most once per URL.
            sourceAlive = function (sequence, src) {
                return sequence.failed[src] !== true && sequence.undecoded[src] !== true;
            },

            // The authored image is already a usable presentation: when
            // it matches a catalog frame the sequence adopts it rather
            // than re-fetching what the page already showed. The
            // cascade, not the attribute, decides what a background
            // displays: an authored !important rule overrides an inline
            // frame, so the computed value is the honest read — the read
            // phase's own style for this host when it took one. An img's
            // baseline is its src attribute as authored.
            authoredSource = function (sequence, style) {
                var element = sequence.element;
                if (sequence.property === 'src') {
                    return element.getAttribute('src');
                }
                style = style || computedStyle(element) || element.style;
                return style && typeof style.getPropertyValue === 'function' ?
                        cssUrlSource(style.getPropertyValue('background-image') || '') : null;
            },

            // The module's srcset/sizes pair comes off an img host —
            // each attribute only while it still holds the module's own
            // value, so a value another script wrote since is never
            // touched. A bound img never carries an authored sizes.
            withdrawSrcset = function (sequence) {
                var element = sequence.element;
                if (sequence.ownedSrcset !== null &&
                        element.getAttribute('srcset') === sequence.ownedSrcset) {
                    element.removeAttribute('srcset');
                }
                if (sequence.ownedSizes !== null &&
                        element.getAttribute('sizes') === sequence.ownedSizes) {
                    element.removeAttribute('sizes');
                }
                sequence.ownedSrcset = null;
                sequence.ownedSizes = null;
            },

            // The written source. A background takes an inline
            // declaration at the priority captured with its baseline —
            // an authored !important survives a frame paint instead of
            // being silently demoted by a two-argument write. On an img
            // a frame's own base paints as src — the intrinsic box the
            // baseline already had — while a sharper representation is
            // always written as a srcset width descriptor with a
            // module-owned sizes equal to the frame base's intrinsic
            // width: same layout, more pixels, whatever the device pixel
            // ratio or the CSS sizing — authored width and height
            // attributes alone never pin a box CSS may size from the
            // image. A later base paint withdraws that pair first.
            ownsBackground = function (sequence) {
                var style = sequence.element.style;
                return style.getPropertyValue('background-image') === sequence.ownedBackground &&
                    style.getPropertyPriority('background-image') === sequence.ownedPriority;
            },

            paint = function (sequence, index, rep) {
                var element = sequence.element,
                    base = sequence.frames[index].width;
                sequence.painted = true;
                sequence.adoptPending = false;
                if (sequence.property === 'background-image') {
                    if (rep.css === null) {
                        rep.css = cssUrl(rep.src);
                    }
                    try {
                        element.style.setProperty('background-image', rep.css,
                            sequence.authoredInline ? sequence.authoredInline.priority : '');
                    } finally {
                        // A refusing writer can leave the old declaration or
                        // write before throwing. Remember the actual result.
                        sequence.ownedBackground = element.style.getPropertyValue('background-image');
                        sequence.ownedPriority = element.style.getPropertyPriority('background-image');
                    }
                    return;
                }
                if (rep.width > base) {
                    sequence.ownedSizes = base + 'px';
                    element.setAttribute('sizes', sequence.ownedSizes);
                    sequence.ownedSrcset = rep.src + ' ' + rep.width + 'w';
                    element.setAttribute('srcset', sequence.ownedSrcset);
                    return;
                }
                withdrawSrcset(sequence);
                element.src = rep.src;
                sequence.ownedSrc = element.getAttribute('src');
            },

            // A painted representation becomes the displayed one at
            // once. An img's source is the presentation by definition; a
            // background declaration only counts when the cascade
            // displays it, and asking now would force a style
            // recalculation right after the write — so the claim stands
            // and the next pass's read phase reads the computed source
            // alone to verify it. The state the claim replaced — the
            // bookkeeping and the inline declaration itself, a
            // declaration read rather than a style computation — is kept
            // in the sequence's own carrier for that verification to
            // restore.
            present = function (sequence, index, rep) {
                var prior = sequence.claimPrior,
                    style;
                if (sequence.property === 'background-image') {
                    sequence.claimPredecessor = sequence.displayedRep ?
                            sequence.displayedRep.src : sequence.baselineSource;
                    // A fresh claim starts a fresh bound, even inside
                    // a chain still pending: the state it reverts to
                    // stays the chain's start, the last verified one.
                    sequence.claimPendingSince = null;
                    sequence.claimLapsed = false;
                }
                if (sequence.property === 'background-image' && !sequence.claimPending) {
                    style = sequence.element.style;
                    prior.index = sequence.displayedIndex;
                    prior.rep = sequence.displayedRep;
                    prior.ready = sequence.displayedReady;
                    prior.value = style.getPropertyValue('background-image');
                    prior.priority = style.getPropertyPriority('background-image');
                    sequence.claimPending = true;
                }
                paint(sequence, index, rep);
                // A committed representation is proven by definition —
                // it arrived through a real preparation load.
                setDisplayed(sequence, index, rep, true);
            },

            // A background baseline the cascade is still transitioning
            // toward is not adoptable yet: the computed value is the
            // transition's, not the baseline — a cross-fade, or at its
            // start the very source being replaced. Where the platform
            // lists the host's animations, a background-image transition
            // in flight is that evidence; elsewhere only a value naming
            // url()s without being one, which a bound background
            // computes only mid-transition, can show it. The adoption
            // stays owed: the next pass any input brings asks again, and
            // the read phase hooks a listed transition's settling. The
            // module's next paint retires the debt.
            awaitBaseline = function (sequence, style) {
                var element = sequence.element,
                    text;
                if (typeof element.getAnimations === 'function') {
                    if (listedTransition(element) === null) {
                        return false;
                    }
                } else {
                    style = style || computedStyle(element);
                    text = style && typeof style.getPropertyValue === 'function' ?
                            style.getPropertyValue('background-image') : '';
                    if (typeof text !== 'string' || cssUrlSource(text) !== null || !cssUrlSources(text).length) {
                        return false;
                    }
                }
                sequence.adoptPending = true;
                return true;
            },

            adoptAuthored = function (sequence, style) {
                var source = authoredSource(sequence, style),
                    authored = resolveSource(source),
                    element = sequence.element,
                    matches,
                    declaredStart,
                    chosen,
                    dead,
                    record,
                    matchIndex;
                // The computed baseline is what a first paint replaces —
                // once the cascade has settled on it.
                if (sequence.property === 'background-image') {
                    if (awaitBaseline(sequence, style)) {
                        return;
                    }
                    sequence.baselineSource = authored;
                }
                // The authored URL must be exactly a catalog
                // representation — base or upgrade — after
                // normalization. A baseline the platform cannot parse
                // matches nothing and is simply not adopted.
                matches = authored === null ? undefined : sequence.aliasIndex[authored];
                if (matches === undefined) {
                    return;
                }
                // The declared starting pose where it matches, else the
                // stable first match.
                declaredStart = sequence.intro ? sequence.intro.from : sequence.scrollFrom;
                chosen = matches[0];
                matchIndex = matches.length;
                while (matchIndex--) {
                    if (matches[matchIndex].index === declaredStart) {
                        chosen = matches[matchIndex];
                    }
                }
                // One complete URL is one resource: every alias index
                // holds the same record, so one proof readies them
                // all. An img host reports the baseline's failure
                // eagerly: 'complete' with no pixels is a settled
                // request that produced none. A background host carries
                // no readiness surface at all, so its entry stays
                // unproven until a preparation load reports.
                dead = sequence.property === 'src' &&
                    element.complete && !(element.naturalWidth > 0);
                record = {
                    rep: chosen.rep,
                    ready: !dead && !decodeSupported && sequence.property === 'src' &&
                        !!(element.complete && element.naturalWidth > 0)
                };
                if (dead) {
                    sequence.failed[record.rep.src] = true;
                }
                matchIndex = matches.length;
                while (matchIndex--) {
                    setPrepared(sequence, matches[matchIndex].index, record);
                }
                // Readiness is a property of the displayed
                // representation itself, kept apart from the cache.
                setDisplayed(sequence, chosen.index, chosen.rep, record.ready === true);
                sequence.initialIsFrameZero = chosen.index === 0;
            },

            clearPrepared = function (sequence) {
                var prepared = sequence.prepared,
                    key;
                for (key in prepared) {
                    if (prepared[key] !== undefined) {
                        deletePrepared(sequence, key);
                    }
                }
            },

            // Reduced motion restores the authored static presentation —
            // writes only, made after the pass's read phase: the paint
            // returns to what the page declared, and only when the
            // module ever painted (an untouched img keeps its src
            // attribute exactly as authored; a painted one gets that
            // attribute back verbatim). Adoption reads computed state,
            // so it waits for the next pass's read phase; meanwhile
            // nothing catalog-side pretends to be displayed, and the
            // scrub gate is closed — a return to motion is a fresh
            // presentation decision.
            restoreBaseline = function (sequence) {
                var inline = sequence.authoredInline,
                    element = sequence.element;
                clearPrepared(sequence);
                setDisplayed(sequence, -1, null, false);
                sequence.claimPending = false;
                sequence.passClaim = undefined;
                sequence.gateOpen = false;
                sequence.initialIsFrameZero = false;
                if (sequence.property === 'background-image') {
                    if (sequence.painted && ownsBackground(sequence)) {
                        if (inline && inline.value) {
                            // An authored inline baseline comes back
                            // verbatim, priority included.
                            element.style.setProperty('background-image', inline.value, inline.priority);
                        } else {
                            // The baseline was the stylesheet's — removing
                            // the enhancement's override lets the
                            // stylesheet, including its media conditions,
                            // choose again.
                            element.style.removeProperty('background-image');
                        }
                    }
                } else {
                    withdrawSrcset(sequence);
                    if (sequence.painted && element.getAttribute('src') === sequence.ownedSrc) {
                        element.setAttribute('src', sequence.authoredSrcAttribute);
                    }
                }
                sequence.painted = false;
                sequence.adoptPending = true;
                sequence.dirty = true;
            },

            // The retained record carrying this URL, wherever an alias
            // parked it — aliases hold the same object, and the alias
            // index names every frame the URL can sit at.
            recordForSource = function (sequence, src) {
                var entries = sequence.aliasIndex[src],
                    index = entries ? entries.length : 0,
                    record;
                while (index--) {
                    record = sequence.prepared[entries[index].index];
                    if (record !== undefined && record.rep.src === src) {
                        return record;
                    }
                }
                return null;
            },

            // Whether the URL is a representation of this frame.
            frameOwnsRep = function (sequence, index, src) {
                var reps = sequence.ladders[index],
                    repIndex = reps.length;
                while (repIndex--) {
                    if (reps[repIndex].src === src) {
                        return true;
                    }
                }
                return false;
            },

            // A finite positive host box is the presentation surface:
            // a hidden, detached or zero-size host is inert.
            hostRendered = function (policy) {
                return !!policy && $isFinite(policy.width) && $isFinite(policy.height) &&
                    policy.width > 0 && policy.height > 0;
            },

            // A cached representation can outlive the policy that
            // admitted it. Anything sharper than the frame's own base
            // re-checks the cap at paint time; the base itself is never
            // capped — it is the authored presentation.
            repPaintable = function (sequence, index, rep, policy) {
                if (rep.width <= sequence.frames[index].width) {
                    return true;
                }
                return policy.cap === 'auto' || rep.width <= policy.cap;
            },

            // Whether this representation could paint the frame under
            // the pass's policy: its source alive, the cap rechecked,
            // and at least as useful as what admission would fetch.
            repSatisfiesPolicy = function (sequence, index, rep, required, policy) {
                return !!rep && sourceAlive(sequence, rep.src) &&
                    repPaintable(sequence, index, rep, policy) &&
                    (!required || rep.width >= required.width);
            },

            // The representation a request for this frame should carry:
            // the resolution utility's own selection under the pass's
            // measured geometry, fit, pixel ratio, and CSS cap whenever
            // resolution enhancement is enabled — the base frame
            // otherwise. A selected URL that cannot be requested steps
            // down to the best surviving representation at or below
            // the preferred rung; null means nothing can arrive.
            // The answer is memoized per frame for as long as both of
            // its inputs stand still: the policy snapshot's version and
            // the sources' standing — a failure, a hidden-document
            // decode refusal or its release moves the latter.
            repFor = function (sequence, index, policy) {
                var frame,
                    reps,
                    need,
                    chosen,
                    rep = null,
                    repIndex;
                if (sequence.repMemoPolicy[index] === policy.version &&
                        sequence.repMemoSources[index] === sequence.sourceVersion) {
                    return sequence.repMemo[index];
                }
                reps = sequence.ladders[index];
                if (!sequence.upgradesEnabled) {
                    chosen = reps[0];
                    rep = sourceAlive(sequence, chosen.src) ? chosen : null;
                } else {
                    frame = sequence.frames[index];
                    // An img writes sharper rungs as srcset width
                    // descriptors sized at the base's intrinsic width,
                    // so its intrinsic-size fits still gain density.
                    need = needFor(policy.width, policy.height,
                        frame.width, frame.height, policy.fit, policy.devicePixelRatio,
                        sequence.property === 'src');
                    chosen = selectCandidate(reps, need, policy.cap);
                    if (sourceAlive(sequence, chosen.src)) {
                        rep = chosen;
                    } else {
                        // The ladder is width-ascending, so the last
                        // usable rep at or below the dead rung is the
                        // strongest fallback.
                        repIndex = reps.length;
                        while (repIndex--) {
                            if (reps[repIndex].width <= chosen.width &&
                                    sourceAlive(sequence, reps[repIndex].src)) {
                                rep = reps[repIndex];
                                repIndex = 0;
                            }
                        }
                    }
                }
                sequence.repMemo[index] = rep;
                sequence.repMemoPolicy[index] = policy.version;
                sequence.repMemoSources[index] = sequence.sourceVersion;
                return rep;
            },

            // The retained representation a member actually holds for
            // the current requirement — proven, alive, cap-eligible,
            // and adequate — or null.
            fundedRepAt = function (sequence, index, policy) {
                var entry = sequence.prepared[index];
                return entry !== undefined && entry.ready === true &&
                    repSatisfiesPolicy(sequence, index, entry.rep,
                        repFor(sequence, index, policy), policy) ? entry.rep : null;
            },

            // The retained representation that can paint this frame
            // now — the displayed rep itself for the painted index,
            // else the cached entry. 'Nothing left to fetch' is not 'no
            // usable pixels'.
            usableRepAt = function (sequence, index, policy) {
                var required = repFor(sequence, index, policy),
                    entry;
                if (index === sequence.displayedIndex && sequence.displayedReady === true &&
                        repSatisfiesPolicy(sequence, index, sequence.displayedRep, required, policy)) {
                    return sequence.displayedRep;
                }
                entry = sequence.prepared[index];
                if (entry !== undefined && entry.ready === true &&
                        repSatisfiesPolicy(sequence, index, entry.rep, required, policy)) {
                    return entry.rep;
                }
                return null;
            },

            // A representation physically in flight that this frame
            // can still use — not readiness, but proof that exhaustion
            // has not happened.
            pendingRepAt = function (sequence, index, policy) {
                var ops = sequence.ops,
                    src,
                    rep;
                for (src in ops) {
                    if (ops[src] !== undefined) {
                        rep = ops[src].rep;
                        if (frameOwnsRep(sequence, index, src) &&
                                repSatisfiesPolicy(sequence, index, rep, null, policy)) {
                            return rep;
                        }
                    }
                }
                return null;
            },

            // The frame can never paint — no surviving source to
            // request, no usable retained evidence, and no owned
            // operation whose arrival could still satisfy the policy.
            frameDead = function (sequence, index, policy) {
                return repFor(sequence, index, policy) === null &&
                    usableRepAt(sequence, index, policy) === null &&
                    pendingRepAt(sequence, index, policy) === null;
            },

            frameReadyAt = function (sequence, index, policy) {
                return usableRepAt(sequence, index, policy) !== null;
            },

            // The frames a positive authored scrub buffer requires
            // before a presentation change: the desired index plus the
            // following count in the established travel direction,
            // clipped to the declared range endpoint.
            scrubGateSet = function (sequence) {
                var low = $min(sequence.scrollFrom, sequence.scrollTo),
                    high = $max(sequence.scrollFrom, sequence.scrollTo),
                    set = [],
                    index = sequence.desiredIndex,
                    remaining = sequence.scrubBufferFrames;
                if (sequence.queued) {
                    low = $min(low, index);
                    high = $max(high, index);
                }
                while (remaining-- && index >= low && index <= high) {
                    set.push(index);
                    index += sequence.direction;
                }
                return set;
            },

            // The authored startup buffer as catalog indices: every
            // position the declared easing traverses from zero through
            // the authored horizon — both supported easings are
            // monotone.
            introRequiredSet = function (sequence) {
                var intro = sequence.intro,
                    horizon = $min(sequence.introBufferMs, intro.durationMs),
                    last = indexOnRange(intro.from, intro.to,
                        intro.easing($min(1, horizon / intro.durationMs))),
                    index = $min(intro.from, last),
                    remaining = $abs(last - intro.from) + 1,
                    set = [];
                while (remaining--) {
                    set.push(index);
                    index += 1;
                }
                return set;
            },

            // The set an admission pass must fund before anything
            // optional: the intro's startup buffer while it waits, or
            // the closed scrub gate's frames while it stands closed.
            requiredSetFor = function (sequence) {
                if (sequence.phase === 'intro-wait') {
                    return introRequiredSet(sequence);
                }
                if (sequence.phase === 'scroll' && sequence.scrubBufferFrames > 0 &&
                        !sequence.gateOpen && sequence.desiredIndex >= 0) {
                    return scrubGateSet(sequence);
                }
                return null;
            },

            // The pass's plan: the required set, and the ordered
            // indices the current intent may prepare — the desired
            // frame first, the required set next, then the lead the
            // travel direction asks for. The intro's lead is a time
            // horizon: every index the declared easing traverses
            // through the next horizon-milliseconds. The window is also
            // the retention policy. A plan depends only on the intent
            // fields compared below — for a playing intro that is
            // the index its eased horizon reaches, not the clock itself —
            // so it is rebuilt once per change of intent, never once per
            // frame, admission or eviction. The plan is the sequence's
            // own carrier: its order and membership arrays are cleared
            // and refilled in place.
            planFor = function (sequence) {
                var plan = sequence.plan,
                    desired = sequence.desiredIndex,
                    direction = sequence.direction,
                    phase = sequence.phase,
                    intro = sequence.intro,
                    introPhase = phase === 'intro' || phase === 'intro-wait',
                    order = plan.order,
                    members = plan.members,
                    requiredStore = plan.requiredStore,
                    required = plan.required,
                    lead = -1,
                    ahead = lookaheadMax,
                    low,
                    high,
                    elapsed,
                    unchanged,
                    remaining,
                    index;
                unchanged = plan.built && plan.desired === desired && plan.direction === direction &&
                    plan.phase === phase && plan.gateOpen === sequence.gateOpen;
                // Admissions and evictions ask the same question inside
                // one tick. Only an advancing intro clock needs its
                // eased horizon calculated again.
                if (unchanged && (!introPhase || plan.time === sequence.nowMs)) {
                    return plan;
                }
                plan.time = sequence.nowMs;
                if (introPhase && desired >= 0) {
                    elapsed = phase === 'intro' && sequence.introStartMs !== null ?
                            $max(0, sequence.nowMs - sequence.introStartMs) : 0;
                    lead = indexOnRange(intro.from, intro.to,
                        intro.easing($min(1, (elapsed + introHorizonMs) / intro.durationMs)));
                }
                if (unchanged && plan.lead === lead) {
                    return plan;
                }
                index = order.length;
                while (index--) {
                    members[order[index]] = false;
                }
                order.length = 0;
                if (required) {
                    index = required.length;
                    while (index--) {
                        requiredStore[required[index]] = false;
                    }
                }
                required = requiredSetFor(sequence);
                if (required) {
                    index = required.length;
                    while (index--) {
                        requiredStore[required[index]] = true;
                    }
                }
                plan.built = true;
                plan.desired = desired;
                plan.direction = direction;
                plan.phase = phase;
                plan.gateOpen = sequence.gateOpen;
                plan.lead = lead;
                plan.required = required;
                plan.requiredMembers = required ? requiredStore : null;
                if (desired < 0 || desired >= sequence.frames.length) {
                    return plan;
                }
                order.push(desired);
                members[desired] = true;
                if (required) {
                    // A closed gate's set leads the window — every
                    // required member is demand ahead of speculation.
                    remaining = required.length;
                    index = 0;
                    while (remaining--) {
                        if (members[required[index]] !== true) {
                            order.push(required[index]);
                            members[required[index]] = true;
                        }
                        index += 1;
                    }
                }
                if (introPhase) {
                    direction = intro.to >= intro.from ? 1 : -1;
                    low = $min(intro.from, intro.to);
                    high = $max(intro.from, intro.to);
                    // A horizon still inside the current index always
                    // keeps the next frame coming.
                    ahead = $max(1, $abs(lead - desired));
                } else {
                    low = $min(sequence.scrollFrom, sequence.scrollTo);
                    high = $max(sequence.scrollFrom, sequence.scrollTo);
                    if (sequence.queued) {
                        low = $min(low, desired);
                        high = $max(high, desired);
                    }
                }
                index = desired + direction;
                while (ahead-- && index >= low && index <= high) {
                    if (members[index] !== true) {
                        order.push(index);
                        members[index] = true;
                    }
                    index += direction;
                }
                return plan;
            },

            // The sequence's scratch books for one pricing, eviction or
            // reservation question: entries keyed by URL count only
            // while they carry the current stamp, so nothing is
            // allocated or cleared per question.
            nextStamp = function (sequence) {
                sequence.scratch.stamp += 1;
                return sequence.scratch.stamp;
            },

            // One more holder of a URL in the current pricing: the bytes
            // it adds — its decoded size the first time, else nothing.
            priceAdd = function (scratch, rep, stamp) {
                if (scratch.mark[rep.src] !== stamp) {
                    scratch.mark[rep.src] = stamp;
                    scratch.count[rep.src] = 1;
                    return pixelsFor(rep);
                }
                scratch.count[rep.src] += 1;
                return 0;
            },

            // One holder fewer: the bytes freed when it was the last.
            priceRemove = function (scratch, rep) {
                scratch.count[rep.src] -= 1;
                if (scratch.count[rep.src] === 0) {
                    scratch.mark[rep.src] = 0;
                    return pixelsFor(rep);
                }
                return 0;
            },

            // What the required set actually funds, member by member,
            // priced at distinct sources beside the standing image.
            // The standing image is owned through replacement and
            // counts in every pricing — and when that exact proven,
            // eligible representation also satisfies a required member
            // it funds the member too. Every other member reserves what
            // admission must fetch at the current selection or its
            // legitimate failure fallback; only then does a proven
            // cached rep sharper than that selection get to keep
            // funding its member, one at a time, while the complete
            // reservation still fits. Keeping sharper cache is a
            // preference, never an obligation. Feasibility, eviction
            // protection, and admission all read this one reservation.
            // commitUpgrade asks what the set funds AS IF a candidate
            // rep already stood. The running total is kept
            // incrementally — one URL priced once however many members
            // share it — and the answer fills the caller's carrier.
            priceSet = function (sequence, set, policy, standingRep, into) {
                var standing = standingRep !== undefined ? standingRep :
                        (sequence.displayedIndex >= 0 ? sequence.displayedRep : null),
                    scratch = sequence.scratch,
                    stamp = nextStamp(sequence),
                    chosen = into.byIndex,
                    previous = into.set,
                    total = 0,
                    memberIndex,
                    member,
                    rep,
                    kept,
                    prior,
                    remaining;
                if (previous) {
                    memberIndex = previous.length;
                    while (memberIndex--) {
                        chosen[previous[memberIndex]] = undefined;
                    }
                }
                into.set = set;
                if (standing) {
                    total += priceAdd(scratch, standing, stamp);
                }
                memberIndex = set.length;
                while (memberIndex--) {
                    member = set[memberIndex];
                    if (member === sequence.displayedIndex && standing &&
                            (standingRep !== undefined || sequence.displayedReady === true) &&
                            repSatisfiesPolicy(sequence, member, standing, repFor(sequence, member, policy), policy)) {
                        rep = standing;
                    } else {
                        rep = repFor(sequence, member, policy) || sequence.ladders[member][0];
                    }
                    chosen[member] = rep;
                    total += priceAdd(scratch, rep, stamp);
                }
                into.feasible = total <= decodedBudgetBytes;
                if (into.feasible) {
                    remaining = set.length;
                    memberIndex = 0;
                    while (remaining--) {
                        member = set[memberIndex];
                        memberIndex += 1;
                        kept = fundedRepAt(sequence, member, policy);
                        prior = chosen[member];
                        // Only a strictly sharper retained rep is worth
                        // keeping in place of the priced selection — a
                        // narrower one would withhold budget for less.
                        if (kept && prior && kept.src !== prior.src && kept.width > prior.width) {
                            total -= priceRemove(scratch, prior);
                            total += priceAdd(scratch, kept, stamp);
                            if (total > decodedBudgetBytes) {
                                total -= priceRemove(scratch, kept);
                                total += priceAdd(scratch, prior, stamp);
                            } else {
                                chosen[member] = kept;
                            }
                        }
                    }
                }
                return into;
            },

            // The reservation of the standing presentation, reused until
            // its set, policy, sources or ownership changes. Feasibility,
            // eviction protection and
            // admission all ask the same question, and only an ownership
            // or display change (hold, release, setDisplayed) can move
            // the answer inside a pass. commitUpgrade's as-if pricing is
            // never cached, and fills a carrier of its own.
            setReservation = function (sequence, set, policy, standingRep) {
                if (standingRep !== undefined) {
                    return priceSet(sequence, set, policy, standingRep, sequence.asIfPricing);
                }
                if (sequence.reservationSet !== set || sequence.reservationPolicy !== policy.version ||
                        sequence.reservationSources !== sequence.sourceVersion) {
                    sequence.reservation = priceSet(sequence, set, policy, undefined, sequence.pricing);
                    sequence.reservationSet = set;
                    sequence.reservationPolicy = policy.version;
                    sequence.reservationSources = sequence.sourceVersion;
                }
                return sequence.reservation;
            },

            // The bytes the required set still owes: funding sources no
            // holder owns yet, each once. The candidate is already in
            // capacityFor's total, including when it funds a member.
            reservedBytes = function (sequence, set, reservation, candidateSrc) {
                var mark = sequence.scratch.mark,
                    stamp = nextStamp(sequence),
                    holds = sequence.holds,
                    total = 0,
                    index = set.length,
                    funding;
                while (index--) {
                    funding = reservation.byIndex[set[index]];
                    if (funding && funding.src !== candidateSrc &&
                            mark[funding.src] !== stamp && holds[funding.src] === undefined) {
                        mark[funding.src] = stamp;
                        total += pixelsFor(funding);
                    }
                }
                return total;
            },

            // Room comes from retained entries the current pass ranks
            // below the candidate. Entries are grouped by resource —
            // one URL is one decoded image however many alias indices
            // hold it, so a group frees bytes only when every holder of
            // its URL is reclaimable. The standing image, a landed
            // result, an operation in flight, the candidate's own URL,
            // the desired frame's funding, and the members a required
            // reservation funds are never room; window members are room
            // only when the caller may evict the window. A group ranks
            // by its nearest holder — an alias still close to the desire
            // keeps its URL however far its twins sit. The farthest
            // group goes first, behind the direction of travel before
            // ahead of it. The reclaim is decided before anything is
            // deleted: when the candidate cannot fit even after every
            // reclaimable group, nothing is deleted at all — evicting
            // and then refusing would only invite the next speculation
            // to refetch what was just thrown away. A prune (partial)
            // instead frees whatever obsolete room exists.
            reclaim = function (sequence, excess, candidateSrc, mayEvictWindow, policy, partial) {
                var plan = planFor(sequence),
                    windowMembers = plan.members,
                    requiredMembers = plan.requiredMembers,
                    reservation = plan.required ? setReservation(sequence, plan.required, policy) : null,
                    prepared = sequence.prepared,
                    holds = sequence.holds,
                    desired = sequence.desiredIndex,
                    direction = sequence.direction,
                    scratch = sequence.scratch,
                    groups = scratch.groups,
                    groupList = scratch.groupList,
                    pinned = scratch.pinned,
                    chosen = scratch.picked,
                    stamp = nextStamp(sequence),
                    freed = 0,
                    key,
                    member,
                    record,
                    src,
                    group,
                    rank,
                    groupIndex,
                    best,
                    bestRank;
                groupList.length = 0;
                for (key in prepared) {
                    if (prepared[key] !== undefined) {
                        member = $Number(key);
                        record = prepared[key];
                        src = record.rep.src;
                        if (src === candidateSrc ||
                                (requiredMembers && requiredMembers[member] === true && reservation &&
                                    reservation.byIndex[member] && reservation.byIndex[member].src === src) ||
                                (member === desired && (!requiredMembers || requiredMembers[member] !== true) &&
                                    fundedRepAt(sequence, member, policy)) ||
                                (windowMembers[member] === true && !mayEvictWindow)) {
                            pinned[src] = stamp;
                        } else {
                            rank = (windowMembers[member] === true ? 0 : 1000000000) +
                                $abs(member - desired) * 2 +
                                ((member - desired) * direction < 0 ? 1 : 0);
                            group = groups[src];
                            if (group === undefined) {
                                group = {src: src, stamp: 0, count: 0, rank: 0, bytes: 0};
                                groups[src] = group;
                            }
                            if (group.stamp !== stamp) {
                                group.stamp = stamp;
                                group.count = 1;
                                group.rank = rank;
                                group.bytes = pixelsFor(record.rep);
                                groupList.push(group);
                            } else {
                                group.count += 1;
                                group.rank = $min(group.rank, rank);
                            }
                        }
                    }
                }
                while (freed < excess) {
                    best = null;
                    bestRank = -1;
                    // Only groups retained in this pass can free room.
                    // The reusable lookup also remembers old resources;
                    // scanning it would grow the hot loop with playback.
                    groupIndex = groupList.length;
                    while (groupIndex--) {
                        group = groupList[groupIndex];
                        src = group.src;
                        if (chosen[src] !== stamp && pinned[src] !== stamp &&
                                group.count === holds[src] && group.rank > bestRank) {
                            best = src;
                            bestRank = group.rank;
                        }
                    }
                    if (best === null) {
                        break;
                    }
                    chosen[best] = stamp;
                    freed += groups[best].bytes;
                }
                if (freed < excess && !partial) {
                    return false;
                }
                for (key in prepared) {
                    if (prepared[key] !== undefined && chosen[prepared[key].rep.src] === stamp) {
                        deletePrepared(sequence, key);
                    }
                }
                return freed >= excess;
            },

            // Whether one more decoded image fits — and making it fit
            // when the room is held by lower-priority work. The
            // estimate is everything owned, plus the candidate unless
            // its URL is already owned, plus — for an optional
            // candidate — the required members the set still has to
            // fetch: optional work admits only inside what the buffer
            // leaves free.
            capacityFor = function (sequence, rep, mayEvictWindow, policy, reserveRequired) {
                var required = planFor(sequence).required,
                    need = sequence.ownedBytes +
                        (sequence.holds[rep.src] === undefined ? pixelsFor(rep) : 0),
                    reservation;
                if (required && reserveRequired) {
                    reservation = setReservation(sequence, required, policy);
                    if (reservation.feasible) {
                        need += reservedBytes(sequence, required, reservation, rep.src);
                    }
                }
                if (need <= decodedBudgetBytes) {
                    return true;
                }
                return reclaim(sequence, need - decodedBudgetBytes, rep.src, mayEvictWindow, policy, false);
            },

            // The documented single-frame exception: a mandatory,
            // ungated desire whose decoded size beside the standing
            // image exceeds the whole budget — the candidate alone, the
            // standing image alone, or only the two together — can
            // never be admitted by accounting, so refusing it would be
            // a permanent freeze rather than a wait. It admits anyway,
            // one outstanding at a time: the allowance rides the
            // admitted operation until it settles, newer desires
            // coalesce behind it, and nothing optional fits beside it
            // because the pair already outspends the budget.
            // The exception belongs to a desire no larger set waits on:
            // no required set at all, or one that is just this frame —
            // a gate of one, or a gate clipped to one at its endpoint.
            exceptionAllowed = function (required, index) {
                return required === null || (required.length === 1 && required[0] === index);
            },

            exceptionalAdmissible = function (sequence, rep) {
                var standing = sequence.displayedIndex >= 0 ? sequence.displayedRep : null,
                    pair = pixelsFor(rep);
                if (standing && standing.src !== rep.src) {
                    pair += pixelsFor(standing);
                }
                return sequence.exceptionalSrc === null && pair > decodedBudgetBytes;
            },

            // Prepared frames are cached work, not obligations: while
            // the decoded estimate exceeds the budget, obsolete entries
            // outside the preparation window drop, farthest first.
            prunePrepared = function (sequence, policy) {
                if (sequence.ownedBytes > decodedBudgetBytes) {
                    reclaim(sequence, sequence.ownedBytes - decodedBudgetBytes, null, false, policy, true);
                }
            },

            // Leaving the approaching band ends the scene's claim on
            // decoded memory: the cache drops to just the
            // representation actually painted. Requests already in
            // flight keep their physical slots until they settle.
            releaseRetained = function (sequence) {
                var prepared = sequence.prepared,
                    displayedRep = sequence.displayedRep,
                    shown = sequence.displayedIndex >= 0 && displayedRep,
                    record = shown ? {rep: displayedRep, ready: sequence.displayedReady} : null,
                    key;
                for (key in prepared) {
                    if (prepared[key] !== undefined) {
                        if (shown && prepared[key].rep.src === displayedRep.src) {
                            setPrepared(sequence, key, record);
                        } else {
                            deletePrepared(sequence, key);
                        }
                    }
                }
                if (shown) {
                    setPrepared(sequence, sequence.displayedIndex, record);
                }
            },

            // The painted source itself cannot be requested any more —
            // a broken image is no presentation to protect.
            displayedSourceFailed = function (sequence) {
                var rep = sequence.displayedRep;
                return !!rep && sequence.displayedIndex >= 0 && !sourceAlive(sequence, rep.src);
            },

            schedule = function () {
                if (!frameRequested) {
                    frameRequested = true;
                    requestPhased(readPass, writePass);
                }
            },

            armPlaybackWake = function (sequence, at) {
                var due = sequence.playAt === null ? at : sequence.playAt + sequence.playInterval,
                    wakeId;
                if (sequence.playWakeId !== null && sequence.playWakeAt === due) {
                    return;
                }
                retirePlaybackWake(sequence);
                wakeId = startTimer(function () {
                    if (wakeId === null || sequence.playWakeId !== wakeId) {
                        return;
                    }
                    sequence.playWakeId = null;
                    sequence.playWakeAt = null;
                    if (sequence.playActive && !sequence.faulted && !$doc.hidden) {
                        schedule();
                    }
                }, $max(0, due - at));
                sequence.playWakeId = wakeId;
                sequence.playWakeAt = due;
            },

            dirty = function (sequence) {
                sequence.dirty = true;
                schedule();
            },

            // An input — scroll, resize, observed geometry, visibility,
            // pixel ratio, a motion change — is a fresh look at the
            // page: a background paint the cascade refused earlier may
            // display now, so its refusal is forgotten here and only
            // here, and so is a closed gate's remembered verdict. Every
            // input but scroll can also move the resolution policy, so
            // the next read phase reads it again; a scroll alone re-reads
            // the policy only for a sequence near the viewport.
            input = function (sequence, policyInput) {
                sequence.yielded = false;
                sequence.unwinnable = null;
                sequence.deadGateDesired = -1;
                if (policyInput) {
                    sequence.policyDirty = true;
                }
                dirty(sequence);
            },

            inputEverySequence = function () {
                var index = sequences.length;
                while (index--) {
                    input(sequences[index], true);
                }
            },

            // A scroll is an input only for a sequence it can still
            // move: under reduced motion — as the last pass applied it —
            // the static baseline stands, and only a declared initial
            // frame zero that may still sharpen cares where the scene
            // sits.
            scrollInput = function (sequence) {
                if (motionSeen && !(sequence.upgradesEnabled && sequence.initialIsFrameZero)) {
                    return;
                }
                input(sequence, false);
            },

            // The final paint boundary enforces readiness: only an
            // entry that proved its pixels may stand in for what is
            // showing — and the exact representation painted must
            // still satisfy the pass's resolution policy. The standing
            // frame adds its own rule — a narrower rep of the same
            // frame paints only to repair a failed displayed source.
            commit = function (sequence, index, entry, policy) {
                var rep;
                if (!entry || entry.ready !== true) {
                    return false;
                }
                rep = entry.rep;
                if (index !== sequence.desiredIndex || sequence.rangeValid === false ||
                        !hostRendered(policy) || passMotionNow ||
                        rep.src === sequence.unwinnable) {
                    return false;
                }
                if (!repSatisfiesPolicy(sequence, index, rep, repFor(sequence, index, policy), policy)) {
                    return false;
                }
                if (index === sequence.displayedIndex && sequence.displayedRep &&
                        rep.width <= sequence.displayedRep.width && !displayedSourceFailed(sequence)) {
                    return false;
                }
                present(sequence, index, rep);
                prunePrepared(sequence, policy);
                return true;
            },

            // An upgrade must be a proven representation of the same
            // frame at a higher width, still eligible under the policy
            // as it stands now. The one narrowing allowed is repair of
            // a failed displayed source.
            commitUpgrade = function (sequence, index, entry, policy) {
                var rep,
                    displayedRep = sequence.displayedRep,
                    gate;
                if (!entry || entry.ready !== true || !displayedRep) {
                    return false;
                }
                rep = entry.rep;
                if (index !== sequence.displayedIndex || sequence.rangeValid === false ||
                        !hostRendered(policy) || rep.src === sequence.unwinnable) {
                    return false;
                }
                if (rep.width <= displayedRep.width && !displayedSourceFailed(sequence)) {
                    return false;
                }
                // Reduced motion permits sharpening only the declared
                // initial frame.
                if ((passMotionNow && !sequence.initialIsFrameZero) ||
                        !repPaintable(sequence, index, rep, policy)) {
                    return false;
                }
                // Enlarging the standing image re-prices the required
                // set as if this rep already stood — a paint that
                // would deny the buffer's funding is refused.
                if (rep.width > displayedRep.width) {
                    gate = planFor(sequence).required;
                    if (gate && !setReservation(sequence, gate, policy, rep).feasible) {
                        return false;
                    }
                }
                present(sequence, index, rep);
                // A standing change re-prices the required set: one
                // more scheduled pass spends the capacity it freed.
                dirty(sequence);
                return true;
            },

            // A completion is bookkeeping, not presentation: the
            // operation frees its physical slot, the landed
            // representation parks on the sequence, and the scheduled
            // pass reconciles. Reprioritization never deadens a
            // completed decode — the pass weighs it against the live
            // frame, phase, cap and proximity. Static presentation is
            // the one settled discard, except the refinement still
            // wanted: the authored initial frame zero may sharpen
            // itself.
            startPrepare = function (sequence, rep, exceptional) {
                var src = rep.src,
                    record = {rep: rep},
                    retire = function () {
                        delete sequence.ops[src];
                        sequence.opCount -= 1;
                        if (sequence.exceptionalSrc === src) {
                            sequence.exceptionalSrc = null;
                        }
                    };
                sequence.ops[src] = record;
                sequence.opCount += 1;
                if (exceptional) {
                    sequence.exceptionalSrc = src;
                }
                hold(sequence, rep);
                prepare(sequence.element, sequence.property === 'src', rep).then(function (image) {
                    retire();
                    // The operation's own hold is released whatever the
                    // motion read answers; a parked result holds anew.
                    try {
                        if (!reducedMotion() || (sequence.initialIsFrameZero && frameOwnsRep(sequence, 0, src))) {
                            hold(sequence, rep);
                            sequence.settledOps.push({rep: rep, image: image});
                        }
                    } finally {
                        release(sequence, rep);
                    }
                    dirty(sequence);
                }, function (failure) {
                    retire();
                    release(sequence, rep);
                    // A preparation that never requested the URL — a
                    // refusing constructor or host surface — is no
                    // verdict on it. The slot frees and the next input
                    // asks again; no pass is scheduled for it, so a
                    // refusing constructor cannot spin.
                    if (failure && failure.requested === false) {
                        return;
                    }
                    sequence.deadGateDesired = -1;
                    sequence.sourceVersion += 1;
                    // A load error is the source's own failure whatever
                    // the request's intent became: a dead URL is dead
                    // for every index and role that names it. So is a
                    // decode refused while the document was visible. A
                    // refusal while it was hidden is withheld until it
                    // is visible again — once: a second refusal of the
                    // same URL is final.
                    if (failure && failure.decode === true && $doc.hidden &&
                            sequence.decodeRetried[src] !== true) {
                        sequence.undecoded[src] = true;
                    } else {
                        sequence.failed[src] = true;
                    }
                    dirty(sequence);
                });
            },

            // A completed fetch joins the cache only where it improves
            // what could actually paint: a rep that fails the pass's
            // measured policy cannot displace a paintable base, and a
            // standing paintable rep at least as wide keeps the slot.
            // An unproven adopted entry is no barrier — the arrival is
            // the proof it was waiting on.
            retainSettled = function (sequence, rep, image, policy) {
                var record = recordForSource(sequence, rep.src),
                    aliases = sequence.aliasIndex[rep.src],
                    aliasIndex = aliases ? aliases.length : 0,
                    index,
                    existing;
                // Readiness can change without replacing an owned record.
                sequence.reservationSet = null;
                // A completion proving the painted URL is proof of
                // what is painted, wherever it was requested from.
                if (sequence.displayedRep && sequence.displayedRep.src === rep.src) {
                    sequence.displayedReady = true;
                }
                if (record === null) {
                    record = {rep: rep, image: image, ready: true};
                } else {
                    record.image = image;
                    record.ready = true;
                }
                while (aliasIndex--) {
                    index = aliases[aliasIndex].index;
                    existing = sequence.prepared[index];
                    if (sequence.nearView && repPaintable(sequence, index, rep, policy) &&
                            !(existing !== undefined && existing !== record &&
                                existing.ready !== false && existing.rep.width >= rep.width &&
                                repPaintable(sequence, index, existing.rep, policy))) {
                        setPrepared(sequence, index, record);
                    }
                }
            },

            // The representation the frame would request now, or null
            // when it is ready, can never paint, or is already being
            // fetched. An unproven adopted entry proves the
            // representation actually displayed — its own URL — while
            // that representation is still the demanded and painted one
            // and still satisfies the selection; anywhere else the
            // request carries the selected representation.
            fetchFor = function (sequence, index, policy) {
                var entry = sequence.prepared[index],
                    selected,
                    rep;
                if (frameReadyAt(sequence, index, policy) || frameDead(sequence, index, policy)) {
                    return null;
                }
                selected = repFor(sequence, index, policy);
                rep = entry !== undefined && entry.ready === false &&
                    entry.rep.src !== sequence.frames[index].src &&
                    sourceAlive(sequence, entry.rep.src) &&
                    index === sequence.desiredIndex && index === sequence.displayedIndex &&
                    sequence.displayedRep && sequence.displayedRep.src === entry.rep.src &&
                    repSatisfiesPolicy(sequence, index, entry.rep, selected, policy) ? entry.rep : selected;
                return rep && sequence.ops[rep.src] === undefined ? rep : null;
            },

            // The painted size and the CSS cap decide whether a sharper
            // representation of the displayed frame is worth a fetch.
            // Painting a representation the sequence already owns is
            // reconciliation; the standing rep's own unproven URL is
            // demand; only a new sharpening fetch is optional — it never
            // admits behind a refused demand.
            evaluateUpgrade = function (sequence, policy) {
                var displayed = sequence.displayedIndex,
                    displayedRep = sequence.displayedRep,
                    standing,
                    chosen;
                if (!sequence.upgradesEnabled || !sequence.nearView || displayed < 0 ||
                        !displayedRep || sequence.rangeValid === false || !hostRendered(policy) ||
                        sequence.claimPending || (passMotionNow && !sequence.initialIsFrameZero)) {
                    return;
                }
                standing = sequence.prepared[displayed];
                if (standing !== undefined && (standing.rep.width > displayedRep.width ||
                        displayedSourceFailed(sequence))) {
                    commitUpgrade(sequence, displayed, standing, policy);
                    displayedRep = sequence.displayedRep;
                }
                // The rep the paint already shows is unproven — its own
                // URL owes the decode proof, ahead of speculation, with
                // the same bounded
                // single-frame exception the desired frame holds while
                // no positive gate funds a set.
                if (standing !== undefined && standing.ready === false &&
                        standing.rep.src === displayedRep.src &&
                        sourceAlive(sequence, standing.rep.src) &&
                        repSatisfiesPolicy(sequence, displayed, standing.rep,
                            repFor(sequence, displayed, policy), policy) &&
                        sequence.ops[standing.rep.src] === undefined &&
                        sequence.opCount < maxInFlight) {
                    if (capacityFor(sequence, standing.rep, true, policy, false)) {
                        startPrepare(sequence, standing.rep, false);
                    } else if (exceptionAllowed(planFor(sequence).required, displayed) &&
                            exceptionalAdmissible(sequence, standing.rep)) {
                        startPrepare(sequence, standing.rep, true);
                    } else {
                        demandRefused = true;
                    }
                }
                // A new sharpening fetch serves only the standing frame
                // while it is still the desired one: once the desire has
                // moved on, the fetch would spend a slot and lookahead
                // room on a frame about to be replaced. A failed paint's
                // repair is demand, not sharpening, and reduced motion's
                // initial frame has no desire to follow and still
                // refines.
                if (!sequence.frames[displayed].upgrades.length || demandRefused ||
                        (!passMotionNow && sequence.desiredIndex !== displayed &&
                            !displayedSourceFailed(sequence))) {
                    return;
                }
                chosen = repFor(sequence, displayed, policy);
                // A fallback that cannot improve a healthy paint is not
                // worth a fetch; a parked rep answering the selection
                // waits reclaimable rather than looping a refetch; one
                // URL is one physical request.
                if (!chosen || (chosen.width <= displayedRep.width && !displayedSourceFailed(sequence)) ||
                        (standing !== undefined && standing.rep.src === chosen.src) ||
                        sequence.ops[chosen.src] !== undefined || sequence.opCount >= maxInFlight) {
                    return;
                }
                // An upgrade outranks speculation but never a required
                // buffer: window members are reclaimable for it,
                // required members are not, and the members the set
                // still has to fetch stay reserved.
                if (capacityFor(sequence, chosen, true, policy, true)) {
                    startPrepare(sequence, chosen, false);
                }
            },

            // The one admission path every demand flows through —
            // scroll's desired frame, the intro's opening frame and its
            // active lead, required buffer members, and speculative
            // lookahead — so proximity, slot, and budget checks apply
            // identically to each. Demand is a new desired pose, a
            // required member, the standing rep's own proof, a failed
            // paint's repair, or an active intro's lead; sharpening an
            // already-standing pose and lookahead are optional — they
            // end the sweep once a demand was refused for room, and
            // only ever reclaim obsolete work.
            ensureNeighbors = function (sequence, policy) {
                var plan = planFor(sequence),
                    order = plan.order,
                    requiredMembers = plan.requiredMembers,
                    required = plan.required,
                    demandedIndex = order[0],
                    remaining = order.length,
                    position = 0,
                    candidateIndex,
                    requiredMember,
                    demanded,
                    entry,
                    rep;
                if (!sequence.nearView || !remaining || !hostRendered(policy)) {
                    return;
                }
                // Every slot is a physical request; once all six are
                // out, nothing more can start until one settles.
                while (remaining-- && sequence.opCount < maxInFlight) {
                    candidateIndex = order[position];
                    position += 1;
                    rep = fetchFor(sequence, candidateIndex, policy);
                    if (rep) {
                        entry = sequence.prepared[candidateIndex];
                        requiredMember = !!requiredMembers && requiredMembers[candidateIndex] === true;
                        demanded = requiredMember || sequence.phase === 'intro' ||
                            (candidateIndex === demandedIndex &&
                                !(candidateIndex === sequence.displayedIndex &&
                                    !(entry !== undefined && entry.ready === false) &&
                                    !displayedSourceFailed(sequence)));
                        if (!demanded && demandRefused) {
                            // Later window members share the same
                            // optionality — the gate ends the sweep.
                            remaining = 0;
                        } else if (capacityFor(sequence, rep, candidateIndex === demandedIndex || requiredMember,
                                policy, !demanded)) {
                            startPrepare(sequence, rep, false);
                        } else if (demanded && candidateIndex === demandedIndex &&
                                exceptionAllowed(required, candidateIndex) &&
                                exceptionalAdmissible(sequence, rep)) {
                            startPrepare(sequence, rep, true);
                        } else if (demanded) {
                            demandRefused = true;
                        }
                    }
                }
                // A settle freed a slot — a sharpen the last evaluation
                // could not start gets its chance now.
                evaluateUpgrade(sequence, policy);
            },

            // A borrowed tabindex goes back only while it is still the
            // module's own '-1' — a value the page wrote since is the
            // page's.
            returnTabindex = function (target) {
                try {
                    if (target.getAttribute('tabindex') === '-1') {
                        target.removeAttribute('tabindex');
                    }
                } catch (ignore) {
                    // A refusing surface keeps what it has.
                }
            },

            endLease = function (sequence) {
                var lease = sequence.focusLease,
                    index = lease ? lease.length : 0;
                sequence.focusLease = null;
                while (index--) {
                    try {
                        lease[index]['dispose']();
                    } catch (ignore) {
                        // A refusing release strands only that listener.
                    }
                }
            },

            // A moving focus target for a retiring skip control: the
            // scrollscrub scope the control belongs to. A scope without
            // its own tabindex is made programmatically focusable only
            // for as long as it holds that focus. Whether focus moved is
            // read back, not assumed: a scope the platform will not
            // focus — inert, unrendered — returns the borrowed tabindex
            // at once and the control is blurred instead, so focus never
            // stays on a control about to hide. The lease ends only when
            // focus really leaves the scope: a blur delivered while the
            // scope is still the document's focused element — the window
            // itself losing focus — keeps it. An engine that restores
            // that focus silently, or drops it without a blur (a scope
            // taken out of the document), leaves it without a second
            // blur, so focus arriving anywhere else in the document ends
            // the lease too. Both watchers exist before focus moves: a
            // watcher that cannot be made leaves no focus and no
            // borrowed tabindex behind.
            moveFocusFrom = function (sequence, control) {
                var target = sequence.scopeElement,
                    added = false,
                    lease,
                    releaseBorrow = function () {
                        if ($doc.activeElement === target) {
                            return;
                        }
                        endLease(sequence);
                        returnTabindex(target);
                    };
                try {
                    if (!target.hasAttribute('tabindex')) {
                        target.setAttribute('tabindex', '-1');
                        added = true;
                        endLease(sequence);
                        lease = [];
                        sequence.focusLease = lease;
                        lease.push(new Subscription('blur', target, releaseBorrow));
                        lease.push(new Subscription('focusin', $doc, releaseBorrow));
                    }
                    target.focus({preventScroll: true});
                } catch (ignore) {
                    // A refusing focus or watcher is checked below like
                    // any other.
                }
                if ($doc.activeElement === target) {
                    return;
                }
                if (added) {
                    endLease(sequence);
                    returnTabindex(target);
                }
                try {
                    if ($doc.activeElement === control && typeof control.blur === 'function') {
                        control.blur();
                    }
                } catch (ignore) {
                    // A control that refuses the blur hides regardless.
                }
            },

            // The intro ends once and completely. The work that touches
            // host surfaces — the skip handler, focus, the control's
            // hidden attribute, the waiting deadline — runs first, each
            // call contained, and only then does the phase flip, so a
            // refusal anywhere can neither leave the phase half-ended
            // nor skip a later step. The scene is left dirty: a pass the
            // caller already runs, or schedules, recomputes the desire
            // from the live scroll position.
            endIntro = function (sequence, completed) {
                var intro = sequence.intro,
                    skip = intro ? intro.skip : null,
                    subscription = sequence.skipSubscription;
                if (sequence.phase !== 'intro' && sequence.phase !== 'intro-wait') {
                    return;
                }
                sequence.skipSubscription = null;
                if (subscription) {
                    try {
                        subscription['dispose']();
                    } catch (ignore) {
                        // A refusing release strands only the handler.
                    }
                }
                if (skip && intro.skipRevealed) {
                    intro.skipRevealed = false;
                    // Focus leaves the control deliberately before it
                    // hides — a hidden focused control would drop focus
                    // to the document body.
                    try {
                        if ($doc.activeElement === skip.control) {
                            moveFocusFrom(sequence, skip.control);
                        }
                    } catch (ignore) {
                        // The control still hides below.
                    }
                    // Only what the intro exposed goes back, verbatim.
                    try {
                        skip.control.setAttribute('hidden', skip.hiddenValue === null ? '' : skip.hiddenValue);
                    } catch (ignore) {
                        // A refusing control keeps what it has.
                    }
                }
                // The waiting deadline belongs to the phase — however it
                // ends, no late timer gets a say.
                stopTimer(sequence.introDeadlineId);
                sequence.introDeadlineId = null;
                sequence.introDeadlineAtMs = null;
                sequence.phase = 'scroll';
                sequence.playCursor = sequence.queued ? (completed ? sequence.displayedIndex : -1) : null;
                sequence.playAt = null;
                // The intro-to-scroll handoff is a fresh presentation
                // decision: an authored scrub gate verifies the live
                // position's set before the next change commits.
                sequence.gateOpen = false;
                // Withdraw the intro's intent — the next measured drive
                // recomputes the desire from the live scroll position.
                sequence.desiredIndex = -1;
                sequence.dirty = true;
            },

            // An intro ending outside any pass — the skip control, the
            // waiting deadline, a hidden document — is contained to its
            // own scene, and the pass that follows is asked for.
            endIntroNow = function (sequence) {
                try {
                    endIntro(sequence);
                } catch (ignore) {
                    // Every step inside is already contained.
                }
                dirty(sequence);
            },

            // A waiting intro's wake belongs to one scene only.
            armIntroDeadline = function (sequence, remainingMs) {
                var wakeId = startTimer(function () {
                    if (wakeId === null || sequence.introDeadlineId !== wakeId) {
                        return;
                    }
                    sequence.introDeadlineId = null;
                    if (sequence.phase === 'intro-wait') {
                        endIntroNow(sequence);
                    }
                }, remainingMs);
                sequence.introDeadlineId = wakeId;
            },

            // One intro step: elapsed time picks the intent, a prepared
            // wanted frame paints, everything else keeps the last
            // usable image standing without accumulating a backlog.
            introTick = function (sequence, now, policy) {
                var intro = sequence.intro,
                    elapsed,
                    index;
                sequence.nowMs = now;
                if (sequence.introStartMs === null) {
                    sequence.introStartMs = now;
                }
                elapsed = now - sequence.introStartMs;
                if (elapsed >= intro.durationMs && (!sequence.queued || sequence.displayedIndex === intro.to ||
                        elapsed >= intro.durationMs + introWaitDeadlineMs)) {
                    endIntro(sequence, sequence.displayedIndex === intro.to);
                    return;
                }
                index = indexOnRange(intro.from, intro.to, intro.easing($min(1, elapsed / intro.durationMs)));
                if (sequence.queued) {
                    if (sequence.displayedIndex < 0) {
                        index = intro.from;
                    } else if (index !== sequence.displayedIndex) {
                        index = sequence.displayedIndex + (intro.to >= intro.from ? 1 : -1);
                    }
                }
                sequence.desiredIndex = index;
                if (index !== sequence.displayedIndex) {
                    commit(sequence, index, sequence.prepared[index], policy);
                } else if (displayedSourceFailed(sequence)) {
                    commitUpgrade(sequence, index, sequence.prepared[index], policy);
                }
                ensureNeighbors(sequence, policy);
            },

            // The intro begins when its authored startup buffer can
            // actually paint. Reduced motion at this point ends the
            // phase outright — a waiting intro is withdrawn, never left
            // waiting on a clock it may not start.
            startIntro = function (sequence, policy) {
                var intro = sequence.intro;
                if (sequence.phase !== 'intro-wait') {
                    return;
                }
                if (passMotionNow) {
                    endIntro(sequence);
                    return;
                }
                stopTimer(sequence.introDeadlineId);
                sequence.introDeadlineId = null;
                sequence.phase = 'intro';
                recordIntroConsumed(sequence);
                if (intro.skip) {
                    // The handler lives exactly as long as the intro
                    // it skips.
                    sequence.skipSubscription = new Subscription('click', intro.skip.control, function () {
                        endIntroNow(sequence);
                    });
                    intro.skip.control.removeAttribute('hidden');
                    intro.skipRevealed = true;
                }
                sequence.desiredIndex = intro.from;
                if (sequence.displayedIndex !== intro.from) {
                    commit(sequence, intro.from, sequence.prepared[intro.from], policy);
                } else {
                    // A matching index is not the required
                    // representation: the ready rep of this same frame
                    // paints before the clock starts.
                    commitUpgrade(sequence, intro.from, sequence.prepared[intro.from], policy);
                }
                schedule();
            },

            // A required set's standing — the scrub gate's frames or the
            // intro's startup buffer, judged the same way: DEAD when a
            // member can never arrive or the whole set can never coexist
            // under the decoded budget, READY when every member can
            // paint now, WAITING otherwise. A set that is just the
            // desired frame is never priced dead: the single-frame
            // exception admits it alone.
            setStatus = function (sequence, set, policy) {
                var member = set.length,
                    ready = true;
                while (member--) {
                    if (!frameReadyAt(sequence, set[member], policy)) {
                        ready = false;
                        if (frameDead(sequence, set[member], policy)) {
                            return DEAD;
                        }
                    }
                }
                if (!exceptionAllowed(set, sequence.desiredIndex) &&
                        !setReservation(sequence, set, policy).feasible) {
                    return DEAD;
                }
                return ready ? READY : WAITING;
            },

            // The scrub buffer gate, per the host's authored count.
            // Open means frame changes paint as their readiness lands;
            // closed means the standing image keeps standing while the
            // desired index and its following set prepare together. A
            // set that cannot fund keeps its gate closed, and that
            // verdict is remembered for the same desire, direction,
            // standing image and its proof, under the same policy, until
            // an input or a source failure — the set is not re-priced on
            // every pass that changes nothing, and a proof landing for
            // the standing image is a change.
            driveBuffered = function (sequence, desired, policy) {
                var status;
                if (sequence.gateOpen && frameReadyAt(sequence, desired, policy)) {
                    commit(sequence, desired, sequence.prepared[desired], policy);
                    evaluateUpgrade(sequence, policy);
                    ensureNeighbors(sequence, policy);
                    return;
                }
                sequence.gateOpen = false;
                if (sequence.deadGateDesired === desired && sequence.deadGateDirection === sequence.direction &&
                        sequence.deadGateStanding === sequence.displayedRep &&
                        sequence.deadGateReady === sequence.displayedReady &&
                        sequence.deadGatePolicy === policy.version) {
                    status = DEAD;
                } else {
                    status = setStatus(sequence, planFor(sequence).required, policy);
                    if (status === DEAD) {
                        sequence.deadGateDesired = desired;
                        sequence.deadGateDirection = sequence.direction;
                        sequence.deadGateStanding = sequence.displayedRep;
                        sequence.deadGateReady = sequence.displayedReady;
                        sequence.deadGatePolicy = policy.version;
                    }
                }
                if (status === DEAD) {
                    evaluateUpgrade(sequence, policy);
                    return;
                }
                if (status === READY) {
                    sequence.gateOpen = true;
                    commit(sequence, desired, sequence.prepared[desired], policy);
                    evaluateUpgrade(sequence, policy);
                }
                ensureNeighbors(sequence, policy);
            },

            // scrollOffset is the read phase's snapshot — geometry and
            // position are measured before this pass writes anything.
            drive = function (sequence, progress, policy, scrollOffset) {
                var desired,
                    goal,
                    cursor,
                    prepared;
                if (sequence.queued) {
                    sequence.playDrivenAt = sequence.nowMs;
                    sequence.playProgress = progress;
                    sequence.playOffset = scrollOffset;
                    sequence.playActive = false;
                }
                if (passMotionNow || (sequence.queued && $doc.hidden)) {
                    // A reduced-motion page keeps its authored baseline;
                    // the authored initial frame still refines itself.
                    evaluateUpgrade(sequence, policy);
                    return;
                }
                if (sequence.phase === 'intro' || sequence.phase === 'intro-wait') {
                    // Direct playback hands off on scroll. Queued playback
                    // finishes a running intro; startup waiting still yields.
                    if (scrollOffset === sequence.introScrollOffset || (sequence.queued && sequence.phase === 'intro')) {
                        return;
                    }
                    endIntro(sequence);
                }
                desired = indexOnRange(sequence.scrollFrom, sequence.scrollTo, progress);
                if (sequence.queued) {
                    goal = desired;
                    cursor = sequence.playCursor;
                    if (cursor === -1 || (cursor === null && backForwardNavigation())) {
                        cursor = goal;
                    } else if (cursor === null) {
                        cursor = sequence.scrollFrom;
                    } else if (sequence.displayedIndex >= 0 && sequence.displayedIndex !== cursor &&
                            (goal - sequence.displayedIndex) * (cursor - sequence.displayedIndex) <= 0) {
                        cursor = sequence.displayedIndex;
                    } else if (sequence.displayedIndex === cursor && sequence.displayedReady &&
                            cursor !== goal && (sequence.playAt === null ||
                                sequence.nowMs - sequence.playAt >= sequence.playInterval)) {
                        cursor += goal > cursor ? 1 : -1;
                        sequence.playAt = sequence.nowMs;
                    }
                    sequence.playCursor = cursor;
                    desired = cursor;
                    // Only an advancing, ready playhead needs another clock tick.
                    // Pending preparation wakes the existing owner on completion.
                    sequence.playActive = cursor !== goal && sequence.displayedIndex === cursor &&
                            sequence.displayedReady;
                    if (goal !== cursor) {
                        sequence.direction = goal > cursor ? 1 : -1;
                    }
                }
                // The travel direction the lookahead follows — the sign
                // of the last move; before any move the declared range's
                // own direction.
                if (!sequence.queued && desired !== sequence.desiredIndex) {
                    if (sequence.desiredIndex < 0) {
                        sequence.direction = sequence.scrollTo >= sequence.scrollFrom ? 1 : -1;
                    } else {
                        sequence.direction = desired > sequence.desiredIndex ? 1 : -1;
                    }
                }
                sequence.desiredIndex = desired;
                if (sequence.scrubBufferFrames > 0 && !(sequence.gateOpen && desired === sequence.displayedIndex)) {
                    driveBuffered(sequence, desired, policy);
                    if (sequence.queued) {
                        sequence.playActive = desired !== goal && sequence.displayedIndex === desired && sequence.displayedReady;
                    }
                    return;
                }
                if (desired === sequence.displayedIndex) {
                    // The desired frame is already the painted one —
                    // unless its own source failed.
                    if (displayedSourceFailed(sequence)) {
                        commitUpgrade(sequence, desired, sequence.prepared[desired], policy);
                    }
                    evaluateUpgrade(sequence, policy);
                    ensureNeighbors(sequence, policy);
                    return;
                }
                prepared = sequence.prepared[desired];
                if (prepared !== undefined && prepared.ready === true &&
                        repPaintable(sequence, desired, prepared.rep, policy)) {
                    commit(sequence, desired, prepared, policy);
                }
                if (sequence.queued) {
                    sequence.playActive = desired !== goal && sequence.displayedIndex === desired && sequence.displayedReady;
                }
                ensureNeighbors(sequence, policy);
            },

            // A background paint claimed earlier is verified against the
            // computed source this pass's read phase took. A value still
            // in flight toward the claim — a transition's cross-fade
            // naming it — keeps the claim pending, and the next pass
            // reads again while the claim is inside its pending bound,
            // counted from its first pending read. Past the bound the
            // claim requests no pass of its own, and the next pass that
            // reads it still pending treats it as owned mid-transition.
            // Predecessor evidence — the replaced source still computed
            // under a background-image transition, read only where the
            // platform cannot list animations — is pending only inside
            // the bound; at or past it, it is foreign. A claim that
            // settles as owned lets the next pass sharpen: sharpening
            // waited while it was pending.
            // Only our still-owned inline declaration can be reverted.
            // Positive computed evidence reverts: a readable
            // computed source that does not name the claim means a
            // stylesheet rule outranking the inline layer kept the
            // declaration from ever becoming the presentation. The
            // inline declaration and the bookkeeping both return to what
            // stood before, and that representation is not painted again
            // until a fresh input. Unreadable style is no evidence, and
            // the claim stands.
            verifyClaim = function (sequence, at) {
                var prior = sequence.claimPrior,
                    evidence = sequence.passClaim,
                    style = sequence.element.style;
                sequence.passClaim = undefined;
                // A newer inline declaration is another writer's decision,
                // even if computed style still shows our transitioning image.
                // Completion work must not reclaim it; a fresh input may retry.
                if (!ownsBackground(sequence)) {
                    sequence.claimPending = false;
                    sequence.painted = false;
                    sequence.yielded = true;
                    sequence.playActive = false;
                    retirePlaybackWake(sequence);
                    endIntro(sequence);
                    clearPrepared(sequence);
                    setDisplayed(sequence, -1, null, false);
                    prior.rep = null;
                    sequence.dirty = false;
                    sequence.passMeasured = null;
                    sequence.passPolicy = null;
                    return;
                }
                if ((evidence === 'pending' || evidence === 'predecessor') &&
                        !sequence.claimLapsed) {
                    if (sequence.claimPendingSince === null) {
                        sequence.claimPendingSince = at;
                    }
                    if (at - sequence.claimPendingSince >= pendingVerifyMs) {
                        sequence.claimLapsed = true;
                    }
                    if (evidence === 'pending' || !sequence.claimLapsed) {
                        return;
                    }
                }
                if (evidence === 'predecessor') {
                    evidence = 'foreign';
                }
                sequence.claimPending = false;
                if (!sequence.displayedRep || evidence !== 'foreign') {
                    // Sharpening waits while a claim is pending, so a
                    // rung that landed meanwhile is looked at again by
                    // the pass that follows — this one settles right
                    // after when it measured.
                    if (sequence.upgradesEnabled && sequence.displayedRep && sequence.passMeasured === null) {
                        sequence.dirty = true;
                    }
                    return;
                }
                sequence.unwinnable = sequence.displayedRep.src;
                if (prior.value) {
                    style.setProperty('background-image', prior.value, prior.priority);
                } else {
                    style.removeProperty('background-image');
                }
                sequence.ownedBackground = style.getPropertyValue('background-image');
                sequence.ownedPriority = style.getPropertyPriority('background-image');
                setDisplayed(sequence, prior.index, prior.rep, prior.ready);
                prior.rep = null;
                // The refusal is a fresh decision for the scene.
                sequence.dirty = true;
            },

            // A waiting intro at the start position: the authored
            // startup buffer is the demand. The clock starts only in a
            // pass where the whole set is ready; a member that can
            // never arrive or a set that can never coexist ends the
            // intro once. The bound is one absolute deadline on the
            // frame clock from the first genuinely eligible pass.
            awaitIntro = function (sequence, policy, at) {
                var status;
                if (sequence.introDeadlineAtMs === null) {
                    sequence.introDeadlineAtMs = at + introWaitDeadlineMs;
                }
                if (at >= sequence.introDeadlineAtMs) {
                    endIntro(sequence);
                    return;
                }
                if (sequence.introDeadlineId === null) {
                    // The pending wake is the remaining interval only.
                    armIntroDeadline(sequence, sequence.introDeadlineAtMs - at);
                }
                status = setStatus(sequence, planFor(sequence).required, policy);
                if (status === DEAD) {
                    endIntro(sequence);
                    return;
                }
                ensureNeighbors(sequence, policy);
                if (status === READY) {
                    startIntro(sequence, policy);
                }
            },

            // One sequence's settle phase of the pass: proximity and
            // range state from the read phase, parked completions
            // reconciled against the pass's own policy, then intent.
            settleSequence = function (sequence, at) {
                var policy = sequence.passPolicy,
                    measured = sequence.passMeasured,
                    wasNear = sequence.nearView,
                    rendered = hostRendered(policy),
                    settled,
                    drained,
                    settledRemaining,
                    settledIndex,
                    entry;
                sequence.passMeasured = null;
                sequence.nowMs = at;
                demandRefused = false;
                sequence.nearView = measured.near !== false;
                sequence.rangeValid = measured.progress !== null;
                if (!sequence.nearView && wasNear) {
                    releaseRetained(sequence);
                    // Nothing seen while away is a fresh presentation
                    // decision on return.
                    sequence.gateOpen = false;
                }
                // Landed representations reconcile before any drive,
                // intro start, or upgrade evaluation looks at the
                // cache. The drain is seeded once, so a settle landing
                // mid-pass waits untouched for the next one.
                settled = sequence.settledOps;
                if (settled.length) {
                    drained = settled.length;
                    settledRemaining = drained;
                    settledIndex = 0;
                    while (settledRemaining--) {
                        entry = settled[settledIndex];
                        retainSettled(sequence, entry.rep, entry.image, policy);
                        release(sequence, entry.rep);
                        settledIndex += 1;
                    }
                    // Whatever landed during the drain moves to the
                    // front, in place.
                    settledRemaining = settled.length - drained;
                    settledIndex = 0;
                    while (settledRemaining--) {
                        settled[settledIndex] = settled[settledIndex + drained];
                        settledIndex += 1;
                    }
                    settled.length = settledIndex;
                    prunePrepared(sequence, policy);
                }
                if (!sequence.rangeValid || !rendered) {
                    retirePlaybackWake(sequence);
                    sequence.playActive = false;
                    sequence.playAt = null;
                    // No measurable range or no rendered host: intent
                    // withdraws. A running intro ends for good; a
                    // waiting intro stays inert with its deadline timer
                    // disarmed — the recorded bound keeps counting.
                    if (sequence.phase === 'intro') {
                        endIntro(sequence);
                    }
                    if (sequence.phase === 'intro-wait') {
                        stopTimer(sequence.introDeadlineId);
                        sequence.introDeadlineId = null;
                    } else {
                        sequence.desiredIndex = -1;
                    }
                    sequence.gateOpen = false;
                    return;
                }
                // The declared wait resolves on the measured position,
                // the document's visibility and the motion preference:
                // anywhere but the authored start, a root offset that
                // moved since the wait began, a hidden document, or
                // reduced motion ends the phase so drive runs normally
                // in this same pass.
                if ((sequence.phase === 'intro-wait' &&
                        (measured.progress !== 0 || measured.offset !== sequence.introScrollOffset ||
                            $doc.hidden)) ||
                        ((sequence.phase === 'intro-wait' || sequence.phase === 'intro') && passMotionNow)) {
                    endIntro(sequence);
                }
                if (sequence.phase === 'intro-wait' && sequence.nearView) {
                    awaitIntro(sequence, policy, at);
                }
                drive(sequence, measured.progress, policy, measured.offset);
            },

            // One scroll subscription per distinct resolved root,
            // shared by every sequence measuring it. A sequence whose
            // root is a nested element also joins the window's group:
            // the page scrolling moves that root toward or away from
            // the viewport, and whether the scene is near is measured
            // against the page viewport too.
            rootGroupFor = function (root) {
                var index = rootGroups.length,
                    group;
                while (index--) {
                    if (rootGroups[index].root === root) {
                        return rootGroups[index];
                    }
                }
                group = {root: root, sequences: [], subscription: null};
                // A native input the module keeps for the page's life;
                // the group holds it.
                group.subscription = new Subscription('scroll', root || $w, function () {
                    var members = group.sequences,
                        member = members.length;
                    while (member--) {
                        scrollInput(members[member]);
                    }
                });
                rootGroups.push(group);
                return group;
            },

            // A ResizeObserver delivery: every sequence a reported
            // target can move is dirtied; reports for unwatched boxes
            // schedule no work.
            observerDelivery = function (entries) {
                var entryIndex = entries.length,
                    memberIndex,
                    entry,
                    record,
                    members;
                while (entryIndex--) {
                    entry = entries[entryIndex];
                    record = observed.get(entry.target);
                    if (record) {
                        members = record.sequences;
                        memberIndex = members.length;
                        while (memberIndex--) {
                            input(members[memberIndex], true);
                        }
                    }
                }
            },

            // A watched box is shared state: one record per target
            // carries every sequence whose geometry or resolution
            // policy it can move.
            observeTarget = function (sequence, target) {
                var index,
                    record,
                    members;
                if (!target || observerFailed) {
                    return;
                }
                if (!observer) {
                    if (NativeResizeObserver === null || NativeWeakMap === null) {
                        observerFailed = true;
                        return;
                    }
                    try {
                        observed = new NativeWeakMap();
                        observer = new NativeResizeObserver(observerDelivery);
                    } catch (observerError) {
                        observer = null;
                        observerFailed = true;
                        return;
                    }
                }
                record = observed.get(target);
                if (!record) {
                    // A host that refuses one target loses only that
                    // observation.
                    try {
                        observer.observe(target);
                    } catch (observeError) {
                        return;
                    }
                    record = {sequences: []};
                    observed.set(target, record);
                }
                members = record.sequences;
                index = members.length;
                while (index--) {
                    if (members[index] === sequence) {
                        return;
                    }
                }
                members.push(sequence);
            },

            // The scrub scope: an explicit reference must name exactly
            // one element that actually declares a scrollscrub
            // relationship; otherwise the nearest ancestor-or-self that
            // does. The walk is over elements only.
            scopeFor = function (element) {
                var selector = element.getAttribute('data-sequence-scrub'),
                    node = element,
                    found;
                if (selector !== null) {
                    try {
                        found = selector === '' ? null : $doc.querySelectorAll(selector);
                    } catch (unusable) {
                        found = null;
                    }
                    if (!found || found.length !== 1 || !found[0].hasAttribute(scrubMarker)) {
                        throw malformed('data-sequence-scrub must resolve to exactly one ' +
                            scrubMarker + ' element');
                    }
                    return found[0];
                }
                while (node && node.nodeType === 1) {
                    if (node.hasAttribute(scrubMarker)) {
                        return node;
                    }
                    node = node.parentNode;
                }
                throw malformed('no scrollscrub scope declares this sequence');
            },

            // The declared skip is exactly one authored native button,
            // effectively type=button, and authored initially hidden.
            resolveSkip = function (selector) {
                var found,
                    control;
                try {
                    found = $doc.querySelectorAll(selector);
                } catch (error) {
                    throw malformed('sequence-intro-skip must be a usable selector');
                }
                if (!found || found.length !== 1) {
                    throw malformed('sequence-intro-skip must match exactly one element');
                }
                control = found[0];
                if (tagName(control) !== 'BUTTON' ||
                        (control.getAttribute('type') || 'submit').toLowerCase() !== 'button' ||
                        !control.hasAttribute('hidden')) {
                    throw malformed('sequence-intro-skip must name an initially hidden button[type=button]');
                }
                return {control: control, hiddenValue: control.getAttribute('hidden')};
            },

            // Ownership is counted across every declaration on the
            // page: a control claimed by more than one is bindable by
            // none of them.
            skipClaimCount = function (control) {
                var count = 0,
                    index = declaredSkipClaims.length;
                while (index--) {
                    if (declaredSkipClaims[index] === control) {
                        count += 1;
                    }
                }
                return count;
            },

            // The intro is a declared phase of the same owner, not a
            // separate player: duration positive, indices within the
            // catalog, the ready trigger only, a supported easing, and —
            // when a skip is declared — a skip this host alone can own.
            // Anything else is a malformed declaration and the whole
            // host stays at its authored baseline: a declared skip that
            // cannot be owned never leaves an intro without its way out,
            // and never leaves a half-enhanced host behind.
            introFor = function (element, frameCount) {
                var durationText = attribute(element, 'sequence-intro-duration-ms'),
                    durationMs,
                    from,
                    to,
                    trigger,
                    easingName,
                    skipSelector,
                    skip = null;
                if (durationText === null) {
                    return null;
                }
                durationMs = decimalValue(durationText, false);
                if (!$isFinite(durationMs)) {
                    throw malformed('sequence-intro-duration-ms must be a nonnegative decimal duration');
                }
                if (durationMs === 0) {
                    return null;
                }
                from = catalogIndex(attribute(element, 'sequence-intro-from'), 'sequence-intro-from', frameCount);
                to = catalogIndex(attribute(element, 'sequence-intro-to'), 'sequence-intro-to', frameCount);
                trigger = attribute(element, 'sequence-intro-trigger');
                if (trigger !== null && trigger !== 'ready') {
                    throw malformed('sequence-intro-trigger must be ready');
                }
                easingName = attribute(element, 'sequence-intro-easing');
                if (easingName === null) {
                    easingName = 'ease-in-out';
                }
                if (easingName !== 'linear' && easingName !== 'ease-in-out') {
                    throw malformed('sequence-intro-easing must be linear or ease-in-out');
                }
                skipSelector = attribute(element, 'sequence-intro-skip');
                if (skipSelector !== null) {
                    skip = resolveSkip(skipSelector);
                    if (skipClaimCount(skip.control) !== 1) {
                        throw malformed('sequence-intro-skip names a control another sequence also declares');
                    }
                }
                return {
                    from: from === null ? 0 : from,
                    to: to === null ? frameCount - 1 : to,
                    durationMs: durationMs,
                    easing: easingName === 'linear' ? easeLinear : easeInOut,
                    skip: skip,
                    skipRevealed: false
                };
            },

            // Catalog metadata normalized once at bind: every source
            // resolved against the document base, each frame's
            // representation ladder, and the source → [{index, rep}]
            // alias index settlement and adoption consult. One complete
            // URL is one resource with one intrinsic size; a source the
            // platform cannot parse is a malformed declaration.
            // An img host writes sharper representations as srcset
            // candidates, so an upgrade URL that cannot be written as
            // one (srcsetPaint) never enters its ladder: it could never
            // paint without growing the box.
            catalogFor = function (element, srcsetPaint) {
                var parsed = readFragment(element.getAttribute(marker), marker, 'catalog', malformed),
                    frames,
                    dimensions = $create(null),
                    aliasIndex = $create(null),
                    ladders = [],
                    ladder = [],
                    remaining,
                    index = 0,
                    reps,
                    repRemaining,
                    repIndex,
                    rep,
                    seen,
                    src,
                    base;
                try {
                    parsed = imageresolution['catalog'](parsed);
                } catch (invalid) {
                    throw malformed(invalid && invalid.message ? invalid.message : 'the catalog is invalid');
                }
                frames = parsed['frames'];
                remaining = frames.length;
                while (remaining--) {
                    reps = imageresolution['representationsFor'](frames[index]);
                    repRemaining = reps.length;
                    repIndex = 0;
                    while (repRemaining--) {
                        src = resolveSource(reps[repIndex]['src']);
                        if (src === null) {
                            throw malformed('a catalog source cannot be resolved');
                        }
                        if (repIndex === 0) {
                            base = src;
                        }
                        // css is the background declaration, written
                        // once on the first paint that needs it.
                        rep = {src: src, width: reps[repIndex]['width'], height: reps[repIndex]['height'], css: null};
                        seen = dimensions[src];
                        if (seen !== undefined && (seen.width !== rep.width || seen.height !== rep.height)) {
                            throw malformed('one resource cannot carry two intrinsic sizes');
                        }
                        dimensions[src] = rep;
                        if (repIndex === 0 || !srcsetPaint || !srcsetUnsafe.test(src)) {
                            ladder.push(rep);
                            if (aliasIndex[src] === undefined) {
                                aliasIndex[src] = [];
                            }
                            aliasIndex[src].push({index: index, rep: rep});
                        }
                        repIndex += 1;
                    }
                    ladders[index] = ladder;
                    ladder = [];
                    frames[index]['src'] = base;
                    index += 1;
                }
                return {frames: frames, ladders: ladders, aliasIndex: aliasIndex};
            },

            // Everything that can refuse — the declaration, the
            // catalog, the scope, the authored baseline, the intro
            // decision, the watch targets — runs before anything
            // registers, so a refusal leaves the host exactly as
            // authored and costs no later declaration its binding.
            bind = function (element, ordinal) {
                var reference = element.getAttribute(marker),
                    playback,
                    playbackFps,
                    declaredProperty,
                    srcAttribute = null,
                    style = null,
                    baseline,
                    catalog,
                    frameCount,
                    scopeElement,
                    range,
                    root,
                    from,
                    to,
                    intro,
                    sequence,
                    watchers,
                    content,
                    index;
                // srcset or a picture parent already owns this host's
                // source — native selection stays authoritative, so the
                // host is left to the browser, silently, as
                // progressiveresolution leaves it.
                if (nativelySelected(element, true)) {
                    return;
                }
                playback = attribute(element, 'sequence-playback');
                playbackFps = attribute(element, 'sequence-playback-fps');
                if (playback !== null && playback !== 'direct' && playback !== 'queued') {
                    throw malformed('sequence-playback must be direct or queued');
                }
                if (playbackFps !== null && (!/^[0-9]+$/.test(playbackFps) ||
                        +playbackFps < 1 || +playbackFps > 120 || playback !== 'queued')) {
                    throw malformed('sequence-playback-fps requires queued playback and an integer from 1 to 120');
                }
                declaredProperty = property(element, malformed);
                // The host already presents an image: an img sequence
                // host without an authored src attribute — absent, or
                // only whitespace — has no baseline to stand on or
                // return to. The attribute is kept verbatim for that
                // return.
                if (declaredProperty === 'src') {
                    srcAttribute = element.getAttribute('src');
                    if (srcAttribute === null || srcAttribute.trim() === '') {
                        throw malformed(marker + ' on an img requires an authored src baseline');
                    }
                } else {
                    // A background baseline is one image or none: a
                    // layered or generated value — a gradient beside a
                    // url(), several url()s — is not a presentation one
                    // frame can stand in for.
                    style = computedStyle(element);
                    baseline = style && typeof style.getPropertyValue === 'function' ?
                            style.getPropertyValue('background-image') : '';
                    baseline = typeof baseline === 'string' ? baseline.trim() : '';
                    if (baseline !== '' && baseline !== 'none' && cssUrlSource(baseline) === null) {
                        throw malformed('the authored background-image must be a single url() or none');
                    }
                }
                catalog = catalogFor(element, declaredProperty === 'src');
                frameCount = catalog.frames.length;
                scopeElement = scopeFor(element);
                range = scrollrange['read'](scopeElement);
                if (range.resolved.error) {
                    throw malformed(range.resolved.error.message || 'the scrub declaration is malformed');
                }
                root = range.resolved.root;
                from = catalogIndex(attribute(element, 'sequence-from'), 'sequence-from', frameCount);
                to = catalogIndex(attribute(element, 'sequence-to'), 'sequence-to', frameCount);
                from = from === null ? 0 : from;
                to = to === null ? frameCount - 1 : to;
                intro = introFor(element, frameCount);
                sequence = {
                    element: element,
                    property: declaredProperty,
                    frames: catalog.frames,
                    ladders: catalog.ladders,
                    aliasIndex: catalog.aliasIndex,
                    scopeElement: scopeElement,
                    range: range,
                    queued: playback === 'queued',
                    playInterval: 1000 / (+playbackFps || 30),
                    playCursor: null,
                    playProgress: 0,
                    playOffset: 0,
                    playAt: null,
                    playWakeId: null,
                    playWakeAt: null,
                    playDrivenAt: -1,
                    playActive: false,
                    scrollFrom: from,
                    scrollTo: to,
                    // The lookahead's travel direction — the declared
                    // range's own direction until a real move reports.
                    direction: to >= from ? 1 : -1,
                    // The last animation timestamp the pass supplied.
                    nowMs: 0,
                    displayedIndex: -1,
                    displayedRep: null,
                    displayedReady: false,
                    desiredIndex: -1,
                    prepared: $create(null),
                    // Physical operations by URL — one resource, one
                    // request, whichever index or role asked for it.
                    ops: $create(null),
                    opCount: 0,
                    // The URL admitted under the single-frame
                    // exception, while it is outstanding.
                    exceptionalSrc: null,
                    holds: $create(null),
                    ownedBytes: 0,
                    failed: $create(null),
                    undecoded: $create(null),
                    // URLs whose hidden-document decode refusal already
                    // had its one retry.
                    decodeRetried: $create(null),
                    upgradesEnabled: element.hasAttribute(resolutionMarker),
                    initialIsFrameZero: false,
                    intro: intro,
                    introBufferMs: bufferValue(element, 'sequence-intro-buffer-ms', false),
                    scrubBufferFrames: bufferValue(element, 'sequence-scrub-buffer-frames', true),
                    gateOpen: false,
                    // A closed gate judged unable to fund, remembered
                    // for this desire, direction and standing image.
                    deadGateDesired: -1,
                    deadGateDirection: 0,
                    deadGateStanding: null,
                    deadGateReady: false,
                    deadGatePolicy: -1,
                    // The preparation plan, refilled in place.
                    plan: {
                        built: false,
                        time: -1,
                        desired: -1,
                        direction: 0,
                        phase: null,
                        gateOpen: false,
                        lead: -1,
                        order: [],
                        members: [],
                        requiredStore: [],
                        required: null,
                        requiredMembers: null
                    },
                    // The policy snapshot, refilled in place; version
                    // moves when an input of it changed, read once any
                    // read phase took it. policyDirty asks the next read
                    // phase for it whatever the scene's proximity.
                    policy: {cap: 'auto', fit: '', devicePixelRatio: 1, width: 0, height: 0, version: 0, read: false},
                    policyDirty: true,
                    // The selection memo and the two versions it was
                    // computed under; sourceVersion moves whenever a
                    // source's standing does.
                    repMemo: [],
                    repMemoPolicy: [],
                    repMemoSources: [],
                    sourceVersion: 0,
                    // The cached reservation, the carrier it is priced
                    // into, the as-if carrier commitUpgrade prices, and
                    // the stamped scratch books.
                    reservation: null,
                    reservationSet: null,
                    reservationPolicy: -1,
                    reservationSources: -1,
                    pricing: {feasible: false, byIndex: [], set: null},
                    asIfPricing: {feasible: false, byIndex: [], set: null},
                    scratch: {
                        stamp: 0,
                        mark: $create(null),
                        count: $create(null),
                        groups: $create(null),
                        groupList: [],
                        pinned: $create(null),
                        picked: $create(null)
                    },
                    introDeadlineId: null,
                    introDeadlineAtMs: null,
                    // The scene's identity for the session record:
                    // catalog reference plus the declared scroll and
                    // intro ranges.
                    introKey: intro ? introSessionKey(element,
                        reference + '|' + from + '-' + to + '|' + intro.from + '-' + intro.to,
                        ordinal) : null,
                    phase: 'scroll',
                    introStartMs: null,
                    introScrollOffset: 0,
                    authoredSrcAttribute: srcAttribute,
                    authoredInline: null,
                    // Whether the module has written the image property
                    // since the baseline last stood, and the srcset and
                    // sizes values it last wrote on an img.
                    painted: false,
                    ownedBackground: null,
                    ownedPriority: null,
                    ownedSrc: null,
                    yielded: false,
                    ownedSrcset: null,
                    ownedSizes: null,
                    // Whether adoption of the authored image waits for
                    // the next read phase.
                    adoptPending: false,
                    skipSubscription: null,
                    // The focus watchers — the scope's blur and the
                    // document's focusin — that return a borrowed
                    // tabindex.
                    focusLease: null,
                    // A background paint awaiting a read phase's
                    // verification, the state it replaced, the evidence
                    // that read took, and a URL the cascade refused
                    // until a fresh input; the batch time of the claim's
                    // first pending read, and whether its pending bound
                    // ran out; the source the latest paint replaced, and
                    // the computed baseline a first paint replaces.
                    claimPending: false,
                    claimPredecessor: null,
                    baselineSource: null,
                    claimPendingSince: null,
                    claimLapsed: false,
                    claimPrior: {index: -1, rep: null, ready: false, value: '', priority: ''},
                    passClaim: undefined,
                    unwinnable: null,
                    nearView: false,
                    rangeValid: false,
                    dirty: true,
                    // Page or platform code threw during this pass: contained,
                    // and the host is re-dirtied without a frame of its
                    // own.
                    faulted: false,
                    passPolicy: null,
                    passMeasured: null,
                    measurement: {},
                    settledOps: []
                };
                // The authored inline background is the baseline this
                // host returns to — value and priority captured before
                // the first enhancement write.
                if (declaredProperty === 'background-image' && element.style) {
                    sequence.authoredInline = {
                        value: element.style.getPropertyValue('background-image') || '',
                        priority: element.style.getPropertyPriority('background-image') || ''
                    };
                }
                adoptAuthored(sequence, style);
                // The intro's opening frame is a declared desire, not
                // bind-time work: the pass measures first and admits the
                // proof through the same gates any desire faces. A
                // back/forward return after the intro ran skips straight
                // to scroll ownership.
                if (intro && !reducedMotion() &&
                        !(backForwardNavigation() && introConsumedInSession(sequence.introKey))) {
                    sequence.phase = 'intro-wait';
                    sequence.desiredIndex = intro.from;
                    sequence.introScrollOffset = scrollOffset(root);
                }
                watchers = policyWatchTargets(element);
                // Registration — nothing below refuses a declaration.
                rootGroupFor(root).sequences.push(sequence);
                if (root) {
                    rootGroupFor(null).sequences.push(sequence);
                }
                observeTarget(sequence, range.resolved.subject);
                if (root) {
                    observeTarget(sequence, root);
                }
                // The boxes that grow with the root's scrollable content,
                // as scrollrange resolved them: an element root's own box
                // does not change when its content grows — a root that
                // becomes scrollable later, or a subject whose offset
                // inside it moves, shows up only in its content — and the
                // viewport's span and every subject's document position
                // follow the document's own boxes.
                content = range.resolved.content;
                index = content ? content.length : 0;
                while (index--) {
                    observeTarget(sequence, content[index]);
                }
                index = watchers.length;
                while (index--) {
                    observeTarget(sequence, watchers[index]);
                }
                sequences.push(sequence);
                dirty(sequence);
            },

            // Declaration order is the bind order. One host's failure —
            // a malformed declaration, or page or platform code that
            // throws anywhere in its bind — leaves that host as
            // authored and never costs a later declaration its
            // enhancement; a malformed declaration is also reported
            // once.
            bindAll = function (hosts) {
                var remaining = hosts.length,
                    index = 0,
                    claim;
                // Skip ownership is decided before any host binds.
                while (remaining--) {
                    try {
                        claim = attribute(hosts[index], 'sequence-intro-skip');
                        if (claim) {
                            declaredSkipClaims.push(resolveSkip(claim).control);
                        }
                    } catch (ignore) {
                        // Invalid on its own — that host's bind refuses
                        // and reports it.
                    }
                    index += 1;
                }
                remaining = hosts.length;
                index = 0;
                while (remaining--) {
                    declarationError = null;
                    try {
                        bind(hosts[index], index);
                    } catch (bindError) {
                        if (bindError !== null && bindError === declarationError) {
                            report('paste.ui.imagesequence', hosts[index], bindError.message);
                        }
                    }
                    index += 1;
                }
            },

            // A pass that threw for one host costs only that host: its
            // pass state clears and it is marked faulted — nothing else
            // happens in the phase that threw. The write phase ends a
            // faulted host's intro and leaves the host dirty, measured
            // again with the next pass any input asks for, never
            // scheduling one of its own. A failure in page or platform
            // code is contained, not reported.
            fault = function (sequence) {
                retirePlaybackWake(sequence);
                sequence.passPolicy = null;
                sequence.passMeasured = null;
                sequence.passClaim = undefined;
                sequence.faulted = true;
            },

            // An adoption still owed behind a cross-fade asks for its
            // pass when the host's listed background-image transition
            // settles — finished or cancelled — so nothing polls while
            // it runs. Without the list, only an input asks again.
            adoptWhenSettled = function (sequence) {
                var element = sequence.element,
                    transition = typeof element.getAnimations === 'function' ?
                            listedTransition(element) : null,
                    finished = transition ? transition['finished'] : null,
                    settle = function () {
                        if (sequence.adoptPending) {
                            dirty(sequence);
                        }
                    };
                if (finished && typeof finished.then === 'function') {
                    finished.then(settle, settle);
                }
            },

            // The read phase for one sequence: a pending adoption, a
            // pending claim's computed evidence, the range measure when
            // the scene is dirty, and the policy snapshot when the scene
            // is near, playing, or a policy input fired. One
            // computed-style read serves every style question this host
            // asks in the phase.
            readSequence = function (sequence, remeasure) {
                var element = sequence.element,
                    style = null,
                    styled = false,
                    measured = null,
                    near;
                if (sequence.yielded) {
                    sequence.dirty = false;
                    return;
                }
                if (sequence.adoptPending) {
                    sequence.adoptPending = false;
                    style = computedStyle(element);
                    styled = true;
                    adoptAuthored(sequence, style);
                    if (sequence.adoptPending) {
                        adoptWhenSettled(sequence);
                    }
                }
                if (sequence.claimPending) {
                    if (!styled) {
                        style = computedStyle(element);
                        styled = true;
                    }
                    sequence.passClaim = claimEvidence(sequence, style);
                }
                if (sequence.dirty || remeasure) {
                    sequence.dirty = false;
                    measured = measureRange(sequence.range, sequence.measurement);
                    sequence.passMeasured = measured;
                }
                if (measured !== null || sequence.phase === 'intro' || (sequence.playActive && sequence.playWakeId === null)) {
                    near = measured !== null ? measured.near !== false : sequence.nearView;
                    if (near || remeasure || sequence.policyDirty || !sequence.policy.read ||
                            sequence.phase === 'intro' || sequence.playActive) {
                        if (!styled) {
                            style = computedStyle(element);
                        }
                        sequence.policyDirty = false;
                        policyRead(sequence, style);
                    }
                    sequence.passPolicy = sequence.policy;
                }
            },

            // Reduced motion arriving: the intro ends and the authored
            // baseline comes back — writes only; adoption and the
            // static pass follow in the next frame's read phase.
            standDown = function (sequence) {
                retirePlaybackWake(sequence);
                sequence.passPolicy = null;
                sequence.passMeasured = null;
                sequence.playActive = false;
                sequence.playCursor = null;
                endIntro(sequence);
                restoreBaseline(sequence);
                sequence.desiredIndex = -1;
            };

        // The module's one frame pass, armed as one phased request.
        // The read phase runs before any module writes in the batch:
        // scroll geometry and the resolution-policy snapshot together,
        // a pending claim's computed source alone, for every sequence
        // in play. The write phase follows every module's reads: a
        // motion preference that changed since the last pass is
        // applied, as writes; then pending background claims are
        // verified, each measured sequence settles in declaration
        // order, every playing intro ticks, and a host that faulted in
        // either phase ends its intro. Each sequence's part of each
        // phase is contained: one host's throw never starves the
        // others. A re-request happens only while an intro is
        // progressing, a background claim awaits its verification
        // inside its pending bound, or
        // the pass itself left a sequence dirty — everything else is
        // input- or completion-driven.
        readPass = function () {
            var index,
                sequence;
            if (passRead) {
                return;
            }
            passRead = true;
            frameRequested = false;
            passMotionNow = reducedMotion();
            passMotionChanged = passMotionNow !== motionSeen;
            motionSeen = passMotionNow;
            index = sequences.length;
            while (index--) {
                sequence = sequences[index];
                sequence.faulted = false;
                try {
                    readSequence(sequence, passMotionChanged);
                } catch (readError) {
                    fault(sequence);
                }
            }
        };

        writePass = function (at) {
            var reschedule = false,
                index,
                remaining,
                sequence;
            if (!passRead) {
                return;
            }
            passRead = false;
            if (passMotionChanged && passMotionNow) {
                index = sequences.length;
                while (index--) {
                    try {
                        standDown(sequences[index]);
                    } catch (motionError) {
                        fault(sequences[index]);
                    }
                }
            }
            passMotionChanged = false;
            index = sequences.length;
            while (index--) {
                sequence = sequences[index];
                if (sequence.claimPending && !sequence.faulted) {
                    try {
                        verifyClaim(sequence, at);
                    } catch (claimError) {
                        fault(sequence);
                    }
                }
            }
            remaining = sequences.length;
            index = 0;
            while (remaining--) {
                sequence = sequences[index];
                index += 1;
                if (sequence.passMeasured !== null) {
                    try {
                        settleSequence(sequence, at);
                    } catch (settleError) {
                        fault(sequence);
                    }
                }
            }
            remaining = sequences.length;
            index = 0;
            while (remaining--) {
                sequence = sequences[index];
                index += 1;
                if (sequence.phase === 'intro' && sequence.passPolicy !== null) {
                    demandRefused = false;
                    try {
                        introTick(sequence, at, sequence.passPolicy);
                    } catch (tickError) {
                        fault(sequence);
                    }
                }
                if (sequence.queued && sequence.phase === 'scroll' && sequence.playActive && sequence.playWakeId === null &&
                        sequence.passPolicy !== null && sequence.playDrivenAt !== at) {
                    sequence.nowMs = at;
                    try {
                        drive(sequence, sequence.playProgress, sequence.passPolicy, sequence.playOffset);
                    } catch (playError) {
                        sequence.playActive = false;
                        fault(sequence);
                    }
                }
                sequence.passPolicy = null;
                if (sequence.playActive && !sequence.faulted && !sequence.yielded) {
                    armPlaybackWake(sequence, at);
                } else {
                    retirePlaybackWake(sequence);
                }
                if (sequence.faulted) {
                    try {
                        endIntro(sequence);
                    } catch (ignore) {
                        // Every step inside is already contained.
                    }
                    sequence.dirty = true;
                } else if (sequence.phase === 'intro' || sequence.dirty ||
                        (sequence.claimPending && !sequence.claimLapsed)) {
                    reschedule = true;
                }
            }
            if (reschedule) {
                schedule();
            }
        };

        if (NativePromise !== null && NativeImage !== null) {
            hosts = $doc.querySelectorAll('[' + marker + ']');
            // No declared sequence, no listener of any kind — not even
            // the motion query's.
            if (hosts.length) {
                // A reported change only schedules: the pass applies it.
                motionRecord = mediaquery['observe']('(prefers-reduced-motion: reduce)', inputEverySequence);
                motionSeen = reducedMotion();
                try {
                    decodeSupported = typeof (new NativeImage()).decode === 'function';
                } catch (unavailable) {
                    decodeSupported = false;
                }
                bindAll(hosts);
            }
            if (!sequences.length) {
                if (motionRecord !== null) {
                    motionRecord['dispose']();
                    motionRecord = null;
                }
            } else {
                pageInputs.push(new Subscription('resize', $w, inputEverySequence));

                // ResizeObserver reports sizes, not positions: an image
                // or web font finishing inside a box whose own size is
                // fixed moves a subject while no watched box resizes and
                // no scroll or resize carries the shift. Bound before the
                // document's own load, every sequence takes one fresh
                // look when it fires — the same re-measure scrollscrub
                // makes, so a scope and its sequence agree. Nothing
                // waits on it, and the subscription retires with its one
                // delivery; bound after load, the first pass already
                // measured settled geometry.
                if ($doc.readyState !== 'complete') {
                    pageInputs.push(new Subscription('load', $w, inputEverySequence, null, 1));
                }

                // A hidden document ends every intro; a visible one is a
                // fresh look — a decode the platform refused while the
                // document was hidden gets its one retry.
                pageInputs.push(new Subscription('visibilitychange', $doc, function () {
                    var index = sequences.length,
                        sequence,
                        src;
                    if ($doc.hidden) {
                        while (index--) {
                            retirePlaybackWake(sequences[index]);
                            sequences[index].playActive = false;
                            sequences[index].playAt = null;
                            endIntroNow(sequences[index]);
                        }
                    } else {
                        while (index--) {
                            sequence = sequences[index];
                            for (src in sequence.undecoded) {
                                if (sequence.undecoded[src] === true) {
                                    sequence.decodeRetried[src] = true;
                                }
                            }
                            sequence.undecoded = $create(null);
                            sequence.sourceVersion += 1;
                            input(sequence, true);
                        }
                    }
                }));

                // The device pixel ratio moving is an input of its own
                // for every sequence that sharpens.
                watchIndex = sequences.length;
                while (watchIndex--) {
                    if (sequences[watchIndex].upgradesEnabled) {
                        mediaquery['watchResolution'](inputEverySequence);
                        watchIndex = 0;
                    }
                }
            }
        }

        return imagesequence;
    }
);
