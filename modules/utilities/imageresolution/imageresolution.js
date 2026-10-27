/*jslint browser:true plusplus:true regexp:true sub:true */
/*globals paste */

/**
 * The resolution-selection contract the enhancement elements share,
 * reduced to pure functions: validate a descriptor's representations
 * and upgrade ladder, then choose the smallest representation that
 * covers a supplied painted need inside a supplied width cap.
 *
 * The selection contract touches no DOM, network or clock: callers
 * measure their own hosts and pass numbers and already-read CSS text;
 * committing a source is the owning element's decision, gated on
 * "still wanted, not worse". The host helpers at the end are the one
 * copy of the reads and the preparation both owners make of their
 * hosts.
 *
 * catalog(document) validates a {frames: [...]} catalog and returns it
 * normalized: every frame carries a non-empty src, positive integral
 * intrinsic width/height, and an upgrade ladder declared in ascending
 * order — width and height both grow at every step — that shares the
 * base aspect ratio: a resolution step is the same content, never a
 * different crop. descriptor(document) is the same contract for one
 * standalone image: {src, width, height, upgrades}. Invalid input —
 * including a ladder declared out of order — throws TypeError; nothing
 * half-validates and nothing is silently reordered.
 *
 * representationsFor(base) is base first, then its upgrades in
 * declared (ascending) order — the list selection walks.
 *
 * needFor(paintedWidth, paintedHeight, intrinsicWidth, intrinsicHeight,
 * fit, devicePixelRatio, densityCorrected) returns the intrinsic width
 * that would render the painted box sharply. 'fit' is the computed
 * object-fit keyword or the computed background-size text:
 *
 *   'cover' / 'fill' — the larger axis scale; a cover crop can demand a
 *       wider source than the box, a fill stretch both axes.
 *   'contain' — the smaller axis scale.
 *   'none', 'auto', 'auto auto' — the image paints at its own intrinsic
 *       size. A plain source or background paints larger, never sharper,
 *       at more pixels: the need is the base width and no upgrade is
 *       ever demanded.
 *   'scale-down' — contain when that shrinks the base, otherwise the
 *       same intrinsic-size rule as 'none'.
 *   one or two background-size lengths ('960px', '50%', 'auto 100%',
 *       '960px 540px') — the rendered size those lengths give the
 *       image, against the painted box for percentages; two explicit
 *       positive axes stretch, so the larger axis scale applies. If
 *       either axis resolves to zero, CSS displays no image and the
 *       demand is zero, regardless of the other axis or device ratio.
 *   a comma-separated layer list, or any value this grammar does not
 *       cover — unverifiable: no demand beyond the base.
 *   '' (the fit could not be read) — the painted width alone.
 *
 * densityCorrected is true for an img whose representations are written
 * as srcset width descriptors with sizes at the base's intrinsic width:
 * every representation then keeps the base's intrinsic size and only
 * its density changes, so 'none' and a non-shrinking 'scale-down' paint
 * the base box at scale 1 and the need is the base width times the
 * device pixel ratio. Backgrounds never pass it.
 *
 * A degenerate box or image returns 0 — no demand.
 *
 * selectCandidate(representations, need, cap) picks the smallest
 * representation covering need among the eligible — the cap (an
 * intrinsic pixel width; 'auto' or anything that is not a finite
 * number means no cap) limits OPTIONAL upgrades only; index 0 is always
 * eligible because a quality cap never blocks the base. When nothing
 * eligible is sufficient, the largest eligible is the honest best.
 *
 * cssUrl(src) serializes a URL as a quoted CSS url() token, escaping
 * the characters that would otherwise end or corrupt it.
 * cssUrlSource(value) is the reading side: the decoded URL of a value
 * consisting of exactly one url() token, or null for anything else — a
 * gradient, 'none', or a layered list verifies nothing.
 * cssUrlSources(value) is the decoded URL of every url() token in a
 * value, in order — [] when there is none. An owner reads a computed
 * background-image with both: a single url() equal to its own source is
 * owned; a value whose url() tokens include its own source but is not
 * a single url() — a cross-fade or interpolation while a transition
 * runs — is pending, so the claim is kept and verified again next pass;
 * anything else is a foreign writer.
 *
 * sizeContainer(containerType) is true when a computed container-type
 * carries the 'size' or 'inline-size' keyword among its tokens — a
 * size container is a box whose size container queries resolve
 * against, whatever other container features the value combines.
 *
 * transitionsBackground(property, duration, delay) reads a host's
 * computed transition-property, transition-duration and
 * transition-delay: true when the last property entry naming
 * background-image — 'all', 'background' or 'background-image' — has a
 * positive combined duration (the duration, never negative, plus the
 * delay) at its position, the time lists repeating to the length of the
 * property list. Under such a transition an owner's computed source can
 * still read as the source its paint replaced before the transition
 * starts reporting the change. Where the host lists its running
 * animations (getAnimations), that list is the owners' evidence and
 * this reading is not consulted; only where it is absent does an owner
 * treat a computed value whose url() tokens include that predecessor
 * as pending too, inside its pending bound, and without such a
 * transition the predecessor still showing is a foreign writer.
 *
 * Host helpers. Platform globals are captured once, when this module
 * defines, ahead of both owners; a page script replacing one later
 * changes nothing. A declaration problem throws what the caller's
 * optional fail(message) returns — a plain TypeError when it passes
 * none — so an owner that tells its own declaration errors apart from
 * page or platform failures by identity can.
 *
 *   tagName(element), computedStyle(element) — the upper-cased tag
 *       name; the computed style, or null where the platform has none.
 *   report(owner, element, message) — a TypeError naming the owner and
 *       the host ('#id', else the tag name), rethrown on a later task
 *       through the captured timer, so the page's error reporting sees
 *       it and nothing reaches the console. A refused timer loses it.
 *   readFragment(reference, name, block, fail) — the parsed JSON of the
 *       script[type="application/json"] a '#id' reference names. block
 *       names that script in the invalid-JSON message: a noun, or null
 *       for its '#id'.
 *   resolveSource(src) — src resolved against the document base, src
 *       itself where the platform has no URL parser or base, null for
 *       a URL it cannot parse or a non-string.
 *   property(element, fail) — the declared data-image-property: 'src'
 *       (img hosts only) or 'background-image'; by tag name when
 *       omitted.
 *   nativelySelected(element, selfIncluded) — whether srcset, sizes or
 *       a picture already selects the host's source: an img carrying
 *       srcset or sizes, or a picture ancestor. selfIncluded counts a
 *       host that is itself a picture too; imagesequence passes it,
 *       progressiveresolution does not.
 *   paintedBox(host, rect, style) — the sizing area for an image or
 *       background, using its owner record, measured rectangle and
 *       computed style. Both resolution owners use the same policy.
 *   policyWatchTargets(host) — the host plus every ancestor element
 *       that is a size container.
 *   listedTransition(element) — the host's background-image
 *       transition still in flight, delayed or running, from
 *       getAnimations, or null; call it only where getAnimations exists.
 *   claimState(element, style, own, predecessor) — what a background
 *       host's computed background-image says about the owner's claim
 *       on the resolved URL own: 'owned', 'pending', 'predecessor',
 *       'foreign', or 'unread' when the style cannot be read or the
 *       value is blank, by the rule cssUrlSources and
 *       transitionsBackground describe above.
 *   prepare(element, imgHost, rep) — one native Image preparation of
 *       rep: a promise for the image once it decoded (load where the
 *       platform has no decode) and, unless rep's src is a vector
 *       source, its reported natural size does not contradict rep's
 *       width and aspect ratio; otherwise a rejection {src, decode,
 *       requested} — decode for a decoder refusal after a good load,
 *       requested false when no request ever started. An img host's
 *       authored crossorigin and referrerpolicy carry to the fetch. A
 *       vector source is a '.svg' or '.svgz' path, before any query or
 *       fragment, or an image/svg+xml data URL.
 *
 * @example
 *     // internal use — the elements own the only public surface
 *     var frame = imageresolution['catalog'](parsed)['frames'][0],
 *         need = imageresolution['needFor'](960, 540, 640, 640, 'cover', 2),
 *         pick = imageresolution['selectCandidate'](
 *             imageresolution['representationsFor'](frame), need, 'auto');
 *     if (pick['width'] > displayed['width']) { commit(host, pick['src']); }
 *
 * @requires paste/event
 * @module paste/ui/utilities/imageresolution
 */
paste['define'](
    'paste.ui.utilities.imageresolution',
    ['paste.event'],
    function (imageresolution, event) {
        'use strict';

        var $w = window,
            $doc = document,
            NativePromise = typeof Promise === 'function' ? Promise : null,
            NativeImage = $w['Image'],
            NativeURL = typeof $w['URL'] === 'function' ? $w['URL'] : null,
            $getComputedStyle = typeof $w['getComputedStyle'] === 'function' ?
                    $w['getComputedStyle'] : null,
            $setTimeout = $w['setTimeout'],
            $parseJSON = JSON['parse'],
            Subscription = event['Event']['Subscription'],
            $math = Math,
            $floor = $math['floor'],
            $abs = $math['abs'],
            $max = $math['max'],
            $min = $math['min'],
            $isFinite = isFinite,
            $isArray = Array['isArray'],
            $Number = Number,
            $String = String,
            $fromCharCode = $String['fromCharCode'],
            $parseInt = parseInt,
            $parseFloat = parseFloat,
            REPLACEMENT = $fromCharCode(0xFFFD),
            urlTokens = /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^()"'\s]+))\s*\)/gi,
            identifierChar = /[\-\w\\]/,
            urlToken = /^url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^()"'\s]+))\s*\)$/i,
            escapeToken = /\\(?:[0-9a-fA-F]{1,6}[\t\n\f ]?|[\s\S])/g,
            hexDigit = /^[0-9a-fA-F]/,
            // The elements' plain decimal grammar — digits with an
            // optional fraction, or a bare fraction; no sign, exponent,
            // radix prefix or unit. Attributes apply it to their text
            // untrimmed; this computed custom-property reading alone
            // tolerates surrounding whitespace, which a custom property
            // keeps from its declaration.
            capToken = /^\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*$/,
            // The paint path's patterns live here, built once: cssUrl
            // runs on every background commit and sizeScale on every
            // measured background-size.
            sizeSeparator = /\s+/,
            listSeparator = /\s*,\s*/,
            timeToken = /^(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+\-]?[0-9]+)?)(s|ms)$/i,
            backslashes = /\\/g,
            quotes = /"/g,
            carriageReturns = /\r/g,
            lineFeeds = /\n/g,
            formFeeds = /\f/g,
            // A vector source's reported natural size is the engine's
            // own default for the document, not pixels: a viewBox-only
            // image reads 0x0 in one engine and a default box in
            // another.
            vectorSource = /^data:image\/svg\+xml[;,]|\.svgz?(?:[?#]|$)/i,

            // A computed length in px; anything unreadable is none.
            computedLength = function (style, name) {
                var length = $parseFloat(style.getPropertyValue(name));
                return length > 0 ? length : 0;
            },

            // The first layer's keyword of a layered background value.
            firstLayer = function (value) {
                return (value || '').split(',')[0].trim();
            },

            // The viewport, without scrollbars: the root element's
            // client box. In quirks mode neither the root element nor
            // the body reports it in every engine — either can answer
            // its own box — so the window's inner size, scrollbars
            // included, stands in.
            viewportBox = function () {
                var root = $doc.compatMode === 'BackCompat' ? null : $doc.documentElement;
                return {
                    width: (root && root.clientWidth) || $w.innerWidth || 0,
                    height: (root && root.clientHeight) || $w.innerHeight || 0
                };
            },

            // An img's content box, or a background's origin box for its
            // first layer's attachment — over the scrollable content for
            // 'local' on a box that scrolls — from the border-box rect
            // and the pass's own style read. Padding, border and
            // scrollable size are layout lengths: where the rect differs
            // from the layout size by more than rounding, a transform
            // scales the rendered box, and the lengths scale with it.
            originBox = function (host, rect, style, attachment) {
                var element = host.element,
                    origin = 'content-box',
                    overflow,
                    local = false,
                    offsetWidth,
                    offsetHeight,
                    borderX,
                    borderY,
                    paddingX = 0,
                    paddingY = 0,
                    scaleX = 1,
                    scaleY = 1,
                    width,
                    height;
                if (host.property === 'background-image') {
                    // A box overflow does not apply to — an inline box —
                    // reports no client or scrollable size: it keeps its
                    // origin box.
                    overflow = style.getPropertyValue('overflow-x');
                    local = attachment === 'local' && overflow !== '' &&
                        overflow !== 'visible' && overflow !== 'clip' &&
                        element.clientWidth > 0 && element.clientHeight > 0 &&
                        element.scrollWidth > 0 && element.scrollHeight > 0;
                    origin = firstLayer(style.getPropertyValue('background-origin'));
                }
                if (origin === 'border-box' && !local) {
                    return rect;
                }
                borderX = computedLength(style, 'border-left-width') +
                    computedLength(style, 'border-right-width');
                borderY = computedLength(style, 'border-top-width') +
                    computedLength(style, 'border-bottom-width');
                if (origin === 'content-box') {
                    paddingX = computedLength(style, 'padding-left') +
                        computedLength(style, 'padding-right');
                    paddingY = computedLength(style, 'padding-top') +
                        computedLength(style, 'padding-bottom');
                }
                if (!local && borderX + paddingX === 0 && borderY + paddingY === 0) {
                    return rect;
                }
                offsetWidth = element.offsetWidth;
                offsetHeight = element.offsetHeight;
                if (offsetWidth > 0 && $abs(rect.width - offsetWidth) > 1) {
                    scaleX = rect.width / offsetWidth;
                }
                if (offsetHeight > 0 && $abs(rect.height - offsetHeight) > 1) {
                    scaleY = rect.height / offsetHeight;
                }
                if (local) {
                    // The scrollable size is the padding box of the
                    // content, past the border; the border box adds it
                    // back.
                    width = element.scrollWidth - paddingX +
                        (origin === 'border-box' ? borderX : 0);
                    height = element.scrollHeight - paddingY +
                        (origin === 'border-box' ? borderY : 0);
                } else {
                    width = (rect.width / scaleX) - borderX - paddingX;
                    height = (rect.height / scaleY) - borderY - paddingY;
                }
                width *= scaleX;
                height *= scaleY;
                return {width: width > 0 ? width : 0, height: height > 0 ? height : 0};
            },

            // The box the image is sized against, from the border-box
            // rect and the pass's own style read: an img's content box;
            // a background's positioning area — the box its
            // background-origin names (the padding box by default),
            // measured over the whole scrollable content for a 'local'
            // attachment on a box that scrolls (one with a client box
            // and a scrollable size). A 'fixed' attachment paints
            // against the viewport where the engine honours it and
            // against that same origin box where it paints 'scroll'
            // instead, which this read cannot tell apart: the larger of
            // the two in each dimension covers either — a larger fetch,
            // never a blurrier image (an unrendered host keeps its empty
            // box).
            paintedBox = function (host, rect, style) {
                var attachment = host.property === 'background-image' ?
                        firstLayer(style.getPropertyValue('background-attachment')) : '',
                    box = originBox(host, rect, style, attachment),
                    viewport;
                if (attachment !== 'fixed' || (rect.width === 0 && rect.height === 0)) {
                    return box;
                }
                viewport = viewportBox();
                return {
                    width: box.width > viewport.width ? box.width : viewport.width,
                    height: box.height > viewport.height ? box.height : viewport.height
                };
            },

            finite = function (value, name) {
                if (typeof value !== 'number' || !$isFinite(value)) {
                    throw new TypeError(name + ' must be finite');
                }
                return value;
            },

            representation = function (document, name) {
                var src = document && document['src'],
                    width = document && document['width'],
                    height = document && document['height'];
                if (typeof src !== 'string' || !src.trim()) {
                    throw new TypeError(name + ' src must be a non-empty string');
                }
                // These are intrinsic JSON dimensions, not CSS values:
                // coercing "640", true or [640] silently changes a malformed
                // declaration into a different image contract.
                finite(width, name + ' width');
                finite(height, name + ' height');
                if (!(width > 0) || !(height > 0) ||
                        $floor(width) !== width || $floor(height) !== height) {
                    throw new TypeError(name + ' dimensions must be positive integers');
                }
                return {'src': src, 'width': width, 'height': height};
            },

            // An upgrade ladder: declared in ascending order, width AND
            // height growing at every step, one aspect ratio throughout
            // — a resolution step is the same content at more pixels,
            // never a different crop and never a shorter image.
            upgradesFor = function (document, base, name) {
                var declared = document['upgrades'],
                    upgrades,
                    baseWidth = base['width'],
                    aspect = baseWidth / base['height'],
                    previousWidth = baseWidth,
                    previousHeight = base['height'],
                    remaining,
                    index,
                    rung,
                    width,
                    height;
                // Omission means no sharper rungs; an explicit null or
                // non-array is malformed JSON, not an empty declaration.
                if (declared !== undefined && !$isArray(declared)) {
                    throw new TypeError(name + ' upgrades must be an array');
                }
                upgrades = [];
                if (!declared) {
                    return upgrades;
                }
                // Forward order is semantic: each rung is checked
                // against the one declared before it.
                remaining = declared.length;
                index = 0;
                while (remaining--) {
                    rung = representation(declared[index], name + ' upgrades[' + index + ']');
                    width = rung['width'];
                    height = rung['height'];
                    if (width <= previousWidth || height <= previousHeight) {
                        throw new TypeError(name + ' upgrades must ascend in width and height');
                    }
                    if ($abs(width / height - aspect) > aspect * 0.01) {
                        throw new TypeError(name + ' upgrades[' + index + '] must share the base aspect ratio');
                    }
                    upgrades[index] = rung;
                    previousWidth = width;
                    previousHeight = height;
                    index += 1;
                }
                return upgrades;
            },

            catalog = function (document) {
                var frames,
                    sourceFrames = document && document['frames'],
                    index,
                    base,
                    name;
                if (!$isArray(sourceFrames) || !sourceFrames.length) {
                    throw new TypeError('catalog must contain a non-empty frames array');
                }
                frames = [];
                index = sourceFrames.length;
                while (index--) {
                    name = 'frames[' + index + ']';
                    base = representation(sourceFrames[index], name);
                    base['upgrades'] = upgradesFor(sourceFrames[index], base, name);
                    frames[index] = base;
                }
                return {'frames': frames};
            },

            descriptor = function (document) {
                var base = representation(document, 'descriptor');
                base['upgrades'] = upgradesFor(document, base, 'descriptor');
                return base;
            },

            // The representations of one image: base first, then its
            // upgrades in declared (ascending) order.
            representationsFor = function (base) {
                return [{
                    'src': base['src'],
                    'width': base['width'],
                    'height': base['height']
                }].concat(base['upgrades'] || []);
            },

            // One background-size component in CSS pixels: a px
            // length, or a percentage of the painted box's axis. 'auto'
            // answers null; anything else — calc(), an unconverted
            // unit — answers undefined: unverifiable.
            sizeComponent = function (token, axis) {
                var unit,
                    value;
                if (token === 'auto') {
                    return null;
                }
                if (token.length > 2 && token.slice(-2) === 'px') {
                    unit = 1;
                    value = $Number(token.slice(0, -2));
                } else if (token.length > 1 && token.slice(-1) === '%') {
                    unit = axis / 100;
                    value = $Number(token.slice(0, -1));
                } else {
                    return undefined;
                }
                if (!$isFinite(value) || value < 0) {
                    return undefined;
                }
                return value * unit;
            },

            // The rendering scale an explicit background-size gives the
            // image, or 0 for nothing demandable beyond the base (a zero
            // axis, both axes auto, or a value outside the grammar).
            sizeScale = function (fit, paintedWidth, paintedHeight, intrinsicWidth, intrinsicHeight) {
                var tokens = fit.split(sizeSeparator),
                    width,
                    height;
                if (tokens.length > 2) {
                    return 0;
                }
                width = sizeComponent(tokens[0], paintedWidth);
                height = tokens.length === 2 ? sizeComponent(tokens[1], paintedHeight) : null;
                if (width === undefined || height === undefined) {
                    return 0;
                }
                // CSS paints no background image when either resolved
                // axis is zero. The other axis must not trigger a larger
                // image download for an image that cannot be displayed.
                // null means auto, so only an explicit zero stops demand.
                if (width === 0 || height === 0) {
                    return 0;
                }
                if (width === null && height === null) {
                    return 0;
                }
                if (height === null) {
                    return width / intrinsicWidth;
                }
                if (width === null) {
                    return height / intrinsicHeight;
                }
                // Two positive explicit axes stretch the image non-uniformly:
                // each axis must arrive at painted density, so the
                // larger scale governs.
                return $max(width / intrinsicWidth, height / intrinsicHeight);
            },

            // Intrinsic width that would render the painted box sharply.
            // The requirement is intrinsicWidth times the rendering
            // scale times the device ratio — dividing painted size by
            // scale would invert it and underestimate. Fits that paint
            // the image at its own intrinsic size answer the base
            // width: there a larger source paints larger, not sharper.
            needFor = function (paintedWidth, paintedHeight, intrinsicWidth, intrinsicHeight, fit, devicePixelRatio, densityCorrected) {
                var ratio = typeof devicePixelRatio === 'number' && $isFinite(devicePixelRatio) &&
                        devicePixelRatio > 0 ? devicePixelRatio : 1,
                    widthScale,
                    heightScale,
                    scale;
                // No painted area means no pixels to sharpen — either
                // dimension at zero is zero demand, never a fallback
                // to whatever the other axis would have asked for.
                if (!(paintedWidth > 0) || !(paintedHeight > 0) ||
                        !(intrinsicWidth > 0) || !(intrinsicHeight > 0)) {
                    return 0;
                }
                if (typeof fit !== 'string') {
                    fit = '';
                }
                // Fits that paint the image at its own intrinsic size:
                // sharper only through density.
                if (fit === 'none' && densityCorrected === true) {
                    return intrinsicWidth * ratio;
                }
                if (fit === 'none' || fit === 'auto' || fit === 'auto auto') {
                    return intrinsicWidth;
                }
                // One size per background layer: which layer is the
                // declared image is not something this value says —
                // nothing beyond the base is demanded.
                if (fit.indexOf(',') !== -1) {
                    return 0;
                }
                widthScale = paintedWidth / intrinsicWidth;
                heightScale = paintedHeight / intrinsicHeight;
                if (fit === '') {
                    scale = widthScale;
                } else if (fit === 'cover' || fit === 'fill') {
                    scale = $max(widthScale, heightScale);
                } else if (fit === 'contain') {
                    scale = $min(widthScale, heightScale);
                } else if (fit === 'scale-down') {
                    // Contain when that shrinks the base; otherwise the
                    // base paints at its own intrinsic size.
                    scale = $min(widthScale, heightScale, 1);
                } else {
                    scale = sizeScale(fit, paintedWidth, paintedHeight, intrinsicWidth, intrinsicHeight);
                }
                if (scale === 1 && fit === 'scale-down') {
                    return densityCorrected === true ? intrinsicWidth * ratio : intrinsicWidth;
                }
                if (!(scale > 0) || !$isFinite(scale)) {
                    return 0;
                }
                return intrinsicWidth * scale * ratio;
            },

            // Smallest representation that supplies the need, capped by
            // the caller's policy — the cap limits OPTIONAL upgrades
            // only; the base is always eligible because a quality cap
            // never blocks content. When nothing eligible is sufficient,
            // the largest eligible is the honest best. A cap that is
            // not a finite number is no cap at all.
            selectCandidate = function (representations, need, cap) {
                // One pass over the ascending ladder: the first eligible
                // rep meeting the need is the smallest sufficient, and
                // the last eligible seen is the fallback when none is.
                var capped = typeof cap === 'number' && $isFinite(cap),
                    index = 0,
                    remaining = representations.length,
                    candidate,
                    width,
                    largestEligible = null;
                while (remaining--) {
                    candidate = representations[index];
                    width = candidate['width'];
                    if (index === 0 || !capped || width <= cap) {
                        largestEligible = candidate;
                        if (width >= need) {
                            return candidate;
                        }
                    } else {
                        // The validated ladder is ascending: every
                        // remaining upgrade is above this cap too.
                        return largestEligible;
                    }
                    index += 1;
                }
                return largestEligible;
            },

            // A URL written into a CSS declaration is serialized text:
            // quotes, backslashes and line terminators are legal inside
            // a URL yet corrupt an unescaped quoted string — the paint
            // would parse as nothing at all.
            cssUrl = function (src) {
                return 'url("' + $String(src)
                    .replace(backslashes, '\\\\')
                    .replace(quotes, '\\"')
                    .replace(carriageReturns, '\\d ')
                    .replace(lineFeeds, '\\a ')
                    .replace(formFeeds, '\\c ') + '")';
            },

            // One CSS escape, decoded. A hex escape of 1-6 digits takes
            // one optional trailing whitespace; zero, a surrogate, or a
            // value past U+10FFFF is the replacement character, and an
            // astral code point becomes its UTF-16 surrogate pair.
            unescapeOne = function (match) {
                var esc = match.slice(1),
                    code;
                if (!hexDigit.test(esc)) {
                    return esc;
                }
                code = $parseInt(esc, 16);
                if (code === 0 || (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF) {
                    return REPLACEMENT;
                }
                if (code > 0xFFFF) {
                    code -= 0x10000;
                    return $fromCharCode(0xD800 + $floor(code / 0x400), 0xDC00 + code % 0x400);
                }
                return $fromCharCode(code);
            },

            cssText = function (text) {
                return $String(text).replace(escapeToken, unescapeOne);
            },

            // The decoded URL of a value that is exactly one url()
            // token — a computed declaration hands back the escapes
            // cssUrl wrote, so a URL carrying a quote still equals
            // itself. Anything else is null.
            cssUrlSource = function (value) {
                var match = typeof value === 'string' ? urlToken.exec(value.trim()) : null;
                if (!match) {
                    return null;
                }
                return cssText(match[1] !== undefined ? match[1] :
                        (match[2] !== undefined ? match[2] : match[3]));
            },

            // The decoded URL of every url() token in a value, in order.
            // A token counts only where it starts an identifier — the
            // tail of a longer name is not a url() function.
            cssUrlSources = function (value) {
                var sources = [],
                    match,
                    start;
                if (typeof value !== 'string') {
                    return sources;
                }
                urlTokens.lastIndex = 0;
                match = urlTokens.exec(value);
                while (match) {
                    start = match.index;
                    if (start === 0 || !identifierChar.test(value.charAt(start - 1))) {
                        sources.push(cssText(match[1] !== undefined ? match[1] :
                                (match[2] !== undefined ? match[2] : match[3])));
                    }
                    match = urlTokens.exec(value);
                }
                return sources;
            },

            // A size container: 'size' or 'inline-size' among the
            // whitespace-separated tokens of a computed container-type.
            sizeContainer = function (containerType) {
                var tokens,
                    index;
                if (typeof containerType !== 'string') {
                    return false;
                }
                tokens = containerType.split(sizeSeparator);
                index = tokens.length;
                while (index--) {
                    if (tokens[index] === 'size' || tokens[index] === 'inline-size') {
                        return true;
                    }
                }
                return false;
            },

            // A computed time in milliseconds; anything unreadable is 0.
            timeMs = function (text) {
                var match = timeToken.exec(text),
                    value = match ? $Number(match[1]) : 0;
                if (!$isFinite(value)) {
                    return 0;
                }
                return match && match[2].toLowerCase() === 's' ? value * 1000 : value;
            },

            // Whether a computed transition animates background-image:
            // the last transition-property entry naming it — 'all',
            // 'background' or 'background-image' — decides, with its
            // duration and delay at the same position, each list
            // repeating to the length of the property list; it runs when
            // its combined duration — the duration, never negative,
            // plus the delay — is positive.
            transitionsBackground = function (property, duration, delay) {
                var properties,
                    durations,
                    delays,
                    index,
                    name,
                    span;
                if (typeof property !== 'string' || typeof duration !== 'string' ||
                        typeof delay !== 'string') {
                    return false;
                }
                properties = property.trim().split(listSeparator);
                durations = duration.trim().split(listSeparator);
                delays = delay.trim().split(listSeparator);
                index = properties.length;
                while (index--) {
                    name = properties[index].toLowerCase();
                    if (name === 'all' || name === 'background' || name === 'background-image') {
                        span = $max(timeMs(durations[index % durations.length]), 0) +
                            timeMs(delays[index % delays.length]);
                        return span > 0;
                    }
                }
                return false;
            },

            tagName = function (element) {
                return (element.tagName || '').toUpperCase();
            },

            computedStyle = function (element) {
                return $getComputedStyle === null ? null : $getComputedStyle(element);
            },

            declarationError = function (message) {
                return new TypeError(message);
            },

            // A malformed declaration is reported once, off the bind
            // path: the error surfaces through the page's own error
            // reporting and the define sweep continues.
            report = function (owner, element, message) {
                var error = new TypeError(owner + ' ' +
                        (element.id ? '#' + element.id : tagName(element).toLowerCase()) +
                        ': ' + message);
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

            // '#id' names an inert script[type="application/json"] block —
            // a declaration, not executable configuration. One read, one
            // parse.
            readFragment = function (reference, name, block, fail) {
                var id = typeof reference === 'string' && reference.charAt(0) === '#' ? reference.slice(1) : null,
                    refuse = fail || declarationError,
                    element,
                    type;
                if (!id) {
                    throw refuse(name + ' must be a #fragment reference');
                }
                element = $doc.getElementById(id);
                if (!element) {
                    throw refuse(name + ' references a missing element: ' + id);
                }
                type = (element.getAttribute('type') || '').toLowerCase();
                if (tagName(element) !== 'SCRIPT' || type !== 'application/json') {
                    throw refuse(name + ' must reference a script[type="application/json"] element');
                }
                try {
                    return $parseJSON(element.textContent || '');
                } catch (parseError) {
                    throw refuse(name + ' ' + (block === null ? '#' + id : block) + ' is not valid JSON');
                }
            },

            // A declared URL is authored against the document's base —
            // resolved once at read time, so later comparisons stand on
            // absolute URLs. Absolute URLs keep their own origin; a
            // module's own bundle location is never a base. A URL the
            // platform cannot parse resolves to null — the caller
            // decides what that means; it never escapes as an exception.
            resolveSource = function (src) {
                var base = $doc.baseURI;
                if (typeof src !== 'string') {
                    return null;
                }
                if (NativeURL === null || !base) {
                    return src;
                }
                try {
                    return new NativeURL(src, base)['href'];
                } catch (parseError) {
                    return null;
                }
            },

            // Whether a url() token of a computed value names this URL —
            // computed values carry absolute URLs, so the plain compare
            // answers without a parse whenever it can.
            namesSource = function (raw, src) {
                return raw === src || resolveSource(raw) === src;
            },

            property = function (element, fail) {
                var declared = element.getAttribute('data-image-property'),
                    refuse = fail || declarationError;
                if (declared === null) {
                    return tagName(element) === 'IMG' ? 'src' : 'background-image';
                }
                if (declared !== 'src' && declared !== 'background-image') {
                    throw refuse('data-image-property must be src or background-image');
                }
                if (declared === 'src' && tagName(element) !== 'IMG') {
                    throw refuse('data-image-property src requires an img host');
                }
                return declared;
            },

            // Native resolution selection already owns srcset, sizes and
            // picture content — an img carrying sizes alone too: an
            // owner never overwrites an authored sizes. The ancestor
            // walk is over elements only.
            nativelySelected = function (element, selfIncluded) {
                var node = selfIncluded === true ? element : element.parentNode;
                if (tagName(element) === 'IMG' &&
                        (element.hasAttribute('srcset') || element.hasAttribute('sizes'))) {
                    return true;
                }
                while (node && node.nodeType === 1) {
                    if (tagName(node) === 'PICTURE') {
                        return true;
                    }
                    node = node.parentNode;
                }
                return false;
            },

            // The elements a resolution refresh must watch: the host
            // itself, plus the ancestors a container query could hit —
            // size containers, whatever other container features their
            // container-type combines. A policy value that only the
            // container changes would otherwise go unread. The walk is
            // over elements only: the document above the root element
            // has no computed style to read.
            policyWatchTargets = function (host) {
                var targets = [host],
                    node = host.parentNode,
                    style,
                    containerType;
                while (node && node.nodeType === 1) {
                    style = computedStyle(node);
                    containerType = style && typeof style.getPropertyValue === 'function' ?
                            style.getPropertyValue('container-type') : '';
                    if (sizeContainer(containerType)) {
                        targets.push(node);
                    }
                    node = node.parentNode;
                }
                return targets;
            },

            // The host's background-image transition still in flight —
            // delayed or running — as the platform lists it, or null. A
            // CSS transition names the longhand it animates: 'background'
            // and 'all' expand to it before any transition exists.
            listedTransition = function (element) {
                var animations = element.getAnimations(),
                    index = animations ? animations.length : 0,
                    animation;
                while (index--) {
                    animation = animations[index];
                    if (animation && animation['transitionProperty'] === 'background-image') {
                        return animation;
                    }
                }
                return null;
            },

            // The only evidence a background claim needs: the source the
            // cascade actually computed. Exactly one url() naming the
            // claimed source owns the paint; a value whose url() tokens
            // include it without being that single url() — a cross-fade
            // or interpolation a transition computes while it runs — is
            // still pending. Where the platform lists the host's
            // animations, that list is the only transition evidence: a
            // background-image transition still in flight is pending
            // whatever older source a chain of paints still computes, and
            // with none in flight the value is foreign. Only where the
            // platform cannot list them does the declared transition stand
            // in: under it the value can still be the source the latest
            // paint replaced, before the transition reports the change, so
            // a value whose url() tokens name that predecessor is
            // predecessor evidence. Anything else is foreign.
            claimState = function (element, style, own, predecessor) {
                var value,
                    single,
                    sources,
                    index;
                if (!style || typeof style.getPropertyValue !== 'function') {
                    return 'unread';
                }
                value = style.getPropertyValue('background-image');
                if (typeof value !== 'string' || value.trim() === '') {
                    return 'unread';
                }
                single = cssUrlSource(value);
                if (single !== null && namesSource(single, own)) {
                    return 'owned';
                }
                sources = cssUrlSources(value);
                index = single === null ? sources.length : 0;
                while (index--) {
                    if (namesSource(sources[index], own)) {
                        return 'pending';
                    }
                }
                if (typeof element.getAnimations === 'function') {
                    return listedTransition(element) !== null ? 'pending' : 'foreign';
                }
                if (predecessor === null || predecessor === own ||
                        !transitionsBackground(style.getPropertyValue('transition-property'),
                            style.getPropertyValue('transition-duration'),
                            style.getPropertyValue('transition-delay'))) {
                    return 'foreign';
                }
                index = sources.length;
                while (index--) {
                    if (namesSource(sources[index], predecessor)) {
                        return 'predecessor';
                    }
                }
                return 'foreign';
            },

            // A preparation that never started — the captured Image
            // constructor refusing, or answering something that is not
            // an element — still settles, so the caller's bookkeeping
            // reconciles; it settles as no request at all, never as the
            // source's failure: nothing ever reached the URL.
            failedPreparation = function (src) {
                return NativePromise['reject']({src: src, decode: false, requested: false});
            },

            // One native preparation: an Image owns the fetch and the
            // decode. The operation is a single promise settling when
            // the underlying request does — the request keeps its
            // physical slot until the platform reports the outcome.
            // decode() is the completion when the platform has it — a
            // load event alone is not decoded content; load is only the
            // fallback for baselines without decode. A rejection
            // reports which side refused: the network (error) or the
            // decoder after a good load. An img host carries its own
            // authored CORS and referrer attributes to the same URL's
            // preparation fetch, so the prepared response is the one
            // the img will use; nothing is added that was not authored,
            // and a background host carries none.
            prepare = function (element, imgHost, rep) {
                var image,
                    src = rep['src'],
                    crossorigin = imgHost ? element.getAttribute('crossorigin') : null,
                    referrerpolicy = imgHost ? element.getAttribute('referrerpolicy') : null,
                    subscriptions = [],
                    requested = false,
                    settled = false,
                    resolveSettled,
                    rejectSettled,
                    promise,
                    release = function () {
                        var index = subscriptions.length,
                            subscription;
                        while (index--) {
                            subscription = subscriptions[index];
                            subscriptions[index] = null;
                            try {
                                subscription['dispose']();
                            } catch (ignore) {
                                // A refusing host surface strands only
                                // its own listener; the op still settles.
                            }
                        }
                        subscriptions = [];
                    },
                    finish = function (done, decodeRefused) {
                        var failure,
                            naturalWidth,
                            naturalHeight,
                            aspect = rep['width'] / rep['height'];
                        if (settled) {
                            return;
                        }
                        // Decode alone cannot prove the declared rung:
                        // incorrectly labelled pixels would change an
                        // img's intrinsic size when painted as srcset.
                        // Match the ladder's aspect-ratio tolerance. A
                        // vector source has no pixel size to contradict
                        // the declaration, and neither has an image
                        // reporting no natural size.
                        if (done && !vectorSource.test(src)) {
                            naturalWidth = image.naturalWidth;
                            naturalHeight = image.naturalHeight;
                            if (naturalWidth > 0 && naturalHeight > 0 &&
                                    (naturalWidth !== rep['width'] ||
                                    $abs(naturalWidth / naturalHeight - aspect) > aspect * 0.01)) {
                                done = false;
                            }
                        }
                        // The op is settled before listeners are
                        // released — a listener removal that throws can
                        // strand a physical claim, never the promise.
                        settled = true;
                        failure = done ? null : {src: src, decode: decodeRefused, requested: requested};
                        try {
                            release();
                        } finally {
                            if (done) {
                                resolveSettled(image);
                            } else {
                                rejectSettled(failure);
                            }
                        }
                    },
                    onLoad = function () {
                        var decoded;
                        if (typeof image.decode !== 'function') {
                            finish(true, false);
                            return;
                        }
                        // The decode boundary is a call into a platform
                        // facility: a synchronous throw or a non-promise
                        // return is a decoder refusal, never proof the
                        // content decoded — and the op must still settle
                        // so its slot frees.
                        try {
                            decoded = image.decode();
                        } catch (decodeError) {
                            finish(false, true);
                            return;
                        }
                        if (!decoded || typeof decoded.then !== 'function') {
                            finish(false, true);
                            return;
                        }
                        try {
                            decoded.then(function () {
                                finish(true, false);
                            }, function () {
                                finish(false, true);
                            });
                        } catch (thenError) {
                            finish(false, true);
                        }
                    },
                    onError = function () {
                        finish(false, false);
                    };
                try {
                    image = new NativeImage();
                } catch (imageError) {
                    return failedPreparation(src);
                }
                // A substitute constructor answering something that is
                // not an element cannot carry the load and error
                // subscriptions — core binds a target without a
                // nodeType to the document instead, and the op would
                // never settle.
                if (!image || image.nodeType !== 1) {
                    return failedPreparation(src);
                }
                promise = new NativePromise(function (resolve, reject) {
                    resolveSettled = resolve;
                    rejectSettled = reject;
                });
                // Everything below is host-owned surface. Any refusal
                // frees what was claimed and settles this op failed;
                // other preparations in the same pass are untouched.
                try {
                    if (crossorigin !== null) {
                        image.crossOrigin = crossorigin;
                    }
                    if (referrerpolicy !== null) {
                        image.referrerPolicy = referrerpolicy;
                    }
                    subscriptions.push(new Subscription('load', image, onLoad));
                    subscriptions.push(new Subscription('error', image, onError));
                    // A preparation is a request that actually starts.
                    image.src = src;
                    requested = true;
                } catch (prepareError) {
                    // Refused before the source was assigned: no request
                    // reached the URL, so the settle carries no verdict.
                    finish(false, false);
                }
                return promise;
            };

        /**
         * The resolution cap an owner reads from --paste-resolution-max-width:
         * a positive plain decimal is a cap in intrinsic pixels; anything
         * else — 'auto', empty, a unit, an exponent, zero — is no cap. One
         * reading for every owner, so the same CSS caps every image alike.
         * @param {*} text The computed custom-property value, or null.
         * @returns {number|string} A positive number, or 'auto'.
         */
        imageresolution['capFrom'] = function (text) {
            var match = typeof text === 'string' ? capToken.exec(text) : null,
                value = match ? $Number(match[1]) : 0;
            return value > 0 && $isFinite(value) ? value : 'auto';
        };
        imageresolution['catalog'] = catalog;
        imageresolution['descriptor'] = descriptor;
        imageresolution['representationsFor'] = representationsFor;
        imageresolution['needFor'] = needFor;
        imageresolution['paintedBox'] = paintedBox;
        imageresolution['selectCandidate'] = selectCandidate;
        imageresolution['cssUrl'] = cssUrl;
        imageresolution['cssUrlSource'] = cssUrlSource;
        imageresolution['cssUrlSources'] = cssUrlSources;
        imageresolution['sizeContainer'] = sizeContainer;
        imageresolution['transitionsBackground'] = transitionsBackground;
        imageresolution['tagName'] = tagName;
        imageresolution['computedStyle'] = computedStyle;
        imageresolution['report'] = report;
        imageresolution['readFragment'] = readFragment;
        imageresolution['resolveSource'] = resolveSource;
        imageresolution['property'] = property;
        imageresolution['nativelySelected'] = nativelySelected;
        imageresolution['policyWatchTargets'] = policyWatchTargets;
        imageresolution['listedTransition'] = listedTransition;
        imageresolution['claimState'] = claimState;
        imageresolution['prepare'] = prepare;
        return imageresolution;
    }
);
