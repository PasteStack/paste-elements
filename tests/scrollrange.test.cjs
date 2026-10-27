'use strict';

// The scrub relationship's measurement contract: anchor pairs translate
// into root scroll-space endpoints, element roots measure in their own
// coordinate system, container mode is the root's own scroll fraction,
// and a degenerate or ambiguous declaration reports rather than guesses.

const test = require('node:test');
const assert = require('assert/strict');
const {loadModule, Element} = require('./fakes.cjs');

function loadScrollrange(env) {
    env = env || {};
    const loaded = loadModule({
        file: 'paste/ui/utilities/scrollrange.js',
        name: 'paste.ui.utilities.scrollrange',
        deps: [],
        impls: [],
        elements: env.elements || {},
        window: env.window,
        document: env.document
    });
    return {geometry: loaded.module, document: loaded.document, window: loaded.window};
}

function elementModeMeasuresAnchors() {
    const subject = new Element('div', 'subject');
    // Declared: the subject's top reaching the viewport's bottom is
    // progress 0; its bottom reaching the viewport's top is 1.
    const scope = new Element('div', 'scope');
    scope.appendChild(subject);
    const {geometry, document, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    assert.strictEqual(range.resolved.root, null, 'the viewport is the default root');
    assert.strictEqual(range.resolved.subject, scope, 'the scope is the default subject');

    // subject scroll-space: 1600..1800; viewport 800 tall.
    // S = top edge - 800 = 800, E = bottom edge - 0 = 1800.
    window.pageYOffset = 0;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    let measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0, 'the range has not begun');

    window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'mid-range is proportional');

    window.pageYOffset = 2400;
    scope.rect = {top: -800, bottom: -600, width: 100, height: 200};
    measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 1, 'past the end clamps');
}

function customAnchorsShiftTheEndpoints() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-start', 'center center');
    scope.setAttribute('data-scrub-end', 'top top');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    // subject scroll-space 1600..1800, center 1700; viewport 800.
    // S = center - 400 = 1300; E = top - 0 = 1600.
    window.pageYOffset = 1450;
    scope.rect = {top: 150, bottom: 350, width: 100, height: 200};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'center-to-top endpoints measure the authored span');
}

function elementRootsMeasureInTheirOwnScrollSpace() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    scroller.rect = {top: 100, bottom: 500, width: 300, height: 400};
    const subject = new Element('div', 'subject');
    subject.rect = {top: 0, bottom: 200, width: 300, height: 200};
    scroller.appendChild(subject);
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.setAttribute('data-scrub-subject', '#subject');
    scope.setAttribute('data-scrub-mode', 'container');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scope);
    assert.strictEqual(range.resolved.root, scroller, 'the named root resolves');
    // container mode: offset / (scrollHeight - clientHeight)
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'the nested scroller reads its own offset');
}

// A bordered scroller's scroll space starts at its content box — the
// border-box top plus the border itself (clientTop). Here a 20px
// border moved a 0.5 midpoint to 0.4 when the origin read the border
// box instead.
function elementRootBorderShiftsTheScrollSpaceOrigin() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 100;
    scroller.scrollHeight = 400;
    scroller.clientTop = 20;
    scroller.scrollTop = 200;
    scroller.rect = {top: 100, bottom: 200, width: 300, height: 100};
    const subject = new Element('div', 'subject');
    subject.rect = {top: 120, bottom: 220, width: 300, height: 100};
    scroller.appendChild(subject);
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.setAttribute('data-scrub-subject', '#subject');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scope);
    // Scroll space: subject 200..300, viewport 100 → S = 100, E = 300,
    // offset 200 lands the midpoint.
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5,
        'the border offset is part of the scroll-space origin');
}

// 'near' rides the same read: the subject is inside the approaching
// band while any of it sits within one viewport of the visible span —
// callers spend preparation only inside that band.
function nearReportsTheApproachingBand() {
    const scope = new Element('div', 'scope');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);

    // subject scroll-space 5000..5200, viewport 800 — over three
    // viewports below the fold: out of the band.
    window.pageYOffset = 0;
    scope.rect = {top: 5000, bottom: 5200, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).near, false,
        'a scene beyond a viewport of lead is not near');

    // offset 4000: the subject top (5000) sits within one viewport of
    // the fold (4000 + 800 + 800 lead) — the band is inclusive.
    window.pageYOffset = 4000;
    scope.rect = {top: 1000, bottom: 1200, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).near, true,
        'one viewport of lead counts as approaching');

    // scrolled well past: bottom 5200 < offset - 800 = 5600 — gone.
    window.pageYOffset = 6400;
    scope.rect = {top: -1400, bottom: -1200, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).near, false,
        'a scene left behind leaves the band too');
}

function containerModeWithoutRangeIsInert() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const {geometry, document, window} = loadScrollrange({elements: {scope: scope}});
    document.documentElement.scrollHeight = 800;
    document.documentElement.clientHeight = 800;
    window.pageYOffset = 0;
    const range = geometry.read(scope);
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, null, 'a page that cannot scroll has no progress');
}

function documentContainerModeReadsPageScroll() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const {geometry, document, window} = loadScrollrange({elements: {scope: scope}});
    document.documentElement.scrollHeight = 2400;
    document.documentElement.clientHeight = 800;
    window.pageYOffset = 800;
    const range = geometry.read(scope);
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'the page scroll fraction is the progress');
}

function degenerateRangeReports() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-start', 'bottom top');
    scope.setAttribute('data-scrub-end', 'top bottom');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    window.pageYOffset = 0;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, null, 'a reversed span is not progress');
    assert.deepEqual(Object.keys(measured).sort(), ['end', 'near', 'offset', 'progress', 'start'],
        'a measurement carries progress, near, offset and its endpoints only');
    assert.strictEqual(measured.start, null);
    assert.strictEqual(measured.end, null);
}

function ambiguousResolutionRefuses() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#nowhere');
    const {geometry} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    assert.ok(range.resolved.error && range.resolved.error.name === 'TypeError', 'a missing root is a declaration error');
}

// vm-context errors are not host intrinsics — name is the honest check.
function isTypeError(error) {
    return error && error.name === 'TypeError';
}

function invalidEndpointsRefuse() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-start', 'middle top');
    const {geometry} = loadScrollrange({elements: {scope: scope}});
    assert.throws(function () {
        geometry.read(scope);
    }, isTypeError);
    scope.setAttribute('data-scrub-start', 'top');
    assert.throws(function () {
        geometry.read(scope);
    }, isTypeError, 'a single anchor is not a pair');
}

// The declared window remaps the measured span once: progress below a
// is 0, above b is 1, and inside it is the fraction through the window.
function windowRemapsElementProgress() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-window', '0.25 0.75');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    // Range 800..1800: window 0.25–0.75 of it is offsets 1050..1550.
    window.pageYOffset = 800;
    scope.rect = {top: 800, bottom: 1000, width: 100, height: 200};
    let measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0, 'below the window stays 0');

    window.pageYOffset = 1300; // base 0.5 → (0.5-0.25)/0.5 = 0.5
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'mid-window is proportional');

    window.pageYOffset = 1600; // base 0.8 — past the window's end
    scope.rect = {top: 0, bottom: 200, width: 100, height: 200};
    measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 1, 'past the window clamps to 1');
}

function windowRemapsContainerProgress() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-window', '0.25 0.75');
    const {geometry, document, window} = loadScrollrange({elements: {scope: scope}});
    document.documentElement.scrollHeight = 2400;
    document.documentElement.clientHeight = 800;
    // Range 1600: window 0.25–0.75 is offsets 400..1200.
    window.pageYOffset = 800; // base 0.5 → (0.5-0.25)/0.5 = 0.5
    const range = geometry.read(scope);
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'the window applies to container mode too');
}

function invalidWindowRefuses() {
    const scope = new Element('div', 'scope');
    const {geometry} = loadScrollrange({elements: {scope: scope}});
    scope.setAttribute('data-scrub-window', '0.5');
    assert.throws(function () {
        geometry.read(scope);
    }, isTypeError, 'a lone fraction is not a window');
    scope.setAttribute('data-scrub-window', '0.9 0.2');
    assert.throws(function () {
        geometry.read(scope);
    }, isTypeError, 'a reversed window is degenerate');
    scope.setAttribute('data-scrub-window', '-0.1 0.5');
    assert.throws(function () {
        geometry.read(scope);
    }, isTypeError, 'bounds live inside 0..1');
}

function subjectOutsideRootRefuses() {
    const scroller = new Element('div', 'scroller');
    const subject = new Element('div', 'subject');
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.setAttribute('data-scrub-subject', '#subject');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller, subject: subject}});
    const range = geometry.read(scope);
    assert.ok(range.resolved.error && range.resolved.error.name === 'TypeError', 'the subject must live inside its root');
}

// Container mode measures the root's own scroll range — the scope
// only declares the relationship, so a scope sitting beside the
// scroller is valid, and subject/start/end declarations do not apply.
function containerScopeBesideScrollerReadsItsFraction() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    scroller.rect = {top: 100, bottom: 500, width: 300, height: 400};
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    scope.setAttribute('data-scrub-root', '#scroller');
    // Irrelevant in container mode — they must be ignored, not resolved.
    scope.setAttribute('data-scrub-subject', '#nowhere');
    scope.setAttribute('data-scrub-start', 'middle nowhere');
    scope.setAttribute('data-scrub-end', 'bogus pair');
    const {geometry} = loadScrollrange({elements: {scroller: scroller, scope: scope}});
    const range = geometry.read(scope);
    assert.ok(!range.resolved.error, 'an external container scope is valid');
    assert.strictEqual(range.resolved.root, scroller, 'the named root resolves');
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5,
        'the scroller\u2019s own offset is the progress');
}

// Anchors are a closed vocabulary — inherited Object properties are
// not anchors. `constructor`, `toString`, `__proto__` must refuse in
// either token position while a neighboring valid declaration still
// binds and measures.
function inheritedAnchorNamesRefuse() {
    const bad = new Element('div', 'bad');
    const {geometry} = loadScrollrange({elements: {bad: bad}});
    ['constructor', 'toString', '__proto__'].forEach(function (name) {
        bad.setAttribute('data-scrub-start', name + ' bottom');
        assert.throws(function () {
            geometry.read(bad);
        }, isTypeError, name + ' is not a subject anchor');
        bad.setAttribute('data-scrub-start', 'top ' + name);
        assert.throws(function () {
            geometry.read(bad);
        }, isTypeError, name + ' is not a viewport anchor');
        bad.setAttribute('data-scrub-end', name + ' top');
        assert.throws(function () {
            geometry.read(bad);
        }, isTypeError, name + ' is not an end anchor either');
        bad.removeAttribute('data-scrub-end');
    });
    // A malformed declaration is inert; it does not poison neighbors.
    bad.setAttribute('data-scrub-start', 'bogus anchors');
    const good = new Element('div', 'good');
    const env = loadScrollrange({elements: {bad: bad, good: good}});
    assert.throws(function () {
        env.geometry.read(bad);
    }, isTypeError);
    env.window.pageYOffset = 1300;
    good.rect = {top: 300, bottom: 500, width: 100, height: 200};
    const measured = env.geometry.measure(env.geometry.read(good));
    assert.strictEqual(measured.progress, 0.5,
        'a neighboring valid declaration still measures');
}

// A subject with no rendered client rectangles — a display:none
// section, a detached node — is not a range at 0; it is no range at
// all. Nothing approaches it either.
function unrenderedSubjectMeasuresInactive() {
    const scope = new Element('div', 'scope');
    scope.clientRects = [];
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    window.pageYOffset = 1300;
    // display:none's answer on the platform: no rectangles and an
    // all-zero bounding box.
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, null, 'no rendered box, no progress');
    assert.strictEqual(measured.near, false, 'and nothing is near it');
    // A rendered zero-height point anchor is a different thing: it
    // still has a client rect, and it still measures.
    scope.clientRects = undefined;
    scope.rect = {top: 300, bottom: 300, width: 100, height: 0};
    const point = geometry.measure(range);
    assert.strictEqual(point.progress, 0.625,
        'a rendered zero-height anchor still measures');
}

// A viewport with no height carries no visible span — the measured
// endpoints are meaningless, so the range is inactive, not at 0.
function emptyViewportMeasuresInactive() {
    const scope = new Element('div', 'scope');
    const documentElement = new Element('html');
    documentElement.clientHeight = 0;
    const {geometry, window} = loadScrollrange({
        elements: {scope: scope},
        document: {documentElement: documentElement},
        window: {innerHeight: 0}
    });
    const range = geometry.read(scope);
    window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, null, 'a zero-height viewport has no progress');
    assert.strictEqual(measured.near, false, 'and no approaching band either');
}

// A container root with no viewport height cannot measure either —
// its own scroll fraction is undefined.
function emptyContainerViewportMeasuresInactive() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 0;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    scroller.rect = {top: 0, bottom: 0, width: 300, height: 0};
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.setAttribute('data-scrub-mode', 'container');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scope);
    const measured = geometry.measure(range);
    assert.strictEqual(measured.progress, null, 'a zero-height scroller has no fraction');
}


// The document's own scroller is the viewport root whatever selector
// names it: the window carries its offset and its scroll event, so an
// element root here would count the offset twice and listen on a
// target that never fires.
function documentScrollerSelectorsNormalizeToTheViewport() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', 'html');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    assert.ok(!range.resolved.error, 'the root element is a valid root');
    assert.strictEqual(range.resolved.root, null,
        'the root element did not normalize to the viewport root');
    window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).progress, 0.5,
        'the page offset was counted twice');

    const scrolling = new Element('div', 'scrolling');
    const scoped = new Element('div', 'scoped');
    scoped.setAttribute('data-scrub-root', '#scrolling');
    scrolling.appendChild(scoped);
    const env = loadScrollrange({
        elements: {scrolling: scrolling},
        document: {scrollingElement: scrolling}
    });
    assert.strictEqual(env.geometry.read(scoped).resolved.root, null,
        'document.scrollingElement did not normalize to the viewport root');
}

function quirksBodyRootNormalizesToTheViewport() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', 'body');
    const {geometry, document} = loadScrollrange({
        elements: {scope: scope},
        document: {compatMode: 'BackCompat'}
    });
    assert.strictEqual(geometry.read(scope).resolved.root, null,
        'a quirks-mode body root did not normalize to the viewport root');
    // In standards mode the body is an ordinary element root.
    document.compatMode = 'CSS1Compat';
    assert.strictEqual(geometry.read(scope).resolved.root, document.body,
        'a standards-mode body was mistaken for the document scroller');
}

// In quirks mode the root element's clientHeight and scrollHeight are
// the document's height, not the viewport's — the body is the
// scrolling element there, and the viewport measures through it.
function quirksViewportMeasuresThroughTheBody() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const {geometry, document, window} = loadScrollrange({
        elements: {scope: scope},
        document: {compatMode: 'BackCompat'}
    });
    document.documentElement.clientHeight = 2400;
    document.documentElement.scrollHeight = 2400;
    document.body.clientHeight = 800;
    document.body.scrollHeight = 2400;
    window.pageYOffset = 800;
    const measured = geometry.measure(geometry.read(scope));
    assert.strictEqual(measured.progress, 0.5,
        'the quirks viewport measured the document height as its own');
}

function scrollingElementSuppliesTheViewport() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const scroller = new Element('body');
    scroller.clientHeight = 800;
    scroller.scrollHeight = 2400;
    const {geometry, document, window} = loadScrollrange({
        elements: {scope: scope},
        document: {scrollingElement: scroller}
    });
    document.documentElement.clientHeight = 2400;
    document.documentElement.scrollHeight = 2400;
    window.pageYOffset = 800;
    assert.strictEqual(geometry.measure(geometry.read(scope)).progress, 0.5,
        'the viewport was not read from document.scrollingElement');
}

// measure hands back the root offset it read — a caller needing the
// offset too never re-reads it.
function measureReportsTheOffsetItRead() {
    const scope = new Element('div', 'scope');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).offset, 1300,
        'the element-mode read did not report its offset');

    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 600;
    const container = new Element('div', 'container');
    container.setAttribute('data-scrub-mode', 'container');
    container.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(container);
    const env = loadScrollrange({elements: {scroller: scroller}});
    assert.strictEqual(env.geometry.measure(env.geometry.read(container)).offset, 600,
        'the container-mode read did not report its offset');
}

// An element root whose content never overflows cannot scroll: its
// offset never moves, so a number would be a frozen constant. The
// range is inactive instead.
function nonScrollingElementRootIsInactive() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 400;
    scroller.rect = {top: 0, bottom: 400, width: 300, height: 400};
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.rect = {top: 100, bottom: 200, width: 300, height: 100};
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const measured = geometry.measure(geometry.read(scope));
    assert.strictEqual(measured.progress, null, 'a scroller that cannot scroll reported progress');
    assert.strictEqual(measured.near, false, 'a scroller that cannot scroll reported near');
}

// The window is two plain decimal fractions: Number()'s wider grammar
// — hexadecimal, binary, exponents, signs — is not a declaration.
function windowAcceptsDecimalFractionsOnly() {
    const scope = new Element('div', 'scope');
    const {geometry} = loadScrollrange({elements: {scope: scope}});
    ['0x0 1', '0 0b1', '0 1e0', '-0 1', '+0 1', '0 Infinity', '0 1.'].forEach(function (text) {
        scope.setAttribute('data-scrub-window', text);
        if (text === '0 1.') {
            assert.deepStrictEqual(Array.from(geometry.read(scope).options.window), [0, 1],
                'a trailing decimal point is still a decimal');
            return;
        }
        assert.throws(function () {
            geometry.read(scope);
        }, isTypeError, text + ' was accepted as a window');
    });
    scope.setAttribute('data-scrub-window', '.25 .75');
    assert.deepStrictEqual(Array.from(geometry.read(scope).options.window), [0.25, 0.75],
        'leading-point decimals are fractions');
}

// A rendered subject with a non-empty box measures from that one
// rectangle: the rectangle list (an allocation per read) is consulted
// only for an all-zero box, the one case where display:none and a
// rendered zero-size point look alike.
function renderedSubjectReadsNoRectangleList() {
    const scope = new Element('div', 'scope');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    let listed = 0;
    scope.getClientRects = function () {
        listed += 1;
        return this.clientRects === undefined ? [this.rect] : this.clientRects;
    };
    window.pageYOffset = 1300;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    assert.strictEqual(geometry.measure(range).progress, 0.5);
    scope.rect = {top: 300, bottom: 300, width: 100, height: 0};
    assert.strictEqual(geometry.measure(range).progress, 0.625);
    assert.strictEqual(listed, 0, 'a non-empty box still read its rectangle list');
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
    scope.clientRects = [];
    assert.strictEqual(geometry.measure(range).progress, null);
    assert.strictEqual(listed, 1, 'an all-zero box did not consult the rectangle list');
    scope.clientRects = undefined;
    assert.notStrictEqual(geometry.measure(range).progress, null,
        'a rendered zero-size point stopped measuring');
}

// resolved.content names the boxes that grow with the root's scrollable
// content: an element root's element children, or for the viewport the
// root element, the body and the body's children. A nested root that
// cannot scroll at bind reports it, and once its content grows (the
// box an owner watches) the same range measures.
function contentBoxesAreResolvedForObservation() {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 400;
    scroller.rect = {top: 0, bottom: 400, width: 300, height: 400};
    const wrapper = new Element('div', 'wrapper');
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.rect = {top: 100, bottom: 200, width: 300, height: 100};
    wrapper.appendChild(scope);
    scroller.appendChild(wrapper);
    const tail = new Element('p', 'tail');
    scroller.appendChild(tail);
    const page = new Element('div', 'page');
    const viewportScope = new Element('div', 'viewport-scope');
    page.appendChild(viewportScope);
    const {geometry, document} = loadScrollrange({elements: {scroller: scroller, page: page}});
    const range = geometry.read(scope);
    assert.strictEqual(range.resolved.content.length, 2);
    assert.ok(range.resolved.content[0] === wrapper && range.resolved.content[1] === tail,
        'the element root\'s content boxes were not resolved');
    assert.strictEqual(geometry.measure(range).progress, null);
    // The wrapper grows: the scroller's box is unchanged, its span is not.
    scroller.scrollHeight = 1600;
    const measured = geometry.measure(range);
    assert.strictEqual(typeof measured.progress, 'number',
        'a root that became scrollable still did not measure');
    const viewportRange = geometry.read(viewportScope);
    const expected = [document.documentElement, document.body].concat(document.body.children);
    assert.strictEqual(viewportRange.resolved.content.length, expected.length);
    assert.ok(expected.every((box, index) => viewportRange.resolved.content[index] === box),
        'the viewport root\'s content boxes were not resolved');
    scope.setAttribute('data-scrub-mode', 'container');
    const containerContent = geometry.read(scope).resolved.content;
    assert.ok(containerContent.length === 2 && containerContent[0] === wrapper,
        'a container range resolved no content boxes');
}

// Each case registers with the Node test runner under its function name.
test(elementModeMeasuresAnchors);
test(customAnchorsShiftTheEndpoints);
test(elementRootsMeasureInTheirOwnScrollSpace);
test(elementRootBorderShiftsTheScrollSpaceOrigin);
test(nearReportsTheApproachingBand);
test(containerModeWithoutRangeIsInert);
test(documentContainerModeReadsPageScroll);
test(degenerateRangeReports);
test(ambiguousResolutionRefuses);
test(invalidEndpointsRefuse);
test(windowRemapsElementProgress);
test(windowRemapsContainerProgress);
test(invalidWindowRefuses);
test(subjectOutsideRootRefuses);
test(containerScopeBesideScrollerReadsItsFraction);
test(inheritedAnchorNamesRefuse);
test(unrenderedSubjectMeasuresInactive);
test(emptyViewportMeasuresInactive);
test(emptyContainerViewportMeasuresInactive);
test(documentScrollerSelectorsNormalizeToTheViewport);
test(quirksBodyRootNormalizesToTheViewport);
test(quirksViewportMeasuresThroughTheBody);
test(scrollingElementSuppliesTheViewport);
test(measureReportsTheOffsetItRead);
test(nonScrollingElementRootIsInactive);
test(windowAcceptsDecimalFractionsOnly);
test(renderedSubjectReadsNoRectangleList);
test(contentBoxesAreResolvedForObservation);

// A nested root far below the page viewport is not near, in either
// mode, however its own scroll stands; brought within one page-viewport
// of lead it is. Every measure reads afresh.
test('a nested root is near only when its own box nears the page viewport', () => {
    const scroller = new Element('div', 'scroller');
    scroller.rect = {top: 10000, bottom: 10400, width: 600, height: 400};
    scroller.clientHeight = 400;
    scroller.scrollHeight = 3000;
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    // root-space 500..1500: inside the root's own one-viewport band.
    scope.rect = {top: 10500, bottom: 11500, width: 600, height: 1000};
    scroller.appendChild(scope);
    const container = new Element('div', 'container');
    container.setAttribute('data-scrub-mode', 'container');
    container.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(container);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const element = geometry.read(scope);
    const contained = geometry.read(container);
    let measured = geometry.measure(element);
    assert.strictEqual(measured.near, false, 'an element scene in a far scroller was near');
    assert.strictEqual(typeof measured.progress, 'number', 'nearness changed the progress contract');
    measured = geometry.measure(contained);
    assert.strictEqual(measured.near, false, 'a container scene in a far scroller was near');
    assert.strictEqual(measured.progress, 0);
    // The page scrolls the scroller to one viewport (800) below the fold.
    scroller.rect = {top: 1600, bottom: 2000, width: 600, height: 400};
    scope.rect = {top: 2100, bottom: 3100, width: 600, height: 1000};
    assert.strictEqual(geometry.measure(element).near, true, 'an approaching element scene was not near');
    assert.strictEqual(geometry.measure(contained).near, true, 'an approaching container scene was not near');
    // Scrolled past by more than one viewport above the page.
    scroller.rect = {top: -1300, bottom: -900, width: 600, height: 400};
    scope.rect = {top: -800, bottom: 200, width: 600, height: 1000};
    assert.strictEqual(geometry.measure(element).near, false, 'a scroller left behind kept its scene near');
    assert.strictEqual(geometry.measure(contained).near, false);
    // A container with no scrollable span stays inert and follows the
    // root's nearness.
    scroller.scrollHeight = 400;
    scroller.rect = {top: 0, bottom: 400, width: 600, height: 400};
    measured = geometry.measure(contained);
    assert.strictEqual(measured.progress, null);
    assert.strictEqual(measured.near, true);
});

test('measure reads afresh on every call and returns its own object', () => {
    const scope = new Element('div', 'scope');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    let rects = 0;
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    window.pageYOffset = 1300;
    const rect = scope.getBoundingClientRect.bind(scope);
    scope.getBoundingClientRect = () => { rects += 1; return rect(); };
    const a = geometry.measure(range);
    const b = geometry.measure(range);
    assert.equal(rects, 2);
    assert.notStrictEqual(a, b, 'two callers shared one result object');
    assert.deepEqual(a, b);
    assert.strictEqual(a.progress, 0.5);
});

// Located endpoints follow the root's own scroll from the offset alone:
// no rectangle is read, the window applies, and a null measurement
// stays null.
test('progressFrom follows the offset from located endpoints', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-window', '0.25 0.75');
    const {geometry, window} = loadScrollrange({elements: {scope: scope}});
    const range = geometry.read(scope);
    // scroll-space 1600..1800 at offset 0: start 800, end 1800.
    window.pageYOffset = 0;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.start, 800);
    assert.strictEqual(measured.end, 1800);
    let rects = 0;
    scope.getBoundingClientRect = () => { rects += 1; return null; };
    window.pageYOffset = 1300;
    assert.strictEqual(geometry.progressFrom(range, measured), 0.5);
    window.pageYOffset = 1000;
    assert.strictEqual(geometry.progressFrom(range, measured), 0);
    window.pageYOffset = 5000;
    assert.strictEqual(geometry.progressFrom(range, measured), 1);
    assert.equal(rects, 0, 'progressFrom read layout');
    assert.strictEqual(geometry.progressFrom(range, {progress: null, near: false, offset: 0, start: null, end: null}), null);

    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 0;
    scroller.rect = {top: 0, bottom: 400, width: 300, height: 400};
    const container = new Element('div', 'container');
    container.setAttribute('data-scrub-mode', 'container');
    container.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(container);
    const nested = loadScrollrange({elements: {scroller: scroller}}).geometry;
    const contained = nested.read(container);
    const located = nested.measure(contained);
    assert.strictEqual(located.start, 0);
    assert.strictEqual(located.end, 1200);
    scroller.scrollTop = 900;
    assert.strictEqual(nested.progressFrom(contained, located), 0.75);
});

// A root whose computed overflow-y is visible or clip is not a scroll
// container: its scrollHeight still exceeds its clientHeight, but its
// offset never moves, so a number would be frozen. Both modes measure
// inactive; hidden still scrolls programmatically and measures.
test('an element root that is not a scroll container is inactive', () => {
    ['visible', 'clip'].forEach((overflow) => {
        const scroller = new Element('div', 'scroller');
        scroller.clientHeight = 200;
        scroller.scrollHeight = 1000;
        scroller.rect = {top: 0, bottom: 200, width: 300, height: 200};
        scroller.computedStyle = {'overflow-y': overflow};
        const scope = new Element('section', 'scope');
        scope.setAttribute('data-scrub-root', '#scroller');
        scope.rect = {top: 50, bottom: 150, width: 300, height: 100};
        scroller.appendChild(scope);
        const container = new Element('div', 'container');
        container.setAttribute('data-scrub-mode', 'container');
        container.setAttribute('data-scrub-root', '#scroller');
        scroller.appendChild(container);
        const {geometry} = loadScrollrange({elements: {scroller: scroller}});
        assert.strictEqual(geometry.measure(geometry.read(scope)).progress, null,
            'an overflow-y: ' + overflow + ' element root reported progress');
        assert.strictEqual(geometry.measure(geometry.read(container)).progress, null,
            'an overflow-y: ' + overflow + ' container root reported progress');
        scroller.computedStyle = {'overflow-y': 'hidden'};
        assert.strictEqual(typeof geometry.measure(geometry.read(scope)).progress, 'number',
            'an overflow-y: hidden root stopped measuring');
        assert.strictEqual(geometry.measure(geometry.read(container)).progress, 0);
    });
});

// A transformed ancestor scales the rectangles but not scrollTop or
// clientHeight: edges are divided by the root's rendered-over-layout
// height before they meet the offset. A 300px root drawn at half size,
// subject 1000..1200 in its scroll space: S = 700, E = 1200.
test('a scaled nested root measures in its unscaled scroll space', () => {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 300;
    scroller.offsetHeight = 300;
    scroller.scrollHeight = 2200;
    scroller.rect = {top: 0, bottom: 150, width: 300, height: 150};
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scope);
    scroller.scrollTop = 700;
    scope.rect = {top: 150, bottom: 250, width: 300, height: 100};
    let measured = geometry.measure(range);
    assert.strictEqual(measured.start, 700);
    assert.strictEqual(measured.end, 1200);
    assert.strictEqual(measured.progress, 0);
    scroller.scrollTop = 950;
    scope.rect = {top: 25, bottom: 125, width: 300, height: 100};
    measured = geometry.measure(range);
    assert.strictEqual(measured.progress, 0.5, 'the scaled rectangles skewed the endpoints');
});

test('invalid modes and selector syntax throw, while an unresolved subject reports its error', () => {
    const scope = new Element('section', 'scope');
    const {geometry, document} = loadScrollrange({elements: {scope}});
    scope.setAttribute('data-scrub-mode', 'unknown');
    assert.throws(() => geometry.read(scope), error => isTypeError(error) && /scrub-mode/.test(error.message));
    scope.removeAttribute('data-scrub-mode');
    scope.setAttribute('data-scrub-subject', '#absent');
    assert.ok(geometry.read(scope).resolved.error, 'an absent subject must not become a usable range');
    scope.setAttribute('data-scrub-subject', '[');
    document.querySelectorAll = () => { throw new SyntaxError('invalid selector'); };
    assert.throws(() => geometry.read(scope), error => isTypeError(error) && /valid CSS selector/.test(error.message));
});

test('the document scrolling box supplies the viewport and fallback offset', () => {
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const {geometry, document, window} = loadScrollrange({elements: {scope}});
    document.documentElement.clientHeight = 500;
    document.documentElement.scrollHeight = 1500;
    document.documentElement.scrollTop = 250;
    window.innerHeight = 800;
    window.pageYOffset = undefined;
    const measured = geometry.measure(geometry.read(scope));
    assert.equal(measured.progress, 0.25);
    assert.equal(measured.offset, 250);
    assert.equal(measured.end, 1000);
});

test('an inactive viewport or root avoids reading the subject rectangle', () => {
    const root = new Element('div', 'root');
    root.clientHeight = 0;
    root.scrollHeight = 1600;
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#root');
    root.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {root}});
    const range = geometry.read(scope);
    scope.getBoundingClientRect = () => { throw new Error('an inactive subject was measured'); };
    assert.equal(geometry.measure(range).progress, null);
    root.clientHeight = 400;
    root.scrollHeight = 400;
    assert.equal(geometry.measure(range).progress, null);
});

test('an invalid subject rectangle does not read the root geometry', () => {
    const root = new Element('div', 'root');
    root.clientHeight = 400;
    root.scrollHeight = 1600;
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#root');
    scope.rect = {top: NaN, bottom: NaN, width: 100, height: 200};
    root.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {root}});
    const range = geometry.read(scope);
    root.getBoundingClientRect = () => { throw new Error('an invalid range read the root'); };
    assert.equal(geometry.measure(range).progress, null);
});

test('an unusable root scale falls back to unscaled scroll coordinates', () => {
    const root = new Element('div', 'root');
    root.clientHeight = 400;
    root.offsetHeight = 400;
    root.scrollHeight = 1600;
    root.rect = {top: 0, bottom: 400, width: 100, height: Infinity};
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#root');
    scope.rect = {top: 100, bottom: 200, width: 100, height: 100};
    root.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {root}});
    const measured = geometry.measure(geometry.read(scope));
    assert.equal(measured.start, -300);
    assert.equal(measured.end, 200);
    assert.equal(measured.progress, 0.6);
});

// offsetHeight rounds the layout height: an untransformed root whose
// height is fractional renders within a pixel of it and is unscaled —
// dividing by the rounded figure would skew every edge, and further
// with each edge's distance into the scroll space.
test('a fractional-height root is not mistaken for a scaled one', () => {
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 300;
    scroller.offsetHeight = 301;
    scroller.scrollHeight = 8000;
    scroller.rect = {top: 0, bottom: 300.5, width: 300, height: 300.5};
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', '#scroller');
    scroller.appendChild(scope);
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scope);
    // Subject at 4000..4400 in the root's scroll space.
    scroller.scrollTop = 3900;
    scope.rect = {top: 100, bottom: 500, width: 300, height: 400};
    const measured = geometry.measure(range);
    assert.strictEqual(measured.start, 3700, 'the rounded layout height skewed the start');
    assert.strictEqual(measured.end, 4400, 'the rounded layout height skewed the end');
    scroller.scrollTop = 0;
    scope.rect = {top: 4000, bottom: 4400, width: 300, height: 400};
    assert.deepStrictEqual([geometry.measure(range).start, geometry.measure(range).end], [3700, 4400],
        'the endpoints moved with the offset they were measured at');
});

// While the root element's overflow is visible in both axes, the
// viewport takes the body's overflow over: a standards-mode body whose
// computed overflow-y scrolls (body { overflow-x: hidden } computes
// overflow-y to auto) is still no scroll container, and its scrollTop
// never moves. Once the root element's overflow is not visible, the
// body keeps its own overflow and scrolls.
test('a body whose overflow the viewport takes over is inactive', () => {
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-scrub-root', 'body');
    scope.rect = {top: 1000, bottom: 1400, width: 300, height: 400};
    const container = new Element('div', 'container');
    container.setAttribute('data-scrub-mode', 'container');
    container.setAttribute('data-scrub-root', 'body');
    const {geometry, document} = loadScrollrange({elements: {scope: scope, container: container}});
    const body = document.body;
    body.clientHeight = 800;
    body.scrollHeight = 3400;
    body.rect = {top: 0, bottom: 800, width: 300, height: 800};
    body.computedStyle = {'overflow-x': 'hidden', 'overflow-y': 'auto'};
    document.documentElement.computedStyle = {'overflow-x': 'visible', 'overflow-y': 'visible'};
    const range = geometry.read(scope);
    assert.strictEqual(range.resolved.root, body, 'precondition: a standards-mode body is an element root');
    assert.strictEqual(geometry.measure(range).progress, null,
        'a body whose overflow the viewport took over reported a frozen progress');
    assert.strictEqual(geometry.measure(geometry.read(container)).progress, null,
        'a container body whose overflow the viewport took over reported progress');
    document.documentElement.computedStyle = {'overflow-x': 'hidden', 'overflow-y': 'hidden'};
    assert.strictEqual(typeof geometry.measure(range).progress, 'number',
        'a body that keeps its own scrolling overflow stopped measuring');
    assert.strictEqual(geometry.measure(geometry.read(container)).progress, 0);
});

// A root's own box moves with the page, never through its own scroll:
// an element-mode scope whose subject is its root reports the
// declaration rather than binding to a number that depends on where
// the page stood at the last measure. Container mode measures the
// root's own scroll, so a container scope may be the root.
test('a subject that is its own root refuses', () => {
    const scroller = new Element('div', 'scroller');
    scroller.setAttribute('data-scrub-root', '#scroller');
    scroller.clientHeight = 300;
    scroller.scrollHeight = 2000;
    const {geometry} = loadScrollrange({elements: {scroller: scroller}});
    const range = geometry.read(scroller);
    assert.ok(range.resolved.error && range.resolved.error.name === 'TypeError',
        'a scope that is its own root bound');
    assert.ok(/not the root itself/.test(range.resolved.error.message), range.resolved.error.message);
    const subject = new Element('div', 'subject');
    const inner = new Element('div', 'inner');
    inner.setAttribute('data-scrub-root', '#inner');
    inner.setAttribute('data-scrub-subject', '#inner');
    subject.appendChild(inner);
    const named = loadScrollrange({elements: {subject: subject}}).geometry.read(inner);
    assert.ok(named.resolved.error, 'a subject selector naming the root bound');
    scroller.setAttribute('data-scrub-mode', 'container');
    assert.ok(!geometry.read(scroller).resolved.error, 'a container scope that is its root refused');
});


test('caller-owned measurement is refreshed and cleared when the range degenerates', () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-scrub-mode', 'container');
    const {geometry, document} = loadScrollrange({elements: {scope}});
    const range = geometry.read(scope);
    document.documentElement.scrollHeight = 1600;
    document.body.scrollHeight = 1600;
    const into = {};
    assert.strictEqual(geometry.measure(range, into), into);
    assert.equal(into.end, 800);
    assert.notStrictEqual(geometry.measure(range), into);
    document.documentElement.scrollHeight = 800;
    document.body.scrollHeight = 800;
    assert.strictEqual(geometry.measure(range, into), into);
    assert.equal(into.progress, null);
    assert.equal(into.start, null);
    assert.equal(into.end, null);
});
