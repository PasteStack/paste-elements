'use strict';

// The imageresolution helper contract: pure arithmetic and validation —
// the intrinsic width a painted box needs is intrinsic size times the
// rendering scale times the device ratio (never painted size divided
// by scale), a cover crop can demand more than the painted box, a
// contain fit can demand more height than width, and the cap narrows
// optional upgrades without ever blocking the base.

const test = require('node:test');
const assert = require('assert/strict');
const {loadModule, eventModule} = require('./fakes.cjs');

function loadResolution() {
    return loadModule({
        file: 'paste/ui/utilities/imageresolution.js',
        name: 'paste.ui.utilities.imageresolution',
        deps: ['paste.event'],
        impls: [eventModule]
    }).module;
}

// The headline case: a 480×270 image painted at 960×540 is rendered
// at twice its intrinsic size — it needs a 960-wide source at dpr 1,
// 1920 at dpr 2. Dividing painted size by scale would halve the answer.
function plainFitNeedsIntrinsicTimesScale() {
    const resolution = loadResolution();
    assert.strictEqual(
        resolution.needFor(960, 540, 480, 270, '', 1),
        960,
        'the painted box wants its own width at dpr 1');
    assert.strictEqual(
        resolution.needFor(960, 540, 480, 270, '', 2),
        1920,
        'device pixels multiply the same painted need');
    // Painted smaller than intrinsic needs only the painted width.
    assert.strictEqual(
        resolution.needFor(240, 135, 480, 270, '', 1),
        240);
}

// Cover crops: the larger of the two axis scales applies, so a box
// taller than the image's aspect pulls demand UP, not down.
function coverDemandsTheLargerAxis() {
    const resolution = loadResolution();
    // 800×450 into a 400×300 cover box: scale is max(0.5, 0.667) —
    // the painted image overflows the box's width entirely.
    assert.ok(
        Math.abs(resolution.needFor(400, 300, 800, 450, 'cover', 1) - 1600 / 3) < 0.01,
        'cover reads the height-dominant scale');
    // A box the image already covers on width needs only the width.
    assert.strictEqual(
        resolution.needFor(960, 270, 480, 270, 'cover', 1),
        960);
}

// Contain letterboxes: the smaller scale fits the whole image inside
// the box — demand follows the limiting axis.
function containFitsTheSmallerAxis() {
    const resolution = loadResolution();
    // 800×450 into a 400×300 contain box: scale is min(0.5, 0.667) —
    // the image renders 400×225, needing 400 intrinsically.
    assert.strictEqual(
        resolution.needFor(400, 300, 800, 450, 'contain', 1),
        400);
    // A wide flat box contains by height: the demand is the rendered
    // width the height implies, not the box's own width.
    assert.ok(
        Math.abs(resolution.needFor(1200, 225, 800, 450, 'contain', 1) - 400) < 0.01,
        'contain on a flat box demands the height-implied width');
}

function degenerateInputsNeedNothing() {
    const resolution = loadResolution();
    assert.strictEqual(resolution.needFor(0, 300, 800, 450, '', 1), 0);
    assert.strictEqual(resolution.needFor(400, 0, 800, 450, '', 1), 0,
        'a zero-height box has no pixels to sharpen');
    assert.strictEqual(resolution.needFor(400, 300, 0, 450, '', 1), 0);
    assert.strictEqual(resolution.needFor(400, 300, 800, 0, '', 1), 0);
}

// A degenerate painted axis under cover or contain must not fall
// through to a width-only fallback: nothing painted is nothing needed.
function degenerateFitsNeedNothing() {
    const resolution = loadResolution();
    ['cover', 'contain'].forEach(function (fit) {
        assert.strictEqual(resolution.needFor(1600, 0, 640, 640, fit, 1), 0,
            fit + ': a collapsed height wants nothing, whatever the width');
        assert.strictEqual(resolution.needFor(0, 700, 640, 640, fit, 1), 0,
            fit + ': a collapsed width wants nothing, whatever the height');
    });
    // The same collapse under the default fit behaves identically.
    assert.strictEqual(resolution.needFor(1600, 0, 640, 640, '', 1), 0);
}

function selectionPicksTheSmallestSufficient() {
    const resolution = loadResolution();
    const descriptor = resolution.descriptor({
        src: 'base-640.jpg', width: 640, height: 640,
        upgrades: [
            {src: 'up-1280.jpg', width: 1280, height: 1280},
            {src: 'up-1920.jpg', width: 1920, height: 1920}
        ]
    });
    const representations = resolution.representationsFor(descriptor);
    assert.strictEqual(representations.length, 3);
    assert.strictEqual(
        resolution.selectCandidate(representations, 700, 'auto').src,
        'up-1280.jpg');
    assert.strictEqual(
        resolution.selectCandidate(representations, 2000, 'auto').src,
        'up-1920.jpg',
        'beyond every tier the largest eligible answers');
    assert.strictEqual(
        resolution.selectCandidate(representations, 640, 'auto').src,
        'base-640.jpg');
}

function capNarrowsUpgradesNeverTheBase() {
    const resolution = loadResolution();
    const descriptor = resolution.descriptor({
        src: 'base-640.jpg', width: 640, height: 640,
        upgrades: [{src: 'up-1280.jpg', width: 1280, height: 1280}]
    });
    const representations = resolution.representationsFor(descriptor);
    // A cap below the base's own width still leaves the base eligible —
    // a quality ceiling never blocks the content itself.
    assert.strictEqual(
        resolution.selectCandidate(representations, 1280, 500).src,
        'base-640.jpg');
    assert.strictEqual(
        resolution.selectCandidate(representations, 1280, 1300).src,
        'up-1280.jpg');
}

function catalogValidatesItsFrames() {
    const resolution = loadResolution();
    assert.throws(function () {
        resolution.catalog({frames: []});
    }, /non-empty frames/);
    assert.throws(function () {
        resolution.catalog({frames: [{src: '', width: 1, height: 1}]});
    }, /non-empty string/);
    assert.throws(function () {
        resolution.catalog({frames: [{src: 'a.jpg', width: 0, height: 1}]});
    }, /dimensions must be positive/);
    assert.throws(function () {
        resolution.catalog({frames: [{
            src: 'a.jpg', width: 640, height: 640,
            upgrades: [{src: 'down.jpg', width: 320, height: 320}]
        }]});
    }, /ascend in width/);
    assert.throws(function () {
        resolution.catalog({frames: [{
            src: 'a.jpg', width: 640, height: 640,
            upgrades: [{src: 'crop.jpg', width: 1280, height: 1400}]
        }]});
    }, /aspect ratio/);
    // The contract declares the ladder lower to higher: a ladder typed
    // out of order is a malformed declaration, refused like any other —
    // never silently reordered into something the author did not write.
    assert.throws(function () {
        resolution.catalog({frames: [{
            src: 'a.jpg', width: 640, height: 640,
            upgrades: [
                {src: 'big.jpg', width: 1920, height: 1920},
                {src: 'mid.jpg', width: 1280, height: 1280}
            ]
        }]});
    }, /ascend in width and height/);
    // A ladder declared in order keeps exactly that order.
    const parsed = resolution.catalog({frames: [{
        src: 'a.jpg', width: 640, height: 640,
        upgrades: [
            {src: 'mid.jpg', width: 1280, height: 1280},
            {src: 'big.jpg', width: 1920, height: 1920}
        ]
    }]});
    assert.strictEqual(parsed.frames[0].upgrades[0].src, 'mid.jpg');
    assert.strictEqual(parsed.frames[0].upgrades[1].src, 'big.jpg');
}

// Catalog and descriptor dimensions are JSON numbers, not coercible strings,
// booleans, arrays or fractional CSS measurements. A declaration of the
// wrong type must not silently become another intrinsic image size.
function nonNumericAndFractionalDimensionsAreRejected() {
    const resolution = loadResolution();
    [
        {src: 'a.jpg', width: '640', height: 360},
        {src: 'a.jpg', width: true, height: 360},
        {src: 'a.jpg', width: [640], height: 360},
        {src: 'a.jpg', width: 640.5, height: 360},
        {src: 'a.jpg', width: 640, height: '360'},
        {src: 'a.jpg', width: 640, height: 360.25}
    ].forEach(function (descriptor) {
        assert.throws(function () {
            resolution.descriptor(descriptor);
        }, /must be finite|dimensions must be positive integers/,
            'malformed dimension accepted: ' + JSON.stringify(descriptor));
    });
    assert.throws(function () {
        resolution.catalog({frames: [{src: 'a.jpg', width: 640, height: 360,
            upgrades: [{src: 'b.jpg', width: '1280', height: 720}]}]});
    }, /must be finite/, 'an upgrade must reject numeric text too');
}

// An optional array is either omitted or an actual array. An explicit
// null, an object or a string is malformed and fails at the descriptor
// boundary instead of being read as no upgrades.
function malformedUpgradeListsAreRejected() {
    const resolution = loadResolution();
    [null, {}, 'up.jpg', 3, true].forEach(function (upgrades) {
        assert.throws(function () {
            resolution.descriptor({src: 'base.jpg', width: 640, height: 360,
                upgrades: upgrades});
        }, /upgrades must be an array/,
            'malformed upgrades accepted: ' + JSON.stringify(upgrades));
    });
    assert.deepStrictEqual(Array.from(resolution.descriptor({
        src: 'base.jpg', width: 640, height: 360
    }).upgrades), [], 'an omitted upgrade list remains an empty list');
}

// A non-uniform 'fill' stretch must supply both axes at painted
// density — a 480×270 image stretched to 480×540 demands the vertical
// scale (2×), not the horizontal one (1×): width-only reading under-
// estimates and picks a source that blurs vertically.
function fillDemandsTheGreaterAxisToo() {
    const resolution = loadResolution();
    assert.strictEqual(
        resolution.needFor(480, 540, 480, 270, 'fill', 1),
        960,
        'fill ignored the axis that stretches more');
    // DPR multiplies the same greater-axis requirement.
    assert.strictEqual(
        resolution.needFor(480, 540, 480, 270, 'fill', 2),
        1920);
    // Selection from a ladder: only the 960 source satisfies the need.
    const descriptor = resolution.descriptor({
        src: 'base.jpg', width: 480, height: 270,
        upgrades: [{src: 'wide.jpg', width: 960, height: 540}]
    });
    const reps = resolution.representationsFor(descriptor);
    assert.strictEqual(
        resolution.selectCandidate(reps,
            resolution.needFor(480, 540, 480, 270, 'fill', 1), 'auto').src,
        'wide.jpg',
        'the width-only underestimate kept the blurring base');
}

// 'none' and 'auto' paint at intrinsic size — the box is irrelevant;
// 'scale-down' takes the smaller of intrinsic and contain.
function noneAutoAndScaleDownReadTheirOwnGeometry() {
    const resolution = loadResolution();
    assert.strictEqual(
        resolution.needFor(4000, 4000, 480, 270, 'none', 1),
        480,
        'none rendered other than intrinsic size');
    assert.strictEqual(
        resolution.needFor(4000, 4000, 480, 270, 'auto', 1),
        480,
        'auto rendered other than intrinsic size');
    // scale-down of an oversized box: contain would shrink below
    // intrinsic only when the box is smaller; here intrinsic wins.
    assert.strictEqual(
        resolution.needFor(4000, 4000, 480, 270, 'scale-down', 1),
        480,
        'scale-down ignored the intrinsic ceiling');
    // scale-down of a small box follows the contain scale.
    assert.strictEqual(
        resolution.needFor(240, 240, 480, 270, 'scale-down', 1),
        240,
        'scale-down ignored the contain scale for a small box');
    // None of the named fits fall through to the width-only default.
    assert.strictEqual(
        resolution.needFor(100, 4000, 480, 270, 'none', 1),
        480,
        'a tall box under none demanded the stretched scale');
}

// An intrinsic-size fit paints whatever source it is given at that
// source's own size: a larger rung would paint larger, never sharper.
// At DPR 2 the base is still the whole need — no upgrade is demanded
// for background-size auto, 'auto auto', object-fit none, or a
// scale-down that resolves to none.
function intrinsicSizeFitsNeverDemandAnUpgrade() {
    const resolution = loadResolution();
    const reps = resolution.representationsFor(resolution.descriptor({
        src: 'base.jpg', width: 640, height: 360,
        upgrades: [{src: 'up.jpg', width: 1280, height: 720}]
    }));
    ['auto', 'auto auto', 'none'].forEach(function (fit) {
        const need = resolution.needFor(1600, 900, 640, 360, fit, 2);
        assert.strictEqual(need, 640, fit + ' demanded more than the base at DPR 2');
        assert.strictEqual(resolution.selectCandidate(reps, need, 'auto').src, 'base.jpg',
            fit + ' selected an upgrade that would paint zoomed');
    });
    // scale-down on a box larger than the base resolves to none.
    assert.strictEqual(resolution.needFor(1600, 900, 640, 360, 'scale-down', 2), 640,
        'scale-down resolving to none demanded a zooming upgrade');
    // scale-down on a smaller box contains — the rendered size no
    // longer follows the source, so device pixels count again.
    assert.strictEqual(resolution.needFor(320, 180, 640, 360, 'scale-down', 2), 640);
    assert.strictEqual(resolution.needFor(320, 180, 1280, 720, 'scale-down', 2), 640);
}

// Explicit background-size lengths render the image at the size they
// name, whatever the source's own pixels: one value scales uniformly,
// two values stretch and the larger axis governs; percentages are of
// the painted box. A layered list or a value outside that grammar is
// unverifiable and demands nothing beyond the base.
function explicitBackgroundSizesReadBothAxes() {
    const resolution = loadResolution();
    // 100% 100% stretches 480x270 into 480x540: the vertical 2x governs.
    assert.strictEqual(resolution.needFor(480, 540, 480, 270, '100% 100%', 1), 960,
        'a two-value percentage read only the width');
    // auto 100%: height follows the box, width follows the aspect.
    assert.strictEqual(resolution.needFor(400, 540, 480, 270, 'auto 100%', 1), 960,
        'auto width with an explicit height scaled by width');
    // Two pixel lengths: 960x1080 from 480x270 → the vertical 4x governs.
    assert.strictEqual(resolution.needFor(400, 300, 480, 270, '960px 1080px', 1), 1920);
    // One length: width given, height auto — uniform.
    assert.strictEqual(resolution.needFor(400, 300, 480, 270, '960px', 2), 1920);
    assert.ok(Math.abs(resolution.needFor(1000, 300, 480, 270, '50%', 1) - 500) < 1e-6);
    assert.ok(Math.abs(resolution.needFor(1000, 300, 480, 270, '50% auto', 1) - 500) < 1e-6);
    // Unverifiable values ask for nothing beyond the base.
    ['cover, contain', '100% 100%, auto', 'calc(50% + 10px)', '10em', '1px 2px 3px', 'bogus']
        .forEach(function (fit) {
            assert.strictEqual(resolution.needFor(1600, 900, 480, 270, fit, 2), 0,
                'an unverifiable background-size demanded work: ' + fit);
        });
    // A zero-length axis paints nothing.
    assert.strictEqual(resolution.needFor(1600, 900, 480, 270, '0px auto', 1), 0);
}

// A device pixel ratio that is not a positive finite number reads as 1.
function invalidDevicePixelRatioReadsAsOne() {
    const resolution = loadResolution();
    [undefined, null, 0, -2, NaN, Infinity, '2'].forEach(function (ratio) {
        assert.strictEqual(resolution.needFor(960, 540, 480, 270, 'cover', ratio), 960,
            'ratio ' + String(ratio) + ' was not read as 1');
    });
}

// Every rung must be larger on both axes: a rung inside the 1%
// aspect tolerance whose height does not grow is not more pixels of
// the same image.
function ladderHeightMustAscendToo() {
    const resolution = loadResolution();
    assert.throws(function () {
        resolution.descriptor({src: 'a.jpg', width: 1000, height: 1000,
            upgrades: [{src: 'b.jpg', width: 1005, height: 1000}]});
    }, /ascend in width and height/);
    assert.throws(function () {
        resolution.descriptor({src: 'a.jpg', width: 1000, height: 1000,
            upgrades: [
                {src: 'b.jpg', width: 2000, height: 2000},
                {src: 'c.jpg', width: 2010, height: 1999}
            ]});
    }, /ascend in width and height/);
}

// A cap that is not a finite number is no cap: null, NaN, Infinity or
// a string never disable every upgrade.
function nonFiniteCapIsNoCap() {
    const resolution = loadResolution();
    const reps = resolution.representationsFor(resolution.descriptor({
        src: 'base.jpg', width: 640, height: 640,
        upgrades: [
            {src: 'up-1280.jpg', width: 1280, height: 1280},
            {src: 'up-1920.jpg', width: 1920, height: 1920}
        ]
    }));
    [null, undefined, NaN, Infinity, -Infinity, '1000', 'auto'].forEach(function (cap) {
        assert.strictEqual(resolution.selectCandidate(reps, 1500, cap).src, 'up-1920.jpg',
            'cap ' + String(cap) + ' blocked the sufficient upgrade');
    });
}

// The CSS url() helpers: serialization escapes what would corrupt the
// quoted token, and the reading side decodes CSS escapes the way the
// CSS syntax does — NUL, surrogates and values past U+10FFFF become
// U+FFFD, and an astral code point arrives as its surrogate pair.
function cssUrlHelpersRoundTripAndDecodeEscapes() {
    const resolution = loadResolution();
    const src = 'data:image/svg+xml,<svg a="b">\\</svg>\n';
    assert.strictEqual(resolution.cssUrlSource(resolution.cssUrl(src)), src,
        'a serialized URL did not read back as itself');
    assert.strictEqual(resolution.cssUrl('a"b'), 'url("a\\"b")');
    assert.strictEqual(resolution.cssUrlSource('url("x\\1F600 y")'), 'x\uD83D\uDE00y',
        'an astral escape was truncated');
    assert.strictEqual(resolution.cssUrlSource('url("x\\0 y")'), 'x\uFFFDy');
    assert.strictEqual(resolution.cssUrlSource('url("x\\D800 y")'), 'x\uFFFDy');
    assert.strictEqual(resolution.cssUrlSource('url("x\\110000 y")'), 'x\uFFFDy');
    assert.strictEqual(resolution.cssUrlSource('url("x\\41 y")'), 'xAy');
    assert.strictEqual(resolution.cssUrlSource("url('a\\'b')"), "a'b");
    assert.strictEqual(resolution.cssUrlSource('url(plain.jpg)'), 'plain.jpg');
    ['none', 'linear-gradient(#fff, #000)', 'url("a.jpg"), url("b.jpg")', '', null]
        .forEach(function (value) {
            assert.strictEqual(resolution.cssUrlSource(value), null,
                'an unverifiable value read as a URL: ' + String(value));
        });
}

// Each case registers with the Node test runner under its function name.
test(intrinsicSizeFitsNeverDemandAnUpgrade);
test(explicitBackgroundSizesReadBothAxes);
test(invalidDevicePixelRatioReadsAsOne);
test(ladderHeightMustAscendToo);
test(nonFiniteCapIsNoCap);
test(cssUrlHelpersRoundTripAndDecodeEscapes);
test(plainFitNeedsIntrinsicTimesScale);
test(coverDemandsTheLargerAxis);
test(containFitsTheSmallerAxis);
test(fillDemandsTheGreaterAxisToo);
test(noneAutoAndScaleDownReadTheirOwnGeometry);
test(degenerateInputsNeedNothing);
test(degenerateFitsNeedNothing);
test(selectionPicksTheSmallestSufficient);
test(capNarrowsUpgradesNeverTheBase);
test(catalogValidatesItsFrames);
test(nonNumericAndFractionalDimensionsAreRejected);
test(malformedUpgradeListsAreRejected);

// The cap every owner reads from --paste-resolution-max-width: a
// positive plain decimal is a cap; everything else Number() would also
// accept — exponents, radix prefixes, signs, units — and zero, empty,
// 'auto' or a non-string is no cap. One grammar, so the same CSS caps
// every image on the page alike.
function capFromReadsPlainDecimalsOnly() {
    const resolution = loadResolution();
    [['1280', 1280], [' 960 ', 960], ['1280.', 1280], ['.5', 0.5], ['1280.5', 1280.5]]
        .forEach(function (pair) {
            assert.strictEqual(resolution.capFrom(pair[0]), pair[1],
                JSON.stringify(pair[0]) + ' was not read as a cap');
        });
    ['auto', '', ' ', '0', '0.0', '1e3', '0x500', '+1280', '-1280', '1280px',
        'Infinity', 'NaN', '12 80', null, undefined, 1280, {}].forEach(function (text) {
        assert.strictEqual(resolution.capFrom(text), 'auto',
            String(text) + ' was read as a cap');
    });
}

// The paint-path helpers keep their patterns at factory scope: repeated
// calls answer identically (a shared global pattern carries no state
// between calls), and the bodies themselves build no RegExp per call.
function paintPathPatternsAreBuiltOnce() {
    const resolution = loadResolution();
    const src = 'a\\b"c\rd\ne\ff';
    const first = resolution.cssUrl(src);
    assert.strictEqual(resolution.cssUrl(src), first, 'a repeated serialization differed');
    assert.strictEqual(resolution.cssUrlSource(first), src);
    assert.strictEqual(resolution.needFor(600, 600, 640, 640, '50%  100%', 1),
        resolution.needFor(600, 600, 640, 640, '50%  100%', 1));
    assert.strictEqual(resolution.needFor(600, 1500, 640, 640, '100%   100%', 1), 1500,
        'a run of separating whitespace split into an empty component');
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/utilities/imageresolution/imageresolution.js'), 'utf8');
    ['cssUrl = function', 'sizeScale = function'].forEach(function (head) {
        const start = source.indexOf(head);
        assert.ok(start >= 0, head + ' not found');
        const body = source.slice(start, source.indexOf('\n            },', start));
        assert.ok(!(/[(,]\s*\/[^/*]/).test(body), head + ' builds a RegExp per call');
    });
}

test(capFromReadsPlainDecimalsOnly);
test(paintPathPatternsAreBuiltOnce);

// Every url() token of a computed value, decoded in order: a cross-fade
// in flight carries both its endpoints; a single token, a layered list
// and a gradient read as what they are; a name merely ending in 'url' is
// not a url() function.
function cssUrlSourcesListsEveryToken() {
    const resolution = loadResolution();
    const sources = value => Array.from(resolution.cssUrlSources(value));
    assert.deepEqual(sources('cross-fade(url("a.jpg") 40%, url(b.jpg))'),
        ['a.jpg', 'b.jpg']);
    assert.deepEqual(sources('-webkit-cross-fade(url("a\\"q.jpg"), url(\'b.jpg\'), 0.5)'),
        ['a"q.jpg', 'b.jpg']);
    assert.deepEqual(sources(resolution.cssUrl('x\ny')), ['x\ny']);
    assert.deepEqual(sources('linear-gradient(#000, #fff), URL(c.jpg)'), ['c.jpg']);
    assert.deepEqual(sources('myurl(a.jpg) image-url(b.jpg)'), []);
    ['none', 'linear-gradient(#fff, #000)', '', null, undefined, 3].forEach(function (value) {
        assert.deepEqual(sources(value), [], String(value) + ' listed a URL');
    });
    // The pattern carries no state between calls.
    assert.deepEqual(sources('url(a) url(b)'), ['a', 'b']);
    assert.deepEqual(sources('url(a) url(b)'), ['a', 'b']);
}

// A size container is any computed container-type naming 'size' or
// 'inline-size' among its tokens, including combined values.
function sizeContainerReadsTokens() {
    const resolution = loadResolution();
    ['size', 'inline-size', 'inline-size scroll-state', 'scroll-state size', ' size ']
        .forEach(function (value) {
            assert.strictEqual(resolution.sizeContainer(value), true, value);
        });
    ['normal', 'scroll-state', '', 'inline-sizes', 'block-size', null, undefined]
        .forEach(function (value) {
            assert.strictEqual(resolution.sizeContainer(value), false, String(value));
        });
}

// A computed transition animates background-image when the last
// property entry naming it — 'all', 'background' or 'background-image'
// — has a positive combined duration at its position, the time lists
// repeating to the length of the property list.
function transitionsBackgroundReadsTheComputedLists() {
    const resolution = loadResolution();
    [
        ['all', '0.3s', '0s'],
        ['background', '300ms', '0s'],
        ['background-image', '0s', '0.1s'],
        ['BACKGROUND-IMAGE', '0.3S', '0S'],
        ['opacity, background-image', '0s, 0.2s', '0s'],
        ['opacity, width, all', '0.2s', '0s'],
        ['opacity, all', '0s, 1s', '0s, 0s'],
        ['background-image', '0.5s', '-0.2s'],
        [' all ', ' 0.3s ', ' 0s ']
    ].forEach(function (lists) {
        assert.strictEqual(resolution.transitionsBackground(lists[0], lists[1], lists[2]), true,
            JSON.stringify(lists));
    });
    [
        ['all', '0s', '0s'],
        ['none', '0.3s', '0s'],
        ['opacity', '0.3s', '0s'],
        ['background-color', '0.3s', '0s'],
        ['background-image, opacity', '0s, 1s', '0s'],
        ['background-image, all', '0.3s, 0s', '0s'],
        ['all, opacity', '0s, 1s', '0s'],
        ['background-image', '0.2s', '-0.2s'],
        ['background-image', '-1s', '0s'],
        ['background-image', 'auto', '0s'],
        ['', '', ''],
        [null, '0.3s', '0s'],
        ['all', undefined, '0s']
    ].forEach(function (lists) {
        assert.strictEqual(resolution.transitionsBackground(lists[0], lists[1], lists[2]), false,
            JSON.stringify(lists));
    });
}

// An img written through srcset width descriptors keeps the base's
// intrinsic size at every rung: object-fit none and a non-shrinking
// scale-down then gain sharpness from density, so the need is the base
// width times the device ratio. A shrinking scale-down is contain, and
// without the flag the intrinsic-size rule stands.
function densityCorrectedIntrinsicFitsDemandTheRatio() {
    const resolution = loadResolution();
    assert.strictEqual(resolution.needFor(300, 200, 640, 640, 'none', 2, true), 1280);
    assert.strictEqual(resolution.needFor(900, 900, 640, 640, 'scale-down', 2, true), 1280);
    assert.strictEqual(resolution.needFor(320, 320, 640, 640, 'scale-down', 2, true), 640);
    assert.strictEqual(resolution.needFor(300, 200, 640, 640, 'none', 2), 640);
    assert.strictEqual(resolution.needFor(300, 200, 640, 640, 'auto', 2, true), 640,
        'a background intrinsic-size fit demanded density');
}

test(cssUrlSourcesListsEveryToken);
test(sizeContainerReadsTokens);
test(transitionsBackgroundReadsTheComputedLists);
test(densityCorrectedIntrinsicFitsDemandTheRatio);

// Either zero-sized background axis makes the image unpainted, even when
// the other explicit axis is large enough to otherwise demand an upgrade.
for (const size of ['0px 600px', '600px 0px', '0% 300%', '300% 0%']) {
    test('an unpainted background demands no resolution for ' + size, () => {
        const resolution = loadResolution();
        for (const ratio of [1, 2]) {
            assert.equal(resolution.needFor(200, 200, 100, 100, '600px 600px', ratio), 600 * ratio,
                'positive control: both painted axes require the larger image');
            assert.equal(resolution.needFor(200, 200, 100, 100, size, ratio), 0,
                'a zero background axis must not demand an upgrade at device ratio ' + ratio);
        }
    });
}

test('explicit background axes preserve whichever positive axis needs more pixels', () => {
    const resolution = loadResolution();
    for (const [fit, expected] of [['900px 20px', 900], ['auto 600px', 600],
        ['900px auto', 900], ['auto auto', 100], ['20px 900px', 900]]) {
        assert.equal(resolution.needFor(200, 200, 100, 100, fit, 1), expected, fit);
    }
});

test('background transition duration and negative delay compare in matching units', () => {
    const resolution = loadResolution();
    assert.equal(resolution.transitionsBackground('background-image', '0.5s', '-200ms'), true);
    assert.equal(resolution.transitionsBackground('background-image', '200ms', '-0.5s'), false);
});

test('every ladder step must increase width even within the allowed aspect tolerance', () => {
    const resolution = loadResolution();
    assert.throws(() => resolution.descriptor({src: 'base', width: 100, height: 100, upgrades: [
        {src: 'first', width: 1000, height: 1000},
        {src: 'second', width: 1000, height: 1001}
    ]}), error => error.name === 'TypeError' && /ascend/.test(error.message));
});

test('descriptor height must be finite and catalog errors identify their frame', () => {
    const resolution = loadResolution();
    assert.throws(() => resolution.descriptor({src: 'base', width: 100, height: Infinity}),
        error => error.name === 'TypeError');
    assert.throws(() => resolution.catalog({frames: [{src: 'good', width: 100, height: 100},
        {src: 'bad', width: 0, height: 100}]}), error => error.name === 'TypeError' && /frames\[1\]/.test(error.message));
});

test('absent fit defaults to painted width and unbounded scale demands nothing', () => {
    const resolution = loadResolution();
    assert.equal(resolution.needFor(200, 300, 100, 100, undefined, 2), 400);
    assert.equal(resolution.needFor(Infinity, 300, 100, 100, 'cover', 1), 0);
});

test('computed URL parsing ignores non-string objects and unreadable times', () => {
    const resolution = loadResolution();
    assert.equal(resolution.cssUrlSources({toString() { return 'url(hidden.png)'; }}).length, 0);
    assert.equal(resolution.transitionsBackground('background-image', '9'.repeat(400) + 's', '0s'), false);
});

test('a negative background axis invalidates the whole explicit size', () => {
    const resolution = loadResolution();
    for (const fit of ['-1px 600px', '600px -1px', '-1% 300%', '300% -1%']) {
        assert.equal(resolution.needFor(200, 200, 100, 100, fit, 1), 0, fit);
    }
});

for (const origin of ['border-box', 'content-box']) {
    test(origin + ' with no insets reuses geometry without offset reads', () => {
        const resolution = loadResolution();
        const element = {
            get offsetWidth() { assert.fail('unnecessary offsetWidth'); },
            get offsetHeight() { assert.fail('unnecessary offsetHeight'); }
        };
        const rect = {width: 200, height: 100};
        const values = {'background-origin': origin, 'background-attachment': 'scroll', 'overflow-x': 'visible'};
        const style = {getPropertyValue: name => values[name] || '0px'};
        assert.equal(resolution.paintedBox({element, property: 'background-image'}, rect, style), rect);
    });
}
